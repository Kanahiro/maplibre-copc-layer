import { afterEach, describe, expect, test, vi } from 'vitest';
import { CopcReader, readRange } from '../src/worker/copc-reader';

const file = new Uint8Array(2048);
const view = new DataView(file.buffer);
const encoder = new TextEncoder();
function put(offset: number, value: string): void { file.set(encoder.encode(value), offset); }
put(0, 'LASF');
view.setUint8(24, 1); view.setUint8(25, 4);
view.setUint16(94, 375, true);
view.setUint32(100, 2, true);
view.setUint8(104, 7);
view.setUint16(105, 36, true);
for (const [i, scale] of [0.01, 0.01, 0.01].entries()) view.setFloat64(131 + i * 8, scale, true);
put(377, 'copc'); view.setUint16(393, 1, true); view.setUint16(395, 160, true);
view.setFloat64(429, 100, true); view.setFloat64(437, 200, true); view.setFloat64(445, 300, true);
view.setFloat64(453, 10, true); view.setFloat64(461, 2, true);
view.setBigUint64(469, 1000n, true); view.setBigUint64(477, 64n, true);
put(591, 'LASF_Projection'); view.setUint16(607, 2112, true); view.setUint16(609, 8, true);
put(643, 'TESTWKT');
// Root point data and a pointer to a child hierarchy page.
view.setInt32(1000, 0, true); view.setBigUint64(1016, 1500n, true);
view.setInt32(1024, 100, true); view.setInt32(1028, 1, true);
view.setInt32(1032, 1, true); view.setBigUint64(1048, 1600n, true);
view.setInt32(1056, 32, true); view.setInt32(1060, -1, true);
view.setInt32(1600, 1, true); view.setBigUint64(1616, 1700n, true);
view.setInt32(1624, 100, true); view.setInt32(1628, 1, true);

function mockRanges(status = 206, source = file): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const range = String((init.headers as Record<string, string>).Range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(match[1]); const end = Number(match[2]);
    return new Response(source.slice(start, end + 1), {
      status,
      headers: status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${source.length}` } : {},
    });
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe('COPC reader', () => {
  test('parses LAS, info VLR, hierarchy pages and point fields', async () => {
    mockRanges();
    const reader = await CopcReader.open('https://example.test/cloud.copc.laz');
    expect(reader.cube).toEqual([90, 190, 290, 110, 210, 310]);
    expect(reader.wkt).toBe('TESTWKT');
    const root = await reader.loadPage(reader.rootPage);
    expect(root.nodes[0].id).toBe('0-0-0-0');
    const child = await reader.loadPage(root.pages.get('1-0-0-0')!);
    expect(child.nodes[0].id).toBe('1-0-0-0');
    const record = new Uint8Array(36);
    const point = new DataView(record.buffer);
    point.setInt32(0, 1234, true); point.setUint16(12, 32768, true);
    point.setUint8(16, 6); point.setUint16(30, 65535, true);
    expect(reader.pointAt(record, 0)).toMatchObject({ x: 12.34, intensity: 32768, classification: 6, red: 65535 });
		const visited: number[] = [];
		reader.forEachPoint(record, (value) => visited.push(value.x));
		expect(visited).toEqual([12.34]);
  });
  test('rejects a server that ignores Range', async () => {
    mockRanges(200);
    await expect(readRange('https://example.test/cloud.copc.laz', 0, 375)).rejects.toThrow('byte ranges');
  });
	test('reads WKT from an extended VLR', async () => {
		const source = file.slice();
		const data = new DataView(source.buffer);
		data.setUint32(100, 1, true);
		data.setBigUint64(235, 700n, true);
		data.setUint32(243, 1, true);
		source.set(encoder.encode('LASF_Projection'), 702);
		data.setUint16(718, 2112, true);
		data.setBigUint64(720, 8n, true);
		source.set(encoder.encode('TESTWKT'), 760);
		mockRanges(206, source);
		expect((await CopcReader.open('https://example.test/cloud.copc.laz')).wkt).toBe('TESTWKT');
	});
});
