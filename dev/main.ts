import GUI from 'lil-gui';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
	CopcLayer,
	type ColorMode,
	type ColorExpression,
	type PointFilter,
} from '../src/index';
import { GlobeControl } from './globe-control';

const CLASSIFICATION_LABELS: Record<number, string> = {
	0: 'Never Classified',
	1: 'Unclassified',
	2: 'Ground',
	3: 'Low Vegetation',
	4: 'Medium Vegetation',
	5: 'High Vegetation',
	6: 'Building',
	7: 'Low Point (noise)',
	8: 'Model Key-point',
	9: 'Water',
	10: 'Rail',
	11: 'Road Surface',
	12: 'Overlap',
	17: 'Bridge Deck',
	18: 'High Noise',
};

const DEFAULT_CLASSIFICATION_COLORS: Record<number, [number, number, number]> =
	{
		0: [0.5, 0.5, 0.5],
		1: [0.7, 0.7, 0.7],
		2: [0.6, 0.4, 0.2],
		3: [0.5, 0.8, 0.5],
		4: [0.2, 0.7, 0.2],
		5: [0.0, 0.4, 0.0],
		6: [1.0, 0.2, 0.2],
		7: [0.3, 0.3, 0.3],
		8: [0.6, 0.3, 0.8],
		9: [0.2, 0.4, 1.0],
		10: [1.0, 0.6, 0.0],
		11: [0.9, 0.9, 0.3],
		12: [0.0, 0.8, 0.8],
		17: [0.9, 0.5, 0.4],
		18: [0.5, 0.0, 0.0],
	};

