import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { CacheManager, type CachedNodeData } from '../src/cache-manager';
import { NodeResidency } from '../src/node-residency';

function node(id: string): CachedNodeData {
	const geometry = new THREE.BufferGeometry();
	return {
		nodeId: id,
		positions: new Float64Array(3),
		colors: new Float32Array(3),
		heights: new Float32Array(1),
		classifications: new Uint8Array(1),
		intensities: new Float32Array(1),
		pointCount: 1,
		geometry,
		points: new THREE.Points(geometry, new THREE.PointsMaterial()),
		materialConfig: { pointSize: 1, depthTest: true },
		lastAccessed: 0,
		sizeBytes: 100,
	};
}

describe('NodeResidency', () => {
	test('keeps ancestor points visible as descendants arrive and reuses offscreen nodes', () => {
		const cache = new CacheManager({ maxMemoryBytes: 1000 });
		const scene = new THREE.Scene();
		const requests: string[] = [];
		const residency = new NodeResidency(cache, scene, (id) => requests.push(id), 1);
		residency.setDesired(['0-0-0-0', '1-0-0-0']);
		expect(requests).toEqual(['0-0-0-0']);
		residency.admit(node('0-0-0-0'));
		expect(scene.children).toHaveLength(1);
		expect(requests).toEqual(['0-0-0-0', '1-0-0-0']);
		residency.admit(node('1-0-0-0'));
		expect(scene.children).toHaveLength(2);
		residency.setDesired(['0-0-0-0']);
		expect(scene.children).toHaveLength(1);
		expect(cache.has('1-0-0-0')).toBe(true);
		residency.setDesired(['0-0-0-0', '1-0-0-0']);
		expect(scene.children).toHaveLength(2);
		expect(requests).toHaveLength(2);
	});

	test('keeps a completed request after it leaves the view', () => {
		const cache = new CacheManager({ maxMemoryBytes: 1000 });
		const scene = new THREE.Scene();
		const requests: string[] = [];
		const residency = new NodeResidency(cache, scene, (id) => requests.push(id));
		residency.setDesired(['a']);
		residency.setDesired(['b']);
		residency.admit(node('a'));
		expect(cache.has('a')).toBe(true);
		expect(scene.children).toHaveLength(0);
		residency.setDesired(['a']);
		expect(scene.children).toHaveLength(1);
		expect(requests).toEqual(['a', 'b']);
	});
});
