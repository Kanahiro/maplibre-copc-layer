import { resolve } from 'node:path';
import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import dts from 'vite-plugin-dts';

const require = createRequire(import.meta.url);

function glslPlugin(): Plugin {
	return {
		name: 'glsl-loader',
		transform(code, id) {
			if (id.endsWith('.glsl')) {
				return {
					code: `export default ${JSON.stringify(code)}`,
					map: null,
				};
			}
		},
	};
}

function copyLazPerfWasm(): Plugin {
	return {
		name: 'copy-laz-perf-wasm',
		closeBundle() {
			const src = require.resolve('laz-perf/lib/web/laz-perf.wasm');
			copyFileSync(src, resolve('dist/laz-perf.wasm'));
		},
	};
}

export default defineConfig({
	plugins: [glslPlugin(), dts({ rollupTypes: true }), copyLazPerfWasm()],
	build: {
		lib: {
			entry: resolve('src/index.ts'),
			formats: ['es'],
			fileName: 'index',
		},
		rollupOptions: {
			external: ['maplibre-gl', 'three', 'copc', 'proj4'],
		},
	},
	worker: {
		format: 'es',
	},
});
