import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { CopcLayer } from '../src/index';

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

	copcLayer = new CopcLayer(copcUrl, {
		pointSize: 4,
		colorMode: 'rgb',
		sseThreshold: 2,
		enableEDL: true,
		edlStrength: 5,
		onInitialized: (message) => {
			map.flyTo({ center: message.center, zoom: 16 });
		},
	});

	map.addLayer(copcLayer);
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
