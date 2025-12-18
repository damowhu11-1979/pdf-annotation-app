import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/pdf-annotation-app/',   // <-- must match repo name (case-sensitive)
})
