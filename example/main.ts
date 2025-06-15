import { CopcLayer } from '../src/copclayer';

import { Map, addProtocol } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { useGsiTerrainSource } from 'maplibre-gl-gsi-terrain';

import { GUI } from 'lil-gui';

const gsiTerrainSource = useGsiTerrainSource(addProtocol);

const map = new Map({
	container: 'app',
	style: {
		version: 8,
		sources: {
			osm: {
				type: 'raster',
				tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
				tileSize: 256,
				attribution: '© OpenStreetMap contributors',
				maxzoom: 18,
			},
			dem: gsiTerrainSource,
		},
		layers: [
			{
				id: 'osm',
				type: 'raster',
				source: 'osm',
			},
		],
	},
	center: [139.04979382895846, 35.79193396826148],
	zoom: 10,
	maxPitch: 100,
	hash: true,
});

let copcLayer: CopcLayer | null = null;

map.on('load', () => {
	loadThreeLayerFromUrlParams();
});

const parameters = {
	pointSize: 6,
	colorMode: 'rgb' as 'rgb' | 'height' | 'intensity' | 'white',
	maxCacheSize: 100,
	sseThreshold: 4,
	depthTest: true,
	wasmPath: '/assets/laz-perf.wasm', // Configure WASM path explicitly
	maxCacheMemory: 100 * 1024 * 1024, // 100MB
	enableCacheLogging: false,
};

// Create URL input container with improved styling
const urlContainer = document.createElement('div');
Object.assign(urlContainer.style, {
	position: 'absolute',
	top: '10px',
	left: '10px',
	zIndex: '1000',
	backgroundColor: 'white',
	padding: '12px',
	borderRadius: '6px',
	boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
	border: '1px solid #e2e8f0',
	maxWidth: '400px',
});

// Create title
const title = document.createElement('h3');
title.textContent = 'COPC Data Source';
Object.assign(title.style, {
	margin: '0 0 8px 0',
	fontSize: '14px',
	fontWeight: '600',
	color: '#374151',
});

// Create URL input with improved styling
const urlInput = document.createElement('input');
Object.assign(urlInput, {
	type: 'text',
	placeholder: 'Enter COPC file URL (.copc.laz)',
	value: '',
});
Object.assign(urlInput.style, {
	width: '100%',
	padding: '8px 12px',
	marginBottom: '8px',
	border: '1px solid #d1d5db',
	borderRadius: '4px',
	fontSize: '14px',
	boxSizing: 'border-box',
});

// Create reload button with improved styling
const reloadButton = document.createElement('button');
reloadButton.textContent = 'Load Point Cloud';
Object.assign(reloadButton.style, {
	width: '100%',
	padding: '8px 16px',
	backgroundColor: '#3b82f6',
	color: 'white',
	border: 'none',
	borderRadius: '4px',
	cursor: 'pointer',
	fontSize: '14px',
	fontWeight: '500',
	transition: 'background-color 0.2s',
});

// Add hover effect
reloadButton.addEventListener('mouseenter', () => {
	reloadButton.style.backgroundColor = '#2563eb';
});
reloadButton.addEventListener('mouseleave', () => {
	reloadButton.style.backgroundColor = '#3b82f6';
});

// Add elements to container
urlContainer.appendChild(title);
urlContainer.appendChild(urlInput);
urlContainer.appendChild(reloadButton);
document.body.appendChild(urlContainer);

// Add sample COPC URLs for easy testing
const sampleContainer = document.createElement('div');
Object.assign(sampleContainer.style, {
	marginTop: '8px',
	padding: '8px',
	backgroundColor: '#f8fafc',
	borderRadius: '4px',
	border: '1px solid #e2e8f0',
});

// Function to update URL parameters
function updateUrlParameters() {
	const url = new URL(window.location.href);
	url.searchParams.set('pointSize', parameters.pointSize.toString());
	url.searchParams.set('colorMode', parameters.colorMode);
	url.searchParams.set('sseThreshold', parameters.sseThreshold.toString());
	url.searchParams.set('depthTest', parameters.depthTest.toString());
	window.history.pushState({}, '', url);
}

// Function to load parameters from URL
function loadParametersFromUrl() {
	const url = new URL(window.location.href);

	// Load COPC URL
	const copcUrl = url.searchParams.get('copc');
	if (copcUrl) {
		urlInput.value = copcUrl;
	}

	// Load other parameters
	const pointSize = url.searchParams.get('pointSize');
	if (pointSize) {
		parameters.pointSize = parseInt(pointSize);
	}

	const colorMode = url.searchParams.get('colorMode');
	if (
		colorMode &&
		['rgb', 'height', 'intensity', 'white'].includes(colorMode)
	) {
		parameters.colorMode = colorMode as
			| 'rgb'
			| 'height'
			| 'intensity'
			| 'white';
	}

	const sseThreshold = url.searchParams.get('sseThreshold');
	if (sseThreshold) {
		parameters.sseThreshold = parseInt(sseThreshold);
	}

	const depthTest = url.searchParams.get('depthTest');
	if (depthTest) {
		parameters.depthTest = depthTest === 'true';
	}
}

// Load initial parameters from URL
loadParametersFromUrl();

