import { Vector3 } from 'three';

/**
 * Calculates the Screen Space Error (SSE) for a point cloud node.
 *
 * SSE represents how many pixels on screen the geometric error of a node occupies.
 * Higher SSE means the node's error is more visible, indicating it should be rendered
 * with higher detail (by loading its children).
 *
 * @param cameraCenter - The camera position in world space
 * @param center - The center of the node in world space
 * @param fov - The field of view in degrees
 * @param geometricError - The geometric error of the node (typically voxel size at that level)
 * @param screenHeight - The height of the screen in pixels
 * @param distanceFactor - Optional factor to adjust SSE based on distance (default: 1.0)
 * @returns The calculated Screen Space Error in pixels
 */
export function computeScreenSpaceError(
	cameraCenter: Vector3,
	center: Vector3,
	fov: number,
	geometricError: number,
	screenHeight: number,
	distanceFactor: number = 1.0,
) {
	// Distance between camera and node center
	const distance = cameraCenter.distanceTo(center);

	// Convert FOV from degrees to radians
	const fovInRadians = fov * (Math.PI / 180);

	// Calculate the base SSE using the perspective projection formula:
	// SSE = (geometricError * screenHeight) / (2 * distance * tan(FOV/2))
	let sse =
		(geometricError * screenHeight) /
		(2.0 * distance * Math.tan(fovInRadians / 2.0));

	// Apply distance factor - reduces SSE for distant objects
	// This helps prioritize loading nodes that are closer to the camera
	if (distanceFactor !== 1.0) {
		const normalizedDistance = Math.min(1.0, distance / 1000.0); // Normalize to 0-1 range
		const distanceAdjustment =
			1.0 - normalizedDistance * (1.0 - distanceFactor);
		sse *= distanceAdjustment;
	}

	// Apply frustum culling approximation
	// If the node is far outside the view frustum, reduce its SSE
	const viewVector = new Vector3().subVectors(center, cameraCenter).normalize();
	const forward = new Vector3(0, 0, -1); // Assuming camera looks down negative Z
	const dot = viewVector.dot(forward);

	// If node is behind camera or at extreme angles, reduce SSE
	if (dot < 0.0) {
		sse *= Math.max(0.0, 1.0 + dot); // Gradually reduce SSE as angle increases
	}

	return sse;
}