function rgbToHex(r: number, g: number, b: number): string {
	const toHex = (v: number) =>
		Math.round(v * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgb(hex: string): [number, number, number] {
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;
	return [r, g, b];
}

interface ColorStop {
	value: number;
	color: string;
}

function buildColorExpression(
	mode: 'linear' | 'discrete',
	stops: ColorStop[],
): ColorExpression {
	const expr: (string | number | [number, number, number])[] = [mode];
	for (const stop of stops) {
		expr.push(stop.value);
		expr.push(hexToRgb(stop.color));
	}
	return expr as unknown as ColorExpression;
}

// --- State ---

const params = new URLSearchParams(window.location.search);

const state = {
	url: params.get('copc') ?? '',
	pointSize: 4,
	colorMode: 'rgb' as ColorMode,
	sseThreshold: 2,
	depthTest: true,
	enableEDL: true,
	edlStrength: 5,
	edlRadius: 1.5,
	stats: '',
};

const classificationHexColors: Record<string, string> = {};
for (const [code, rgb] of Object.entries(DEFAULT_CLASSIFICATION_COLORS)) {
	classificationHexColors[code] = rgbToHex(...rgb);
}

const classificationVisibility: Record<string, boolean> = {};
for (const code of Object.keys(CLASSIFICATION_LABELS)) {
	classificationVisibility[code] = true;
}

const filterState = {
	intensityMin: 0,
	intensityMax: 1,
	bboxMinX: 0,
	bboxMaxX: 0,
	bboxMinY: 0,
	bboxMaxY: 0,
	bboxMinZ: 0,
	bboxMaxZ: 0,
};

const heightColorState = {
	mode: 'linear' as 'linear' | 'discrete',
	stops: [] as ColorStop[],
};

const intensityColorState = {
	mode: 'linear' as 'linear' | 'discrete',
	stops: [
		{ value: 0, color: '#000000' },
		{ value: 1, color: '#ffffff' },
	] as ColorStop[],
};

let bboxBounds: {
	minx: number;
	maxx: number;
	miny: number;
	maxy: number;
	minz: number;
	maxz: number;
} | null = null;

// --- Map ---

const map = new maplibregl.Map({
	container: 'map',
	style: {
		version: 8,
		sources: {
			osm: {
				type: 'raster',
				tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
				tileSize: 256,
				attribution: '&copy; OpenStreetMap contributors',
				maxzoom: 18,
			},
		},
		projection: { type: 'globe' },
		layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
	},
	center: [139.7, 35.7],
	zoom: 10,
	maxPitch: 85,
	hash: true,
});

let copcLayer: CopcLayer | null = null;

function getClassificationColorsMap(): Record<
	number,
	[number, number, number]
> {
	const result: Record<number, [number, number, number]> = {};
	for (const [code, hex] of Object.entries(classificationHexColors)) {
		result[Number(code)] = hexToRgb(hex);
	}
	return result;
}

function applyFilter() {
	if (!copcLayer) return;
	const filter: PointFilter = {};

	const visibleClasses = new Set<number>();
	let allVisible = true;
	for (const [code, visible] of Object.entries(classificationVisibility)) {
		if (visible) {
			visibleClasses.add(Number(code));
		} else {
			allVisible = false;
		}
	}
	if (!allVisible) {
		filter.classification = visibleClasses;
	}

	if (filterState.intensityMin > 0 || filterState.intensityMax < 1) {
		filter.intensityRange = [
			filterState.intensityMin,
			filterState.intensityMax,
		];
	}

	if (bboxBounds) {
		const bbox: Record<string, number> = {};
		if (filterState.bboxMinX > bboxBounds.minx)
			bbox.minx = filterState.bboxMinX;
		if (filterState.bboxMaxX < bboxBounds.maxx)
			bbox.maxx = filterState.bboxMaxX;
		if (filterState.bboxMinY > bboxBounds.miny)
			bbox.miny = filterState.bboxMinY;
		if (filterState.bboxMaxY < bboxBounds.maxy)
			bbox.maxy = filterState.bboxMaxY;
		if (filterState.bboxMinZ > bboxBounds.minz)
			bbox.minz = filterState.bboxMinZ;
		if (filterState.bboxMaxZ < bboxBounds.maxz)
			bbox.maxz = filterState.bboxMaxZ;
		if (Object.keys(bbox).length > 0) {
			filter.bbox = bbox;
		}
	}

	copcLayer.setFilter(filter);
}

function loadCopc() {
	const copcUrl = state.url.trim();
	if (!copcUrl) return;

	if (copcLayer) {
		map.removeLayer(copcLayer.id);
		copcLayer = null;
	}

	const url = new URL(window.location.href);
	url.searchParams.set('copc', copcUrl);
	window.history.replaceState({}, '', url);

	copcLayer = new CopcLayer(copcUrl, {
		pointSize: state.pointSize,
		colorMode: state.colorMode,
		heightColor:
			heightColorState.stops.length >= 2
				? buildColorExpression(
						heightColorState.mode,
						heightColorState.stops,
					)
				: undefined,
		intensityColor: buildColorExpression(
			intensityColorState.mode,
			intensityColorState.stops,
		),
		classificationColors: getClassificationColorsMap(),
		sseThreshold: state.sseThreshold,
		depthTest: state.depthTest,
		enableEDL: state.enableEDL,
		edlStrength: state.edlStrength,
		edlRadius: state.edlRadius,
		debug: true,
		alwaysShowRoot: true,
		onInitialized: (message) => {
			const { bounds } = message;
			map.flyTo({
				center: [
					(bounds.minx + bounds.maxx) / 2,
					(bounds.miny + bounds.maxy) / 2,
				],
				zoom: 16,
			});
			setupBboxSliders(bounds);
			if (heightColorState.stops.length === 0) {
				heightColorState.stops = [
					{ value: bounds.minz, color: '#0000ff' },
					{
						value: (bounds.minz + bounds.maxz) / 2,
						color: '#ffff00',
					},
					{ value: bounds.maxz, color: '#ff0000' },
				];
			}
			rebuildHeightColorFolder(bounds.minz, bounds.maxz);
		},
	});

	map.addLayer(copcLayer);
}

// --- GUI ---

const guiContainer = document.createElement('div');
guiContainer.style.cssText = 'position:absolute;top:0;left:0;z-index:1000;';
document.body.appendChild(guiContainer);

const gui = new GUI({ title: 'COPC Viewer', container: guiContainer });
gui.domElement.style.setProperty('--name-width', '120px');
gui.domElement.style.maxWidth = '100%';
gui.domElement.style.width = '480px';

gui.add(state, 'url').name('URL').onFinishChange(loadCopc);
gui.add({ load: loadCopc }, 'load').name('Load Point Cloud');
gui.add(state, 'stats').name('Stats').listen().disable();

const rendering = gui.addFolder('Rendering');
rendering
	.add(state, 'pointSize', 1, 20, 1)
	.name('Point Size')
	.onChange((v: number) => {
		copcLayer?.setPointSize(v);
	});
rendering
	.add(state, 'colorMode', [
		'rgb',
		'height',
		'intensity',
		'classification',
		'white',
	])
	.name('Color Mode')
	.onChange(() => {
		classificationFolder.show(state.colorMode === 'classification');
		heightColorFolder.show(state.colorMode === 'height');
		intensityColorFolder.show(state.colorMode === 'intensity');
		copcLayer?.setColorMode(state.colorMode);
	});
rendering
	.add(state, 'sseThreshold', 1, 20, 1)
	.name('SSE Threshold')
	.onChange((v: number) => {
		copcLayer?.setSseThreshold(v);
	});
rendering
	.add(state, 'depthTest')
	.name('Depth Test')
	.onChange((v: boolean) => {
		copcLayer?.setDepthTest(v);
	});

const edl = gui.addFolder('Eye-Dome Lighting');
edl
	.add(state, 'enableEDL')
	.name('Enable')
	.onChange((v: boolean) => {
		copcLayer?.setEDLEnabled(v);
	});
edl
	.add(state, 'edlStrength', 0, 10, 0.1)
	.name('Strength')
	.onChange((v: number) => {
		copcLayer?.setEDLParameters({ strength: v });
	});
edl
	.add(state, 'edlRadius', 0, 5, 0.1)
	.name('Radius')
	.onChange((v: number) => {
		copcLayer?.setEDLParameters({ radius: v });
	});

const classificationFolder = gui.addFolder('Classification Colors');
for (const code of Object.keys(classificationHexColors)) {
	const num = Number(code);
	const label = CLASSIFICATION_LABELS[num] ?? `Class ${code}`;
	classificationFolder
		.addColor(classificationHexColors, code)
		.name(`${code}: ${label}`)
		.onChange(() => {
			copcLayer?.setClassificationColors(getClassificationColorsMap());
		});
}
classificationFolder.show(state.colorMode === 'classification');

function applyHeightColor() {
	if (!copcLayer || heightColorState.stops.length < 2) return;
	copcLayer.setHeightColor(
		buildColorExpression(heightColorState.mode, heightColorState.stops),
	);
}

function applyIntensityColor() {
	if (!copcLayer) return;
	copcLayer.setIntensityColor(
		buildColorExpression(
			intensityColorState.mode,
			intensityColorState.stops,
		),
	);
}

// --- Height Color ---

let heightColorFolder = gui.addFolder('Height Color');
heightColorFolder.show(state.colorMode === 'height');

function rebuildHeightColorFolder(minz: number, maxz: number) {
	heightColorFolder.destroy();
	heightColorFolder = gui.addFolder('Height Color');
	heightColorFolder.show(state.colorMode === 'height');

	const step = Math.max(0.01, (maxz - minz) / 1000);

	heightColorFolder
		.add(heightColorState, 'mode', ['linear', 'discrete'])
		.name('Mode')
		.onChange(applyHeightColor);

	for (let idx = 0; idx < heightColorState.stops.length; idx++) {
		const stop = heightColorState.stops[idx];
		const stopFolder = heightColorFolder.addFolder(`Stop ${idx + 1}`);
		stopFolder
			.add(stop, 'value', minz, maxz, step)
			.name('Height (m)')
			.onChange(applyHeightColor);
		stopFolder
			.addColor(stop, 'color')
			.name('Color')
			.onChange(applyHeightColor);
	}

	heightColorFolder
		.add(
			{
				add: () => {
					heightColorState.stops.push({
						value: maxz,
						color: '#ffffff',
					});
					rebuildHeightColorFolder(minz, maxz);
					applyHeightColor();
				},
			},
			'add',
		)
		.name('+ Add Stop');

	if (heightColorState.stops.length > 2) {
		heightColorFolder
			.add(
				{
					remove: () => {
						heightColorState.stops.pop();
						rebuildHeightColorFolder(minz, maxz);
						applyHeightColor();
					},
				},
				'remove',
			)
			.name('- Remove Last Stop');
	}
}

// --- Intensity Color ---

let intensityColorFolder = gui.addFolder('Intensity Color');
intensityColorFolder.show(state.colorMode === 'intensity');

function rebuildIntensityColorFolder() {
	intensityColorFolder.destroy();
	intensityColorFolder = gui.addFolder('Intensity Color');
	intensityColorFolder.show(state.colorMode === 'intensity');

	intensityColorFolder
		.add(intensityColorState, 'mode', ['linear', 'discrete'])
		.name('Mode')
		.onChange(applyIntensityColor);

	for (let idx = 0; idx < intensityColorState.stops.length; idx++) {
		const stop = intensityColorState.stops[idx];
		const stopFolder = intensityColorFolder.addFolder(`Stop ${idx + 1}`);
		stopFolder
			.add(stop, 'value', 0, 1, 0.01)
			.name('Intensity')
			.onChange(applyIntensityColor);
		stopFolder
			.addColor(stop, 'color')
			.name('Color')
			.onChange(applyIntensityColor);
	}

	intensityColorFolder
		.add(
			{
				add: () => {
					intensityColorState.stops.push({
						value: 1,
						color: '#ffffff',
					});
					rebuildIntensityColorFolder();
					applyIntensityColor();
				},
			},
			'add',
		)
		.name('+ Add Stop');

	if (intensityColorState.stops.length > 2) {
		intensityColorFolder
			.add(
				{
					remove: () => {
						intensityColorState.stops.pop();
						rebuildIntensityColorFolder();
						applyIntensityColor();
					},
				},
				'remove',
			)
			.name('- Remove Last Stop');
	}
}

rebuildIntensityColorFolder();

const filterFolder = gui.addFolder('Filters');

const classFilterFolder = filterFolder.addFolder('Classification');
for (const code of Object.keys(CLASSIFICATION_LABELS)) {
	const num = Number(code);
	const label = CLASSIFICATION_LABELS[num] ?? `Class ${code}`;
	classFilterFolder
		.add(classificationVisibility, code)
		.name(`${code}: ${label}`)
		.onChange(applyFilter);
}

let bboxFolder = filterFolder.addFolder('Bbox (WGS84)');

function setupBboxSliders(bounds: {
	minx: number;
	maxx: number;
	miny: number;
	maxy: number;
	minz: number;
	maxz: number;
}) {
	bboxBounds = bounds;
	filterState.bboxMinX = bounds.minx;
	filterState.bboxMaxX = bounds.maxx;
	filterState.bboxMinY = bounds.miny;
	filterState.bboxMaxY = bounds.maxy;
	filterState.bboxMinZ = bounds.minz;
	filterState.bboxMaxZ = bounds.maxz;

	bboxFolder.destroy();
	bboxFolder = filterFolder.addFolder('Bbox (WGS84)');

	const lngStep = (bounds.maxx - bounds.minx) / 1000;
	const latStep = (bounds.maxy - bounds.miny) / 1000;
	const zStep = Math.max(0.1, (bounds.maxz - bounds.minz) / 1000);

	bboxFolder
		.add(filterState, 'bboxMinX', bounds.minx, bounds.maxx, lngStep)
		.name('Min X (lng)')
		.onChange(applyFilter);
	bboxFolder
		.add(filterState, 'bboxMaxX', bounds.minx, bounds.maxx, lngStep)
		.name('Max X (lng)')
		.onChange(applyFilter);
	bboxFolder
		.add(filterState, 'bboxMinY', bounds.miny, bounds.maxy, latStep)
		.name('Min Y (lat)')
		.onChange(applyFilter);
	bboxFolder
		.add(filterState, 'bboxMaxY', bounds.miny, bounds.maxy, latStep)
		.name('Max Y (lat)')
		.onChange(applyFilter);
	bboxFolder
		.add(filterState, 'bboxMinZ', bounds.minz, bounds.maxz, zStep)
		.name('Min Z (m)')
		.onChange(applyFilter);
	bboxFolder
		.add(filterState, 'bboxMaxZ', bounds.minz, bounds.maxz, zStep)
		.name('Max Z (m)')
		.onChange(applyFilter);
}

const intensityFolder = filterFolder.addFolder('Intensity');
intensityFolder
	.add(filterState, 'intensityMin', 0, 1, 0.01)
	.name('Min')
	.onChange(applyFilter);
intensityFolder
	.add(filterState, 'intensityMax', 0, 1, 0.01)
	.name('Max')
	.onChange(applyFilter);

// --- Init ---

map.addControl(new GlobeControl());

map.on('load', () => {
	if (state.url) loadCopc();
});

setInterval(() => {
	if (copcLayer) {
		const stats = copcLayer.getNodeStats();
		const loading = copcLayer.isLoading();
		state.stats = `Nodes: ${stats.visible} visible / ${stats.loaded} cached${loading ? ' (loading...)' : ''}`;
	} else {
		state.stats = '';
	}
}, 1000);
