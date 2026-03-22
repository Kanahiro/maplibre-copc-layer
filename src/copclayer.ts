import maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { CacheManager, type CachedNodeData } from './cache-manager';
import pointsVertexShader from './shaders/points.vert.glsl';
import pointsFragmentShader from './shaders/points.frag.glsl';
import edlVertexShader from './shaders/edl.vert.glsl';
import edlFragmentShader from './shaders/edl.frag.glsl';
import CopcWorker from './worker/index.ts?worker&inline';
import {
	DEFAULT_CLASSIFICATION_COLORS,
	EARTH_CIRCUMFERENCE,
	DEG2RAD,
} from './constants';

export type ColorMode =
	| 'rgb'
	| 'height'
	| 'intensity'
	| 'classification'
	| 'white';

export type RGBColor = [number, number, number];

export type ColorExpression =
	| ['linear', ...(number | RGBColor)[]]
	| ['discrete', ...(number | RGBColor)[]];

export interface BboxFilter {
	minx?: number;
	maxx?: number;
	miny?: number;
	maxy?: number;
	minz?: number;
	maxz?: number;
}

export interface PointFilter {
	classification?: Set<number>;
	intensityRange?: [number, number];
	bbox?: BboxFilter;
}

export interface CopcLayerOptions {
	pointSize?: number;
	colorMode?: ColorMode;
	heightColor?: ColorExpression;
	intensityColor?: ColorExpression;
	classificationColors?: Record<number, RGBColor>;
	filter?: PointFilter;
	alwaysShowRoot?: boolean;
	maxCacheSize?: number;
	sseThreshold?: number;
	depthTest?: boolean;
	maxCacheMemory?: number;
	debug?: boolean;
	enableEDL?: boolean;
	edlStrength?: number;
	edlRadius?: number;
	onInitialized?: (message: {
		nodeCount: number;
		bounds: {
			minx: number;
			maxx: number;
			miny: number;
			maxy: number;
			minz: number;
			maxz: number;
		};
	}) => void;
}

type ResolvedOptions = Required<
	Omit<CopcLayerOptions, 'heightColor' | 'intensityColor'>
> &
	Pick<CopcLayerOptions, 'heightColor' | 'intensityColor'>;

const DEFAULT_OPTIONS: ResolvedOptions = {
	pointSize: 6,
	colorMode: 'rgb',
	heightColor: undefined,
	intensityColor: undefined,
	classificationColors: { ...DEFAULT_CLASSIFICATION_COLORS },
	filter: {},
	alwaysShowRoot: false,
	maxCacheSize: 100,
	sseThreshold: 8,
	depthTest: true,
	maxCacheMemory: 100 * 1024 * 1024,
	debug: false,
	enableEDL: false,
	edlStrength: 0.4,
	edlRadius: 1.5,
	onInitialized: () => {},
} as const;

const MAX_COLOR_STOPS = 16;

function colorComputeModeValue(mode: ColorMode): number {
	switch (mode) {
		case 'rgb':
			return 0;
		case 'height':
			return 1;
		case 'intensity':
			return 2;
		case 'classification':
			return 3;
		case 'white':
			return 4;
	}
}

function parseColorExpressionUniforms(expr: ColorExpression | undefined): {
	mode: number;
	count: number;
	values: number[];
	colors: THREE.Vector3[];
} {
	const values: number[] = new Array(MAX_COLOR_STOPS).fill(0);
	const colors: THREE.Vector3[] = Array.from(
		{ length: MAX_COLOR_STOPS },
		() => new THREE.Vector3(1, 1, 1),
	);

	if (!expr || expr.length < 3) {
		return { mode: 0, count: 0, values, colors };
	}

	const mode = expr[0] === 'discrete' ? 1 : 0;
	let count = 0;
	for (let i = 1; i < expr.length && count < MAX_COLOR_STOPS; i += 2) {
		const v = expr[i] as number;
		const c = expr[i + 1] as RGBColor;
		values[count] = v;
		colors[count] = new THREE.Vector3(c[0], c[1], c[2]);
		count++;
	}

	return { mode, count, values, colors };
}

export interface NodeStats {
	loaded: number;
	visible: number;
}

export class CopcLayer implements maplibregl.CustomLayerInterface {
	readonly id: string;
	readonly type: 'custom' = 'custom' as const;
	readonly renderingMode: '3d' = '3d' as const;
	readonly url: string;

