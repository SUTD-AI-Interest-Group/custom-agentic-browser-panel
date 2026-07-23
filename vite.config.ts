import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Two entry points: the side panel page (React app) and the MV3 service worker.
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
