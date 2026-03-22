import { DEG2RAD } from '../constants';

export type Vec3 = [number, number, number];

function distance(a: Vec3, b: Vec3): number {
	const dx = a[0] - b[0];
	const dy = a[1] - b[1];
	const dz = a[2] - b[2];
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Calculates Screen Space Error (SSE) for a point cloud node.
 * Higher SSE = more visible error = should render with higher detail.
 */
export function computeScreenSpaceError(
	cameraCenter: Vec3,
	center: Vec3,
	fov: number,
	geometricError: number,
	screenHeight: number,
): number {
	const dist = distance(cameraCenter, center);
	const fovRad = fov * DEG2RAD;

	return (
		(geometricError * screenHeight) / (2.0 * dist * Math.tan(fovRad / 2.0))
	);
}
