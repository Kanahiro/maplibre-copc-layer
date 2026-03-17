import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { CopcLayer, type ColorMode } from '../src/index';

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
			//type: 'globe',
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
const paramsEl = document.getElementById('params') as HTMLDivElement;

// Parameter controls
const pointSizeInput = document.getElementById('pointSize') as HTMLInputElement;
const pointSizeVal = document.getElementById('pointSize-val') as HTMLSpanElement;
const colorModeSelect = document.getElementById('colorMode') as HTMLSelectElement;
const sseThresholdInput = document.getElementById('sseThreshold') as HTMLInputElement;
const sseThresholdVal = document.getElementById('sseThreshold-val') as HTMLSpanElement;
const depthTestInput = document.getElementById('depthTest') as HTMLInputElement;
const enableEDLInput = document.getElementById('enableEDL') as HTMLInputElement;
const edlStrengthInput = document.getElementById('edlStrength') as HTMLInputElement;
const edlStrengthVal = document.getElementById('edlStrength-val') as HTMLSpanElement;
const edlRadiusInput = document.getElementById('edlRadius') as HTMLInputElement;
const edlRadiusVal = document.getElementById('edlRadius-val') as HTMLSpanElement;
const edlOpacityInput = document.getElementById('edlOpacity') as HTMLInputElement;
const edlOpacityVal = document.getElementById('edlOpacity-val') as HTMLSpanElement;

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
	const edlOpacity = Number(edlOpacityInput.value);

	copcLayer = new CopcLayer(copcUrl, {
		pointSize,
		colorMode,
		sseThreshold,
		depthTest,
		enableEDL,
		edlStrength,
		edlRadius,
		edlOpacity,
		onInitialized: (message) => {
			map.flyTo({ center: message.center, zoom: 16 });
		},
	});

	map.addLayer(copcLayer);
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

// Parameter event handlers
pointSizeInput.addEventListener('input', () => {
	const v = Number(pointSizeInput.value);
	pointSizeVal.textContent = String(v);
	copcLayer?.setPointSize(v);
});

colorModeSelect.addEventListener('change', () => {
	const value = urlInput.value.trim();
	if (value) loadCopc(value);
});

sseThresholdInput.addEventListener('input', () => {
	const v = Number(sseThresholdInput.value);
	sseThresholdVal.textContent = String(v);
	copcLayer?.setSseThreshold(v);
});

depthTestInput.addEventListener('change', () => {
	copcLayer?.toggleDepthTest(depthTestInput.checked);
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

edlOpacityInput.addEventListener('input', () => {
	const v = Number(edlOpacityInput.value);
	edlOpacityVal.textContent = String(v);
	copcLayer?.updateEDLParameters({ opacity: v });
});

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
