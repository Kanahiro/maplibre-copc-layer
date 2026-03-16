import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tsdownConfig from './tsdown.config.js';

import { defineConfig } from 'vite-plus';
import type { Plugin } from 'vite-plus';

const lazPerfWasmSrc = resolve(
	'node_modules/.pnpm/laz-perf@0.0.7/node_modules/laz-perf/lib/web/laz-perf.wasm',
);

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

function lazPerfWasmPlugin(): Plugin {
	return {
		name: 'laz-perf-wasm',
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (req.url?.endsWith('laz-perf.wasm')) {
					try {
						const data = readFileSync(lazPerfWasmSrc);
						res.setHeader('Content-Type', 'application/wasm');
						res.setHeader('Content-Length', data.length);
						res.end(data);
					} catch {
						next();
					}
					return;
				}
				next();
			});
		},
		writeBundle(options) {
			if (!options.dir) return;
			const outDir = resolve(options.dir);
			mkdirSync(outDir, { recursive: true });
			try {
				copyFileSync(lazPerfWasmSrc, resolve(outDir, 'laz-perf.wasm'));
			} catch {
				console.warn('[laz-perf-wasm] Failed to copy laz-perf.wasm');
			}
		},
	};
}

export default defineConfig({
	plugins: [glslPlugin(), lazPerfWasmPlugin()],
	pack: tsdownConfig,
	lint: { options: { typeAware: true, typeCheck: true } },
});
