export type Vec3 = [number, number, number]

function distance(a: Vec3, b: Vec3): number {
	const dx = a[0] - b[0]
	const dy = a[1] - b[1]
	const dz = a[2] - b[2]
	return Math.sqrt(dx * dx + dy * dy + dz * dz)
}


/**
 * Calculates Screen Space Error (SSE) for a point cloud node.
 * Higher SSE = more visible error = should render with higher detail.
 *
 * @param maxDistance - Optional maximum effective distance. When the camera is
 *   extremely far away (e.g. Globe View at low zoom), the distance is capped
 *   to this value so that SSE does not approach 0.
 */
export function computeScreenSpaceError(
	cameraCenter: Vec3,
	center: Vec3,
	fov: number,
	geometricError: number,
	screenHeight: number,
	maxDistance?: number,
): number {
	let dist = distance(cameraCenter, center)

	// Cap distance to prevent SSE from approaching 0 at extreme camera
	// altitudes (e.g. Globe View at low zoom levels)
	if (maxDistance !== undefined && dist > maxDistance) {
		dist = maxDistance
	}

	const fovRad = fov * (Math.PI / 180)

	return (
		(geometricError * screenHeight) /
		(2.0 * dist * Math.tan(fovRad / 2.0))
	)
}
