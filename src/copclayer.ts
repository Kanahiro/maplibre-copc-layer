import {
	CustomLayerInterface,
	CustomRenderMethodInput,
	Map as MapLibre,
} from 'maplibre-gl';
import * as THREE from 'three';
import { CacheManager, CachedNodeData, CacheStats } from './cache-manager';

/**
 * Color modes available for point cloud rendering
 */
export type ColorMode = 'rgb' | 'height' | 'intensity' | 'white';

/**
 * Configuration options for the CopcLayer
 */
export interface CopcLayerOptions {
	/** Size of points in pixels (default: 6) */
	pointSize?: number;
	/** Color mode for rendering points (default: 'rgb') */
	colorMode?: ColorMode;
	/** Maximum number of nodes to keep in cache (default: 100) */
	maxCacheSize?: number;
	/** Screen space error threshold for level-of-detail (default: 8) */
	sseThreshold?: number;
	/** Whether to enable depth testing (default: true) */
	depthTest?: boolean;
	/** Maximum cache memory usage in bytes (default: 100MB) */
	maxCacheMemory?: number;
	/** Enable cache logging for debugging (default: false) */
	enableCacheLogging?: boolean;
}

/**
 * Default configuration values
 */
const DEFAULT_OPTIONS: Required<CopcLayerOptions> = {
	pointSize: 6,
	colorMode: 'rgb',
	maxCacheSize: 100,
	sseThreshold: 8,
	depthTest: true,
	maxCacheMemory: 100 * 1024 * 1024, // 100MB
	enableCacheLogging: false,
} as const;

/**
 * Extended node statistics including cache performance
 */
export interface NodeStats {
	/** Number of nodes currently loaded and ready for rendering */
	loaded: number;
	/** Number of nodes currently visible based on LOD */
	visible: number;
	/** Number of nodes cached for reuse */
	cached: number;
	/** Cache hit ratio (0-1) */
	cacheHitRatio: number;
	/** Cache memory usage in bytes */
	cacheMemoryUsage: number;
	/** Number of pending worker requests */
	pendingRequests: number;
}

/**
 * A custom MapLibre layer for rendering Cloud-Optimized Point Cloud (COPC) data using Three.js
 *
 * Features advanced caching system on main thread to minimize worker communication:
 * - LRU-based cache management
 * - Memory usage monitoring
 * - Cache hit/miss analytics
 * - Optimized Three.js object reuse
 * - Efficient SSE-based level-of-detail
 *
 * @example
 * ```typescript
 * import { CopcLayer } from 'maplibre-copc-layer';
 *
 * const layer = new CopcLayer('https://example.com/data.copc.laz', {
 *   pointSize: 8,
 *   colorMode: 'height',
 *   sseThreshold: 4,
 *   maxCacheSize: 200,
 *   maxCacheMemory: 200 * 1024 * 1024 // 200MB
 * });
 *
 * map.addLayer(layer);
 * ```
 */
export class CopcLayer implements CustomLayerInterface {
	/** Layer identifier */
	readonly id: string;
	/** Layer type - always 'custom' */
	readonly type: 'custom' = 'custom';
	/** Rendering mode - always '3d' */
	readonly renderingMode: '3d' = '3d';
	/** URL to the COPC file */
	readonly url: string;

	/** Reference to the MapLibre map instance */
	public map?: MapLibre;
	/** Three.js camera */
	public readonly camera: THREE.Camera;
	/** Three.js scene */
	public readonly scene: THREE.Scene;
	/** Three.js renderer */
	public renderer?: THREE.WebGLRenderer;
	/** Web worker for processing COPC data */
	public readonly worker: Worker;
	/** Cache manager for efficient data reuse */
	public readonly cacheManager: CacheManager;

	/** Current configuration options */
	private readonly options: Required<CopcLayerOptions>;
	/** Current SSE threshold */
	private sseThreshold: number;
	/** List of currently visible node IDs */
	private visibleNodes: string[] = [];
	/** Whether the worker has been initialized */
	private workerInitialized: boolean = false;
	/** Set of nodes currently being requested from worker */
	private pendingRequests: Set<string> = new Set();
	/** Request queue to track load order */
	private requestQueue: string[] = [];