	public map?: maplibregl.Map;
	public readonly camera: THREE.Camera;
	public readonly scene: THREE.Scene;
	public renderer?: THREE.WebGLRenderer;
	public readonly worker: Worker;
	public readonly cacheManager: CacheManager;

	private readonly options: ResolvedOptions;
	private visibleNodes: string[] = [];
	private workerInitialized = false;
	private pendingRequests = new Set<string>();
	private requestQueue: string[] = [];
	private lastCameraPosition: [number, number, number] | null = null;
	private sceneCenter: maplibregl.MercatorCoordinate | null = null;
	private colorTarget?: THREE.WebGLRenderTarget;
	private depthTarget?: THREE.WebGLRenderTarget;
	private edlMaterial?: THREE.ShaderMaterial;
	private edlQuadScene?: THREE.Scene;
	private edlQuadCamera?: THREE.OrthographicCamera;
	private readonly _tempMatrix1 = new THREE.Matrix4();
	private readonly _tempMatrix2 = new THREE.Matrix4();
	private _lastEdlWidth = 0;
	private _lastEdlHeight = 0;
	private _lastUpdatePointsTime = 0;
	private classificationFilterTexture: THREE.DataTexture;
	private classificationColorTexture: THREE.DataTexture;

	constructor(
		url: string,
		options: CopcLayerOptions = {},
		layerId = 'copc-layer',
	) {
		this.id = layerId;
		this.url = url;
		this.options = { ...DEFAULT_OPTIONS, ...options };

		if (!this.options.intensityColor) {
			this.options.intensityColor = ['linear', 0, [0, 0, 0], 1, [1, 1, 1]];
		}

		this.cacheManager = new CacheManager({
			maxNodes: this.options.maxCacheSize,
			maxMemoryBytes: this.options.maxCacheMemory,
			debug: this.options.debug,
		});

		this.camera = new THREE.Camera();
		this.scene = new THREE.Scene();

		this.classificationFilterTexture =
			this.createClassificationFilterTexture();
		this.classificationColorTexture =
			this.createClassificationColorTexture();

		this.worker = new CopcWorker();
		this.setupWorkerMessageHandlers();
	}

	private setupWorkerMessageHandlers() {
		this.worker.onmessage = (event) => {
			const message = event.data;

			switch (message.type) {
				case 'initialized':
					this.workerInitialized = true;
					if (!this.options.heightColor) {
						const { bounds } = message;
						this.options.heightColor = [
							'linear',
							bounds.minz,
							[0, 0, 1],
							(bounds.minz + bounds.maxz) / 2,
							[1, 1, 0],
							bounds.maxz,
							[1, 0, 0],
						];
					}
					this.requestNodeData('0-0-0-0');
					this.options.onInitialized?.(message);
					break;
				case 'nodeLoaded':
					this.handleNodeLoaded(
						message.node,
						message.positions,
						message.colors,
						message.heights,
						message.classifications,
						message.intensities,
					);
					break;
				case 'nodesToLoad':
					this.cancelAllPendingRequests();
					this.lastCameraPosition = message.cameraPosition;
					this.visibleNodes = message.nodes;
					this.updateVisibleNodes();
					break;
				case 'error':
					if (this.options.debug) {
						console.error('[CopcLayer] Worker error:', message.message);
					}
					break;
			}

			this.map?.triggerRepaint();
		};

		this.worker.onerror = (error) => {
			if (this.options.debug) {
				console.error('[CopcLayer] Worker error event:', error);
			}
		};
	}

