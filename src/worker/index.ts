import { Copc, type Hierarchy, Las } from 'copc';
import proj4, { type Converter } from 'proj4';
import lazPerfWasmUrl from '../../vendor/laz-perf/js/src/laz-perf.wasm?url';
import { computeScreenSpaceError, type Vec3 } from './sse';
import { EARTH_CIRCUMFERENCE, DEG2RAD } from '../constants';

type RGBColor = [number, number, number];

type ColorExpression =
	| ['linear', ...(number | RGBColor)[]]
	| ['discrete', ...(number | RGBColor)[]];

interface InitMessage {
	type: 'init';
	url: string;
	options?: {
		colorMode?: 'rgb' | 'height' | 'intensity' | 'classification' | 'white';
		heightColor?: ColorExpression;
		intensityColor?: ColorExpression;
		classificationColors?: Record<number, RGBColor>;
		alwaysShowRoot?: boolean;
	};
}

interface LoadNodeMessage {
	type: 'loadNode';
	node: string;
}

interface UpdatePointsMessage {
	type: 'updatePoints';
	cameraPosition: [number, number, number];
	mapHeight: number;
	fov: number;
	sseThreshold: number;
	zoom: number;
}

interface CancelRequestsMessage {
	type: 'cancelRequests';
	nodes: string[];
}

type WorkerMessage =
	| InitMessage
	| LoadNodeMessage
	| UpdatePointsMessage
	| CancelRequestsMessage;

let copc: Copc | null = null;
let lazPerf: unknown = undefined;
let proj: Converter;
let nodes: Hierarchy.Node.Map = {};
let nodeCenters: Record<string, Vec3> = {};
let url: string;
let colorMode: 'rgb' | 'height' | 'intensity' | 'classification' | 'white' =
	'rgb';
let alwaysShowRoot = false;
const cancelledRequests = new Set<string>();

let classificationColors: Record<number, RGBColor> = {};
let heightColor: ColorExpression | undefined;
let intensityColor: ColorExpression = ['linear', 0, [0, 0, 0], 1, [1, 1, 1]];

function applyColorExpression(
	expr: ColorExpression,
	height: number,
	colors: Float32Array,
	offset: number,
): void {
	if (expr[0] === 'linear') {
		// ["linear", h0, c0, h1, c1, ...]
		const firstH = expr[1] as number;
		const firstC = expr[2] as RGBColor;
		if (height <= firstH) {
			colors[offset] = firstC[0];
			colors[offset + 1] = firstC[1];
			colors[offset + 2] = firstC[2];
			return;
		}
		const lastIdx = expr.length - 2;
		const lastH = expr[lastIdx] as number;
		const lastC = expr[lastIdx + 1] as RGBColor;
		if (height >= lastH) {
			colors[offset] = lastC[0];
			colors[offset + 1] = lastC[1];
			colors[offset + 2] = lastC[2];
			return;
		}
		for (let i = 1; i < expr.length - 2; i += 2) {
			const h1 = expr[i + 2] as number;
			if (height <= h1) {
				const h0 = expr[i] as number;
				const c0 = expr[i + 1] as RGBColor;
				const c1 = expr[i + 3] as RGBColor;
				const t = (height - h0) / (h1 - h0);
				colors[offset] = c0[0] + t * (c1[0] - c0[0]);
				colors[offset + 1] = c0[1] + t * (c1[1] - c0[1]);
				colors[offset + 2] = c0[2] + t * (c1[2] - c0[2]);
				return;
			}
		}
	} else {
		// ["discrete", h0, c0, h1, c1, ...]
		const dc = expr[2] as RGBColor;
		let r = dc[0],
			g = dc[1],
			b = dc[2];
		for (let i = 1; i < expr.length; i += 2) {
			if (height >= (expr[i] as number)) {
				const c = expr[i + 1] as RGBColor;
				r = c[0];
				g = c[1];
				b = c[2];
			} else {
				break;
			}
		}
		colors[offset] = r;
		colors[offset + 1] = g;
		colors[offset + 2] = b;
	}
}

