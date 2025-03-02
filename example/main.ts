import { ThreeLayer } from '../src/threelayer';

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

let customLayer: ThreeLayer | null = null;

map.on('load', () => {
	loadThreeLayerFromUrlParams();
});

const parameters = {
	pointSize: 6,
	colorMode: 'rgb',
	maxCacheSize: 100,
	sseThreshold: 4,
	sizeAttenuation: false,
	depthTest: true,
};

function loadThreeLayerFromUrlParams() {
	const url = new URL(window.location.href);
	const copcUrl = url.searchParams.get('copc');
	const maxCacheSize = url.searchParams.get('maxCache')
		? parseInt(url.searchParams.get('maxCache')!)
		: 100;

	if (copcUrl) {
		customLayer = new ThreeLayer(copcUrl, {
			maxCacheSize: maxCacheSize,
			colorMode: parameters.colorMode,
			pointSize: parameters.pointSize,
			sseThreshold: parameters.sseThreshold,
			pointSizeAttenuation: parameters.sizeAttenuation,
			depthTest: parameters.depthTest,
		});
		map.addLayer(customLayer);
	}
}

const gui = new GUI({
	title: 'コントロール',
	container: document.getElementById('gui') as HTMLElement,
	width: 400,
});

// Create folders for different categories
const pointsFolder = gui.addFolder('Point Settings');
const renderingFolder = gui.addFolder('Rendering Options');
const performanceFolder = gui.addFolder('Performance');

// Point appearance controls
pointsFolder.add(parameters, 'pointSize', 1, 20, 1).onChange((value: number) => {
	if (customLayer) {
		customLayer.setPointSize(value);
	}
});

pointsFolder.add(parameters, 'colorMode', ['rgb', 'height', 'intensity', 'white']).onChange((value: string) => {
	if (customLayer) {
		// Need to recreate the layer with the new color mode
		const currentLayer = customLayer;
		map.removeLayer(currentLayer.id);
		
		customLayer = new ThreeLayer(currentLayer.url, {
			maxCacheSize: parameters.maxCacheSize,
			colorMode: value as 'rgb' | 'height' | 'intensity' | 'white',
			pointSize: parameters.pointSize,
			sseThreshold: parameters.sseThreshold,
			pointSizeAttenuation: parameters.sizeAttenuation,
			depthTest: parameters.depthTest,
		});
		
		map.addLayer(customLayer);
	}
});

// Rendering options
renderingFolder.add(parameters, 'sizeAttenuation').name('Size Attenuation').onChange((value: boolean) => {
	if (customLayer) {
		customLayer.toggleSizeAttenuation(value);
	}
});

renderingFolder.add(parameters, 'depthTest').name('Depth Test').onChange((value: boolean) => {
	if (customLayer) {
		customLayer.toggleDepthTest(value);
	}
});

// Performance settings
performanceFolder.add(parameters, 'sseThreshold', 1, 10, 1).name('SSE Threshold').onChange((value: number) => {
	if (customLayer) {
		customLayer.setSseThreshold(value);
	}
});

// Open folders by default
pointsFolder.open();
renderingFolder.open();
