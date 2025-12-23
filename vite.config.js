import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Reverting to the explicit repository name as this is the standard for GitHub Pages
  base: '/pdf-annotation-app/',
})
