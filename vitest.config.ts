import { existsSync, realpathSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// Dev-only. Isolated from vite.config.ts so the extension build is untouched:
// vite build still uses vite.config.ts and never sees *.test.ts files.

/**
 * Directories Vite may read from, beyond the project root.
 *
 * A git worktree usually symlinks `node_modules` at the main checkout rather
 * than installing a second copy, and Vite resolves a `?url` asset import
 * (`pdfjs-dist/build/pdf.worker.min.mjs?url`, reached from `platform/pdf.ts`)
 * to its *real* path. That path lands outside the worktree root, so Vite's
 * filesystem guard rejects it with "Denied ID" and the whole test file fails to
 * load — the suite is green in the main checkout and red in every worktree,
 * which reads as a broken merge rather than a resolution quirk.
 *
 * Allowing the resolved node_modules fixes both layouts, and is a no-op wherever
 * node_modules is a real directory inside the root.
 */
function allowedFsRoots(): string[] {
  if (!existsSync('node_modules')) return []
  try {
    return [realpathSync('node_modules')]
  } catch {
    return []
  }
}

export default defineConfig({
  server: {
    fs: { allow: ['.', ...allowedFsRoots()] },
  },
  test: {
    environment: 'jsdom', // gives DOMParser to the HTML-parsing tests
    globals: true,
    include: ['src/**/*.test.ts'],
  },
})