	private handleNodeLoaded(
		nodeId: string,
		positionsBuffer: ArrayBuffer,
		colorsBuffer: ArrayBuffer,
		heightsBuffer: ArrayBuffer,
		classificationsBuffer: ArrayBuffer,
		intensitiesBuffer: ArrayBuffer,
	): void {
		this.pendingRequests.delete(nodeId);
		this.removeFromRequestQueue(nodeId);

		const positions = new Float64Array(positionsBuffer);
		const colors = new Float32Array(colorsBuffer);
		const heights = new Float32Array(heightsBuffer);
		const classifications = new Uint8Array(classificationsBuffer);
		const intensities = new Float32Array(intensitiesBuffer);

		const nodeData = CacheManager.createNodeData(
			nodeId,
			positions,
			colors,
			heights,
			classifications,
			intensities,
			{
				pointSize: this.options.pointSize,
				depthTest: this.options.depthTest,
			},
		);

		const geometry = new THREE.BufferGeometry();

		if (this.sceneCenter) {
			const { x: cx, y: cy, z: cz } = this.sceneCenter;
			const relativePositions = new Float32Array(positions.length);
			for (let i = 0; i < positions.length; i += 3) {
				relativePositions[i] = positions[i] - cx;
				relativePositions[i + 1] = positions[i + 1] - cy;
				relativePositions[i + 2] = positions[i + 2] - cz;
			}
			geometry.setAttribute(
				'position',
				new THREE.BufferAttribute(relativePositions, 3),
			);
		} else {
			geometry.setAttribute(
				'position',
				new THREE.BufferAttribute(new Float32Array(positions), 3),
			);
		}

		geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
		geometry.setAttribute(
			'heightValue',
			new THREE.BufferAttribute(heights, 1),
		);

		const classificationAttr = new Float32Array(classifications.length);
		for (let i = 0; i < classifications.length; i++) {
			classificationAttr[i] = classifications[i];
		}
		geometry.setAttribute(
			'classification',
			new THREE.BufferAttribute(classificationAttr, 1),
		);
		geometry.setAttribute(
			'intensity',
			new THREE.BufferAttribute(intensities, 1),
		);

		const material = this.createPointMaterial();
		const points = new THREE.Points(geometry, material);

		nodeData.geometry = geometry;
		nodeData.points = points;

		const protectedNodes = new Set(this.visibleNodes);
		this.cacheManager.set(nodeData, protectedNodes);
	}

	private updateVisibleNodes(): void {
		while (this.scene.children.length > 0) {
			this.scene.remove(this.scene.children[0]);
		}

		const nodesToRequest: string[] = [];

		for (const nodeId of this.visibleNodes) {
			const cachedData = this.cacheManager.get(nodeId);

			if (cachedData?.points) {
				this.scene.add(cachedData.points);
				if (this.needsMaterialUpdate(cachedData)) {
					this.updateNodeMaterial(cachedData);
				}
			} else if (!this.pendingRequests.has(nodeId)) {
				nodesToRequest.push(nodeId);
			}
		}

		for (const nodeId of this.prioritizeNodeRequests(nodesToRequest)) {
			this.requestNodeData(nodeId);
		}
	}

	private requestNodeData(nodeId: string): void {
		if (this.pendingRequests.has(nodeId)) return;

		this.pendingRequests.add(nodeId);
		this.requestQueue.push(nodeId);

		this.worker.postMessage({ type: 'loadNode', node: nodeId });
	}

	private needsMaterialUpdate(nodeData: CachedNodeData): boolean {
		const { materialConfig: c } = nodeData;
		return (
			c.pointSize !== this.options.pointSize ||
			c.depthTest !== this.options.depthTest
		);
	}

	private updateNodeMaterial(nodeData: CachedNodeData): void {
		if (!nodeData.points) return;

		if (nodeData.points.material instanceof THREE.Material) {
			nodeData.points.material.dispose();
		}

		nodeData.points.material = this.createPointMaterial();
		nodeData.materialConfig = {
			pointSize: this.options.pointSize,
			depthTest: this.options.depthTest,
		};
	}

	private rebuildAllMaterials(): void {
		for (const nodeId of this.cacheManager.getCachedNodeIds()) {
			const nodeData = this.cacheManager.get(nodeId);
			if (nodeData) this.updateNodeMaterial(nodeData);
		}
	}

	private updateAllColorUniforms(): void {
		const modeValue = colorComputeModeValue(this.options.colorMode);
		const expr =
			this.options.colorMode === 'intensity'
				? this.options.intensityColor
				: this.options.heightColor;
		const exprUniforms = parseColorExpressionUniforms(expr);

		for (const nodeId of this.cacheManager.getCachedNodeIds()) {
			const nodeData = this.cacheManager.peek(nodeId);
			if (!nodeData?.points) continue;
			const mat = nodeData.points.material as THREE.ShaderMaterial;
			mat.uniforms.colorComputeMode.value = modeValue;
			mat.uniforms.colorExprMode.value = exprUniforms.mode;
			mat.uniforms.colorExprStopCount.value = exprUniforms.count;
			mat.uniforms.colorExprStopValues.value = exprUniforms.values;
			mat.uniforms.colorExprStopColors.value = exprUniforms.colors;
			mat.uniforms.classificationColorTexture.value =
				this.classificationColorTexture;
		}
	}

