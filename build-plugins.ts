import type { Plugin } from 'vite';

export function glslPlugin(): Plugin {
  return {
    name: 'glsl-loader',
    transform(code, id) {
      if (id.endsWith('.glsl')) return { code: `export default ${JSON.stringify(code)}`, map: null };
    },
  };
}

/** Adapt the checked-in Emscripten UMD output without editing the submodule. */
export function lazPerfPlugin(): Plugin {
  return {
    name: 'laz-perf-module',
    transform(code, id) {
      if (!id.endsWith('/vendor/laz-perf/js/src/laz-perf.js')) return;
      const umd = code.indexOf("\nif (typeof exports === 'object'");
      if (umd < 0) throw new Error('Unsupported vendored laz-perf build');
      return { code: `${code.slice(0, umd)}\nexport default createLazPerf;`, map: null };
    },
  };
}
