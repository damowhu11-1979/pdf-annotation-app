import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // keep this as '/' for local dev; set to '/pdf-annotation-app/' before deploy to GitHub Pages
  // base: '/pdf-annotation-app/',
})