	private removeFromRequestQueue(nodeId: string): void {
		const index = this.requestQueue.indexOf(nodeId);
		if (index > -1) this.requestQueue.splice(index, 1);
	}

	private cancelAllPendingRequests(): void {
		if (this.pendingRequests.size === 0) return;

		this.worker.postMessage({
			type: 'cancelRequests',
			nodes: Array.from(this.pendingRequests),
		});

		this.pendingRequests.clear();
		this.requestQueue.length = 0;
	}

	private prioritizeNodeRequests(nodeIds: string[]): string[] {
		if (!this.lastCameraPosition || nodeIds.length <= 1) return nodeIds;

		const [camLon, camLat] = this.lastCameraPosition;

		const nodesWithPriority = nodeIds.map((nodeId) => {
			const parts = nodeId.split('-').map(Number);
			const [depth, x, y] = parts;
			const nodeSize = 1.0 / 2 ** depth;
			const nodeCenterX = x * nodeSize + nodeSize / 2;
			const nodeCenterY = y * nodeSize + nodeSize / 2;

			const dx = nodeCenterX - camLon;
			const dy = nodeCenterY - camLat;
			const distance = Math.sqrt(dx * dx + dy * dy);

			const depthPriority = depth * 10;
			const distancePriority = distance > 0 ? 1000 / distance : 1000;
			const priority = depthPriority + distancePriority * 0.1;

			return { nodeId, priority };
		});

		nodesWithPriority.sort((a, b) => b.priority - a.priority);
		return nodesWithPriority.map((n) => n.nodeId);
	}

	async onAdd(map: maplibregl.Map, gl: WebGLRenderingContext): Promise<void> {
		this.map = map;

		this.worker.postMessage({
			type: 'init',
			url: this.url,
			options: {
				alwaysShowRoot: this.options.alwaysShowRoot,
			},
		});

		this.renderer = new THREE.WebGLRenderer({
			canvas: map.getCanvas(),
			context: gl,
		});
		this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
		this.renderer.autoClear = false;

		if (this.options.enableEDL) {
			this.setupEDL();
		}
	}

	public setCacheConfig(config: Partial<CopcLayerOptions>): void {
		Object.assign(this.options, config);

		const protectedNodes = new Set(this.visibleNodes);
		this.cacheManager.updateOptions(
			{
				maxNodes: this.options.maxCacheSize,
				maxMemoryBytes: this.options.maxCacheMemory,
				debug: this.options.debug,
			},
			protectedNodes,
		);

		this.updateVisibleNodes();
	}

	public setPointSize(size: number): void {
		this.options.pointSize = size;
		this.rebuildAllMaterials();
		this.map?.triggerRepaint();
	}

	public setSseThreshold(threshold: number): void {
		this.options.sseThreshold = threshold;
		this.updatePoints();
		this.map?.triggerRepaint();
	}

	public setDepthTest(enabled: boolean): void {
		this.options.depthTest = enabled;
		this.rebuildAllMaterials();
		this.map?.triggerRepaint();
	}

	public setColorMode(mode: ColorMode): void {
		this.options.colorMode = mode;
		this.updateAllColorUniforms();
		this.map?.triggerRepaint();
	}

	public setHeightColor(expr: ColorExpression): void {
		this.options.heightColor = expr;
		if (this.options.colorMode === 'height') {
			this.updateAllColorUniforms();
			this.map?.triggerRepaint();
		}
	}

	public setIntensityColor(expr: ColorExpression): void {
		this.options.intensityColor = expr;
		if (this.options.colorMode === 'intensity') {
			this.updateAllColorUniforms();
			this.map?.triggerRepaint();
		}
	}

	public setClassificationColors(
		colors: Record<number, RGBColor>,
	): void {
		this.options.classificationColors = colors;
		this.updateClassificationColorTexture();
		this.map?.triggerRepaint();
	}

	/**
	 * Compute camera altitude in meters above sea level.
	 * MapLibre's getCameraAltitude() returns NaN in Globe mode because
	 * the Globe transform's internal _pixelPerMeter is never initialized.
	 * We replicate the formula using publicly accessible values.
	 */
	private computeCameraAltitude(
		fov: number,
		height: number,
		zoom: number,
	): number {
		if (!this.map) return 0;
		const latRad = this.map.getCenter().lat * DEG2RAD;
		const fovRad = fov * DEG2RAD;
		const pitchRad = this.map.getPitch() * DEG2RAD;

		const worldSize = 512 * 2 ** zoom;
		const pixelPerMeter = worldSize / (EARTH_CIRCUMFERENCE * Math.cos(latRad));
		const cameraToCenterDistance = height / (2 * Math.tan(fovRad / 2));

		return (Math.cos(pitchRad) * cameraToCenterDistance) / pixelPerMeter;
	}

