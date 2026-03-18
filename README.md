# maplibre-copc-layer

[![npm version](https://img.shields.io/npm/v/maplibre-copc-layer)](https://www.npmjs.com/package/maplibre-copc-layer)
[![license](https://img.shields.io/npm/l/maplibre-copc-layer)](https://github.com/spatialty-io/maplibre-copc-layer/blob/main/LICENSE)

Render massive point clouds on [MapLibre GL JS](https://maplibre.org/) — powered by [COPC](https://copc.io/) and [Three.js](https://threejs.org/).

Stream [Cloud-Optimized Point Cloud (COPC)](https://copc.io/) data directly into MapLibre as a custom layer. Only the tiles visible on screen are fetched and rendered, enabling smooth visualization of billion-point datasets in the browser.

## Highlights

- **Streaming LOD** — Screen-space error (SSE) based level-of-detail fetches only what you see
- **Web Worker parsing** — COPC decoding and coordinate reprojection run off the main thread
- **LRU cache** — Configurable node count and memory limits keep the GPU lean
- **Eye-Dome Lighting** — EDL post-processing for depth perception without normals
- **Color modes** — RGB, height ramp, intensity, and flat white
- **Globe support** — Works with MapLibre's Globe projection via the included `GlobeControl`
- **Zero config** — Drop in a single `CopcLayer` class and go

## Demo

**[Live Demo](https://maplibre-copc-layer.spatialty.workers.dev/?copc=https%3A%2F%2Fgsvrg.ipri.aist.go.jp%2F3ddb-pds%2Fcopc%2F114112.copc.laz#17.95/35.657894/139.746455/-83.4/60)**

## Install

```bash
npm install maplibre-copc-layer
```

Peer dependencies:

```bash
npm install maplibre-gl three
```

## Quick Start

```ts
import maplibregl from 'maplibre-gl';
import { CopcLayer } from 'maplibre-copc-layer';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [139.7, 35.7],
  zoom: 14,
});

const layer = new CopcLayer('https://example.com/pointcloud.copc.laz', {
  colorMode: 'rgb',
  pointSize: 4,
  enableEDL: true,
  onInitialized: ({ center }) => map.flyTo({ center, zoom: 16 }),
});

map.on('load', () => map.addLayer(layer));
```

## API

### `CopcLayer`

```ts
new CopcLayer(url: string, options?: CopcLayerOptions, layerId?: string)
```

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `pointSize` | `number` | `6` | Point size in pixels |
| `colorMode` | `'rgb' \| 'height' \| 'intensity' \| 'white'` | `'rgb'` | Coloring mode |
| `sseThreshold` | `number` | `8` | SSE threshold for LOD — lower values load more detail |
| `depthTest` | `boolean` | `true` | Enable depth testing |
| `maxCacheSize` | `number` | `100` | Max cached nodes |
| `maxCacheMemory` | `number` | `104857600` | Max cache memory in bytes (100 MB) |
| `enableEDL` | `boolean` | `false` | Enable Eye-Dome Lighting |
| `edlStrength` | `number` | `0.4` | EDL effect strength |
| `edlRadius` | `number` | `1.5` | EDL sampling radius |
| `wasmPath` | `string` | `undefined` | Custom path to `laz-perf.wasm` |
| `debug` | `boolean` | `false` | Enable debug logging |
| `onInitialized` | `(msg) => void` | — | Called with `{ nodeCount, center }` after COPC header loads |

#### Methods

| Method | Description |
|---|---|
| `setPointSize(size)` | Update point size |
| `setSseThreshold(threshold)` | Update SSE threshold |
| `setDepthTest(enabled)` | Toggle depth testing |
| `setEDLEnabled(enabled)` | Toggle Eye-Dome Lighting |
| `updateEDLParameters({ strength?, radius? })` | Update EDL parameters |
| `updateCacheConfig(config)` | Update cache limits at runtime |
| `clearCache()` | Clear all cached nodes |
| `getPointSize()` | Get current point size |
| `getColorMode()` | Get current color mode |
| `getSseThreshold()` | Get current SSE threshold |
| `getDepthTest()` | Get depth test state |
| `getEDLParameters()` | Get EDL parameters |
| `getOptions()` | Get all current options |
| `isLoading()` | Whether data is currently being fetched |
| `getNodeStats()` | Returns `{ loaded, visible }` node counts |

### `GlobeControl`

A MapLibre `IControl` that toggles between Mercator and Globe projections.

```ts
import { GlobeControl } from 'maplibre-copc-layer';

map.addControl(new GlobeControl());
```

## Development

```bash
pnpm install
pnpm dev       # Dev server with demo app
pnpm test      # Run tests
pnpm build     # Build library
```

## License

MIT
