/**
 * Cache Management System for COPC Node Data
 * 
 * Implements efficient LRU-based caching on main thread to reduce
 * worker communication overhead and improve rendering performance.
 */

import * as THREE from 'three';

/**
 * Cached node data structure containing all necessary information
 * for immediate rendering without worker communication
 */
export interface CachedNodeData {
	/** Unique node identifier (e.g., "3-4-5-6") */
	nodeId: string;
	/** Position buffer data for points */
	positions: Float32Array;
	/** Color buffer data for points */
	colors: Float32Array;
	/** Number of points in this node */
	pointCount: number;
	/** Three.js geometry object (cached for reuse) */
	geometry?: THREE.BufferGeometry;
	/** Three.js points object (cached for reuse) */
	points?: THREE.Points;
	/** Material configuration used for this node */
	materialConfig: {
		colorMode: string;
		pointSize: number;
		depthTest: boolean;
	};
	/** Last access timestamp for LRU algorithm */
	lastAccessed: number;
	/** Size estimate in bytes for memory management */
	sizeBytes: number;
}

/**
 * Cache statistics for monitoring performance
 */
export interface CacheStats {
	/** Total number of cached items */
	size: number;
	/** Number of cache hits */
	hits: number;
	/** Number of cache misses */
	misses: number;
	/** Cache hit ratio (0-1) */
	hitRatio: number;
	/** Total memory usage estimate in bytes */
	memoryUsage: number;
	/** Maximum allowed memory usage in bytes */
	maxMemoryUsage: number;
}

/**
 * Configuration options for the cache manager
 */
export interface CacheManagerOptions {
	/** Maximum number of nodes to cache */
	maxNodes?: number;
	/** Maximum memory usage in bytes (default: 100MB) */
	maxMemoryBytes?: number;
	/** Enable verbose logging for debugging */
	enableLogging?: boolean;
}

/**
 * High-performance LRU cache manager for COPC node data
 * 
 * Features:
 * - LRU eviction strategy
 * - Memory usage monitoring
 * - Three.js object caching
 * - Performance metrics
 * - Efficient O(1) operations
 */
export class CacheManager {
	private cache = new Map<string, CachedNodeData>();
	private accessOrder: string[] = [];
	private stats: CacheStats;
	private options: Required<CacheManagerOptions>;
	
	/**
	 * Create a new cache manager instance
	 */
	constructor(options: CacheManagerOptions = {}) {
		this.options = {
			maxNodes: options.maxNodes ?? 100,
			maxMemoryBytes: options.maxMemoryBytes ?? 100 * 1024 * 1024, // 100MB
			enableLogging: options.enableLogging ?? false,
		};
		
		this.stats = {
			size: 0,
			hits: 0,
			misses: 0,
			hitRatio: 0,
			memoryUsage: 0,
			maxMemoryUsage: this.options.maxMemoryBytes,
		};
		
		this.log('Cache manager initialized', this.options);
	}
	
	/**
	 * Get cached node data if available
	 * 
	 * @param nodeId - Node identifier
	 * @returns Cached data or null if not found
	 */
	get(nodeId: string): CachedNodeData | null {
		const data = this.cache.get(nodeId);
		
		if (data) {
			// Update LRU order
			this.updateAccessOrder(nodeId);
			data.lastAccessed = Date.now();
			this.stats.hits++;
			this.log(`Cache HIT for node ${nodeId}`);
			return data;
		}
		
		this.stats.misses++;
		this.log(`Cache MISS for node ${nodeId}`);
		return null;
	}
	
	/**
	 * Store node data in cache
	 * 
	 * @param nodeData - Complete node data to cache
	 */
	set(nodeData: CachedNodeData): void {
		const { nodeId } = nodeData;
		
		// Check if already exists (update case)
		const existing = this.cache.get(nodeId);
		if (existing) {
			// Dispose old Three.js resources
			this.disposeNodeResources(existing);
			this.stats.memoryUsage -= existing.sizeBytes;
		}
		
		// Ensure cache size limits before adding
		this.ensureCacheLimits(nodeData.sizeBytes);
		
		// Add to cache
		nodeData.lastAccessed = Date.now();
		this.cache.set(nodeId, nodeData);
		this.updateAccessOrder(nodeId);
		this.stats.memoryUsage += nodeData.sizeBytes;
		this.stats.size = this.cache.size;
		
		this.log(`Cached node ${nodeId} (${this.formatBytes(nodeData.sizeBytes)})`);
		this.updateHitRatio();
	}
	
	/**
	 * Check if node is cached
	 * 
	 * @param nodeId - Node identifier
	 * @returns True if cached
	 */
	has(nodeId: string): boolean {
		return this.cache.has(nodeId);
	}
	