function calcCubeCenter(
	cube: [number, number, number, number, number, number],
	node: string,
): Vec3 {
	const parts = node.split('-').map(Number);
	const [depth, x, y, z] = parts;
	const divisor = 2 ** depth;
	const cubeSizeOfNode = [
		(cube[3] - cube[0]) / divisor,
		(cube[4] - cube[1]) / divisor,
		(cube[5] - cube[2]) / divisor,
	];

	return [
		cube[0] + cubeSizeOfNode[0] * x + cubeSizeOfNode[0] / 2,
		cube[1] + cubeSizeOfNode[1] * y + cubeSizeOfNode[1] / 2,
		cube[2] + cubeSizeOfNode[2] * z + cubeSizeOfNode[2] / 2,
	];
}

async function initCopc(initUrl: string) {
	try {
		copc = await Copc.create(initUrl);
		if (!copc?.wkt) {
			self.postMessage({
				type: 'error',
				message: 'Failed to initialize COPC or WKT is missing',
			});
			return;
		}

		if (copc.wkt.trimStart().startsWith('GEOCCS')) {
			proj = proj4('+proj=geocent +datum=WGS84 +units=m +no_defs');
		} else {
			proj = proj4(copc.wkt);
		}

		const { nodes: loadedNodes } = await Copc.loadHierarchyPage(
			initUrl,
			copc.info.rootHierarchyPage,
		);

		nodes = loadedNodes;
		nodeCenters = {};
		for (const k of Object.keys(nodes)) {
			nodeCenters[k] = calcCubeCenter(copc.info.cube, k);
		}

		const cube = copc.info.cube;
		const cubeCorners = [
			[cube[0], cube[1], cube[2]],
			[cube[3], cube[1], cube[2]],
			[cube[0], cube[4], cube[2]],
			[cube[3], cube[4], cube[2]],
			[cube[0], cube[1], cube[5]],
			[cube[3], cube[1], cube[5]],
			[cube[0], cube[4], cube[5]],
			[cube[3], cube[4], cube[5]],
		];
		const wgs84Corners = cubeCorners.map((c) => proj.inverse(c));
		const bounds = {
			minx: Math.min(...wgs84Corners.map((c) => c[0])),
			maxx: Math.max(...wgs84Corners.map((c) => c[0])),
			miny: Math.min(...wgs84Corners.map((c) => c[1])),
			maxy: Math.max(...wgs84Corners.map((c) => c[1])),
			minz: Math.min(...wgs84Corners.map((c) => c[2])),
			maxz: Math.max(...wgs84Corners.map((c) => c[2])),
		};

		if (!heightColor) {
			heightColor = [
				'linear',
				bounds.minz,
				[0, 0, 1],
				(bounds.minz + bounds.maxz) / 2,
				[1, 1, 0],
				bounds.maxz,
				[1, 0, 0],
			];
		}
		self.postMessage({
			type: 'initialized',
			nodeCount: Object.keys(nodes).length,
			bounds,
		});
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error initializing COPC: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

async function loadNode(node: string) {
	if (!copc) {
		self.postMessage({ type: 'error', message: 'COPC not initialized' });
		return;
	}

	if (cancelledRequests.has(node)) {
		cancelledRequests.delete(node);
		return;
	}

	try {
		const targetNode = nodes[node];
		if (!targetNode) {
			self.postMessage({ type: 'error', message: `Node ${node} not found` });
			return;
		}

		const view = await Copc.loadPointDataView(url, copc, targetNode, {
			lazPerf,
		});

		if (cancelledRequests.has(node)) {
			cancelledRequests.delete(node);
			return;
		}

		const positions = new Float64Array(targetNode.pointCount * 3);
		const colors = new Float32Array(targetNode.pointCount * 3);
		const classifications = new Uint8Array(targetNode.pointCount);
		const intensities = new Float32Array(targetNode.pointCount);

		const hasRgb =
			view.dimensions['Red'] &&
			view.dimensions['Green'] &&
			view.dimensions['Blue'];
		const hasIntensity = view.dimensions['Intensity'];
		const hasClassification = view.dimensions['Classification'];

		const getX = view.getter('X');
		const getY = view.getter('Y');
		const getZ = view.getter('Z');
		const getRed = hasRgb ? view.getter('Red') : null;
		const getGreen = hasRgb ? view.getter('Green') : null;
		const getBlue = hasRgb ? view.getter('Blue') : null;
		const getIntensity = hasIntensity ? view.getter('Intensity') : null;
		const getClassification = hasClassification
			? view.getter('Classification')
			: null;

		for (let i = 0; i < targetNode.pointCount; i++) {
			const px = getX(i);
			const py = getY(i);
			const pz = getZ(i);

			const [lon, lat, height] = proj.inverse([px, py, pz]) as [
				number,
				number,
				number,
			];
			const lonRad = lon * DEG2RAD;
			const latRad = lat * DEG2RAD;

			const mercX = 0.5 + lonRad / (2 * Math.PI);
			const sinLat = Math.sin(latRad);
			const k = (1 + sinLat) / (1 - sinLat);
			const mercY = 0.5 - Math.log(k) / (4 * Math.PI);
			const mercZ = height / EARTH_CIRCUMFERENCE;

			positions[i * 3] = mercX;
			positions[i * 3 + 1] = mercY;
			positions[i * 3 + 2] = mercZ;

			classifications[i] = getClassification ? getClassification(i) : 0;
			intensities[i] = getIntensity ? getIntensity(i) / 65535 : 0;

			switch (colorMode) {
				case 'rgb':
					if (getRed && getGreen && getBlue) {
						colors[i * 3] = getRed(i) / 65535;
						colors[i * 3 + 1] = getGreen(i) / 65535;
						colors[i * 3 + 2] = getBlue(i) / 65535;
					} else {
						colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1;
					}
					break;

				case 'height': {
					applyColorExpression(heightColor!, height, colors, i * 3);
					break;
				}

				case 'intensity': {
					applyColorExpression(
						intensityColor,
						intensities[i],
						colors,
						i * 3,
					);
					break;
				}

				case 'classification': {
					if (getClassification) {
						const cls = getClassification(i);
						const c = classificationColors[cls];
						if (c) {
							colors[i * 3] = c[0];
							colors[i * 3 + 1] = c[1];
							colors[i * 3 + 2] = c[2];
						} else {
							colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1;
						}
					} else {
						colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1;
					}
					break;
				}

				case 'white':
				default:
					colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1;
					break;
			}
		}

		self.postMessage(
			{
				type: 'nodeLoaded',
				node,
				positions: positions.buffer,
				colors: colors.buffer,
				classifications: classifications.buffer,
				intensities: intensities.buffer,
				pointCount: targetNode.pointCount,
			},
			{
				transfer: [
					positions.buffer,
					colors.buffer,
					classifications.buffer,
					intensities.buffer,
				],
			},
		);
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error loading node ${node}: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

function updatePoints(
	cameraPosition: [number, number, number],
	mapHeight: number,
	fov: number,
	sseThreshold: number,
) {
	if (!copc) {
		self.postMessage({ type: 'error', message: 'COPC not initialized' });
		return;
	}

	try {
		const cameraWorld = proj.forward([
			cameraPosition[0],
			cameraPosition[1],
			cameraPosition[2],
		]) as Vec3;

		const visibleNodes: string[] = [];

		for (const [nodeId, center] of Object.entries(nodeCenters)) {
			const depth = Number.parseInt(nodeId.split('-')[0]);

			const sse = computeScreenSpaceError(
				cameraWorld,
				center,
				fov,
				copc.info.spacing * 0.5 ** depth,
				mapHeight,
			);

			if (sse > sseThreshold) {
				visibleNodes.push(nodeId);
			}
		}

		if (alwaysShowRoot && visibleNodes.length === 0) {
			visibleNodes.push('0-0-0-0');
		}

		self.postMessage({
			type: 'nodesToLoad',
			nodes: visibleNodes,
			cameraPosition,
		});
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error updating points: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;

	try {
		switch (message.type) {
			case 'init':
				url = message.url;
				if (message.options) {
					colorMode = message.options.colorMode || 'rgb';
					alwaysShowRoot = message.options.alwaysShowRoot ?? false;
					if (message.options.heightColor) {
						heightColor = message.options.heightColor;
					}
					if (message.options.intensityColor) {
						intensityColor = message.options.intensityColor;
					}
					if (message.options.classificationColors) {
						classificationColors = message.options.classificationColors;
					}
				}
				lazPerf = await Las.PointData.createLazPerf({
					locateFile: () => lazPerfWasmUrl,
				});
				await initCopc(message.url);
				break;
			case 'loadNode':
				await loadNode(message.node);
				break;
			case 'updatePoints':
				updatePoints(
					message.cameraPosition,
					message.mapHeight,
					message.fov,
					message.sseThreshold,
				);
				break;
			case 'cancelRequests':
				for (const nodeId of message.nodes) {
					cancelledRequests.add(nodeId);
				}
				break;
		}
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error processing message: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
};
