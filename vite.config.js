import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // REPLACE 'pdf-editor' below with your ACTUAL repository name from GitHub!
  base: '/pdf-editor/', 
})