	private updatePoints(): void {
		if (!this.map || !this.workerInitialized) return;

		const now = performance.now();
		if (now - this._lastUpdatePointsTime < 100) return;
		this._lastUpdatePointsTime = now;

		const fov = this.map.transform.fov;
		const height = this.map.transform.height;
		const zoom = this.map.getZoom();

		const cameraLngLat = this.map.transform.getCameraLngLat().toArray();
		const cameraAltitude = this.computeCameraAltitude(fov, height, zoom);

		this.worker.postMessage({
			type: 'updatePoints',
			cameraPosition: [...cameraLngLat, cameraAltitude],
			mapHeight: height,
			fov,
			sseThreshold: this.options.sseThreshold,
			zoom,
		});
	}

	render(
		_gl: WebGLRenderingContext,
		options: maplibregl.CustomRenderMethodInput,
	) {
		if (!this.map || !this.renderer) return;

		if (!this.sceneCenter || this.shouldUpdateSceneCenter()) {
			const center = this.map.getCenter();
			this.sceneCenter = maplibregl.MercatorCoordinate.fromLngLat(center);
			this.clearCache();
		}

		const centerLngLat = this.sceneCenter.toLngLat();
		const modelMatrix = (
			this.map.transform as {
				getMatrixForModel: (
					lngLat: [number, number],
					altitude: number,
				) => number[];
			}
		).getMatrixForModel([centerLngLat.lng, centerLngLat.lat], 0);

		const s = this.sceneCenter.meterInMercatorCoordinateUnits();
		const invS = 1.0 / s;

		this._tempMatrix1.fromArray(options.defaultProjectionData.mainMatrix);
		this._tempMatrix2.fromArray(modelMatrix);
		this._tempMatrix1.multiply(this._tempMatrix2);
		// prettier-ignore
		this._tempMatrix2.set(
			invS, 0,    0,                0,
			0,    0,    EARTH_CIRCUMFERENCE, 0,
			0,    invS, 0,                0,
			0,    0,    0,                1,
		)
		this._tempMatrix1.multiply(this._tempMatrix2);
		this.camera.projectionMatrix.copy(this._tempMatrix1);

		this.updatePoints();

		this.renderer.setSize(
			this.map.getCanvas().width,
			this.map.getCanvas().height,
		);

		if (this.options.enableEDL) {
			this.updateEDLSize();
		}

		this.renderer.resetState();

		if (
			this.options.enableEDL &&
			this.colorTarget &&
			this.depthTarget &&
			this.edlQuadScene &&
			this.edlQuadCamera
		) {
			this.renderer.setRenderTarget(this.depthTarget);
			this.renderer.clear();
			this.renderer.render(this.scene, this.camera);

			this.renderer.setRenderTarget(this.colorTarget);
			this.renderer.clear();
			this.renderer.render(this.scene, this.camera);

			this.renderer.setRenderTarget(null);
			this.renderer.render(this.edlQuadScene, this.edlQuadCamera);
		} else {
			this.renderer.render(this.scene, this.camera);
		}

		this.map.triggerRepaint();
	}

	private shouldUpdateSceneCenter(): boolean {
		if (!this.sceneCenter || !this.map) return true;

		const currentMercator = maplibregl.MercatorCoordinate.fromLngLat(
			this.map.getCenter(),
		);
		const dx = currentMercator.x - this.sceneCenter.x;
		const dy = currentMercator.y - this.sceneCenter.y;
		return Math.sqrt(dx * dx + dy * dy) > 0.001;
	}

	onRemove(_map: maplibregl.Map, _gl: WebGLRenderingContext): void {
		this.worker.terminate();
		this.cacheManager.clear();
		this.classificationFilterTexture.dispose();
		this.classificationColorTexture.dispose();
		this.visibleNodes.length = 0;
		this.pendingRequests.clear();
		this.requestQueue.length = 0;

		this.colorTarget?.dispose();
		this.colorTarget = undefined;
		this.depthTarget?.dispose();
		this.depthTarget = undefined;
		this.edlMaterial?.dispose();
		this.edlMaterial = undefined;
		this.edlQuadScene?.clear();
		this.edlQuadScene = undefined;
		this.edlQuadCamera = undefined;
	}

