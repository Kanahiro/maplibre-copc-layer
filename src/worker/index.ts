import * as THREE from 'three';
import { Copc, Hierarchy } from 'copc';
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

interface CancelRequestsMessage {
	type: 'cancelRequests';
	nodes: string[];
}

type WorkerMessage = InitMessage | LoadNodeMessage | UpdatePointsMessage | CancelRequestsMessage;

let copc: Copc | null = null;
let proj: Converter;
let nodes: Hierarchy.Node.Map = {};
let nodeCenters: Record<string, [number, number, number]> = {};
let url: string;
let colorMode: 'rgb' | 'height' | 'intensity' | 'white' = 'rgb';
let cancelledRequests: Set<string> = new Set();

/**
 * Calculate the center point of a cube at a specific node location
 */
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

/**
 * Helper function to get point data by index
 */
function getPoint(
	getters: ((index: number) => number)[],
	index: number,
): number[] {
	return getters.map((get) => get(index));
}

/**
 * Initialize COPC file and build node hierarchy
 */
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
		
		self.postMessage({ 
			type: 'initialized', 
			center: rootCenterLngLat,
			nodeCount: Object.keys(nodes).length
		});
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error initializing COPC: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
	}
}

/**
 * Load point data for a specific node (no caching - handled by main thread)
 */
async function loadNode(node: string) {
	if (!copc) {
		self.postMessage({ type: 'error', message: 'COPC not initialized' });
		return;
	}

	// Check if this request has been cancelled
	if (cancelledRequests.has(node)) {
		cancelledRequests.delete(node);
		return; // Silently skip cancelled requests
	}

	try {
		const targetNode = nodes[node];
		if (!targetNode) {
			self.postMessage({ type: 'error', message: `Node ${node} not found` });
			return;
		}

		// Load point data from COPC file
		const view = await Copc.loadPointDataView(url, copc, targetNode);

		// Check if cancelled during loading
		if (cancelledRequests.has(node)) {
			cancelledRequests.delete(node);
			return; // Silently skip cancelled requests
		}

		// Prepare position and color buffers
		// Use Float64Array for positions to maintain double precision
		const positions = new Float64Array(targetNode.pointCount * 3);
		const colors = new Float32Array(targetNode.pointCount * 3);

		// Check available data dimensions
		const hasRgb = 
			view.dimensions['Red'] && 
			view.dimensions['Green'] && 
			view.dimensions['Blue'];
		const hasIntensity = view.dimensions['Intensity'];

		// Process each point
		// Pre-calculate constants for high-precision transformation
		const EARTH_RADIUS = 6378137.0; // WGS84 semi-major axis in meters
		const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;
		const PI_180 = Math.PI / 180.0;
		
		for (let i = 0; i < targetNode.pointCount; i++) {
			// Get XYZ coordinates
			const xyzGetters = ['X', 'Y', 'Z'].map(view.getter);
			const point = getPoint(xyzGetters, i);
			
			// High-precision two-step transformation
			const [lon, lat] = proj.inverse([point[0], point[1]]);
			
			// Convert to radians for higher precision
			const lonRad = lon * PI_180;
			const latRad = lat * PI_180;
			
			// High-precision Web Mercator transformation
			// x = R * λ (longitude in radians)
			const mercX = 0.5 + lonRad / (2 * Math.PI);
			
			// y = R * ln(tan(π/4 + φ/2)) using more stable formula
			// In MapLibre coordinates: Y=0 is north, Y=1 is south
			// So we need to invert the standard mercator Y coordinate
			const sinLat = Math.sin(latRad);
			const k = (1 + sinLat) / (1 - sinLat);
			const mercY = 0.5 - Math.log(k) / (4 * Math.PI);
			
			// Z coordinate: convert altitude to normalized mercator units
			const mercZ = point[2] / EARTH_CIRCUMFERENCE;

			// Store position with offset applied later for additional precision
			positions[i * 3] = mercX;
			positions[i * 3 + 1] = mercY;
			positions[i * 3 + 2] = mercZ;

			// Process color based on color mode
			switch (colorMode) {
				case 'rgb':
					if (hasRgb) {
						const colorGetters = ['Red', 'Green', 'Blue'].map(view.getter);
						const rgb = getPoint(colorGetters, i);
						colors[i * 3] = rgb[0] / 65535;
						colors[i * 3 + 1] = rgb[1] / 65535;
						colors[i * 3 + 2] = rgb[2] / 65535;
					} else {
						// Default to white if RGB not available
						colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1;
					}
					break;

				case 'height':
					// Color by height (Z value) with blue-to-red gradient
					const normalizedHeight =
						(point[2] - copc.info.cube[2]) /
						(copc.info.cube[5] - copc.info.cube[2]);

					colors[i * 3] = Math.min(1, Math.max(0, normalizedHeight * 2)); // Red
					colors[i * 3 + 1] = Math.min(1, Math.max(0, 
						normalizedHeight > 0.5 
							? 2 - normalizedHeight * 2 
							: normalizedHeight * 2
					)); // Green
					colors[i * 3 + 2] = Math.min(1, Math.max(0, 1 - normalizedHeight * 2)); // Blue
					break;

				case 'intensity':
					if (hasIntensity) {
						const intensityGetter = view.getter('Intensity');
						const intensity = intensityGetter(i) / 65535; // Normalize to 0-1
						colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = intensity;
					} else {
						// Default to white if intensity not available
						colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1;
					}
					break;

				case 'white':
				default:
					// White points
					colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1;
					break;
			}
		}

		// Send data to main thread for caching
		self.postMessage({
			type: 'nodeLoaded',
			node,
			positions: positions.buffer,
			colors: colors.buffer,
			pointCount: targetNode.pointCount,
		}, { transfer: [positions.buffer, colors.buffer] }); // Transfer ownership for performance

	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error loading node ${node}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
	}
}

