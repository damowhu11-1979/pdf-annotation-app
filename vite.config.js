import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // MUST match your repo name (case-sensitive)
  base: '/pdf-annotation-app/',
});
