import { defineConfig, type Plugin } from 'vite'

// Second build: the sandbox runtime as a self-contained CLASSIC script.
// sandbox-exec.html has an opaque origin, so a module script would fail its
// CORS check — the runtime must be an IIFE. Runs after the main build
// (emptyOutDir: false) and emits exactly dist/sandbox-exec.js.
//
// The emscripten glue references its .wasm via `new URL(..., import.meta.url)`,
// which lib mode would inline as ~670 KB of base64. The runtime always
// instantiates from panel-transferred `wasmBinary` bytes instead, so that
// asset is dead weight — stub it to a marker string.
const stubWasmAsset: Plugin = {
  name: 'stub-wasm-asset',
  enforce: 'pre',
  transform(code, id) {
    if (!id.includes('emscripten-module.browser')) return
    return code.replace(
      'new URL("emscripten-module.wasm",import.meta.url)',
      '"wasm-comes-from-panel-transfer"',
    )
  },
}

export default defineConfig({
  plugins: [stubWasmAsset],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: 'src/exec/runtime.ts',
      formats: ['iife'],
      name: 'LycheeExec',
      fileName: () => 'sandbox-exec.js',
    },
  },
})