/**
 * Update visible points based on camera position using SSE calculations
 * Uses simple debouncing to reduce computation overhead
 */
let updateCount = 0;
function updatePoints(
	cameraPosition: [number, number, number],
	mapHeight: number,
	fov: number,
	sseThreshold: number,
) {
	// Simple debouncing - update every 10 calls
	if (updateCount++ < 10) return;
	updateCount = 0;

	if (!copc) {
		self.postMessage({ type: 'error', message: 'COPC not initialized' });
		return;
	}

	try {
		const cameraVector = new THREE.Vector3(
			...proj!.forward([cameraPosition[0], cameraPosition[1]]),
			cameraPosition[2],
		);

		const visibleNodes: string[] = [];

		// Test all nodes against SSE threshold
		Object.entries(nodeCenters).forEach(([nodeId, center]) => {
			const depth = parseInt(nodeId.split('-')[0]);
			const nodeCenter = new THREE.Vector3(...center);

			// Apply distance factor that decreases with depth
			// This prioritizes loading higher detail nodes when camera is closer
			const distanceFactor = Math.max(0.5, 1.0 - depth * 0.1);

			const sse = computeScreenSpaceError(
				cameraVector,
				nodeCenter,
				fov,
				copc!.info.spacing * Math.pow(0.5, depth), // Geometric error decreases with depth
				mapHeight,
				distanceFactor,
			);

			// If node passes SSE test, mark as visible
			if (sse > sseThreshold) {
				visibleNodes.push(nodeId);
			}
		});

		// Fallback to root node if no nodes pass SSE test
		if (visibleNodes.length === 0) {
			visibleNodes.push('0-0-0-0');
		}

		// Send visible nodes to main thread for cache-aware loading
		self.postMessage({
			type: 'nodesToLoad',
			nodes: visibleNodes,
			cameraPosition,
			sseThreshold,
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

/**
 * Handle worker messages
 */
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;

	try {
		switch (message.type) {
			case 'init':
				url = message.url;
				// Set options if provided
				if (message.options) {
					colorMode = message.options.colorMode || 'rgb';
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

			case 'cancelRequests':
				// Mark all specified nodes as cancelled
				message.nodes.forEach(nodeId => {
					cancelledRequests.add(nodeId);
				});
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