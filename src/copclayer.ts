import maplibregl from 'maplibre-gl'
import * as THREE from 'three'
import { CacheManager, type CachedNodeData } from './cache-manager'
import pointsVertexShader from './shaders/points.vert.glsl'
import pointsFragmentShader from './shaders/points.frag.glsl'
import edlVertexShader from './shaders/edl.vert.glsl'
import edlFragmentShader from './shaders/edl.frag.glsl'

export type ColorMode = 'rgb' | 'height' | 'intensity' | 'white'

export interface CopcLayerOptions {
	pointSize?: number
	colorMode?: ColorMode
	maxCacheSize?: number
	sseThreshold?: number
	depthTest?: boolean
	maxCacheMemory?: number
	enableCacheLogging?: boolean
	enableEDL?: boolean
	edlStrength?: number
	edlRadius?: number
	edlOpacity?: number
	/** Path to laz-perf.wasm file for LAZ decompression */
	wasmPath?: string
	onInitialized?: (message: {
		nodeCount: number
		center: [number, number]
	}) => void
}

type ResolvedOptions = Required<Omit<CopcLayerOptions, 'wasmPath'>> &
	Pick<CopcLayerOptions, 'wasmPath'>

const DEFAULT_OPTIONS: ResolvedOptions = {
	pointSize: 6,
	colorMode: 'rgb',
	maxCacheSize: 100,
	sseThreshold: 8,
	depthTest: true,
	maxCacheMemory: 100 * 1024 * 1024,
	enableCacheLogging: false,
	enableEDL: false,
	edlStrength: 0.4,
	edlRadius: 1.5,
	edlOpacity: 1.0,
	wasmPath: undefined,
	onInitialized: () => {},
} as const

export interface NodeStats {
	loaded: number
	visible: number
}

export class CopcLayer implements maplibregl.CustomLayerInterface {
	readonly id: string
	readonly type: 'custom' = 'custom' as const
	readonly renderingMode: '3d' = '3d' as const
	readonly url: string

	public map?: maplibregl.Map
	public readonly camera: THREE.Camera
	public readonly scene: THREE.Scene
	public renderer?: THREE.WebGLRenderer
	public readonly worker: Worker
	public readonly cacheManager: CacheManager

	private readonly options: ResolvedOptions
	private sseThreshold: number
	private visibleNodes: string[] = []
	private workerInitialized = false
	private pendingRequests = new Set<string>()
	private requestQueue: string[] = []
	private lastCameraPosition: [number, number, number] | null = null
	private sceneCenter: maplibregl.MercatorCoordinate | null = null
	private colorTarget?: THREE.WebGLRenderTarget
	private depthTarget?: THREE.WebGLRenderTarget
	private edlMaterial?: THREE.ShaderMaterial
	private edlQuadScene?: THREE.Scene
	private edlQuadCamera?: THREE.OrthographicCamera

	constructor(
		url: string,
		options: CopcLayerOptions = {},
		layerId = 'copc-layer',
	) {
		this.id = layerId
		this.url = url
		this.options = { ...DEFAULT_OPTIONS, ...options }
		this.sseThreshold = this.options.sseThreshold

		this.cacheManager = new CacheManager({
			maxNodes: this.options.maxCacheSize,
			maxMemoryBytes: this.options.maxCacheMemory,
			enableLogging: this.options.enableCacheLogging,
		})

		this.camera = new THREE.Camera()
		this.scene = new THREE.Scene()

		this.worker = new Worker(new URL('./worker/index.ts', import.meta.url), {
			type: 'module',
		})
		this.setupWorkerMessageHandlers()
	}

	private setupWorkerMessageHandlers() {
		this.worker.onmessage = (event) => {
			const message = event.data

			switch (message.type) {
				case 'initialized':
					this.workerInitialized = true
					this.requestNodeData('0-0-0-0')
					this.options.onInitialized?.(message)
					break
				case 'nodeLoaded':
					this.handleNodeLoaded(
						message.node,
						message.positions,
						message.colors,
					)
					break
				case 'nodesToLoad':
					this.cancelAllPendingRequests()
					this.lastCameraPosition = message.cameraPosition
					this.visibleNodes = message.nodes
					this.updateVisibleNodes()
					break
				case 'error':
					console.error('Worker error:', message.message)
					break
			}

			this.map?.triggerRepaint()
		}

		this.worker.onerror = (error) => {
			console.error('Worker error event:', error)
		}
	}

