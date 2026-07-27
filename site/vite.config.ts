import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The site deploys to GitHub Pages under /<repo>/, so asset URLs must be
// relative rather than root-absolute. './' works for both Pages and a plain
// static host.
export default defineConfig({
  base: './',
  plugins: [react()],
})
