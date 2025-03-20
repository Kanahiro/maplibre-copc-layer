import {
	CustomLayerInterface,
	CustomRenderMethodInput,
	Map as MapLibre,
} from 'maplibre-gl';
import * as THREE from 'three';

// Configuration options for the ThreeLayer
export interface ThreeLayerOptions {
	pointSize?: number;
	pointSizeAttenuation?: boolean;
	colorMode?: 'rgb' | 'height' | 'intensity' | 'white';
	maxCacheSize?: number; // Maximum number of nodes to keep in cache
	sseThreshold?: number;
	depthTest?: boolean; // Whether to enable depth testing
}

export class ThreeLayer implements CustomLayerInterface {
	id: string;
	type: 'custom';
	renderingMode: '3d';
	url: string;
	map?: MapLibre;
	camera: THREE.Camera;
	scene: THREE.Scene;
	renderer?: THREE.WebGLRenderer;
	worker: Worker;
	pointsMap: Record<string, THREE.Points> = {};
	pointSize: number;
	pointSizeAttenuation: boolean;
	depthTest: boolean;
	options: ThreeLayerOptions;

	private sseThreshold: number;
	private visibleNodes: string[] = [];
	private pointCache: Map<string, THREE.Points> = new Map(); // Cache for removed points
	private maxCacheSize: number = 100; // Maximum number of nodes to keep in cache
	private workerInitialized: boolean = false;

	constructor(url: string, options: ThreeLayerOptions = {}) {
		this.id = 'three_layer';
		this.type = 'custom';
		this.renderingMode = '3d';
		this.url = url;
		this.options = options;

		// Set default options
		this.pointSize = options.pointSize ?? 6;
		this.sseThreshold = options.sseThreshold ?? 8;
		this.pointSizeAttenuation =
			options.pointSizeAttenuation !== undefined
				? options.pointSizeAttenuation
				: false;
		this.maxCacheSize = options.maxCacheSize ?? 100;
		this.depthTest = options.depthTest ?? true;

		this.camera = new THREE.Camera();
		this.scene = new THREE.Scene();

		// Initialize the worker
		this.worker = new Worker(new URL('./worker/index.ts', import.meta.url), {
			type: 'module',
		});
		this.setupWorkerMessageHandlers();
	}

	private setupWorkerMessageHandlers() {
		this.worker.onmessage = (event) => {
			const message = event.data;

			switch (message.type) {
				case 'initialized':
					// Worker has initialized COPC data
					this.workerInitialized = true;
					this.worker.postMessage({ type: 'loadNode', node: '0-0-0-0' });
					this.map?.panTo(message.center);
					break;
				case 'nodeLoaded':
					// Node data loaded, create THREE.Points and add to scene if needed
					if (!message.alreadyLoaded) {
						// Create new points from the data
						this.createPoints(message.node, message.positions, message.colors);
					}
					this.updateScene();
					break;
				case 'nodesToLoad':
					// Update scene with the new maximum depth
					this.visibleNodes = message.nodes;
					this.updateScene();

					// Load one node at a time to avoid overwhelming the worker
					this.visibleNodes.forEach((node) => {
						this.worker.postMessage({
							type: 'loadNode',
							node,
						});
					});

					break;
				case 'error':
					console.error('Worker error:', message.message);
					break;
			}

			if (this.map) {
				this.map.triggerRepaint();
			}
		};

		this.worker.onerror = (error) => {
			console.error('Worker error event:', error);
		};
	}

	private updateScene() {
		// Prune cache if necessary
		this.pruneCache();

		// Remove ALL points from the scene
		this.scene.children.forEach((c) => this.scene.remove(c));

		// re-add
		this.visibleNodes.forEach((n) => {
			if (this.pointsMap[n]) this.scene.add(this.pointsMap[n]);
		});
	}

	private createPoints(
		node: string,
		positionsBuffer: ArrayBuffer,
		colorsBuffer: ArrayBuffer,
	) {
		const positions = new Float32Array(positionsBuffer);
		const colors = new Float32Array(colorsBuffer);

		// Create geometry and add attributes
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

		// Create material with appropriate settings
		const material = this.createPointMaterial();

		// Create the points object and add to pointsMap
		this.pointsMap[node] = new THREE.Points(geometry, material);
	}

	async onAdd(map: MapLibre, gl: WebGLRenderingContext) {
		this.map = map;

		// Initialize the worker with the COPC URL and options
		this.worker.postMessage({
			type: 'init',
			url: this.url,
			options: {
				colorMode: this.options.colorMode || 'rgb',
				maxCacheSize: this.options.maxCacheSize || 100,
			},
		});

		// Setup renderer
		this.renderer = new THREE.WebGLRenderer({
			canvas: map.getCanvas(),
			context: gl,
		});
		this.renderer.autoClear = false;
	}

