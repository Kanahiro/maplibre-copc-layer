import * as THREE from 'three'

export interface CachedNodeData {
	nodeId: string
	positions: Float64Array
	colors: Float32Array
	heights: Float32Array
	classifications: Uint8Array
	intensities: Float32Array
	pointCount: number
	geometry?: THREE.BufferGeometry
	points?: THREE.Points
	/** Shared materials are owned by the layer and disposed once with it. */
	sharedMaterial?: boolean
	materialConfig: {
		pointSize: number
		depthTest: boolean
	}
	lastAccessed: number
	sizeBytes: number
}

export interface CacheManagerOptions {
	maxNodes?: number
	maxMemoryBytes?: number
	debug?: boolean
}

export class CacheManager {
	private cache = new Map<string, CachedNodeData>()
	private memoryUsage = 0
	private options: Required<CacheManagerOptions>

	constructor(options: CacheManagerOptions = {}) {
		this.options = {
			maxNodes: options.maxNodes ?? Infinity,
			maxMemoryBytes: options.maxMemoryBytes ?? 256 * 1024 * 1024,
			debug: options.debug ?? false,
		}
	}

	get(nodeId: string): CachedNodeData | null {
		const data = this.cache.get(nodeId)
		if (data) {
			// Move to end of Map iteration order (most recently used)
			this.cache.delete(nodeId)
			this.cache.set(nodeId, data)
			data.lastAccessed = Date.now()
			return data
		}
		return null
	}

	set(nodeData: CachedNodeData, protectedNodes?: Set<string>): void {
		const { nodeId } = nodeData
		const existing = this.cache.get(nodeId)
		if (existing) {
			this.disposeNodeResources(existing)
			this.memoryUsage -= existing.sizeBytes
			this.cache.delete(nodeId)
		}

		this.ensureCacheLimits(nodeData.sizeBytes, 1, protectedNodes)

		nodeData.lastAccessed = Date.now()
		this.cache.set(nodeId, nodeData)
		this.memoryUsage += nodeData.sizeBytes

		this.log(`Cached node ${nodeId} (${this.formatBytes(nodeData.sizeBytes)})`)
	}

	peek(nodeId: string): CachedNodeData | null {
		return this.cache.get(nodeId) ?? null
	}

	has(nodeId: string): boolean {
		return this.cache.has(nodeId)
	}

	delete(nodeId: string): boolean {
		const data = this.cache.get(nodeId)
		if (!data) return false

		this.disposeNodeResources(data)
		this.cache.delete(nodeId)
		this.memoryUsage -= data.sizeBytes

		this.log(`Removed node ${nodeId} from cache`)
		return true
	}

	clear(): void {
		for (const data of this.cache.values()) {
			this.disposeNodeResources(data)
		}
		this.cache.clear()
		this.memoryUsage = 0
	}

	updateOptions(
		newOptions: Partial<CacheManagerOptions>,
		protectedNodes?: Set<string>,
	): void {
		Object.assign(this.options, newOptions)
		this.ensureCacheLimits(0, 0, protectedNodes)
	}

	/** Release old nodes after the view changes, while retaining the current working set. */
	trim(protectedNodes: Set<string>): void {
		this.ensureCacheLimits(0, 0, protectedNodes)
	}

	getCachedNodeIds(): string[] {
		return Array.from(this.cache.keys())
	}

	size(): number {
		return this.cache.size
	}

	static estimateNodeSize(
		positions: Float64Array | Float32Array,
		colors: Float32Array,
		heights: Float32Array,
		classifications: Uint8Array,
		intensities: Float32Array,
	): number {
		const positionSize =
			positions.length * (positions instanceof Float64Array ? 8 : 4)
		const colorSize = colors.length * 4
		const heightSize = heights.length * 4
		const classificationSize = classifications.length
		const intensitySize = intensities.length * 4
		return positionSize + colorSize + heightSize + classificationSize + intensitySize + 1024
	}

	static createNodeData(
		nodeId: string,
		positions: Float64Array,
		colors: Float32Array,
		heights: Float32Array,
		classifications: Uint8Array,
		intensities: Float32Array,
		materialConfig: CachedNodeData['materialConfig'],
	): CachedNodeData {
		return {
			nodeId,
			positions: new Float64Array(positions),
			colors: new Float32Array(colors),
			heights: new Float32Array(heights),
			classifications: new Uint8Array(classifications),
			intensities: new Float32Array(intensities),
			pointCount: positions.length / 3,
			materialConfig: { ...materialConfig },
			lastAccessed: Date.now(),
			sizeBytes: CacheManager.estimateNodeSize(positions, colors, heights, classifications, intensities),
		}
	}

	private ensureCacheLimits(
		newItemSize: number,
		incomingCount: number,
		protectedNodes?: Set<string>,
	): void {
		while (
			this.cache.size + incomingCount > this.options.maxNodes ||
			this.memoryUsage + newItemSize > this.options.maxMemoryBytes
		) {
			if (this.cache.size === 0) break

			// Map iterates in insertion order; first key is the LRU candidate
			let lruNodeId: string | null = null
			for (const nodeId of this.cache.keys()) {
				if (!protectedNodes?.has(nodeId)) {
					lruNodeId = nodeId
					break
				}
			}

			// Active nodes are pinned. Exceeding the budget temporarily is preferable
			// to evicting and immediately downloading the same visible chunk again.
			if (!lruNodeId) break

			this.delete(lruNodeId)
		}
	}

	private disposeNodeResources(data: CachedNodeData): void {
		data.geometry?.dispose()
		if (!data.sharedMaterial && data.points?.material instanceof THREE.Material) {
			data.points.material.dispose()
		}
	}

	private formatBytes(bytes: number): string {
		const sizes = ['B', 'KB', 'MB', 'GB']
		if (bytes === 0) return '0 B'
		const i = Math.floor(Math.log(bytes) / Math.log(1024))
		return `${Math.round((bytes / 1024 ** i) * 100) / 100} ${sizes[i]}`
	}

	private log(message: string): void {
		if (this.options.debug) {
			console.log('[CacheManager]', message)
		}
	}
}
