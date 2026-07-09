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
      },
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
})
