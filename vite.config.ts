import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Repository is served from manish9701.github.io/reso/ on GitHub Pages.
  base: '/reso/',
  server: { port: 5173 },
});
