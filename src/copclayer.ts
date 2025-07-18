import maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { CacheManager, type CachedNodeData } from './cache-manager';
import pointsVertexShader from './shaders/points.vert.glsl?raw';
import pointsFragmentShader from './shaders/points.frag.glsl?raw';
import edlVertexShader from './shaders/edl.vert.glsl?raw';
import edlFragmentShader from './shaders/edl.frag.glsl?raw';

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
	/** Enable Eye-Dome Lighting effect (default: false) */
	enableEDL?: boolean;
	/** EDL strength (default: 0.4) */
	edlStrength?: number;
	/** EDL radius in pixels (default: 1.5) */
	edlRadius?: number;
	/** EDL opacity (default: 1.0) */
	edlOpacity?: number;
	/** Callback function called when COPC data is initialized */
	onInitialized?: (message: {
		nodeCount: number;
		center: [number, number];
	}) => void;
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
	enableEDL: false,
	edlStrength: 0.4,
	edlRadius: 1.5,
	edlOpacity: 1.0,
	onInitialized: () => {},
} as const;

/**
 * Node statistics
 */
export interface NodeStats {
	/** Number of nodes currently loaded and ready for rendering */
	loaded: number;
	/** Number of nodes currently visible based on LOD */
	visible: number;
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
export class CopcLayer implements maplibregl.CustomLayerInterface {
	/** Layer identifier */
	readonly id: string;
	/** Layer type - always 'custom' */
	readonly type: 'custom' = 'custom' as const;
	/** Rendering mode - always '3d' */
	readonly renderingMode: '3d' = '3d' as const;
	/** URL to the COPC file */
	readonly url: string;

	/** Reference to the MapLibre map instance */
	public map?: maplibregl.Map;
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
	/** Current camera position for request prioritization */
	private lastCameraPosition: [number, number, number] | null = null;
	/** Scene center for precision rendering */
	private sceneCenter: maplibregl.MercatorCoordinate | null = null;
	/** EDL render targets and materials */
	private colorTarget?: THREE.WebGLRenderTarget;
	private depthTarget?: THREE.WebGLRenderTarget;
	private edlMaterial?: THREE.ShaderMaterial;
	private edlQuadScene?: THREE.Scene;
	private edlQuadCamera?: THREE.OrthographicCamera;

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
					// Call the onInitialized callback if provided
					this.options.onInitialized?.(message);
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
					// Cancel all pending requests when camera moves
					this.cancelAllPendingRequests();
					// Update camera position for prioritization
					this.lastCameraPosition = message.cameraPosition;
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
		// Positions are Float64Array for high precision
		const positions = new Float64Array(positionsBuffer);
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

		// Apply relative-to-center transformation with high precision
		if (this.sceneCenter) {
			// Use double precision for the offset calculation
			const centerX = this.sceneCenter.x;
			const centerY = this.sceneCenter.y;
			const centerZ = this.sceneCenter.z;

			// Convert to Float32Array only after applying the offset
			// This preserves precision during the critical transformation step
			const relativePositions = new Float32Array(positions.length);
			for (let i = 0; i < positions.length; i += 3) {
				// Perform subtraction in double precision
				const relX = positions[i] - centerX;
				const relY = positions[i + 1] - centerY;
				const relZ = positions[i + 2] - centerZ;

				// Store as Float32 only after transformation
				relativePositions[i] = relX;
				relativePositions[i + 1] = relY;
				relativePositions[i + 2] = relZ;
			}
			geometry.setAttribute(
				'position',
				new THREE.BufferAttribute(relativePositions, 3),
			);
		} else {
			// Convert Float64Array to Float32Array for Three.js
			const float32Positions = new Float32Array(positions);
			geometry.setAttribute(
				'position',
				new THREE.BufferAttribute(float32Positions, 3),
			);
		}

		geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

		const material = this.createPointMaterial();
		const points = new THREE.Points(geometry, material);

		// Store Three.js objects in cache
		nodeData.geometry = geometry;
		nodeData.points = points;

