import { defineConfig } from 'vite';

export default defineConfig({
	worker: {
		format: 'es',
	},
	root: './example',
	base: './',
	build: {
		outDir: '../demo',
		rollupOptions: {
			input: {
				index: './example/index.html',
			},
			external: ['laz-perf'],
		},
	},
});