	private setupEDL(): void {
		if (!this.renderer || !this.map) return;

		const width = this.map.getCanvas().width;
		const height = this.map.getCanvas().height;

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

		this.edlMaterial = new THREE.ShaderMaterial({
			uniforms: {
				tColor: { value: this.colorTarget.texture },
				tDepth: { value: this.depthTarget.depthTexture },
				screenSize: { value: new THREE.Vector2(width, height) },
				edlStrength: { value: this.options.edlStrength },
				radius: { value: this.options.edlRadius },
			},
			vertexShader: edlVertexShader,
			fragmentShader: edlFragmentShader,
		});

		this.edlQuadScene = new THREE.Scene();
		this.edlQuadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

		const geometry = new THREE.PlaneGeometry(2, 2);
		const quad = new THREE.Mesh(geometry, this.edlMaterial);
		this.edlQuadScene.add(quad);
	}

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

		if (width === this._lastEdlWidth && height === this._lastEdlHeight) return;

		this._lastEdlWidth = width;
		this._lastEdlHeight = height;
		this.colorTarget.setSize(width, height);
		this.depthTarget.setSize(width, height);
		this.edlMaterial.uniforms.screenSize.value.set(width, height);
	}

	private lngLatToMercator(
		lng: number,
		lat: number,
		height: number,
	): [number, number, number] {
		const latRad = lat * DEG2RAD;
		const sinLat = Math.sin(latRad);
		const mercX = 0.5 + lng / 360;
		const mercY =
			0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
		const mercZ = height / EARTH_CIRCUMFERENCE;
		return [mercX, mercY, mercZ];
	}

	private getBboxMercator(): {
		min: [number, number, number];
		max: [number, number, number];
	} | null {
		const bbox = this.options.filter.bbox;
		if (!bbox) return null;
		const hasAny =
			bbox.minx !== undefined ||
			bbox.maxx !== undefined ||
			bbox.miny !== undefined ||
			bbox.maxy !== undefined ||
			bbox.minz !== undefined ||
			bbox.maxz !== undefined;
		if (!hasAny) return null;

		const minLng = bbox.minx ?? -180;
		const maxLng = bbox.maxx ?? 180;
		const minLat = bbox.miny ?? -85;
		const maxLat = bbox.maxy ?? 85;
		const minZ = bbox.minz ?? -1e10;
		const maxZ = bbox.maxz ?? 1e10;

		const minMerc = this.lngLatToMercator(minLng, maxLat, minZ);
		const maxMerc = this.lngLatToMercator(maxLng, minLat, maxZ);

		return { min: minMerc, max: maxMerc };
	}

	private createPointMaterial(): THREE.ShaderMaterial {
		const filter = this.options.filter;
		const bboxMerc = this.getBboxMercator();
		const sc = this.sceneCenter;

		const expr =
			this.options.colorMode === 'intensity'
				? this.options.intensityColor
				: this.options.heightColor;
		const exprUniforms = parseColorExpressionUniforms(expr);

		return new THREE.ShaderMaterial({
			defines: {
				MAX_COLOR_STOPS: MAX_COLOR_STOPS,
			},
			uniforms: {
				size: { value: this.options.pointSize },
				scale: { value: window.devicePixelRatio },
				classificationFilter: { value: this.classificationFilterTexture },
				intensityRange: {
					value: new THREE.Vector2(
						filter.intensityRange?.[0] ?? 0,
						filter.intensityRange?.[1] ?? 1,
					),
				},
				useClassificationFilter: {
					value: filter.classification !== undefined,
				},
				useIntensityFilter: {
					value: filter.intensityRange !== undefined,
				},
				useBboxFilter: { value: bboxMerc !== null },
				bboxMin: {
					value: new THREE.Vector3(
						bboxMerc ? bboxMerc.min[0] - (sc?.x ?? 0) : 0,
						bboxMerc ? bboxMerc.min[1] - (sc?.y ?? 0) : 0,
						bboxMerc ? bboxMerc.min[2] - (sc?.z ?? 0) : 0,
					),
				},
				bboxMax: {
					value: new THREE.Vector3(
						bboxMerc ? bboxMerc.max[0] - (sc?.x ?? 0) : 0,
						bboxMerc ? bboxMerc.max[1] - (sc?.y ?? 0) : 0,
						bboxMerc ? bboxMerc.max[2] - (sc?.z ?? 0) : 0,
					),
				},
				colorComputeMode: {
					value: colorComputeModeValue(this.options.colorMode),
				},
				colorExprMode: { value: exprUniforms.mode },
				colorExprStopCount: { value: exprUniforms.count },
				colorExprStopValues: { value: exprUniforms.values },
				colorExprStopColors: { value: exprUniforms.colors },
				classificationColorTexture: {
					value: this.classificationColorTexture,
				},
			},
			vertexShader: pointsVertexShader,
			fragmentShader: pointsFragmentShader,
			vertexColors: true,
			depthTest: this.options.depthTest,
			depthWrite: this.options.depthTest,
			transparent: false,
		});
	}

	// Public getters

	public getPointSize(): number {
		return this.options.pointSize;
	}

	public getColorMode(): ColorMode {
		return this.options.colorMode;
	}

	public getSseThreshold(): number {
		return this.options.sseThreshold;
	}

	public getDepthTest(): boolean {
		return this.options.depthTest;
	}

	public getOptions(): Readonly<CopcLayerOptions> {
		return { ...this.options };
	}

	public isLoading(): boolean {
		return this.pendingRequests.size > 0 || !this.workerInitialized;
	}

	public getNodeStats(): NodeStats {
		return {
			loaded: this.cacheManager.size(),
			visible: this.visibleNodes.length,
		};
	}

	public clearCache(): void {
		this.cacheManager.clear();
		this.updateVisibleNodes();
	}

	public setEDLEnabled(enabled: boolean): void {
		this.options.enableEDL = enabled;
		if (enabled && !this.edlMaterial) {
			this.setupEDL();
		}
		this.rebuildAllMaterials();
		this.map?.triggerRepaint();
	}

	public setEDLParameters(params: {
		strength?: number;
		radius?: number;
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

		this.map?.triggerRepaint();
	}

	public getEDLParameters(): {
		enabled: boolean;
		strength: number;
		radius: number;
	} {
		return {
			enabled: this.options.enableEDL,
			strength: this.options.edlStrength,
			radius: this.options.edlRadius,
		};
	}

	public setFilter(filter: PointFilter): void {
		this.options.filter = filter;
		this.updateClassificationFilterTexture();
		this.rebuildAllMaterials();
		this.map?.triggerRepaint();
	}

	public getFilter(): PointFilter {
		return { ...this.options.filter };
	}

	private createClassificationFilterTexture(): THREE.DataTexture {
		const data = new Uint8Array(256);
		data.fill(255);
		const texture = new THREE.DataTexture(
			data,
			256,
			1,
			THREE.RedFormat,
			THREE.UnsignedByteType,
		);
		texture.needsUpdate = true;
		return texture;
	}

	private updateClassificationFilterTexture(): void {
		const data = this.classificationFilterTexture.image.data as Uint8Array;
		const filter = this.options.filter;

		if (filter.classification) {
			for (let i = 0; i < 256; i++) {
				data[i] = filter.classification.has(i) ? 255 : 0;
			}
		} else {
			data.fill(255);
		}

		this.classificationFilterTexture.needsUpdate = true;
	}

	private populateClassificationColorData(data: Uint8Array): void {
		data.fill(255);
		const colors = this.options.classificationColors;
		for (const [code, rgb] of Object.entries(colors)) {
			const idx = Number(code);
			if (idx >= 0 && idx < 256) {
				data[idx * 4] = Math.round(rgb[0] * 255);
				data[idx * 4 + 1] = Math.round(rgb[1] * 255);
				data[idx * 4 + 2] = Math.round(rgb[2] * 255);
				data[idx * 4 + 3] = 255;
			}
		}
	}

	private createClassificationColorTexture(): THREE.DataTexture {
		const data = new Uint8Array(256 * 4);
		this.populateClassificationColorData(data);
		const texture = new THREE.DataTexture(
			data,
			256,
			1,
			THREE.RGBAFormat,
			THREE.UnsignedByteType,
		);
		texture.needsUpdate = true;
		return texture;
	}

	private updateClassificationColorTexture(): void {
		const data = this.classificationColorTexture.image.data as Uint8Array;
		this.populateClassificationColorData(data);
		this.classificationColorTexture.needsUpdate = true;
	}
}