// Initialize GUI
const gui = new GUI({
	title: 'COPC Viewer Controls',
	container: document.getElementById('gui') as HTMLElement,
	width: 400,
});

// Create folders for different categories
const pointsFolder = gui.addFolder('Point Settings');
const renderingFolder = gui.addFolder('Rendering Options');
const performanceFolder = gui.addFolder('Performance');

// Add layer info display
const infoFolder = gui.addFolder('Layer Info');
const layerStats = {
	loaded: 0,
	visible: 0,
	cached: 0,
	isLoading: false,
	cacheHitRatio: 0,
	cacheMemoryUsage: 0,
	pendingRequests: 0,
};

infoFolder.add(layerStats, 'loaded').name('Loaded Nodes').listen();
infoFolder.add(layerStats, 'visible').name('Visible Nodes').listen();
infoFolder.add(layerStats, 'cached').name('Cached Nodes').listen();
infoFolder.add(layerStats, 'isLoading').name('Is Loading').listen();
infoFolder.add(layerStats, 'cacheHitRatio').name('Cache Hit Ratio').listen();
infoFolder
	.add(layerStats, 'cacheMemoryUsage')
	.name('Cache Memory (MB)')
	.listen();
infoFolder.add(layerStats, 'pendingRequests').name('Pending Requests').listen();

// Update event listeners to save parameters to URL
pointsFolder
	.add(parameters, 'pointSize', 1, 20, 1)
	.onChange((value: number) => {
		if (copcLayer) {
			copcLayer.setPointSize(value);
		}
		updateUrlParameters();
	});

pointsFolder
	.add(parameters, 'colorMode', ['rgb', 'height', 'intensity', 'white'])
	.onChange((value: string) => {
		if (copcLayer) {
			// Recreate the layer with the new color mode
			// Note: Color mode changes require full layer recreation
			const currentLayer = copcLayer;
			map.removeLayer(currentLayer.id);

			try {
				copcLayer = new CopcLayer(currentLayer.url, {
					maxCacheSize: parameters.maxCacheSize,
					colorMode: value as 'rgb' | 'height' | 'intensity' | 'white',
					pointSize: parameters.pointSize,
					sseThreshold: parameters.sseThreshold,
					depthTest: parameters.depthTest,
					maxCacheMemory: parameters.maxCacheMemory,
					enableCacheLogging: parameters.enableCacheLogging,
				});

				map.addLayer(copcLayer);
			} catch (error) {
				console.error('Failed to recreate layer with new color mode:', error);
				// Restore previous layer if recreation fails
				copcLayer = currentLayer;
				map.addLayer(copcLayer);
			}
		}
		updateUrlParameters();
	});

// Rendering options
renderingFolder
	.add(parameters, 'depthTest')
	.name('Depth Test')
	.onChange((value: boolean) => {
		if (copcLayer) {
			copcLayer.toggleDepthTest(value);
		}
		updateUrlParameters();
	});

// Performance settings
performanceFolder
	.add(parameters, 'sseThreshold', 1, 10, 1)
	.name('SSE Threshold')
	.onChange((value: number) => {
		if (copcLayer) {
			copcLayer.setSseThreshold(value);
		}
		updateUrlParameters();
	});

// Open folders by default
pointsFolder.open();
renderingFolder.open();
infoFolder.open();

// Update stats periodically
setInterval(() => {
	if (copcLayer) {
		const stats = copcLayer.getNodeStats();
		layerStats.loaded = stats.loaded;
		layerStats.visible = stats.visible;
		layerStats.cached = stats.cached;
		layerStats.isLoading = copcLayer.isLoading();
		layerStats.cacheHitRatio = Math.round(stats.cacheHitRatio * 100) / 100; // Round to 2 decimal places
		layerStats.cacheMemoryUsage =
			Math.round((stats.cacheMemoryUsage / (1024 * 1024)) * 100) / 100; // Convert to MB
		layerStats.pendingRequests = stats.pendingRequests;
	}
}, 1000);

// Update loadThreeLayerFromUrlParams to use parameters from URL
function loadThreeLayerFromUrlParams() {
	const url = new URL(window.location.href);
	const copcUrl = url.searchParams.get('copc');
	const maxCacheSize = url.searchParams.get('maxCacheSize')
		? parseInt(url.searchParams.get('maxCacheSize')!)
		: parameters.maxCacheSize;

	if (copcUrl) {
		if (copcLayer) {
			map.removeLayer(copcLayer.id);
		}
		copcLayer = new CopcLayer(copcUrl, {
			maxCacheSize: maxCacheSize,
			colorMode: parameters.colorMode,
			pointSize: parameters.pointSize,
			sseThreshold: parameters.sseThreshold,
			depthTest: parameters.depthTest,
			maxCacheMemory: parameters.maxCacheMemory,
			enableCacheLogging: parameters.enableCacheLogging,
		});
		map.addLayer(copcLayer);
	}
}

// Update reload button event listener to save parameters
reloadButton.addEventListener('click', () => {
	const newUrl = urlInput.value.trim();
	if (newUrl) {
		// Update URL parameters
		const url = new URL(window.location.href);
		url.searchParams.set('copc', newUrl);
		window.history.pushState({}, '', url);

		// Reload COPC data
		loadThreeLayerFromUrlParams();
	}
});