	private handleNodeLoaded(
		nodeId: string,
		positionsBuffer: ArrayBuffer,
		colorsBuffer: ArrayBuffer,
	): void {
		this.pendingRequests.delete(nodeId)
		this.removeFromRequestQueue(nodeId)

		const positions = new Float64Array(positionsBuffer)
		const colors = new Float32Array(colorsBuffer)

		const nodeData = CacheManager.createNodeData(nodeId, positions, colors, {
			colorMode: this.options.colorMode,
			pointSize: this.options.pointSize,
			depthTest: this.options.depthTest,
		})

		const geometry = new THREE.BufferGeometry()

		if (this.sceneCenter) {
			const { x: cx, y: cy, z: cz } = this.sceneCenter
			const relativePositions = new Float32Array(positions.length)
			for (let i = 0; i < positions.length; i += 3) {
				relativePositions[i] = positions[i] - cx
				relativePositions[i + 1] = positions[i + 1] - cy
				relativePositions[i + 2] = positions[i + 2] - cz
			}
			geometry.setAttribute(
				'position',
				new THREE.BufferAttribute(relativePositions, 3),
			)
		} else {
			geometry.setAttribute(
				'position',
				new THREE.BufferAttribute(new Float32Array(positions), 3),
			)
		}

		geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

		const material = this.createPointMaterial()
		const points = new THREE.Points(geometry, material)

		nodeData.geometry = geometry
		nodeData.points = points

		const protectedNodes = new Set(this.visibleNodes)
		this.cacheManager.set(nodeData, protectedNodes)
	}

	private updateVisibleNodes(): void {
		while (this.scene.children.length > 0) {
			this.scene.remove(this.scene.children[0])
		}

		const nodesToRequest: string[] = []

		for (const nodeId of this.visibleNodes) {
			const cachedData = this.cacheManager.get(nodeId)

			if (cachedData?.points) {
				this.scene.add(cachedData.points)
				if (this.needsMaterialUpdate(cachedData)) {
					this.updateNodeMaterial(cachedData)
				}
			} else if (!this.pendingRequests.has(nodeId)) {
				nodesToRequest.push(nodeId)
			}
		}

		for (const nodeId of this.prioritizeNodeRequests(nodesToRequest)) {
			this.requestNodeData(nodeId)
		}
	}

	private requestNodeData(nodeId: string): void {
		if (this.pendingRequests.has(nodeId)) return

		this.pendingRequests.add(nodeId)
		this.requestQueue.push(nodeId)

		this.worker.postMessage({ type: 'loadNode', node: nodeId })
	}

	private needsMaterialUpdate(nodeData: CachedNodeData): boolean {
		const { materialConfig: c } = nodeData
		return (
			c.colorMode !== this.options.colorMode ||
			c.pointSize !== this.options.pointSize ||
			c.depthTest !== this.options.depthTest
		)
	}

	private updateNodeMaterial(nodeData: CachedNodeData): void {
		if (!nodeData.points) return

		if (nodeData.points.material instanceof THREE.Material) {
			nodeData.points.material.dispose()
		}

		nodeData.points.material = this.createPointMaterial()
		nodeData.materialConfig = {
			colorMode: this.options.colorMode,
			pointSize: this.options.pointSize,
			depthTest: this.options.depthTest,
		}
	}

	private removeFromRequestQueue(nodeId: string): void {
		const index = this.requestQueue.indexOf(nodeId)
		if (index > -1) this.requestQueue.splice(index, 1)
	}

	private cancelAllPendingRequests(): void {
		if (this.pendingRequests.size === 0) return

		this.worker.postMessage({
			type: 'cancelRequests',
			nodes: Array.from(this.pendingRequests),
		})

		this.pendingRequests.clear()
		this.requestQueue.length = 0
	}

	private prioritizeNodeRequests(nodeIds: string[]): string[] {
		if (!this.lastCameraPosition || nodeIds.length <= 1) return nodeIds

		const [camLon, camLat] = this.lastCameraPosition

		const nodesWithPriority = nodeIds.map((nodeId) => {
			const parts = nodeId.split('-').map(Number)
			const [depth, x, y] = parts
			const nodeSize = 1.0 / 2 ** depth
			const nodeCenterX = x * nodeSize + nodeSize / 2
			const nodeCenterY = y * nodeSize + nodeSize / 2

			const dx = nodeCenterX - camLon
			const dy = nodeCenterY - camLat
			const distance = Math.sqrt(dx * dx + dy * dy)

			const depthPriority = depth * 10
			const distancePriority = distance > 0 ? 1000 / distance : 1000
			const priority = depthPriority + distancePriority * 0.1

			return { nodeId, priority }
		})

		nodesWithPriority.sort((a, b) => b.priority - a.priority)
		return nodesWithPriority.map((n) => n.nodeId)
	}

