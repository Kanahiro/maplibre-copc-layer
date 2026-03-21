import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { CopcLayer, type ColorMode } from '../src/index';
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

const DEFAULT_CLASSIFICATION_COLORS: Record<number, [number, number, number]> = {
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

const classificationColors: Record<number, [number, number, number]> = {
	...DEFAULT_CLASSIFICATION_COLORS,
};

function rgbToHex(r: number, g: number, b: number): string {
	const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgb(hex: string): [number, number, number] {
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;
	return [r, g, b];
}

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
		projection: {
			type: 'globe',
		},
		layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
	},
	center: [139.7, 35.7],
	zoom: 10,
	maxPitch: 85,
	hash: true,
});

let copcLayer: CopcLayer | null = null;

const urlInput = document.getElementById('url-input') as HTMLInputElement;
const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
const statsEl = document.getElementById('stats') as HTMLDivElement;
const paramsToggle = document.getElementById(
	'params-toggle',
) as HTMLButtonElement;
const paramsEl = document.getElementById('params') as HTMLDivElement;
const legendEl = document.getElementById('classification-legend') as HTMLDivElement;

// Parameter controls
const pointSizeInput = document.getElementById('pointSize') as HTMLInputElement;
const pointSizeVal = document.getElementById(
	'pointSize-val',
) as HTMLSpanElement;
const colorModeSelect = document.getElementById(
	'colorMode',
) as HTMLSelectElement;
const sseThresholdInput = document.getElementById(
	'sseThreshold',
) as HTMLInputElement;
const sseThresholdVal = document.getElementById(
	'sseThreshold-val',
) as HTMLSpanElement;
const depthTestInput = document.getElementById('depthTest') as HTMLInputElement;
const enableEDLInput = document.getElementById('enableEDL') as HTMLInputElement;
const edlStrengthInput = document.getElementById(
	'edlStrength',
) as HTMLInputElement;
const edlStrengthVal = document.getElementById(
	'edlStrength-val',
) as HTMLSpanElement;
const edlRadiusInput = document.getElementById('edlRadius') as HTMLInputElement;
const edlRadiusVal = document.getElementById(
	'edlRadius-val',
) as HTMLSpanElement;
// Restore COPC URL from query params
const params = new URLSearchParams(window.location.search);
const initialUrl = params.get('copc');
if (initialUrl) {
	urlInput.value = initialUrl;
}

function loadCopc(copcUrl: string) {
	if (copcLayer) {
		map.removeLayer(copcLayer.id);
		copcLayer = null;
	}

	// Save to URL params
	const url = new URL(window.location.href);
	url.searchParams.set('copc', copcUrl);
	window.history.replaceState({}, '', url);

	const pointSize = Number(pointSizeInput.value);
	const colorMode = colorModeSelect.value as ColorMode;
	const sseThreshold = Number(sseThresholdInput.value);
	const depthTest = depthTestInput.checked;
	const enableEDL = enableEDLInput.checked;
	const edlStrength = Number(edlStrengthInput.value);
	const edlRadius = Number(edlRadiusInput.value);

	copcLayer = new CopcLayer(copcUrl, {
		pointSize,
		colorMode,
		classificationColors,
		sseThreshold,
		depthTest,
		enableEDL,
		edlStrength,
		edlRadius,
		debug: true,
		onInitialized: (message) => {
			map.flyTo({ center: message.center, zoom: 16 });
		},
	});

	map.addLayer(copcLayer);
	paramsToggle.classList.add('visible');
	paramsToggle.classList.add('open');
	paramsEl.classList.add('visible');
}

loadBtn.addEventListener('click', () => {
	const value = urlInput.value.trim();
	if (value) loadCopc(value);
});

urlInput.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		const value = urlInput.value.trim();
		if (value) loadCopc(value);
	}
});

// Toggle params panel
paramsToggle.addEventListener('click', () => {
	const isOpen = paramsToggle.classList.toggle('open');
	paramsEl.classList.toggle('visible', isOpen);
});

// Parameter event handlers
pointSizeInput.addEventListener('input', () => {
	const v = Number(pointSizeInput.value);
	pointSizeVal.textContent = String(v);
	copcLayer?.setPointSize(v);
});

function buildClassificationLegend() {
	legendEl.innerHTML = '';
	const codes = Object.keys(classificationColors).map(Number).sort((a, b) => a - b);
	for (const code of codes) {
		const [r, g, b] = classificationColors[code];
		const item = document.createElement('div');
		item.className = 'legend-item';

		const picker = document.createElement('input');
		picker.type = 'color';
		picker.value = rgbToHex(r, g, b);
		picker.addEventListener('input', () => {
			classificationColors[code] = hexToRgb(picker.value);
			const copcUrl = urlInput.value.trim();
			if (copcUrl) loadCopc(copcUrl);
		});

		const label = document.createElement('span');
		label.textContent = `${code}: ${CLASSIFICATION_LABELS[code] ?? 'Unknown'}`;

		item.appendChild(picker);
		item.appendChild(label);
		legendEl.appendChild(item);
	}
}

function updateLegendVisibility() {
	const isClassification = colorModeSelect.value === 'classification';
	legendEl.classList.toggle('visible', isClassification);
}

colorModeSelect.addEventListener('change', () => {
	updateLegendVisibility();
	const value = urlInput.value.trim();
	if (value) loadCopc(value);
});

sseThresholdInput.addEventListener('input', () => {
	const v = Number(sseThresholdInput.value);
	sseThresholdVal.textContent = String(v);
	copcLayer?.setSseThreshold(v);
});

depthTestInput.addEventListener('change', () => {
	copcLayer?.setDepthTest(depthTestInput.checked);
});

enableEDLInput.addEventListener('change', () => {
	copcLayer?.setEDLEnabled(enableEDLInput.checked);
});

edlStrengthInput.addEventListener('input', () => {
	const v = Number(edlStrengthInput.value);
	edlStrengthVal.textContent = String(v);
	copcLayer?.updateEDLParameters({ strength: v });
});

edlRadiusInput.addEventListener('input', () => {
	const v = Number(edlRadiusInput.value);
	edlRadiusVal.textContent = String(v);
	copcLayer?.updateEDLParameters({ radius: v });
});

buildClassificationLegend();
map.addControl(new GlobeControl());

map.on('load', () => {
	if (initialUrl) {
		loadCopc(initialUrl);
	}
});

// Update stats display
setInterval(() => {
	if (copcLayer) {
		const stats = copcLayer.getNodeStats();
		const loading = copcLayer.isLoading();
		statsEl.textContent = `Nodes: ${stats.visible} visible / ${stats.loaded} cached${loading ? ' (loading...)' : ''}`;
	} else {
		statsEl.textContent = '';
	}
}, 1000);
