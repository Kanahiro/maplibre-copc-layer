import { expect, test } from 'vitest';
import { intersectsFrustum } from '../src/worker/frustum';
import type { Vec3 } from '../src/worker/sse';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const box = (x: number): Vec3[] => [
  [x, -0.1, -0.1], [x, -0.1, 0.1], [x, 0.1, -0.1], [x, 0.1, 0.1],
  [x + 0.2, -0.1, -0.1], [x + 0.2, -0.1, 0.1], [x + 0.2, 0.1, -0.1], [x + 0.2, 0.1, 0.1],
];

test('keeps a box crossing the viewport', () => {
  expect(intersectsFrustum(box(0.9), identity, [0, 0, 0])).toBe(true);
});
test('rejects a box outside a frustum plane', () => {
  expect(intersectsFrustum(box(3), identity, [0, 0, 0])).toBe(false);
});
test('subtracts the scene origin', () => {
  expect(intersectsFrustum(box(100), identity, [100, 0, 0])).toBe(true);
});
