import { describe, expect, test, vi } from 'vite-plus/test'
import { CacheManager, type CachedNodeData } from '../src/cache-manager'

function createMockNodeData(
	nodeId: string,
	sizeBytes = 1024,
): CachedNodeData {
	const positions = new Float64Array([0, 0, 0])
	const colors = new Float32Array([1, 1, 1])
	return {
		nodeId,
		positions,
		colors,
		pointCount: 1,
		materialConfig: { colorMode: 'rgb', pointSize: 6, depthTest: true },
		lastAccessed: Date.now(),
		sizeBytes,
	}
}

describe('CacheManager', () => {
	test('get returns null for non-existent node', () => {
		const cache = new CacheManager()
		expect(cache.get('0-0-0-0')).toBeNull()
	})

	test('set and get round-trips correctly', () => {
		const cache = new CacheManager()
		const data = createMockNodeData('0-0-0-0')
		cache.set(data)

		const result = cache.get('0-0-0-0')
		expect(result).not.toBeNull()
		expect(result!.nodeId).toBe('0-0-0-0')
	})

	test('has returns correct values', () => {
		const cache = new CacheManager()
		expect(cache.has('0-0-0-0')).toBe(false)

		cache.set(createMockNodeData('0-0-0-0'))
		expect(cache.has('0-0-0-0')).toBe(true)
	})

	test('delete removes node', () => {
		const cache = new CacheManager()
		cache.set(createMockNodeData('0-0-0-0'))
		expect(cache.has('0-0-0-0')).toBe(true)

		cache.delete('0-0-0-0')
		expect(cache.has('0-0-0-0')).toBe(false)
	})

	test('clear removes all nodes', () => {
		const cache = new CacheManager()
		cache.set(createMockNodeData('node-1'))
		cache.set(createMockNodeData('node-2'))
		expect(cache.size()).toBe(2)

		cache.clear()
		expect(cache.size()).toBe(0)
	})

	test('evicts LRU node when maxNodes exceeded', () => {
		const cache = new CacheManager({ maxNodes: 2 })

		cache.set(createMockNodeData('node-1'))
		cache.set(createMockNodeData('node-2'))
		cache.set(createMockNodeData('node-3'))

		expect(cache.size()).toBe(2)
		expect(cache.has('node-1')).toBe(false)
		expect(cache.has('node-2')).toBe(true)
		expect(cache.has('node-3')).toBe(true)
	})

	test('protects specified nodes from eviction', () => {
		const cache = new CacheManager({ maxNodes: 2 })

		cache.set(createMockNodeData('node-1'))
		cache.set(createMockNodeData('node-2'))

		const protectedNodes = new Set(['node-1'])
		cache.set(createMockNodeData('node-3'), protectedNodes)

		expect(cache.has('node-1')).toBe(true)
		expect(cache.has('node-2')).toBe(false)
		expect(cache.has('node-3')).toBe(true)
	})

	test('evicts based on memory limit', () => {
		const cache = new CacheManager({ maxNodes: 100, maxMemoryBytes: 2048 })

		cache.set(createMockNodeData('node-1', 1024))
		cache.set(createMockNodeData('node-2', 1024))
		cache.set(createMockNodeData('node-3', 1024))

		expect(cache.size()).toBe(2)
		expect(cache.has('node-1')).toBe(false)
	})

	test('getCachedNodeIds returns all cached IDs', () => {
		const cache = new CacheManager()
		cache.set(createMockNodeData('a'))
		cache.set(createMockNodeData('b'))

		const ids = cache.getCachedNodeIds()
		expect(ids).toContain('a')
		expect(ids).toContain('b')
		expect(ids).toHaveLength(2)
	})

	test('LRU order updates on get', () => {
		const cache = new CacheManager({ maxNodes: 2 })

		cache.set(createMockNodeData('node-1'))
		cache.set(createMockNodeData('node-2'))

		// Access node-1 to make it most recently used
		cache.get('node-1')

		// Add node-3, should evict node-2 (LRU)
		cache.set(createMockNodeData('node-3'))

		expect(cache.has('node-1')).toBe(true)
		expect(cache.has('node-2')).toBe(false)
		expect(cache.has('node-3')).toBe(true)
	})
})

describe('CacheManager.createNodeData', () => {
	test('creates node data with correct fields', () => {
		const positions = new Float64Array([1, 2, 3, 4, 5, 6])
		const colors = new Float32Array([1, 0, 0, 0, 1, 0])
		const config = { colorMode: 'rgb', pointSize: 6, depthTest: true }

		const data = CacheManager.createNodeData('0-0-0-0', positions, colors, config)

		expect(data.nodeId).toBe('0-0-0-0')
		expect(data.pointCount).toBe(2)
		expect(data.sizeBytes).toBeGreaterThan(0)
		expect(data.materialConfig.colorMode).toBe('rgb')
	})

	test('copies buffers to ensure independence', () => {
		const positions = new Float64Array([1, 2, 3])
		const colors = new Float32Array([1, 0, 0])
		const config = { colorMode: 'rgb', pointSize: 6, depthTest: true }

		const data = CacheManager.createNodeData('0-0-0-0', positions, colors, config)

		positions[0] = 999
		expect(data.positions[0]).toBe(1)
	})
})

describe('CacheManager.estimateNodeSize', () => {
	test('estimates size for Float64Array positions', () => {
		const positions = new Float64Array(300)
		const colors = new Float32Array(300)

		const size = CacheManager.estimateNodeSize(positions, colors)
		// 300 * 8 (Float64) + 300 * 4 (Float32) + 1024 overhead
		expect(size).toBe(300 * 8 + 300 * 4 + 1024)
	})

	test('estimates size for Float32Array positions', () => {
		const positions = new Float32Array(300)
		const colors = new Float32Array(300)

		const size = CacheManager.estimateNodeSize(positions, colors)
		// 300 * 4 + 300 * 4 + 1024 overhead
		expect(size).toBe(300 * 4 + 300 * 4 + 1024)
	})
})
