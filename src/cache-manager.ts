import * as THREE from 'three'

export interface CachedNodeData {
	nodeId: string
	positions: Float64Array
	colors: Float32Array
	pointCount: number
	geometry?: THREE.BufferGeometry
	points?: THREE.Points
	materialConfig: {
		colorMode: string
		pointSize: number
		depthTest: boolean
	}
	lastAccessed: number
	sizeBytes: number
}

export interface CacheManagerOptions {
	maxNodes?: number
	maxMemoryBytes?: number
	enableLogging?: boolean
}

export class CacheManager {
	private cache = new Map<string, CachedNodeData>()
	private accessOrder: string[] = []
	private memoryUsage = 0
	private options: Required<CacheManagerOptions>

	constructor(options: CacheManagerOptions = {}) {
		this.options = {
			maxNodes: options.maxNodes ?? 100,
			maxMemoryBytes: options.maxMemoryBytes ?? 100 * 1024 * 1024,
			enableLogging: options.enableLogging ?? false,
		}
	}

	get(nodeId: string): CachedNodeData | null {
		const data = this.cache.get(nodeId)
		if (data) {
			this.updateAccessOrder(nodeId)
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
		}

		this.ensureCacheLimits(nodeData.sizeBytes, protectedNodes)

		nodeData.lastAccessed = Date.now()
		this.cache.set(nodeId, nodeData)
		this.updateAccessOrder(nodeId)
		this.memoryUsage += nodeData.sizeBytes

		this.log(`Cached node ${nodeId} (${this.formatBytes(nodeData.sizeBytes)})`)
	}

	has(nodeId: string): boolean {
		return this.cache.has(nodeId)
	}

	delete(nodeId: string): boolean {
		const data = this.cache.get(nodeId)
		if (!data) return false

		this.disposeNodeResources(data)
		this.cache.delete(nodeId)
		this.removeFromAccessOrder(nodeId)
		this.memoryUsage -= data.sizeBytes

		this.log(`Removed node ${nodeId} from cache`)
		return true
	}

	clear(): void {
		for (const data of this.cache.values()) {
			this.disposeNodeResources(data)
		}
		this.cache.clear()
		this.accessOrder.length = 0
		this.memoryUsage = 0
	}

	updateOptions(
		newOptions: Partial<CacheManagerOptions>,
		protectedNodes?: Set<string>,
	): void {
		Object.assign(this.options, newOptions)
		this.ensureCacheLimits(0, protectedNodes)
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
	): number {
		const positionSize =
			positions.length * (positions instanceof Float64Array ? 8 : 4)
		const colorSize = colors.length * 4
		return positionSize + colorSize + 1024
	}

	static createNodeData(
		nodeId: string,
		positions: Float64Array,
		colors: Float32Array,
		materialConfig: CachedNodeData['materialConfig'],
	): CachedNodeData {
		return {
			nodeId,
			positions: new Float64Array(positions),
			colors: new Float32Array(colors),
			pointCount: positions.length / 3,
			materialConfig: { ...materialConfig },
			lastAccessed: Date.now(),
			sizeBytes: CacheManager.estimateNodeSize(positions, colors),
		}
	}

	private updateAccessOrder(nodeId: string): void {
		this.removeFromAccessOrder(nodeId)
		this.accessOrder.push(nodeId)
	}

	private removeFromAccessOrder(nodeId: string): void {
		const index = this.accessOrder.indexOf(nodeId)
		if (index > -1) {
			this.accessOrder.splice(index, 1)
		}
	}

	private ensureCacheLimits(
		newItemSize: number,
		protectedNodes?: Set<string>,
	): void {
		while (
			this.cache.size >= this.options.maxNodes ||
			this.memoryUsage + newItemSize > this.options.maxMemoryBytes
		) {
			if (this.accessOrder.length === 0) break

			let lruNodeId: string | null = null
			for (const nodeId of this.accessOrder) {
				if (!protectedNodes?.has(nodeId)) {
					lruNodeId = nodeId
					break
				}
			}

			if (!lruNodeId) {
				this.log(
					'Warning: Cannot evict any nodes - all are protected. Cache limit exceeded.',
				)
				break
			}

			this.delete(lruNodeId)
		}
	}

	private disposeNodeResources(data: CachedNodeData): void {
		data.geometry?.dispose()
		if (data.points?.material instanceof THREE.Material) {
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
		if (this.options.enableLogging) {
			console.log('[CacheManager]', message)
		}
	}
}
