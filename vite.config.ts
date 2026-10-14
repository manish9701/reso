import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app is a single page with no client-side router, so a RELATIVE base is
// both correct and the only choice that stops the three environments from
// disagreeing about where they live:
//
//   dev      http://localhost:5173/          → base '/'
//   preview  http://localhost:4173/          → base './'
//   Pages    .../reso/                       → base './'
//
// The base used to be the absolute '/reso/' for all three. That made the dev
// server serve the app only at /reso/ while `npm run dev` and every harness
// pointed at http://localhost:5173/ — a bare 404 with no body, so the app never
// loaded and each script failed with an unrelated-looking error. Swapping back
// to an absolute base for preview is not a fix either: `vite preview` then
// redirects / → /reso/, and a plain redirect DROPS THE QUERY STRING, so every
// harness's ?drive=…&level=… silently vanished and the run reported "no active
// modes" as though the physics were broken.
//
// With './' the built index.html references ./assets/… , which resolves
// correctly from /reso/ on Pages and from / in preview, with no redirect at all.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? './' : '/',
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
}));