		// Add to cache, protecting currently visible nodes from eviction
		const protectedNodes = new Set(this.visibleNodes);
		this.cacheManager.set(nodeData, protectedNodes);
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

		// Sort nodes by priority before requesting
		const prioritizedNodes = this.prioritizeNodeRequests(nodesToRequest);

		// Request missing nodes from worker in priority order
		prioritizedNodes.forEach((nodeId) => {
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
	 * Cancel all pending requests when camera moves
	 */
	private cancelAllPendingRequests(): void {
		if (this.pendingRequests.size === 0) {
			return;
		}

		// Send cancellation message to worker
		this.worker.postMessage({
			type: 'cancelRequests',
			nodes: Array.from(this.pendingRequests),
		});

		// Clear pending requests
		this.pendingRequests.clear();
		this.requestQueue.length = 0;

		if (this.options.enableCacheLogging) {
			console.log(
				'[CopcLayer] Cancelled all pending requests due to camera movement',
			);
		}
	}

	/**
	 * Prioritize node requests based on distance from camera and level of detail
	 */
	private prioritizeNodeRequests(nodeIds: string[]): string[] {
		if (!this.lastCameraPosition || nodeIds.length <= 1) {
			return nodeIds;
		}

		const [camLon, camLat] = this.lastCameraPosition;

		// Calculate priority for each node
		const nodesWithPriority = nodeIds.map((nodeId) => {
			const parts = nodeId.split('-').map(Number);
			const [depth, x, y] = parts;

			// Higher depth (more detailed) nodes get higher base priority
			const depthPriority = depth * 10;

			// Calculate approximate node center for distance calculation
			// This is a simplified calculation - in a real implementation
			// you might want to use the actual cube calculations from the worker
			const nodeSize = 1.0 / Math.pow(2, depth);
			const nodeCenterX = x * nodeSize + nodeSize / 2;
			const nodeCenterY = y * nodeSize + nodeSize / 2;

			// Simple distance calculation (not geographically accurate but good for prioritization)
			const dx = nodeCenterX - camLon;
			const dy = nodeCenterY - camLat;
			const distance = Math.sqrt(dx * dx + dy * dy);

			// Closer nodes get higher priority (lower distance = higher priority)
			const distancePriority = distance > 0 ? 1000 / distance : 1000;

			// Combine priorities (depth is more important than distance for LOD)
			const totalPriority = depthPriority + distancePriority * 0.1;

			return {
				nodeId,
				priority: totalPriority,
				depth,
				distance,
			};
		});

		// Sort by priority (highest first)
		nodesWithPriority.sort((a, b) => b.priority - a.priority);

		if (this.options.enableCacheLogging) {
			console.log(
				'[CopcLayer] Prioritized node requests:',
				nodesWithPriority
					.slice(0, 5)
					.map(
						(n) =>
							`${n.nodeId} (depth: ${n.depth}, dist: ${n.distance.toFixed(
								3,
							)}, priority: ${n.priority.toFixed(1)})`,
					),
			);
		}

		return nodesWithPriority.map((n) => n.nodeId);
	}

	/**
	 * Called when the layer is added to the map
	 */
	async onAdd(map: maplibregl.Map, gl: WebGLRenderingContext): Promise<void> {
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
			this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
			this.renderer.autoClear = false;

			// Setup EDL if enabled
			if (this.options.enableEDL) {
				this.setupEDL();
			}
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

		// Update cache manager settings, protecting currently visible nodes
		const protectedNodes = new Set(this.visibleNodes);
		this.cacheManager.updateOptions(
			{
				maxNodes: this.options.maxCacheSize,
				maxMemoryBytes: this.options.maxCacheMemory,
				enableLogging: this.options.enableCacheLogging,
			},
			protectedNodes,
		);

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
	render(
		_: WebGLRenderingContext,
		options: maplibregl.CustomRenderMethodInput,
	) {
		if (!this.map || !this.renderer) return;

		// Update scene center periodically for precision
		// We don't update it every frame to avoid cache invalidation
		if (!this.sceneCenter || this.shouldUpdateSceneCenter()) {
			const center = this.map.getCenter();
			this.sceneCenter = maplibregl.MercatorCoordinate.fromLngLat(center);

			// Invalidate cache to rebuild geometries with new center
			this.clearCache();
		}

		// Get the original projection matrix from MapLibre
		const originalMatrix = new THREE.Matrix4().fromArray(
			options.defaultProjectionData.mainMatrix,
		);

		// Create a translation matrix to offset by the scene center
		// This improves precision by keeping coordinates closer to origin
		const translationMatrix = new THREE.Matrix4().makeTranslation(
			this.sceneCenter.x,
			this.sceneCenter.y,
			this.sceneCenter.z,
		);

		// Apply translation first, then projection
		// P' = P * T where T translates from relative coordinates back to world
		this.camera.projectionMatrix.multiplyMatrices(
			originalMatrix,
			translationMatrix,
		);

		// Update scene based on camera position
		this.updatePoints();

		// Update EDL render target sizes if needed
		if (this.options.enableEDL) {
			this.updateEDLSize();
		}

		// Render the scene
		this.renderer.resetState();

		if (
			this.options.enableEDL &&
			this.colorTarget &&
			this.depthTarget &&
			this.edlQuadScene &&
			this.edlQuadCamera
		) {
			// Render to EDL targets
			this.renderer.setRenderTarget(this.depthTarget);
			this.renderer.clear();
			this.renderer.render(this.scene, this.camera);

			this.renderer.setRenderTarget(this.colorTarget);
			this.renderer.clear();
			this.renderer.render(this.scene, this.camera);

			// Apply EDL post-processing
			this.renderer.setRenderTarget(null);
			this.renderer.render(this.edlQuadScene, this.edlQuadCamera);
		} else {
			// Standard rendering
			this.renderer.render(this.scene, this.camera);
		}

		this.map.triggerRepaint();
	}

	/**
	 * Determine if scene center should be updated
	 * Updates when camera has moved significantly from the scene center
	 */
	private shouldUpdateSceneCenter(): boolean {
		if (!this.sceneCenter || !this.map) return true;

		const currentCenter = this.map.getCenter();
		const currentMercator =
			maplibregl.MercatorCoordinate.fromLngLat(currentCenter);

		// Calculate distance from current center to scene center
		const dx = currentMercator.x - this.sceneCenter.x;
		const dy = currentMercator.y - this.sceneCenter.y;
		const distance = Math.sqrt(dx * dx + dy * dy);

		// Update if moved more than 0.001 in Mercator units for higher precision
		// This is approximately 100 meters at the equator
		return distance > 0.001;
	}

	/**
	 * Clean up resources when layer is removed
	 */
	onRemove(_map: maplibregl.Map, _gl: WebGLRenderingContext): void {
		try {
			// Terminate worker
			this.worker.terminate();

			// Clear cache (disposes Three.js resources)
			this.cacheManager.clear();

			// Clear collections
			this.visibleNodes.length = 0;
			this.pendingRequests.clear();
			this.requestQueue.length = 0;

			// Clean up EDL resources
			if (this.colorTarget) {
				this.colorTarget.dispose();
				this.colorTarget = undefined;
			}
			if (this.depthTarget) {
				this.depthTarget.dispose();
				this.depthTarget = undefined;
			}
			if (this.edlMaterial) {
				this.edlMaterial.dispose();
				this.edlMaterial = undefined;
			}
			if (this.edlQuadScene) {
				this.edlQuadScene.clear();
				this.edlQuadScene = undefined;
			}
			this.edlQuadCamera = undefined;
		} catch (error) {
			console.error('Error during layer cleanup:', error);
		}
	}

	/**
	 * Setup Eye-Dome Lighting post-processing
	 */
	private setupEDL(): void {
		if (!this.renderer || !this.map) return;

		const width = this.map.getCanvas().width;
		const height = this.map.getCanvas().height;

		// Create render targets
		this.colorTarget = new THREE.WebGLRenderTarget(width, height, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
		});

		this.depthTarget = new THREE.WebGLRenderTarget(width, height, {
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
			format: THREE.RGBAFormat,
			depthBuffer: true,
			depthTexture: new THREE.DepthTexture(width, height),
		});

		// Create EDL shader material
		this.edlMaterial = new THREE.ShaderMaterial({
			uniforms: {
				tColor: { value: this.colorTarget.texture },
				tDepth: { value: this.depthTarget.depthTexture },
				screenSize: { value: new THREE.Vector2(width, height) },
				edlStrength: { value: this.options.edlStrength },
				radius: { value: this.options.edlRadius },
				opacity: { value: this.options.edlOpacity },
			},
			vertexShader: edlVertexShader,
			fragmentShader: edlFragmentShader,
		});

		// Setup fullscreen quad for post-processing
		this.edlQuadScene = new THREE.Scene();
		this.edlQuadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

		const geometry = new THREE.PlaneGeometry(2, 2);
		const quad = new THREE.Mesh(geometry, this.edlMaterial);
		this.edlQuadScene.add(quad);
	}

	/**
	 * Update EDL render target sizes when canvas resizes
	 */
	private updateEDLSize(): void {
		if (
			!this.map ||
			!this.colorTarget ||
			!this.depthTarget ||
			!this.edlMaterial
		)
			return;

		const width = this.map.getCanvas().width;
		const height = this.map.getCanvas().height;

		this.colorTarget.setSize(width, height);
		this.depthTarget.setSize(width, height);
		this.edlMaterial.uniforms.screenSize.value.set(width, height);
	}

	/**
	 * Create Three.js material for point rendering
	 */
	private createPointMaterial(): THREE.ShaderMaterial | THREE.PointsMaterial {
		if (this.options.enableEDL) {
			// Use custom shader for EDL
			return new THREE.ShaderMaterial({
				uniforms: {
					size: { value: this.options.pointSize },
					scale: { value: window.devicePixelRatio },
					useVertexColors: { value: this.options.colorMode !== 'white' },
					pointColor: { value: new THREE.Color(0xffffff) },
				},
				vertexShader: pointsVertexShader,
				fragmentShader: pointsFragmentShader,
				vertexColors: this.options.colorMode !== 'white',
				depthTest: this.options.depthTest,
				depthWrite: this.options.depthTest,
				transparent: false,
			});
		} else {
			// Use standard points material
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
	 * Get node statistics
	 */
	public getNodeStats(): NodeStats {
		return {
			loaded: this.cacheManager.size(),
			visible: this.visibleNodes.length,
		};
	}

	/**
	 * Clear the cache manually (useful for debugging or memory management)
	 */
	public clearCache(): void {
		this.cacheManager.clear();
		this.updateVisibleNodes(); // Refresh scene
	}

	/**
	 * Enable or disable EDL effect
	 */
	public setEDLEnabled(enabled: boolean): void {
		this.options.enableEDL = enabled;
		if (enabled && !this.edlMaterial) {
			this.setupEDL();
		}
		// Refresh materials
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
	 * Update EDL parameters
	 */
	public updateEDLParameters(params: {
		strength?: number;
		radius?: number;
		opacity?: number;
	}): void {
		if (!this.edlMaterial) return;

		if (params.strength !== undefined) {
			this.options.edlStrength = params.strength;
			this.edlMaterial.uniforms.edlStrength.value = params.strength;
		}
		if (params.radius !== undefined) {
			this.options.edlRadius = params.radius;
			this.edlMaterial.uniforms.radius.value = params.radius;
		}
		if (params.opacity !== undefined) {
			this.options.edlOpacity = params.opacity;
			this.edlMaterial.uniforms.opacity.value = params.opacity;
		}

		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	/**
	 * Get current EDL parameters
	 */
	public getEDLParameters(): {
		enabled: boolean;
		strength: number;
		radius: number;
		opacity: number;
	} {
		return {
			enabled: this.options.enableEDL,
			strength: this.options.edlStrength,
			radius: this.options.edlRadius,
			opacity: this.options.edlOpacity,
		};
	}
}
