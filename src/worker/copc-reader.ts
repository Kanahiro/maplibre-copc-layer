import { createLazPerf, type LazPerf } from '../../vendor/laz-perf/js/src/index';
import lazPerfWasmUrl from '../../vendor/laz-perf/js/src/laz-perf.wasm?url';

export interface Page { offset: number; length: number }
export interface Node { id: string; level: number; x: number; y: number; z: number; pointCount: number; offset: number; length: number }
export interface HierarchyPage { nodes: Node[]; pages: Map<string, Page> }
export interface PointRecord { x: number; y: number; z: number; red: number; green: number; blue: number; intensity: number; classification: number }

interface Header {
  format: number;
  recordLength: number;
  scale: [number, number, number];
  offset: [number, number, number];
}

const decoder = new TextDecoder();
function stringAt(bytes: Uint8Array, start: number, length: number): string {
  const value = bytes.subarray(start, start + length);
  const end = value.indexOf(0);
  return decoder.decode(end < 0 ? value : value.subarray(0, end));
}
function safeOffset(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('COPC offset exceeds JavaScript safe integer range');
  return Number(value);
}
function triplet(view: DataView, offset: number): [number, number, number] {
  return [0, 8, 16].map((step) => view.getFloat64(offset + step, true)) as [number, number, number];
}

/** One range request; a full-file response is unsafe for large COPC files. */
export async function readRange(url: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0) throw new Error('Invalid byte range');
  const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal });
  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`COPC server must support byte ranges (HTTP ${response.status})`);
  }
  const contentRange = response.headers.get('Content-Range');
  if (contentRange && !contentRange.startsWith(`bytes ${offset}-${offset + length - 1}/`)) throw new Error('Unexpected Content-Range');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== length) throw new Error(`Short COPC range: expected ${length}, got ${bytes.byteLength}`);
  return bytes;
}

export class CopcReader {
  private lazPerf?: LazPerf;
  private constructor(
    readonly url: string,
    readonly header: Header,
    readonly cube: [number, number, number, number, number, number],
    readonly spacing: number,
    readonly rootPage: Page,
    readonly wkt: string,
  ) {}

  static async open(url: string, signal?: AbortSignal): Promise<CopcReader> {
    const bytes = await readRange(url, 0, 375, signal);
    const view = new DataView(bytes.buffer);
    if (stringAt(bytes, 0, 4) !== 'LASF' || view.getUint8(24) !== 1 || view.getUint8(25) !== 4) throw new Error('COPC requires LAS 1.4');
    const headerLength = view.getUint16(94, true);
    if (headerLength < 375) throw new Error('Invalid LAS header length');
    const format = view.getUint8(104) & 0x3f;
    if (format < 6 || format > 8) throw new Error(`Unsupported COPC point format ${format}`);
    const header: Header = {
      format,
      recordLength: view.getUint16(105, true),
      scale: triplet(view, 131),
      offset: triplet(view, 155),
    };
    if (header.recordLength < [30, 36, 38][format - 6]) throw new Error('Invalid point record length');
    let cursor = headerLength;
    let info: Uint8Array | undefined;
    let wkt: string | undefined;
    const count = view.getUint32(100, true);
    for (let i = 0; i < count; i++) {
      const vlr = await readRange(url, cursor, 54, signal);
      const v = new DataView(vlr.buffer);
      const user = stringAt(vlr, 2, 16);
      const record = v.getUint16(18, true);
      const length = v.getUint16(20, true);
      cursor += 54;
      if (user === 'copc' && record === 1) info = await readRange(url, cursor, length, signal);
      if (user === 'LASF_Projection' && record === 2112 && length > 0) wkt = stringAt(await readRange(url, cursor, length, signal), 0, length);
      cursor += length;
    }
	if (!wkt) {
		cursor = safeOffset(view, 235);
		const extendedCount = view.getUint32(243, true);
		for (let i = 0; i < extendedCount; i++) {
			const vlr = await readRange(url, cursor, 60, signal);
			const v = new DataView(vlr.buffer);
			const user = stringAt(vlr, 2, 16);
			const record = v.getUint16(18, true);
			const length = safeOffset(v, 20);
			cursor += 60;
			if (user === 'LASF_Projection' && record === 2112 && length > 0) {
				wkt = stringAt(await readRange(url, cursor, length, signal), 0, length);
				break;
			}
			cursor += length;
		}
	}
    if (!info || info.byteLength !== 160) throw new Error('Missing or invalid COPC info VLR');
    if (!wkt) throw new Error('Missing WKT coordinate reference system');
    const data = new DataView(info.buffer, info.byteOffset, info.byteLength);
    const center = triplet(data, 0);
    const radius = data.getFloat64(24, true);
    const cube: [number, number, number, number, number, number] = [center[0] - radius, center[1] - radius, center[2] - radius, center[0] + radius, center[1] + radius, center[2] + radius];
    const rootPage = { offset: safeOffset(data, 40), length: safeOffset(data, 48) };
    return new CopcReader(url, header, cube, data.getFloat64(32, true), rootPage, wkt);
  }

