import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { glslPlugin, lazPerfPlugin } from './build-plugins';

export default defineConfig({
  plugins: [glslPlugin(), lazPerfPlugin(), dts({ rollupTypes: true })],
  build: {
    lib: {
      entry: resolve('src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    assetsInlineLimit: 300000,
    rollupOptions: {
      external: ['maplibre-gl', 'three', 'proj4'],
    },
  },
  worker: {
    format: 'es',
    plugins: () => [lazPerfPlugin()],
  },
  test: {
    exclude: ['vendor/**', 'node_modules/**'],
  },
});
