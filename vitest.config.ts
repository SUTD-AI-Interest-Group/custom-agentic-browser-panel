import { defineConfig } from 'vitest/config'

// Dev-only. Isolated from vite.config.ts so the extension build is untouched:
// vite build still uses vite.config.ts and never sees *.test.ts files.
export default defineConfig({
  test: {
    environment: 'jsdom', // gives DOMParser to the HTML-parsing tests
    globals: true,
    include: ['src/**/*.test.ts'],
  },
})
