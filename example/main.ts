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
		terrain: {
			source: 'dem',
		},
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
	colorMode: 'height',
	maxCacheSize: 100,
	sseThreshold: 4,
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
		});
		map.addLayer(customLayer);
	}
}

const gui = new GUI({
	title: 'コントロール',
	container: document.getElementById('gui') as HTMLElement,
	width: 400,
});

// control parameters for the ThreeLayer
gui.add(parameters, 'pointSize', 1, 10, 1).onChange((value: number) => {
	if (customLayer) {
		customLayer.setPointSize(value);
	}
});

gui.add(parameters, 'sseThreshold', 1, 10, 1).onChange((value: number) => {
	if (customLayer) {
		customLayer.setSseThreshold(value);
	}
});
