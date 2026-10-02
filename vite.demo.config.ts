import { defineConfig } from 'vite';
import { glslPlugin, lazPerfPlugin } from './build-plugins';

export default defineConfig({
  plugins: [glslPlugin(), lazPerfPlugin()],
  build: {
    outDir: 'demo',
    assetsInlineLimit: 300000,
  },
  worker: {
    format: 'es',
    plugins: () => [lazPerfPlugin()],
  },
});
