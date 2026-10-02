import { DEG2RAD, EARTH_CIRCUMFERENCE } from '../constants';
import type { Vec3 } from './sse';

export function toMercator([lon, lat, height]: Vec3): Vec3 {
  const latRad = Math.max(-85.051129, Math.min(85.051129, lat)) * DEG2RAD;
  const sinLat = Math.sin(latRad);
  return [
    0.5 + lon / 360,
    0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI),
    height / EARTH_CIRCUMFERENCE,
  ];
}