	// Method to adjust point size dynamically
	public setPointSize(size: number) {
		this.pointSize = size;

		// Update all existing points
		Object.values(this.pointsMap).forEach((points) => {
			if (points.material instanceof THREE.PointsMaterial) {
				points.material.size = size;
				points.material.needsUpdate = true;
			}
		});

		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	public setSseThreshold(threshold: number) {
		this.sseThreshold = threshold;

		this.updatePoints();

		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	// Method to toggle size attenuation
	public toggleSizeAttenuation(enabled: boolean) {
		this.pointSizeAttenuation = enabled;

		// Update all existing points
		Object.values(this.pointsMap).forEach((points) => {
			if (points.material instanceof THREE.PointsMaterial) {
				points.material.sizeAttenuation = enabled;
				points.material.needsUpdate = true;
			}
		});

		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	public toggleDepthTest(enabled: boolean) {
		this.depthTest = enabled;

		// Update all existing points
		Object.values(this.pointsMap).forEach((points) => {
			if (points.material instanceof THREE.PointsMaterial) {
				points.material.depthTest = enabled;
				points.material.depthWrite = enabled;
				points.material.needsUpdate = true;
			}
		});

		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	private updatePoints() {
		if (!this.map || !this.workerInitialized) return;

		// Get camera position in world coordinates
		const cameraLngLat = this.map.transform.getCameraLngLat().toArray();
		const cameraAltitude = this.map.transform.getCameraAltitude();

		// Send camera information to worker to determine which nodes to load
		this.worker.postMessage({
			type: 'updatePoints',
			cameraPosition: [...cameraLngLat, cameraAltitude],
			mapHeight: this.map.transform.height,
			fov: this.map.transform.fov,
			sseThreshold: this.sseThreshold,
		});
	}

	render(_: WebGLRenderingContext, options: CustomRenderMethodInput) {
		if (!this.map || !this.renderer) return;

		// Update camera projection matrix from map transform
		const m = new THREE.Matrix4().fromArray(
			options.defaultProjectionData.mainMatrix,
		);
		this.camera.projectionMatrix = m;

		// Update scene based on camera position
		this.updatePoints();

		// Render the scene
		this.renderer.resetState();
		this.renderer.render(this.scene, this.camera);

		this.map.triggerRepaint();
	}

	// Clean up resources when layer is removed
	onRemove(_: MapLibre, __: WebGLRenderingContext) {
		// Terminate the worker
		this.worker.terminate();

		// Remove all points from the scene
		Object.keys(this.pointsMap).forEach((node) => {
			this.scene.remove(this.pointsMap[node]);

			// Dispose of geometry and material
			const points = this.pointsMap[node];
			if (points) {
				points.geometry.dispose();
				if (points.material instanceof THREE.Material) {
					points.material.dispose();
				}
			}
		});

		// Dispose of cached points
		this.pointCache.forEach((points) => {
			points.geometry.dispose();
			if (points.material instanceof THREE.Material) {
				points.material.dispose();
			}
		});

		// Clear maps and sets
		this.pointsMap = {};
		this.visibleNodes = [];
		this.pointCache.clear();
	}

	private pruneCache() {
		// If cache size is within limits, do nothing
		if (this.pointCache.size <= this.maxCacheSize) {
			return;
		}

		// Get all cached nodes
		const cachedNodes = Array.from(this.pointCache.keys());

		// Sort by depth (higher depth = more detailed = remove first)
		cachedNodes.sort((a, b) => {
			const depthA = parseInt(a.split('-')[0]);
			const depthB = parseInt(b.split('-')[0]);
			return depthB - depthA;
		});

		// Remove nodes until cache is within size limit
		while (this.pointCache.size > this.maxCacheSize && cachedNodes.length > 0) {
			const nodeToRemove = cachedNodes.shift()!;
			const points = this.pointCache.get(nodeToRemove)!;

			// Dispose of geometry and material
			points.geometry.dispose();
			if (points.material instanceof THREE.Material) {
				points.material.dispose();
			}

			// Remove from cache
			this.pointCache.delete(nodeToRemove);

			// Log for debugging
			console.log(
				`Removed from cache: ${nodeToRemove}, Cache size: ${this.pointCache.size}`,
			);
		}
	}

	private createPointMaterial(): THREE.Material {
		// Create base material
		const material = new THREE.PointsMaterial({
			vertexColors: this.options.colorMode !== 'white',
			size: this.pointSize,
			sizeAttenuation: this.pointSizeAttenuation,
			depthTest: this.depthTest,
			depthWrite: this.depthTest,
		});

		// If color mode is white, set the color directly
		if (this.options.colorMode === 'white') {
			material.color.set(0xffffff);
		}

		return material;
	}
}
