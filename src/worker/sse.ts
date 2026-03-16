export type Vec3 = [number, number, number]

function distance(a: Vec3, b: Vec3): number {
	const dx = a[0] - b[0]
	const dy = a[1] - b[1]
	const dz = a[2] - b[2]
	return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function dot(a: Vec3, b: Vec3): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function normalize(v: Vec3): Vec3 {
	const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
	if (len === 0) return [0, 0, 0]
	return [v[0] / len, v[1] / len, v[2] / len]
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
	distanceFactor: number = 1.0,
): number {
	const dist = distance(cameraCenter, center)
	const fovRad = fov * (Math.PI / 180)

	let sse =
		(geometricError * screenHeight) /
		(2.0 * dist * Math.tan(fovRad / 2.0))

	// Apply distance factor
	if (distanceFactor !== 1.0) {
		const normalizedDistance = Math.min(1.0, dist / 1000.0)
		const distanceAdjustment =
			1.0 - normalizedDistance * (1.0 - distanceFactor)
		sse *= distanceAdjustment
	}

	// Frustum culling approximation
	const viewVector = normalize([
		center[0] - cameraCenter[0],
		center[1] - cameraCenter[1],
		center[2] - cameraCenter[2],
	])
	const forward: Vec3 = [0, 0, -1]
	const d = dot(viewVector, forward)

	if (d < 0.0) {
		sse *= Math.max(0.0, 1.0 + d)
	}

	return sse
}
