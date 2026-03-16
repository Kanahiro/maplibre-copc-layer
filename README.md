# COPC Viewer

A TypeScript library for loading and rendering Cloud-Optimized Point Cloud (COPC) data in MapLibre GL JS using Three.js.

## Features

- **Efficient Rendering**: Uses screen space error (SSE) based level-of-detail for optimal performance
- **Web Worker Processing**: Heavy computations run in background threads to maintain smooth interaction
- **Multiple Color Modes**: Support for RGB, height-based, intensity-based, and white coloring
- **Flexible Configuration**: Customizable point sizes, cache limits, and rendering options
- **TypeScript Support**: Full type definitions included
- **WASM Path Configuration**: Robust handling of WebAssembly dependencies for different environments

## Installation

```bash
npm install copc-viewer
```

## WASM File Setup

This library depends on the `laz-perf` WebAssembly module. You need to ensure the WASM file is accessible in your application:

### Option 1: Copy WASM file to public directory

```bash
# Copy the WASM file to your public assets folder
cp node_modules/laz-perf/lib/web/laz-perf.wasm public/assets/
```

### Option 2: Use build script

Add to your `package.json`:

```json
{
  "scripts": {
    "build": "cp node_modules/laz-perf/lib/web/laz-perf.wasm public/assets/ && your-build-command"
  }
}
```

### Option 3: Use the provided utility

```typescript
import { getWasmCopyInstructions } from 'copc-viewer';
console.log(getWasmCopyInstructions('public/assets/'));
```

## Quick Start

```typescript
import { ThreeLayer } from 'copc-viewer';
import { Map } from 'maplibre-gl';

// Create a map
const map = new Map({
  container: 'map',
  style: 'your-style-url',
  center: [longitude, latitude],
  zoom: 10
});

// Create and add COPC layer with WASM path configuration
const copcLayer = new ThreeLayer('https://example.com/data.copc.laz', {
  pointSize: 6,
  colorMode: 'rgb',
  sseThreshold: 4,
  depthTest: true,
  wasmPath: '/assets/laz-perf.wasm' // Configure WASM path
});

map.on('load', () => {
  map.addLayer(copcLayer);
});
```

## Configuration Options

### ThreeLayerOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pointSize` | `number` | `6` | Size of points in pixels |
| `colorMode` | `'rgb' \| 'height' \| 'intensity' \| 'white'` | `'rgb'` | Color mode for rendering |
| `maxCacheSize` | `number` | `100` | Maximum number of nodes to cache |
| `sseThreshold` | `number` | `8` | Screen space error threshold for LOD |
| `depthTest` | `boolean` | `true` | Enable depth testing |
| `wasmPath` | `string` | `undefined` | Path to laz-perf WASM file |
| `baseUrl` | `string` | `undefined` | Base URL for resolving relative WASM paths |

## Environment-Specific WASM Configuration

Different bundlers and environments require different WASM configurations:

```typescript
import { getEnvironmentWasmConfig } from 'copc-viewer';

// Get environment-specific suggestions
const configs = getEnvironmentWasmConfig();
console.log(configs['Vite']); // '/assets/laz-perf.wasm'
console.log(configs['Webpack']); // './assets/laz-perf.wasm'
```

### Common Configurations

- **Vite**: `wasmPath: '/assets/laz-perf.wasm'`
- **Webpack**: `wasmPath: './assets/laz-perf.wasm'`
- **Next.js**: `wasmPath: '/static/laz-perf.wasm'`
- **Create React App**: `wasmPath: '/public/laz-perf.wasm'`

## API Reference

### ThreeLayer

#### Constructor

```typescript
new ThreeLayer(url: string, options?: ThreeLayerOptions, layerId?: string)
```

#### Methods

- `setPointSize(size: number): void` - Update point size
- `setSseThreshold(threshold: number): void` - Update SSE threshold
- `toggleDepthTest(enabled: boolean): void` - Toggle depth testing
- `getPointSize(): number` - Get current point size
- `getColorMode(): ColorMode` - Get current color mode
- `getSseThreshold(): number` - Get current SSE threshold
- `isDepthTestEnabled(): boolean` - Check if depth test is enabled
- `getOptions(): Readonly<Required<ThreeLayerOptions>>` - Get current options
- `isLoading(): boolean` - Check if data is loading
- `getNodeStats(): { loaded: number; visible: number; cached: number }` - Get node statistics

## Development

### Build Library

```bash
npm run build:lib
```

### Build Example

```bash
npm run build
```

### Development Server

```bash
npm run dev
```

## Architecture

The library uses a multi-threaded architecture:

1. **Main Thread**: Handles MapLibre integration and Three.js rendering
2. **Web Worker**: Processes COPC data, coordinate transformations, and SSE calculations
3. **Level of Detail**: Automatically selects appropriate point cloud resolution based on camera distance

For more details, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