	async onAdd(map: maplibregl.Map, gl: WebGLRenderingContext): Promise<void> {
		this.map = map

		this.worker.postMessage({
			type: 'init',
			url: this.url,
			options: {
				colorMode: this.options.colorMode,
				maxCacheSize: this.options.maxCacheSize,
				wasmPath: this.options.wasmPath,
			},
		})

		this.renderer = new THREE.WebGLRenderer({
			canvas: map.getCanvas(),
			context: gl,
		})
		this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
		this.renderer.autoClear = false

		if (this.options.enableEDL) {
			this.setupEDL()
		}
	}

	public updateCacheConfig(config: Partial<CopcLayerOptions>): void {
		Object.assign(this.options, config)

		const protectedNodes = new Set(this.visibleNodes)
		this.cacheManager.updateOptions(
			{
				maxNodes: this.options.maxCacheSize,
				maxMemoryBytes: this.options.maxCacheMemory,
				enableLogging: this.options.enableCacheLogging,
			},
			protectedNodes,
		)

		this.updateVisibleNodes()
	}

	public setPointSize(size: number): void {
		this.options.pointSize = size
		for (const nodeId of this.cacheManager.getCachedNodeIds()) {
			const nodeData = this.cacheManager.get(nodeId)
			if (nodeData) this.updateNodeMaterial(nodeData)
		}
		this.map?.triggerRepaint()
	}

	public setSseThreshold(threshold: number): void {
		this.sseThreshold = threshold
		this.options.sseThreshold = threshold
		this.updatePoints()
		this.map?.triggerRepaint()
	}

	public toggleDepthTest(enabled: boolean): void {
		this.options.depthTest = enabled
		for (const nodeId of this.cacheManager.getCachedNodeIds()) {
			const nodeData = this.cacheManager.get(nodeId)
			if (nodeData) this.updateNodeMaterial(nodeData)
		}
		this.map?.triggerRepaint()
	}

	private updatePoints(): void {
		if (!this.map || !this.workerInitialized) return

		const cameraLngLat = this.map.transform.getCameraLngLat().toArray()
		const cameraAltitude = this.map.transform.getCameraAltitude()

		this.worker.postMessage({
			type: 'updatePoints',
			cameraPosition: [...cameraLngLat, cameraAltitude],
			mapHeight: this.map.transform.height,
			fov: this.map.transform.fov,
			sseThreshold: this.sseThreshold,
		})
	}

	render(
		_gl: WebGLRenderingContext,
		options: maplibregl.CustomRenderMethodInput,
	) {
		if (!this.map || !this.renderer) return

		if (!this.sceneCenter || this.shouldUpdateSceneCenter()) {
			const center = this.map.getCenter()
			this.sceneCenter = maplibregl.MercatorCoordinate.fromLngLat(center)
			this.clearCache()
		}

		const originalMatrix = new THREE.Matrix4().fromArray(
			options.defaultProjectionData.mainMatrix,
		)
		const translationMatrix = new THREE.Matrix4().makeTranslation(
			this.sceneCenter.x,
			this.sceneCenter.y,
			this.sceneCenter.z,
		)
		this.camera.projectionMatrix.multiplyMatrices(
			originalMatrix,
			translationMatrix,
		)

		this.updatePoints()

		this.renderer.setSize(
			this.map.getCanvas().width,
			this.map.getCanvas().height,
		)

		if (this.options.enableEDL) {
			this.updateEDLSize()
		}

		this.renderer.resetState()

		if (
			this.options.enableEDL &&
			this.colorTarget &&
			this.depthTarget &&
			this.edlQuadScene &&
			this.edlQuadCamera
		) {
			this.renderer.setRenderTarget(this.depthTarget)
			this.renderer.clear()
			this.renderer.render(this.scene, this.camera)

			this.renderer.setRenderTarget(this.colorTarget)
			this.renderer.clear()
			this.renderer.render(this.scene, this.camera)

			this.renderer.setRenderTarget(null)
			this.renderer.render(this.edlQuadScene, this.edlQuadCamera)
		} else {
			this.renderer.render(this.scene, this.camera)
		}

		this.map.triggerRepaint()
	}

	private shouldUpdateSceneCenter(): boolean {
		if (!this.sceneCenter || !this.map) return true

		const currentMercator = maplibregl.MercatorCoordinate.fromLngLat(
			this.map.getCenter(),
		)
		const dx = currentMercator.x - this.sceneCenter.x
		const dy = currentMercator.y - this.sceneCenter.y
		return Math.sqrt(dx * dx + dy * dy) > 0.001
	}

