import type { Vec3 } from './sse';

/** Conservative clip-space test: reject only if every corner is beyond one plane. */
export function intersectsFrustum(corners: Vec3[], matrix: number[], origin: Vec3): boolean {
  const points = corners.map(([x, y, z]) => {
    x -= origin[0]; y -= origin[1]; z -= origin[2];
    return [
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
      matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15],
    ];
  });
  // A box crossing the eye plane should be kept; perspective division is unstable there.
  if (points.some((point) => point[3] <= 0)) return true;
  const margin = 1.2;
  for (let axis = 0; axis < 3; axis++) {
    if (points.every((p) => p[axis] < -margin * p[3])) return false;
    if (points.every((p) => p[axis] > margin * p[3])) return false;
  }
  return true;
}
