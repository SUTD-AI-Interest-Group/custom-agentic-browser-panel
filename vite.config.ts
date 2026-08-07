import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Entry points: the side panel page (React app), the MV3 service worker, the
// offscreen research host, and the PDF extraction worker.
// public/manifest.json is copied into dist/ as-is.
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    // No <link rel="modulepreload">. Vite emits them with `crossorigin`, which
    // in an extension page makes Chrome fetch the preload in a different world
    // than the module import that follows — the request never matches, so the
    // asset is fetched twice and DevTools logs a "cross-world extension
    // resource mismatch" warning per chunk. There is nothing to win by fixing
    // the attribute instead: every chunk is a local file the browser already
    // has, so preloading saves no latency worth a duplicate fetch. The polyfill
    // this also disables is likewise moot — modulepreload is native well below
    // our `minimum_chrome_version: 116` floor.
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: 'sidepanel.html',
        background: 'src/background.ts',
        offscreen: 'offscreen.html',
        // The pdf-inspector WASM host. A plain entry rather than Vite's
        // separate worker-bundling mode: pdfEngine.ts spawns it by extension
        // URL (chrome.runtime.getURL('pdfWorker.js')), so it needs a stable,
        // unhashed filename exactly like background.js and offscreen.js — which
        // is what entryFileNames below already guarantees.
        pdfWorker: 'src/platform/pdfWorker.ts',
        // The MCP Apps sandbox host is NOT an entry: public/sandbox.html ships
        // verbatim with an inline classic script, because a manifest-sandboxed
        // page has an opaque origin and a module script would fail CORS.
      },
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
})
