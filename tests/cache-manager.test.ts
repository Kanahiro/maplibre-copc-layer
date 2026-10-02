import { describe, expect, test, vi } from 'vitest'
import { CacheManager, type CachedNodeData } from '../src/cache-manager'
import * as THREE from 'three'

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
	test('defaults to a byte budget rather than evicting many small nodes by count', () => {
		const cache = new CacheManager()
		for (let i = 0; i < 120; i++) cache.set(createMockNodeData(`node-${i}`, 1024))
		expect(cache.size()).toBe(120)
	})
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

	test('evicting a node keeps a shared material alive', () => {
		const cache = new CacheManager({ maxNodes: 1 })
		const material = new THREE.PointsMaterial()
		const dispose = vi.spyOn(material, 'dispose')
		const first = createMockNodeData('first')
		first.geometry = new THREE.BufferGeometry()
		const geometryDispose = vi.spyOn(first.geometry, 'dispose')
		first.points = new THREE.Points(first.geometry, material)
		first.sharedMaterial = true
		cache.set(first)
		cache.set(createMockNodeData('second'))
		expect(geometryDispose).toHaveBeenCalledOnce()
		expect(dispose).not.toHaveBeenCalled()
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

	test('updating an unchanged limit keeps a full cache', () => {
		const cache = new CacheManager({ maxNodes: 2 })
		cache.set(createMockNodeData('a'))
		cache.set(createMockNodeData('b'))
		cache.updateOptions({ maxNodes: 2 })
		expect(cache.getCachedNodeIds()).toEqual(['a', 'b'])
	})

	test('keeps a visible working set when it exceeds the cache budget', () => {
		const cache = new CacheManager({ maxNodes: 2 })
		cache.set(createMockNodeData('a'))
		cache.set(createMockNodeData('b'))
		const active = new Set(['a', 'b', 'c'])
		cache.set(createMockNodeData('c'), active)
		expect(cache.size()).toBe(3)
		expect(cache.getCachedNodeIds()).toEqual(['a', 'b', 'c'])
		cache.trim(new Set(['b', 'c']))
		expect(cache.size()).toBe(2)
		expect(cache.has('a')).toBe(false)
		expect(cache.has('c')).toBe(true)
	})

	test('does not evict active nodes to meet the memory budget', () => {
		const cache = new CacheManager({ maxMemoryBytes: 2048 })
		cache.set(createMockNodeData('a', 1024))
		cache.set(createMockNodeData('b', 1024))
		cache.set(createMockNodeData('c', 1024), new Set(['a', 'b', 'c']))
		expect(cache.size()).toBe(3)
		cache.trim(new Set(['b', 'c']))
		expect(cache.getCachedNodeIds()).toEqual(['b', 'c'])
	})
})

describe('CacheManager.createNodeData', () => {
	test('creates node data with correct fields', () => {
		const positions = new Float64Array([1, 2, 3, 4, 5, 6])
		const colors = new Float32Array([1, 0, 0, 0, 1, 0])
		const heights = new Float32Array([10, 20])
		const classifications = new Uint8Array([2, 6])
		const intensities = new Float32Array([0.5, 0.8])
		const config = { pointSize: 6, depthTest: true }

		const data = CacheManager.createNodeData('0-0-0-0', positions, colors, heights, classifications, intensities, config)

		expect(data.nodeId).toBe('0-0-0-0')
		expect(data.pointCount).toBe(2)
		expect(data.sizeBytes).toBeGreaterThan(0)
		expect(data.heights).toEqual(new Float32Array([10, 20]))
		expect(data.classifications).toEqual(new Uint8Array([2, 6]))
		expect(data.intensities).toEqual(new Float32Array([0.5, 0.8]))
	})

	test('copies buffers to ensure independence', () => {
		const positions = new Float64Array([1, 2, 3])
		const colors = new Float32Array([1, 0, 0])
		const heights = new Float32Array([10])
		const classifications = new Uint8Array([2])
		const intensities = new Float32Array([0.5])
		const config = { pointSize: 6, depthTest: true }

		const data = CacheManager.createNodeData('0-0-0-0', positions, colors, heights, classifications, intensities, config)

		positions[0] = 999
		expect(data.positions[0]).toBe(1)
	})
})

describe('CacheManager.estimateNodeSize', () => {
	test('estimates size for Float64Array positions', () => {
		const positions = new Float64Array(300)
		const colors = new Float32Array(300)
		const heights = new Float32Array(100)
		const classifications = new Uint8Array(100)
		const intensities = new Float32Array(100)

		const size = CacheManager.estimateNodeSize(positions, colors, heights, classifications, intensities)
		// 300 * 8 (Float64) + 300 * 4 (Float32) + 100 * 4 (heights) + 100 * 1 (Uint8) + 100 * 4 (Float32) + 1024 overhead
		expect(size).toBe(300 * 8 + 300 * 4 + 100 * 4 + 100 + 100 * 4 + 1024)
	})

	test('estimates size for Float32Array positions', () => {
		const positions = new Float32Array(300)
		const colors = new Float32Array(300)
		const heights = new Float32Array(100)
		const classifications = new Uint8Array(100)
		const intensities = new Float32Array(100)

		const size = CacheManager.estimateNodeSize(positions, colors, heights, classifications, intensities)
		// 300 * 4 + 300 * 4 + 100 * 4 (heights) + 100 * 1 + 100 * 4 + 1024 overhead
		expect(size).toBe(300 * 4 + 300 * 4 + 100 * 4 + 100 + 100 * 4 + 1024)
	})
})
