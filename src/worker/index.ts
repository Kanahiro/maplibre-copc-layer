import * as THREE from 'three';
import { Copc, Hierarchy } from 'copc';
import { MercatorCoordinate } from 'maplibre-gl';
import proj4, { Converter } from 'proj4';
import { computeScreenSpaceError } from './sse';

// Message types for worker communication
interface InitMessage {
	type: 'init';
	url: string;
	options?: {
		colorMode?: 'rgb' | 'height' | 'intensity' | 'white';
		maxCacheSize?: number;
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
}

type WorkerMessage = InitMessage | LoadNodeMessage | UpdatePointsMessage;

let copc: Copc | null = null;
let proj: Converter;
let nodes: Hierarchy.Node.Map = {};
let nodeCenters: Record<string, [number, number, number]> = {};
let url: string;
let loadedNodes: Set<string> = new Set(); // Track loaded nodes
let nodeAccessTimes: Map<string, number> = new Map(); // Track when nodes were last accessed
let colorMode: 'rgb' | 'height' | 'intensity' | 'white' = 'rgb';
let maxCacheSize: number = 100;

function calcCubeCenter(
	cube: [number, number, number, number, number, number],
	node: string,
): [number, number, number] {
	const _node = node.split('-').map((n) => parseInt(n)); // 3-4-5-6
	const cubeSizeOfNode = [
		cube[3] - cube[0],
		cube[4] - cube[1],
		cube[5] - cube[2],
	].map((size) => size / Math.pow(2, _node[0]));

	// cube origin + cube size * node + cube size / 2
	const nodeCenter = [
		cube[0] + cubeSizeOfNode[0] * _node[1] + cubeSizeOfNode[0] / 2,
		cube[1] + cubeSizeOfNode[1] * _node[2] + cubeSizeOfNode[1] / 2,
		cube[2] + cubeSizeOfNode[2] * _node[3] + cubeSizeOfNode[2] / 2,
	];
	return nodeCenter as [number, number, number];
}

// Helper function to get point data
function getPoint(
	getters: ((index: number) => number)[],
	index: number,
): number[] {
	return getters.map((get) => get(index));
}

// Helper function to manage cache size
function manageCache() {
	if (loadedNodes.size <= maxCacheSize) return;

	// Convert to array for sorting
	const entries = Array.from(nodeAccessTimes.entries());

	// Sort by access time (oldest first)
	entries.sort((a, b) => a[1] - b[1]);

	// Remove oldest entries until we're under the limit
	const nodesToRemove = entries.slice(0, loadedNodes.size - maxCacheSize);

	for (const [node] of nodesToRemove) {
		loadedNodes.delete(node);
		nodeAccessTimes.delete(node);
	}

	// Log cache management
	console.log(
		`Cache cleaned: removed ${nodesToRemove.length} nodes, ${loadedNodes.size} remaining`,
	);
}

async function initCopc(url: string) {
	try {
		copc = await Copc.create(url);

		if (!copc || !copc.wkt) {
			self.postMessage({
				type: 'error',
				message: 'Failed to initialize COPC or WKT is missing',
			});
			return;
		}

		proj = proj4(copc.wkt);

		const { nodes: loadedNodes } = await Copc.loadHierarchyPage(
			url,
			copc.info.rootHierarchyPage,
		);

		nodes = loadedNodes;
		nodeCenters = Object.entries(nodes).reduce((curr, [k, _]) => {
			const center = calcCubeCenter(copc!.info.cube, k);
			return {
				...curr,
				[k]: center,
			};
		}, {});

		const rootCenter = nodeCenters['0-0-0-0'];
		const rootCenterLngLat = proj.inverse([rootCenter[0], rootCenter[1]]);
		self.postMessage({ type: 'initialized', center: rootCenterLngLat });
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error initializing COPC: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
	}
}

async function loadNode(node: string) {
	if (!copc) {
		self.postMessage({ type: 'error', message: 'COPC not initialized' });
		return;
	}

	try {
		// If node is already loaded, update access time
		if (loadedNodes.has(node)) {
			nodeAccessTimes.set(node, Date.now());
			self.postMessage({
				type: 'nodeLoaded',
				node,
				alreadyLoaded: true,
			});
		} else {
			const targetNode = nodes[node];
			if (!targetNode) {
				self.postMessage({ type: 'error', message: `Node ${node} not found` });
				return;
			}

			const positions: Float32Array = new Float32Array(
				targetNode.pointCount * 3,
			);
			const colors: Float32Array = new Float32Array(targetNode.pointCount * 3);

			const view = await Copc.loadPointDataView(url, copc, nodes[node]!);

			const hasRgb =
				view.dimensions['Red'] &&
				view.dimensions['Green'] &&
				view.dimensions['Blue'];
			const hasIntensity = view.dimensions['Intensity'];

			for (let i = 0; i < targetNode.pointCount; i++) {
				const xyzGetters = ['X', 'Y', 'Z'].map(view.getter);
				const point = getPoint(xyzGetters, i);
				const [lon, lat] = proj.inverse([point[0], point[1]]);
				const merc = MercatorCoordinate.fromLngLat(
					{ lng: lon, lat: lat },
					point[2],
				);

				positions[i * 3] = merc.x;
				positions[i * 3 + 1] = merc.y;
				positions[i * 3 + 2] = merc.z;

				if (colorMode === 'rgb' && hasRgb) {
					const colorGetters = ['Red', 'Green', 'Blue'].map(view.getter);
					// Use RGB values if available and requested
					const rgb = getPoint(colorGetters, i);
					colors[i * 3] = rgb[0] / 65535;
					colors[i * 3 + 1] = rgb[1] / 65535;
					colors[i * 3 + 2] = rgb[2] / 65535;
				} else if (colorMode === 'height') {
					// Color by height (Z value)
					// Normalize height to a reasonable range (0-1)
					const normalizedHeight =
						(point[2] - copc.info.cube[2]) /
						(copc.info.cube[5] - copc.info.cube[2]);

					// Use a height-based color gradient (blue to red)
					colors[i * 3] = Math.min(1, Math.max(0, normalizedHeight * 2)); // Red
					colors[i * 3 + 1] = Math.min(
						1,
						Math.max(
							0,
							normalizedHeight > 0.5
								? 2 - normalizedHeight * 2
								: normalizedHeight * 2,
						),
					); // Green
					colors[i * 3 + 2] = Math.min(
						1,
						Math.max(0, 1 - normalizedHeight * 2),
					); // Blue
				} else if (colorMode === 'intensity' && hasIntensity) {
					const intensityGetter = view.getter('Intensity');
					// Color by intensity if available
					const intensity = intensityGetter(i) / 65535; // Normalize to 0-1
					colors[i * 3] = intensity;
					colors[i * 3 + 1] = intensity;
					colors[i * 3 + 2] = intensity;
				} else {
					// Default to white
					colors[i * 3] = 1;
					colors[i * 3 + 1] = 1;
					colors[i * 3 + 2] = 1;
				}
			}

			// Add to loaded nodes set
			loadedNodes.add(node);
			nodeAccessTimes.set(node, Date.now());

			// Manage cache to ensure we don't exceed maximum cache size
			manageCache();

			// Send the node data to the main thread
			self.postMessage({
				type: 'nodeLoaded',
				node,
				positions: positions.buffer,
				colors: colors.buffer,
			});
		}
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error loading node ${node}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
	}
}

// FIXME: better debounce
let count = 0;
function updatePoints(
	cameraPosition: [number, number, number],
	mapHeight: number,
	fov: number,
	sseThreshold: number,
) {
	if (count++ < 10) return;
	else count = 0;

	if (!copc) {
		self.postMessage({ type: 'error', message: 'COPC not initialized' });
		return;
	}

	try {
		const cameraVector = new THREE.Vector3(
			...proj!.forward([cameraPosition[0], cameraPosition[1]]),
			cameraPosition[2],
		);

		let sseTestedNodes: string[] = [];

		// Test all nodes against SSE threshold
		Object.entries(nodeCenters).forEach(([node, center]) => {
			const depth = parseInt(node.split('-')[0]);
			const nodeCenter = new THREE.Vector3(...center);

			// Use distance factor that decreases with depth
			// This makes higher depths (more detailed nodes) require the camera to be closer
			const distanceFactor = Math.max(0.5, 1.0 - depth * 0.1);

			const sse = computeScreenSpaceError(
				cameraVector,
				nodeCenter,
				fov,
				copc!.info.spacing * Math.pow(0.5, depth), // 1/1, 1/2, 1/4, 1/8, ...
				mapHeight,
				distanceFactor,
			);

			// If node passes SSE test, add it to nodesByDepth
			if (sse > sseThreshold) {
				sseTestedNodes.push(node);
			}
		});

		// If no nodes pass the SSE test, default to root node
		if (sseTestedNodes.length === 0) {
			self.postMessage({
				type: 'nodesToLoad',
				nodes: ['0-0-0-0'], // Default to root node if no nodes pass the SSE test
			});
			return;
		}

		self.postMessage({
			type: 'nodesToLoad',
			nodes: sseTestedNodes,
		});
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error updating points: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
	}
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;

	try {
		switch (message.type) {
			case 'init':
				url = message.url;
				// Set options if provided
				if (message.options) {
					colorMode = message.options.colorMode || 'rgb';
					maxCacheSize = message.options.maxCacheSize || 100;
				}
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
			default:
				self.postMessage({
					type: 'error',
					message: `Unknown message type: ${(message as any).type}`,
				});
		}
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error processing message: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
	}
};
