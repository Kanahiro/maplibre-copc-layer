import * as THREE from 'three';
import { CacheManager, type CachedNodeData } from './cache-manager';

/** Owns the boundary between a desired COPC view, requests, and resident GPU nodes. */
export class NodeResidency {
	private desired: string[] = [];
	private desiredSet = new Set<string>();
	private inFlight = new Set<string>();
	private failed = new Set<string>();

	constructor(
		private readonly cache: CacheManager,
		private readonly scene: THREE.Scene,
		private readonly request: (nodeId: string) => void,
		private readonly concurrency = 6,
	) {}

	setDesired(nodeIds: string[]): void {
		const next = [...new Set(nodeIds)];
		if (next.length === this.desired.length && next.every((id, i) => id === this.desired[i])) return;
		this.desired = next;
		this.desiredSet = new Set(next);
		for (const id of this.failed) {
			if (!this.desiredSet.has(id)) this.failed.delete(id);
		}
		this.reconcileScene();
		this.fillRequests();
	}

	admit(node: CachedNodeData): void {
		this.inFlight.delete(node.nodeId);
		this.cache.set(node, this.desiredSet);
		this.reconcileScene();
		this.fillRequests();
	}

	fail(nodeId: string): void {
		this.inFlight.delete(nodeId);
		this.failed.add(nodeId);
		this.fillRequests();
	}

	clearCache(): void {
		this.scene.clear();
		this.cache.clear();
		this.failed.clear();
		this.reconcileScene();
		this.fillRequests();
	}

	reset(): void {
		this.desired = [];
		this.desiredSet.clear();
		this.inFlight.clear();
		this.failed.clear();
		this.scene.clear();
		this.cache.clear();
	}

	get protectedNodes(): ReadonlySet<string> {
		return this.desiredSet;
	}

	get visibleCount(): number {
		return this.desired.length;
	}

	get isLoading(): boolean {
		return this.inFlight.size > 0;
	}

	private reconcileScene(): void {
		const wanted = new Set<THREE.Points>();
		for (const id of this.desired) {
			const points = this.cache.get(id)?.points;
			if (points) wanted.add(points);
		}
		for (const child of [...this.scene.children]) {
			if (!wanted.has(child as THREE.Points)) this.scene.remove(child);
		}
		for (const points of wanted) {
			if (points.parent !== this.scene) this.scene.add(points);
		}
	}

	private fillRequests(): void {
		for (const id of this.desired) {
			if (this.inFlight.size >= this.concurrency) break;
			if (this.cache.has(id) || this.inFlight.has(id) || this.failed.has(id)) continue;
			this.inFlight.add(id);
			this.request(id);
		}
	}
}