  async loadPage(page: Page, signal?: AbortSignal): Promise<HierarchyPage> {
    if (page.length === 0 || page.length % 32 !== 0) throw new Error('Invalid hierarchy page length');
    const bytes = await readRange(this.url, page.offset, page.length, signal);
    const view = new DataView(bytes.buffer);
    const nodes: Node[] = [];
    const pages = new Map<string, Page>();
    for (let at = 0; at < bytes.length; at += 32) {
      const level = view.getInt32(at, true);
      const x = view.getInt32(at + 4, true);
      const y = view.getInt32(at + 8, true);
      const z = view.getInt32(at + 12, true);
      const offset = safeOffset(view, at + 16);
      const length = view.getInt32(at + 24, true);
      const pointCount = view.getInt32(at + 28, true);
      if (level < 0 || x < 0 || y < 0 || z < 0 || length < 0 || pointCount < -1) throw new Error('Invalid hierarchy entry');
      const id = `${level}-${x}-${y}-${z}`;
      if (pointCount === -1) pages.set(id, { offset, length });
      else nodes.push({ id, level, x, y, z, pointCount, offset, length });
    }
    return { nodes, pages };
  }

  async loadNode(node: Node, signal?: AbortSignal): Promise<Uint8Array> {
    if (node.pointCount <= 0) return new Uint8Array();
    const compressed = await readRange(this.url, node.offset, node.length, signal);
    this.lazPerf ??= await createLazPerf({ locateFile: () => lazPerfWasmUrl });
    const laz = this.lazPerf;
    const output = new Uint8Array(node.pointCount * this.header.recordLength);
    const chunkPtr = laz._malloc(compressed.length);
    const pointPtr = laz._malloc(this.header.recordLength);
    const chunk = new laz.ChunkDecoder();
    try {
      laz.HEAPU8.set(compressed, chunkPtr);
      chunk.open(this.header.format, this.header.recordLength, chunkPtr);
      for (let i = 0; i < node.pointCount; i++) {
        chunk.getPoint(pointPtr);
        output.set(new Uint8Array(laz.HEAPU8.buffer, pointPtr, this.header.recordLength), i * this.header.recordLength);
      }
    } finally {
      chunk.delete();
      laz._free(chunkPtr);
      laz._free(pointPtr);
    }
    return output;
  }

  /** The same record is reused for every visit; callers must consume it synchronously. */
  forEachPoint(bytes: Uint8Array, visit: (point: PointRecord, index: number) => void): void {
    if (bytes.byteLength % this.header.recordLength !== 0) throw new Error('Invalid point buffer length');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const point: PointRecord = { x: 0, y: 0, z: 0, red: 0, green: 0, blue: 0, intensity: 0, classification: 0 };
    for (let i = 0; i < bytes.byteLength / this.header.recordLength; i++) {
      this.readPoint(view, i, point);
      visit(point, i);
    }
  }

  pointAt(bytes: Uint8Array, index: number): PointRecord {
    const point: PointRecord = { x: 0, y: 0, z: 0, red: 0, green: 0, blue: 0, intensity: 0, classification: 0 };
    this.readPoint(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), index, point);
    return point;
  }

  private readPoint(view: DataView, index: number, point: PointRecord): void {
    const { format, recordLength, scale, offset } = this.header;
    const at = index * recordLength;
    if (at < 0 || at + recordLength > view.byteLength) throw new RangeError('Point index out of range');
    const rgb = format >= 7 ? at + 30 : -1;
    point.x = view.getInt32(at, true) * scale[0] + offset[0];
    point.y = view.getInt32(at + 4, true) * scale[1] + offset[1];
    point.z = view.getInt32(at + 8, true) * scale[2] + offset[2];
    point.intensity = view.getUint16(at + 12, true);
    point.classification = view.getUint8(at + 16);
    point.red = rgb < 0 ? 65535 : view.getUint16(rgb, true);
    point.green = rgb < 0 ? 65535 : view.getUint16(rgb + 2, true);
    point.blue = rgb < 0 ? 65535 : view.getUint16(rgb + 4, true);
  }
}
