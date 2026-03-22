import { describe, expect, test } from 'vitest';
import { computeScreenSpaceError, type Vec3 } from '../src/worker/sse';

describe('computeScreenSpaceError', () => {
	const camera: Vec3 = [0, 0, 0];
	const fov = 60;
	const screenHeight = 1080;

	test('returns higher SSE for closer objects', () => {
		const near: Vec3 = [0, 0, -10];
		const far: Vec3 = [0, 0, -100];
		const geometricError = 1.0;

		const sseNear = computeScreenSpaceError(
			camera,
			near,
			fov,
			geometricError,
			screenHeight,
		);
		const sseFar = computeScreenSpaceError(
			camera,
			far,
			fov,
			geometricError,
			screenHeight,
		);

		expect(sseNear).toBeGreaterThan(sseFar);
	});

	test('returns higher SSE for larger geometric error', () => {
		const center: Vec3 = [0, 0, -50];

		const sseSmall = computeScreenSpaceError(
			camera,
			center,
			fov,
			0.5,
			screenHeight,
		);
		const sseLarge = computeScreenSpaceError(
			camera,
			center,
			fov,
			2.0,
			screenHeight,
		);

		expect(sseLarge).toBeGreaterThan(sseSmall);
	});

	test('returns positive SSE for objects in front of camera', () => {
		const center: Vec3 = [0, 0, -50];
		const sse = computeScreenSpaceError(camera, center, fov, 1.0, screenHeight);
		expect(sse).toBeGreaterThan(0);
	});
});
