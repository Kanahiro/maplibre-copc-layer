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
- **Eye-Dome Lighting** — EDL post-processing for depth perception
- **Color modes** — RGB, height ramp, intensity, classification, and white
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
  enableEDL: true,
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
| `classificationColors` | `Record<number, [number, number, number]>` | `{}` | Override or add classification code colors (0–1 RGB). Merged with ASPRS defaults |
| `filter` | `PointFilter` | `{}` | Filter points by classification, intensity range, or bounding box |
| `alwaysShowRoot` | `boolean` | `false` | Always show root node even when SSE is below threshold |
| `sseThreshold` | `number` | `8` | SSE threshold for LOD — lower loads more detail |
| `depthTest` | `boolean` | `true` | Enable depth testing |
| `maxCacheSize` | `number` | `100` | Max cached nodes |
| `maxCacheMemory` | `number` | `104857600` | Max cache memory in bytes (100 MB) |
| `enableEDL` | `boolean` | `false` | Enable Eye-Dome Lighting |
| `edlStrength` | `number` | `0.4` | EDL effect strength |
| `edlRadius` | `number` | `1.5` | EDL sampling radius |
| `debug` | `boolean` | `false` | Enable debug logging |
| `onInitialized` | `(msg) => void` | — | Called with `{ nodeCount, bounds }` after COPC header loads. `bounds` contains `minx/maxx/miny/maxy/minz/maxz` in WGS84 |

### Methods

| Method | Description |
|---|---|
| `setPointSize(size)` | Update point size |
| `setSseThreshold(threshold)` | Update SSE threshold |
| `setDepthTest(enabled)` | Toggle depth testing |
| `setEDLEnabled(enabled)` | Toggle Eye-Dome Lighting |
| `updateEDLParameters({ strength?, radius? })` | Update EDL parameters |
| `setFilter(filter)` | Update point filter (classification / intensity / bbox) |
| `getFilter()` | Get current point filter |
| `updateCacheConfig(config)` | Update cache limits at runtime |
| `clearCache()` | Clear all cached nodes |
| `isLoading()` | Whether data is currently being fetched |
| `getNodeStats()` | Returns `{ loaded, visible }` node counts |

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
