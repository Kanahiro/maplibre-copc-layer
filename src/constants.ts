export const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137.0;
export const DEG2RAD = Math.PI / 180;

export const DEFAULT_CLASSIFICATION_COLORS: Record<
	number,
	[number, number, number]
> = {
	0: [0.5, 0.5, 0.5], // Never Classified
	1: [0.7, 0.7, 0.7], // Unclassified
	2: [0.6, 0.4, 0.2], // Ground
	3: [0.5, 0.8, 0.5], // Low Vegetation
	4: [0.2, 0.7, 0.2], // Medium Vegetation
	5: [0.0, 0.4, 0.0], // High Vegetation
	6: [1.0, 0.2, 0.2], // Building
	7: [0.3, 0.3, 0.3], // Low Point (noise)
	8: [0.6, 0.3, 0.8], // Model Key-point
	9: [0.2, 0.4, 1.0], // Water
	10: [1.0, 0.6, 0.0], // Rail
	11: [0.9, 0.9, 0.3], // Road Surface
	12: [0.0, 0.8, 0.8], // Overlap
	17: [0.9, 0.5, 0.4], // Bridge Deck
	18: [0.5, 0.0, 0.0], // High Noise
};
