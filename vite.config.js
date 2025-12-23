import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // "./" is the safest setting. 
  // It allows the app to find its files on Localhost AND GitHub Pages automatically.
  base: './',
})