	/**
	 * Creates a new CopcLayer instance
	 *
	 * @param url - URL to the COPC file to load
	 * @param options - Configuration options for the layer
	 * @param layerId - Optional custom layer ID (default: 'copc-layer')
	 */
	constructor(
		url: string,
		options: CopcLayerOptions = {},
		layerId: string = 'copc-layer',
	) {
		if (!url || typeof url !== 'string') {
			throw new Error('COPC URL is required and must be a string');
		}

		this.id = layerId;
		this.url = url;

		// Merge options with defaults
		this.options = {
			...DEFAULT_OPTIONS,
			...options,
		};
		this.sseThreshold = this.options.sseThreshold;

		// Initialize cache manager
		this.cacheManager = new CacheManager({
			maxNodes: this.options.maxCacheSize,
			maxMemoryBytes: this.options.maxCacheMemory,
			enableLogging: this.options.enableCacheLogging,
		});

		this.camera = new THREE.Camera();
		this.scene = new THREE.Scene();

		// Initialize the worker
		try {
			this.worker = new Worker(new URL('./worker/index.ts', import.meta.url), {
				type: 'module',
			});
			this.setupWorkerMessageHandlers();
		} catch (error) {
			throw new Error(
				`Failed to initialize worker: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	/**
	 * Setup worker message handling for cache-optimized data loading
	 */
	private setupWorkerMessageHandlers() {
		this.worker.onmessage = (event) => {
			const message = event.data;

			switch (message.type) {
				case 'initialized':
					// Worker has initialized COPC data
					this.workerInitialized = true;
					this.requestNodeData('0-0-0-0'); // Request root node
					this.map?.panTo(message.center);
					break;

				case 'nodeLoaded':
					// Node data loaded from worker
					this.handleNodeLoaded(
						message.node,
						message.positions,
						message.colors,
					);
					break;

				case 'nodesToLoad':
					// Update visible nodes and request missing data
					this.visibleNodes = message.nodes;
					this.updateVisibleNodes();
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

	/**
	 * Handle node data received from worker and update cache
	 */
	private handleNodeLoaded(
		nodeId: string,
		positionsBuffer: ArrayBuffer,
		colorsBuffer: ArrayBuffer,
	): void {
		// Remove from pending requests
		this.pendingRequests.delete(nodeId);
		this.removeFromRequestQueue(nodeId);

		// Convert to typed arrays
		const positions = new Float32Array(positionsBuffer);
		const colors = new Float32Array(colorsBuffer);

		// Create material configuration for caching
		const materialConfig = {
			colorMode: this.options.colorMode,
			pointSize: this.options.pointSize,
			depthTest: this.options.depthTest,
		};

		// Create cached node data
		const nodeData = CacheManager.createNodeData(
			nodeId,
			positions,
			colors,
			materialConfig,
		);

		// Create Three.js geometry and points object
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

		const material = this.createPointMaterial();
		const points = new THREE.Points(geometry, material);

		// Store Three.js objects in cache
		nodeData.geometry = geometry;
		nodeData.points = points;

		// Add to cache
		this.cacheManager.set(nodeData);

		// Log cache performance for debugging
		if (this.options.enableCacheLogging) {
			const stats = this.cacheManager.getStats();
			console.log(
				`Node ${nodeId} cached. Hit ratio: ${(stats.hitRatio * 100).toFixed(1)}%, Memory: ${this.formatBytes(stats.memoryUsage)}`,
			);
		}
	}

	/**
	 * Update the scene with visible nodes, using cache when possible
	 */
	private updateVisibleNodes(): void {
		// Clear scene
		this.scene.children.forEach((child) => this.scene.remove(child));

		// Track which nodes need to be requested
		const nodesToRequest: string[] = [];

		for (const nodeId of this.visibleNodes) {
			const cachedData = this.cacheManager.get(nodeId);

			if (cachedData && cachedData.points) {
				// Cache hit - add to scene immediately
				this.scene.add(cachedData.points);

				// Update material if configuration changed
				if (this.needsMaterialUpdate(cachedData)) {
					this.updateNodeMaterial(cachedData);
				}
			} else if (!this.pendingRequests.has(nodeId)) {
				// Cache miss - need to request from worker
				nodesToRequest.push(nodeId);
			}
		}

		// Request missing nodes from worker
		nodesToRequest.forEach((nodeId) => {
			this.requestNodeData(nodeId);
		});
	}

	/**
	 * Request node data from worker with queue management
	 */
	private requestNodeData(nodeId: string): void {
		if (this.pendingRequests.has(nodeId)) {
			return; // Already requested
		}

		this.pendingRequests.add(nodeId);
		this.requestQueue.push(nodeId);

		this.worker.postMessage({
			type: 'loadNode',
			node: nodeId,
		});
	}

	/**
	 * Check if node material needs updating due to configuration changes
	 */
	private needsMaterialUpdate(nodeData: CachedNodeData): boolean {
		const current = nodeData.materialConfig;
		return (
			current.colorMode !== this.options.colorMode ||
			current.pointSize !== this.options.pointSize ||
			current.depthTest !== this.options.depthTest
		);
	}

	/**
	 * Update node material with current configuration
	 */
	private updateNodeMaterial(nodeData: CachedNodeData): void {
		if (!nodeData.points) return;

		// Dispose old material
		if (nodeData.points.material instanceof THREE.Material) {
			nodeData.points.material.dispose();
		}

		// Create new material with current settings
		nodeData.points.material = this.createPointMaterial();

		// Update cached configuration
		nodeData.materialConfig = {
			colorMode: this.options.colorMode,
			pointSize: this.options.pointSize,
			depthTest: this.options.depthTest,
		};
	}

	/**
	 * Remove node from request queue
	 */
	private removeFromRequestQueue(nodeId: string): void {
		const index = this.requestQueue.indexOf(nodeId);
		if (index > -1) {
			this.requestQueue.splice(index, 1);
		}
	}

	/**
	 * Called when the layer is added to the map
	 */
	async onAdd(map: MapLibre, gl: WebGLRenderingContext): Promise<void> {
		this.map = map;

		try {
			// Initialize the worker with the COPC URL and options
			this.worker.postMessage({
				type: 'init',
				url: this.url,
				options: {
					colorMode: this.options.colorMode,
					maxCacheSize: this.options.maxCacheSize,
				},
			});

			// Setup renderer
			this.renderer = new THREE.WebGLRenderer({
				canvas: map.getCanvas(),
				context: gl,
			});
			this.renderer.autoClear = false;
		} catch (error) {
			console.error('Failed to initialize CopcLayer:', error);
			throw error;
		}
	}

	/**
	 * Update cache configuration and apply to existing nodes
	 */
	public updateCacheConfig(config: Partial<CopcLayerOptions>): void {
		// Update layer options
		Object.assign(this.options, config);

		// Update cache manager settings
		this.cacheManager.updateOptions({
			maxNodes: this.options.maxCacheSize,
			maxMemoryBytes: this.options.maxCacheMemory,
			enableLogging: this.options.enableCacheLogging,
		});

		// Refresh visible nodes to apply new settings
		this.updateVisibleNodes();
	}

	/**
	 * Set point size and update cached materials
	 */
	public setPointSize(size: number): void {
		if (typeof size !== 'number' || size <= 0 || !Number.isFinite(size)) {
			throw new Error('Point size must be a positive finite number');
		}

		this.options.pointSize = size;

		// Update all cached nodes
		for (const nodeId of this.cacheManager.getCachedNodeIds()) {
			const nodeData = this.cacheManager.get(nodeId);
			if (nodeData) {
				this.updateNodeMaterial(nodeData);
			}
		}

		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	/**
	 * Set SSE threshold for level-of-detail control
	 */
	public setSseThreshold(threshold: number): void {
		if (
			typeof threshold !== 'number' ||
			threshold <= 0 ||
			!Number.isFinite(threshold)
		) {
			throw new Error('SSE threshold must be a positive finite number');
		}

		this.sseThreshold = threshold;
		this.options.sseThreshold = threshold;
		this.updatePoints();

		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	/**
	 * Toggle depth testing and update cached materials
	 */
	public toggleDepthTest(enabled: boolean): void {
		if (typeof enabled !== 'boolean') {
			throw new Error('Depth test flag must be a boolean');
		}

		this.options.depthTest = enabled;

		// Update all cached nodes
		for (const nodeId of this.cacheManager.getCachedNodeIds()) {
			const nodeData = this.cacheManager.get(nodeId);
			if (nodeData) {
				this.updateNodeMaterial(nodeData);
			}
		}

		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	/**
	 * Update visible points based on camera position
	 */
	private updatePoints(): void {
		if (!this.map || !this.workerInitialized) {
			return;
		}

		try {
			const cameraLngLat = this.map.transform.getCameraLngLat().toArray();
			const cameraAltitude = this.map.transform.getCameraAltitude();

			this.worker.postMessage({
				type: 'updatePoints',
				cameraPosition: [...cameraLngLat, cameraAltitude],
				mapHeight: this.map.transform.height,
				fov: this.map.transform.fov,
				sseThreshold: this.sseThreshold,
			});
		} catch (error) {
			console.error('Error updating points:', error);
		}
	}

	/**
	 * Render the scene
	 */
	render(_: WebGLRenderingContext, options: CustomRenderMethodInput) {
		if (!this.map || !this.renderer) return;

		// Update camera projection matrix
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

	/**
	 * Clean up resources when layer is removed
	 */
	onRemove(_map: MapLibre, _gl: WebGLRenderingContext): void {
		try {
			// Terminate worker
			this.worker.terminate();

			// Clear cache (disposes Three.js resources)
			this.cacheManager.clear();

			// Clear collections
			this.visibleNodes.length = 0;
			this.pendingRequests.clear();
			this.requestQueue.length = 0;
		} catch (error) {
			console.error('Error during layer cleanup:', error);
		}
	}

	/**
	 * Create Three.js material for point rendering
	 */
	private createPointMaterial(): THREE.PointsMaterial {
		const material = new THREE.PointsMaterial({
			vertexColors: this.options.colorMode !== 'white',
			size: this.options.pointSize,
			depthTest: this.options.depthTest,
			depthWrite: this.options.depthTest,
			sizeAttenuation: true,
		});

		if (this.options.colorMode === 'white') {
			material.color.setHex(0xffffff);
		}

		return material;
	}

	/**
	 * Format bytes for human-readable display
	 */
	private formatBytes(bytes: number): string {
		const sizes = ['B', 'KB', 'MB', 'GB'];
		if (bytes === 0) return '0 B';
		const i = Math.floor(Math.log(bytes) / Math.log(1024));
		return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
	}

	// Public API methods

	public getPointSize(): number {
		return this.options.pointSize;
	}

	public getColorMode(): ColorMode {
		return this.options.colorMode;
	}

	public getSseThreshold(): number {
		return this.sseThreshold;
	}

	public isDepthTestEnabled(): boolean {
		return this.options.depthTest;
	}

	public getOptions(): Readonly<CopcLayerOptions> {
		return { ...this.options };
	}

	public isLoading(): boolean {
		return this.pendingRequests.size > 0 || !this.workerInitialized;
	}

	/**
	 * Get comprehensive node statistics including cache performance
	 */
	public getNodeStats(): NodeStats {
		const cacheStats = this.cacheManager.getStats();
		
		return {
			loaded: cacheStats.size,
			visible: this.visibleNodes.length,
			cached: cacheStats.size,
			cacheHitRatio: cacheStats.hitRatio,
			cacheMemoryUsage: cacheStats.memoryUsage,
			pendingRequests: this.pendingRequests.size,
		};
	}

	/**
	 * Get detailed cache performance statistics
	 */
	public getCacheStats(): Readonly<CacheStats> {
		return this.cacheManager.getStats();
	}

	/**
	 * Clear the cache manually (useful for debugging or memory management)
	 */
	public clearCache(): void {
		this.cacheManager.clear();
		this.updateVisibleNodes(); // Refresh scene
	}
}