	onRemove(_map: maplibregl.Map, _gl: WebGLRenderingContext): void {
		this.worker.terminate()
		this.cacheManager.clear()
		this.visibleNodes.length = 0
		this.pendingRequests.clear()
		this.requestQueue.length = 0

		this.colorTarget?.dispose()
		this.colorTarget = undefined
		this.depthTarget?.dispose()
		this.depthTarget = undefined
		this.edlMaterial?.dispose()
		this.edlMaterial = undefined
		this.edlQuadScene?.clear()
		this.edlQuadScene = undefined
		this.edlQuadCamera = undefined
	}

	private setupEDL(): void {
		if (!this.renderer || !this.map) return

		const width = this.map.getCanvas().width
		const height = this.map.getCanvas().height

		this.colorTarget = new THREE.WebGLRenderTarget(width, height, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
		})

		this.depthTarget = new THREE.WebGLRenderTarget(width, height, {
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
			format: THREE.RGBAFormat,
			depthBuffer: true,
			depthTexture: new THREE.DepthTexture(width, height),
		})

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
		})

		this.edlQuadScene = new THREE.Scene()
		this.edlQuadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

		const geometry = new THREE.PlaneGeometry(2, 2)
		const quad = new THREE.Mesh(geometry, this.edlMaterial)
		this.edlQuadScene.add(quad)
	}

	private updateEDLSize(): void {
		if (!this.map || !this.colorTarget || !this.depthTarget || !this.edlMaterial)
			return

		const width = this.map.getCanvas().width
		const height = this.map.getCanvas().height

		this.colorTarget.setSize(width, height)
		this.depthTarget.setSize(width, height)
		this.edlMaterial.uniforms.screenSize.value.set(width, height)
	}

	private createPointMaterial(): THREE.ShaderMaterial | THREE.PointsMaterial {
		if (this.options.enableEDL) {
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
			})
		}

		const material = new THREE.PointsMaterial({
			vertexColors: this.options.colorMode !== 'white',
			size: this.options.pointSize,
			depthTest: this.options.depthTest,
			depthWrite: this.options.depthTest,
			sizeAttenuation: true,
		})

		if (this.options.colorMode === 'white') {
			material.color.setHex(0xffffff)
		}

		return material
	}

	// Public getters

	public getPointSize(): number {
		return this.options.pointSize
	}

	public getColorMode(): ColorMode {
		return this.options.colorMode
	}

	public getSseThreshold(): number {
		return this.sseThreshold
	}

	public isDepthTestEnabled(): boolean {
		return this.options.depthTest
	}

	public getOptions(): Readonly<CopcLayerOptions> {
		return { ...this.options }
	}

	public isLoading(): boolean {
		return this.pendingRequests.size > 0 || !this.workerInitialized
	}

	public getNodeStats(): NodeStats {
		return {
			loaded: this.cacheManager.size(),
			visible: this.visibleNodes.length,
		}
	}

	public clearCache(): void {
		this.cacheManager.clear()
		this.updateVisibleNodes()
	}

	public setEDLEnabled(enabled: boolean): void {
		this.options.enableEDL = enabled
		if (enabled && !this.edlMaterial) {
			this.setupEDL()
		}
		for (const nodeId of this.cacheManager.getCachedNodeIds()) {
			const nodeData = this.cacheManager.get(nodeId)
			if (nodeData) this.updateNodeMaterial(nodeData)
		}
		this.map?.triggerRepaint()
	}

	public updateEDLParameters(params: {
		strength?: number
		radius?: number
		opacity?: number
	}): void {
		if (!this.edlMaterial) return

		if (params.strength !== undefined) {
			this.options.edlStrength = params.strength
			this.edlMaterial.uniforms.edlStrength.value = params.strength
		}
		if (params.radius !== undefined) {
			this.options.edlRadius = params.radius
			this.edlMaterial.uniforms.radius.value = params.radius
		}
		if (params.opacity !== undefined) {
			this.options.edlOpacity = params.opacity
			this.edlMaterial.uniforms.opacity.value = params.opacity
		}

		this.map?.triggerRepaint()
	}

	public getEDLParameters(): {
		enabled: boolean
		strength: number
		radius: number
		opacity: number
	} {
		return {
			enabled: this.options.enableEDL,
			strength: this.options.edlStrength,
			radius: this.options.edlRadius,
			opacity: this.options.edlOpacity,
		}
	}
}