	/**
	 * Remove specific node from cache
	 * 
	 * @param nodeId - Node identifier
	 * @returns True if node was removed
	 */
	delete(nodeId: string): boolean {
		const data = this.cache.get(nodeId);
		if (!data) return false;
		
		this.disposeNodeResources(data);
		this.cache.delete(nodeId);
		this.removeFromAccessOrder(nodeId);
		this.stats.memoryUsage -= data.sizeBytes;
		this.stats.size = this.cache.size;
		
		this.log(`Removed node ${nodeId} from cache`);
		return true;
	}
	
	/**
	 * Clear all cached data
	 */
	clear(): void {
		// Dispose all Three.js resources
		for (const data of this.cache.values()) {
			this.disposeNodeResources(data);
		}
		
		this.cache.clear();
		this.accessOrder.length = 0;
		this.stats.memoryUsage = 0;
		this.stats.size = 0;
		
		this.log('Cache cleared');
	}
	
	/**
	 * Get current cache statistics
	 */
	getStats(): Readonly<CacheStats> {
		return { ...this.stats };
	}
	
	/**
	 * Update cache configuration
	 */
	updateOptions(newOptions: Partial<CacheManagerOptions>): void {
		Object.assign(this.options, newOptions);
		
		if (newOptions.maxMemoryBytes) {
			this.stats.maxMemoryUsage = newOptions.maxMemoryBytes;
		}
		
		// Enforce new limits immediately
		this.ensureCacheLimits(0);
		this.log('Cache options updated', this.options);
	}
	
	/**
	 * Get all cached node IDs
	 */
	getCachedNodeIds(): string[] {
		return Array.from(this.cache.keys());
	}
	
	/**
	 * Estimate memory usage of node data
	 */
	static estimateNodeSize(positions: Float32Array, colors: Float32Array): number {
		// Float32Array: 4 bytes per float
		// Add overhead for objects and metadata
		const bufferSize = (positions.length + colors.length) * 4;
		const objectOverhead = 1024; // Estimate for JS objects
		return bufferSize + objectOverhead;
	}
	
	/**
	 * Create cached node data from raw buffers
	 */
	static createNodeData(
		nodeId: string,
		positions: Float32Array,
		colors: Float32Array,
		materialConfig: CachedNodeData['materialConfig']
	): CachedNodeData {
		return {
			nodeId,
			positions: new Float32Array(positions), // Copy to ensure independence
			colors: new Float32Array(colors),
			pointCount: positions.length / 3,
			materialConfig: { ...materialConfig },
			lastAccessed: Date.now(),
			sizeBytes: CacheManager.estimateNodeSize(positions, colors),
		};
	}
	
	/**
	 * Update LRU access order
	 */
	private updateAccessOrder(nodeId: string): void {
		// Remove from current position
		this.removeFromAccessOrder(nodeId);
		// Add to end (most recently used)
		this.accessOrder.push(nodeId);
	}
	
	/**
	 * Remove node from access order array
	 */
	private removeFromAccessOrder(nodeId: string): void {
		const index = this.accessOrder.indexOf(nodeId);
		if (index > -1) {
			this.accessOrder.splice(index, 1);
		}
	}
	
	/**
	 * Ensure cache stays within size and memory limits
	 */
	private ensureCacheLimits(newItemSize: number): void {
		// Check if we need to make space
		while (
			(this.cache.size >= this.options.maxNodes) ||
			(this.stats.memoryUsage + newItemSize > this.options.maxMemoryBytes)
		) {
			if (this.accessOrder.length === 0) break;
			
			// Remove least recently used item
			const lruNodeId = this.accessOrder[0];
			const success = this.delete(lruNodeId);
			
			if (!success) {
				// Safety fallback - should not happen
				this.accessOrder.shift();
			}
		}
	}
	
	/**
	 * Dispose Three.js resources for a node
	 */
	private disposeNodeResources(data: CachedNodeData): void {
		if (data.geometry) {
			data.geometry.dispose();
		}
		if (data.points?.material instanceof THREE.Material) {
			data.points.material.dispose();
		}
	}
	
	/**
	 * Update hit ratio statistics
	 */
	private updateHitRatio(): void {
		const total = this.stats.hits + this.stats.misses;
		this.stats.hitRatio = total > 0 ? this.stats.hits / total : 0;
	}
	
	/**
	 * Format bytes for human-readable display
	 */
	private formatBytes(bytes: number): string {
		const sizes = ['B', 'KB', 'MB', 'GB'];
		if (bytes === 0) return '0 B';
		const i = Math.floor(Math.log(bytes) / Math.log(1024));
		return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
	}
	
	/**
	 * Conditional logging
	 */
	private log(message: string, data?: any): void {
		if (this.options.enableLogging) {
			const prefix = '[CacheManager]';
			if (data) {
				console.log(prefix, message, data);
			} else {
				console.log(prefix, message);
			}
		}
	}
}