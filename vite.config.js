import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
git add .
git commit -m "Fix base path for GitHub Pages"
git push
export default defineConfig({
  plugins: [react()],
  // MUST match your repo name (case-sensitive)
  base: '/pdf-annotation-app/',
});
