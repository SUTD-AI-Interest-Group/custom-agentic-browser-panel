import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Entry points: the side panel page (React app), the MV3 service worker, the
// offscreen research host, and the PDF extraction worker.
// public/manifest.json is copied into dist/ as-is.
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
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
