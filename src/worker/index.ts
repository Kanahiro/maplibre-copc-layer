import proj4, { type Converter } from 'proj4';
import { CopcReader, type Node, type Page } from './copc-reader';
import { computeScreenSpaceError, type Vec3 } from './sse';
import { toMercator } from './coordinates';
import { intersectsFrustum } from './frustum';

type Message =
  | { type: 'init'; url: string; options?: { alwaysShowRoot?: boolean } }
  | { type: 'loadNode'; node: string }
  | { type: 'updatePoints'; cameraPosition: Vec3; mapHeight: number; fov: number; sseThreshold: number; frustumMatrix: number[]; sceneOrigin: Vec3 };

let reader: CopcReader | undefined;
let projection: Converter;
let alwaysShowRoot = false;
const nodes = new Map<string, Node>();
const nodeCorners = new Map<string, Vec3[]>();
const pages = new Map<string, Page>();
const pageLoads = new Map<string, Promise<void>>();
const requests = new Set<string>();
let latestView: Extract<Message, { type: 'updatePoints' }> | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function emitError(message: string, node?: string, fatal = false): void {
  self.postMessage({ type: 'error', message, node, fatal });
}
function cubeCenter(node: Node): Vec3 {
  const cube = reader!.cube;
  const divisor = 2 ** node.level;
  return [
    cube[0] + ((cube[3] - cube[0]) * (node.x + 0.5)) / divisor,
    cube[1] + ((cube[4] - cube[1]) * (node.y + 0.5)) / divisor,
    cube[2] + ((cube[5] - cube[2]) * (node.z + 0.5)) / divisor,
  ];
}
function children(node: Node): Node[] {
  const result: Node[] = [];
  const level = node.level + 1;
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
    const id = `${level}-${2 * node.x + x}-${2 * node.y + y}-${2 * node.z + z}`;
    const child = nodes.get(id);
    if (child) result.push(child);
  }
  return result;
}
function cornersFor(node: Node): Vec3[] {
  const cached = nodeCorners.get(node.id);
  if (cached) return cached;
  const cube = reader!.cube;
  const divisor = 2 ** node.level;
  const low = [cube[0], cube[1], cube[2]].map((value, i) => value + (cube[i + 3] - value) * [node.x, node.y, node.z][i] / divisor);
  const high = [cube[0], cube[1], cube[2]].map((value, i) => value + (cube[i + 3] - value) * ([node.x, node.y, node.z][i] + 1) / divisor);
  const corners: Vec3[] = [];
  for (const x of [low[0], high[0]]) for (const y of [low[1], high[1]]) for (const z of [low[2], high[2]]) {
    corners.push(toMercator(projection.inverse([x, y, z]) as Vec3));
  }
  nodeCorners.set(node.id, corners);
  return corners;
}
async function loadPage(id: string, page: Page): Promise<void> {
  if (!reader || pageLoads.has(id)) return;
  const promise = reader.loadPage(page).then((hierarchy) => {
    for (const node of hierarchy.nodes) nodes.set(node.id, node);
    for (const [key, value] of hierarchy.pages) pages.set(key, value);
    pages.delete(id);
    if (latestView) updatePoints(latestView);
  }).catch((error: unknown) => {
	pages.delete(id);
	emitError(`Hierarchy ${id}: ${errorMessage(error)}`);
  })
    .finally(() => pageLoads.delete(id));
  pageLoads.set(id, promise);
  await promise;
}
async function initialize(message: Extract<Message, { type: 'init' }>): Promise<void> {
  reader = await CopcReader.open(message.url);
  alwaysShowRoot = message.options?.alwaysShowRoot ?? false;
  projection = reader.wkt.trimStart().startsWith('GEOCCS')
    ? proj4('+proj=geocent +datum=WGS84 +units=m +no_defs')
    : proj4(reader.wkt);
  nodes.clear();
  nodeCorners.clear();
  pages.clear();
  await loadPage('root', reader.rootPage);
	// A hierarchy page can contain a pointer for its own root entry.
	while (!nodes.has('0-0-0-0') && pages.has('0-0-0-0')) {
		await loadPage('0-0-0-0', pages.get('0-0-0-0')!);
	}
	if (!nodes.has('0-0-0-0')) throw new Error('COPC root node is missing');
  const cube = reader.cube;
  const corners: Vec3[] = [];
  for (const x of [cube[0], cube[3]]) for (const y of [cube[1], cube[4]]) for (const z of [cube[2], cube[5]]) corners.push(projection.inverse([x, y, z]) as Vec3);
  const bounds = {
    minx: Math.min(...corners.map((c) => c[0])), maxx: Math.max(...corners.map((c) => c[0])),
    miny: Math.min(...corners.map((c) => c[1])), maxy: Math.max(...corners.map((c) => c[1])),
    minz: Math.min(...corners.map((c) => c[2])), maxz: Math.max(...corners.map((c) => c[2])),
  };
  self.postMessage({ type: 'initialized', nodeCount: nodes.size, bounds });
}
function updatePoints(message: Extract<Message, { type: 'updatePoints' }>): void {
  if (!reader) return;
  latestView = message;
  const cameraWorld = projection.forward(message.cameraPosition) as Vec3;
  const visible: string[] = [];
  const visit = (node: Node) => {
	if ((node.level > 0 || !alwaysShowRoot) && !intersectsFrustum(cornersFor(node), message.frustumMatrix, message.sceneOrigin)) return;
    // Each COPC chunk contains its own points. Descending into children adds
    // detail; it does not replace the points stored in their ancestors.
    if (node.pointCount > 0) visible.push(node.id);
    const sse = computeScreenSpaceError(cameraWorld, cubeCenter(node), message.fov, reader!.spacing * 0.5 ** node.level, message.mapHeight);
    if (sse > message.sseThreshold) {
      for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
        const id = `${node.level + 1}-${2 * node.x + x}-${2 * node.y + y}-${2 * node.z + z}`;
        const page = pages.get(id);
        if (page) {
          if (!pageLoads.has(id)) void loadPage(id, page);
        }
      }
      for (const child of children(node)) visit(child);
    }
  };
  const root = nodes.get('0-0-0-0');
  if (root) visit(root);
  self.postMessage({ type: 'nodesToLoad', nodes: visible });
}
async function loadNode(id: string): Promise<void> {
  const node = nodes.get(id);
  if (!reader || !node || node.pointCount <= 0) {
    emitError(`Node ${id} is unavailable`, id);
    return;
  }
  if (requests.has(id)) return;
  requests.add(id);
  try {
    const bytes = await reader.loadNode(node);
    const positions = new Float64Array(node.pointCount * 3);
    const colors = new Float32Array(node.pointCount * 3);
    const heights = new Float32Array(node.pointCount);
    const classifications = new Uint8Array(node.pointCount);
    const intensities = new Float32Array(node.pointCount);
    reader.forEachPoint(bytes, (point, i) => {
      const [lon, lat, height] = projection.inverse([point.x, point.y, point.z]) as Vec3;
      const mercator = toMercator([lon, lat, height]);
      positions[3 * i] = mercator[0];
      positions[3 * i + 1] = mercator[1];
      positions[3 * i + 2] = mercator[2];
      heights[i] = height;
      classifications[i] = point.classification;
      intensities[i] = point.intensity / 65535;
      colors[3 * i] = point.red / 65535;
      colors[3 * i + 1] = point.green / 65535;
      colors[3 * i + 2] = point.blue / 65535;
    });
    self.postMessage({ type: 'nodeLoaded', node: id, positions: positions.buffer, colors: colors.buffer,
      heights: heights.buffer, classifications: classifications.buffer, intensities: intensities.buffer },
      { transfer: [positions.buffer, colors.buffer, heights.buffer, classifications.buffer, intensities.buffer] });
  } catch (error) {
    emitError(`Node ${id}: ${errorMessage(error)}`, id);
  } finally {
    requests.delete(id);
  }
}
self.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'init': void initialize(message).catch((error: unknown) => emitError(`Initialize: ${errorMessage(error)}`, undefined, true)); break;
      case 'updatePoints': updatePoints(message); break;
      case 'loadNode': void loadNode(message.node); break;
    }
  } catch (error) { emitError(errorMessage(error)); }
};
