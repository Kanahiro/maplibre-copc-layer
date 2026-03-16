import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
  dts: {
    tsgo: true,
  },
  exports: true,
  loader: {
    '.glsl': 'text',
  },
})
