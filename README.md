# maplibre-copc-layer

[![npm version](https://img.shields.io/npm/v/maplibre-copc-layer)](https://www.npmjs.com/package/maplibre-copc-layer)
[![license](https://img.shields.io/npm/l/maplibre-copc-layer)](https://github.com/spatialty-io/maplibre-copc-layer/blob/main/LICENSE)

A [MapLibre GL JS](https://maplibre.org/) custom layer for streaming and rendering [Cloud-Optimized Point Cloud (COPC)](https://copc.io/) data, powered by [Three.js](https://threejs.org/).

Only the tiles visible on screen are fetched via SSE-based LOD, enabling smooth visualization of massive point clouds in the browser.

**[Live Demo](https://maplibre-copc-layer.spatialty.workers.dev/?copc=https%3A%2F%2Fgsvrg.ipri.aist.go.jp%2F3ddb-pds%2Fcopc%2F114112.copc.laz#17.95/35.657894/139.746455/-83.4/60)**

## Features

- **Streaming LOD** — Screen-space error based level-of-detail fetches only what you see
- **Web Worker** — COPC decoding and coordinate reprojection run off the main thread
- **LRU cache** — Configurable node count and memory limits
- **Ambient Occlusion** — SSAO post-processing for depth perception
- **Color modes** — RGB, height ramp, intensity, classification, and white
- **Custom color expressions** — User-defined linear/discrete color ramps for height and intensity
- **Filtering** — By classification, intensity range, or bounding box (WGS84)

## Install

```bash
npm install maplibre-copc-layer maplibre-gl three
```

## Usage

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
  enableSSAO: true,
  onInitialized: ({ bounds }) => map.flyTo({
    center: [(bounds.minx + bounds.maxx) / 2, (bounds.miny + bounds.maxy) / 2],
    zoom: 16,
  }),
});

map.on('load', () => map.addLayer(layer));
```

## API

### `new CopcLayer(url, options?, layerId?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `pointSize` | `number` | `6` | Point size in pixels |
| `colorMode` | `'rgb' \| 'height' \| 'intensity' \| 'classification' \| 'white'` | `'rgb'` | Coloring mode |
| `heightColor` | `ColorExpression` | auto | Color ramp for height mode. Default: blue→yellow→red across data bounds |
| `intensityColor` | `ColorExpression` | auto | Color ramp for intensity mode. Default: black→white (0–1) |
| `classificationColors` | `Record<number, RGBColor>` | ASPRS defaults | Classification code colors (0–1 RGB) |
| `filter` | `PointFilter` | `{}` | Filter points by classification, intensity range, or bounding box |
| `alwaysShowRoot` | `boolean` | `false` | Always show root node even when SSE is below threshold |
| `sseThreshold` | `number` | `8` | SSE threshold for LOD — lower loads more detail |
| `depthTest` | `boolean` | `true` | Enable depth testing |
| `maxCacheSize` | `number` | `100` | Max cached nodes |
| `maxCacheMemory` | `number` | `104857600` | Max cache memory in bytes (100 MB) |
| `enableSSAO` | `boolean` | `false` | Enable Screen Space Ambient Occlusion |
| `ssaoStrength` | `number` | `1.0` | SSAO effect strength |
| `ssaoRadius` | `number` | `8.0` | SSAO sampling radius in pixels |
| `debug` | `boolean` | `false` | Enable debug logging |
| `onInitialized` | `(msg) => void` | — | Called with `{ nodeCount, bounds }` after COPC header loads. `bounds` contains `minx/maxx/miny/maxy/minz/maxz` in WGS84 |

### Methods

| Method | Description |
|---|---|
| `setPointSize(size)` | Update point size |
| `setColorMode(mode)` | Switch color mode without reloading data |
| `setHeightColor(expr)` | Update height color expression (instant, no reload) |
| `setIntensityColor(expr)` | Update intensity color expression (instant, no reload) |
| `setClassificationColors(colors)` | Update classification colors (instant, no reload) |
| `setSseThreshold(threshold)` | Update SSE threshold |
| `setDepthTest(enabled)` | Toggle depth testing |
| `setSSAOEnabled(enabled)` | Toggle Screen Space Ambient Occlusion |
| `setSSAOParameters({ strength?, radius? })` | Update SSAO parameters |
| `setFilter(filter)` | Update point filter (classification / intensity / bbox) |
| `getFilter()` | Get current point filter |
| `setCacheConfig(config)` | Update cache limits at runtime |
| `clearCache()` | Clear all cached nodes |
| `isLoading()` | Whether data is currently being fetched |
| `getNodeStats()` | Returns `{ loaded, visible }` node counts |

## Examples

### Height-based coloring with custom color ramp

`ColorExpression` uses a MapLibre Style-like syntax: `["linear", stop, color, stop, color, ...]` or `["discrete", ...]`.

```ts
const layer = new CopcLayer('https://example.com/pointcloud.copc.laz', {
  colorMode: 'height',
  // Linear interpolation: blue at 0m, green at 50m, red at 100m
  heightColor: ['linear', 0, [0, 0, 1], 50, [0, 1, 0], 100, [1, 0, 0]],
});
```

### Discrete height coloring

```ts
const layer = new CopcLayer('https://example.com/pointcloud.copc.laz', {
  colorMode: 'height',
  // Step function: blue below 50m, green 50-100m, red above 100m
  heightColor: ['discrete', 0, [0, 0, 1], 50, [0, 1, 0], 100, [1, 0, 0]],
});
```

### Custom intensity coloring

```ts
const layer = new CopcLayer('https://example.com/pointcloud.copc.laz', {
  colorMode: 'intensity',
  // Intensity values are normalized 0-1
  intensityColor: ['linear', 0, [0, 0, 0.2], 0.5, [1, 1, 0], 1, [1, 0, 0]],
});
```

### Updating colors at runtime (no data reload)

```ts
// Switch color mode instantly
layer.setColorMode('height');

// Update height color ramp — reflected immediately
layer.setHeightColor(['linear', 0, [1, 1, 1], 200, [1, 0, 0]]);

// Update classification colors
layer.setClassificationColors({
  2: [0.4, 0.2, 0.1],  // Ground: brown
  6: [0.8, 0.1, 0.1],  // Building: red
});
```

### Filtering points

```ts
const layer = new CopcLayer('https://example.com/pointcloud.copc.laz', {
  filter: {
    // Show only ground and buildings
    classification: new Set([2, 6]),
    // Intensity range (0-1)
    intensityRange: [0.1, 0.9],
    // Bounding box in WGS84
    bbox: { minx: 139.7, maxx: 139.8, miny: 35.6, maxy: 35.7 },
  },
});

// Update filter at runtime
layer.setFilter({
  classification: new Set([2, 3, 4, 5, 6]),
});
```

### Ambient Occlusion

```ts
const layer = new CopcLayer('https://example.com/pointcloud.copc.laz', {
  enableSSAO: true,
  ssaoStrength: 1.0,
  ssaoRadius: 8.0,
});
```

## Development

```bash
pnpm install
pnpm dev       # Dev server with demo app
pnpm test      # Run tests
pnpm build     # Build library
```

## Third-Party Notices

This project bundles [laz-perf](https://github.com/hobuinc/laz-perf) (Apache License 2.0).

## License

Apache-2.0
