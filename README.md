# maplibre-copc-layer

A [MapLibre GL JS](https://maplibre.org/) custom layer for rendering [Cloud-Optimized Point Cloud (COPC)](https://copc.io/) data using [Three.js](https://threejs.org/).

## Features

- MapLibre GL JS custom layer (`CustomLayerInterface`) as a single class
- Screen-space error (SSE) based level-of-detail
- Web Worker for COPC parsing and coordinate transformation
- LRU cache with node count and memory limits
- Eye-Dome Lighting (EDL) post-processing
- Color modes: RGB, height, intensity, white

## Installation

```bash
npm install maplibre-copc-layer
```

Peer dependencies:

```bash
npm install maplibre-gl three
```

## Usage

```typescript
import maplibregl from 'maplibre-gl';
import { CopcLayer } from 'maplibre-copc-layer';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [139.7, 35.7],
  zoom: 14,
});

const copcLayer = new CopcLayer('https://example.com/pointcloud.copc.laz', {
  colorMode: 'rgb',
  pointSize: 4,
  sseThreshold: 2,
  enableEDL: true,
  onInitialized: (message) => {
    map.flyTo({ center: message.center, zoom: 16 });
  },
});

map.on('load', () => {
  map.addLayer(copcLayer);
});
```

## API

### `CopcLayer`

```typescript
new CopcLayer(url: string, options?: CopcLayerOptions, layerId?: string)
```

#### `CopcLayerOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `pointSize` | `number` | `6` | Point size in pixels |
| `colorMode` | `'rgb' \| 'height' \| 'intensity' \| 'white'` | `'rgb'` | Coloring mode |
| `sseThreshold` | `number` | `8` | SSE threshold for LOD selection |
| `depthTest` | `boolean` | `true` | Enable depth testing |
| `maxCacheSize` | `number` | `100` | Max cached nodes |
| `maxCacheMemory` | `number` | `104857600` | Max cache memory in bytes (default 100 MB) |
| `enableCacheLogging` | `boolean` | `false` | Log cache operations |
| `enableEDL` | `boolean` | `false` | Enable Eye-Dome Lighting |
| `edlStrength` | `number` | `0.4` | EDL strength |
| `edlRadius` | `number` | `1.5` | EDL radius |
| `wasmPath` | `string` | `undefined` | Path to `laz-perf.wasm` |
| `onInitialized` | `(message) => void` | - | Callback with `{ nodeCount, center }` after COPC header is loaded |

#### Methods

| Method | Description |
|---|---|
| `setPointSize(size)` | Update point size |
| `setSseThreshold(threshold)` | Update SSE threshold |
| `setDepthTest(enabled)` | Set depth testing |
| `setEDLEnabled(enabled)` | Toggle EDL |
| `updateEDLParameters({ strength?, radius? })` | Update EDL parameters |
| `updateCacheConfig(config)` | Update cache options at runtime |
| `clearCache()` | Clear all cached nodes |
| `getPointSize()` | Get current point size |
| `getColorMode()` | Get current color mode |
| `getSseThreshold()` | Get current SSE threshold |
| `getDepthTest()` | Get depth test state |
| `getEDLParameters()` | Get EDL parameters |
| `getOptions()` | Get all options |
| `isLoading()` | Check if data is loading |
| `getNodeStats()` | Get `{ loaded, visible }` node counts |

## Development

```bash
# Install dependencies
pnpm install

# Dev server (opens demo app)
pnpm dev

# Run tests
pnpm test

# Build library
pnpm build
```

## License

MIT
