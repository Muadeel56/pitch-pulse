import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The client calls the backend under `/api/*` (see src/api/client.js) so those
// paths never collide with the client-side routes /matches, /follows,
// /notifications — a hard refresh on /matches/2 must serve index.html, not the
// REST endpoint. Vite forwards /api to Fastify on :3000, stripping the prefix.
// /socket.io is proxied straight through (needs ws: true for the upgrade).
const backend = process.env.VITE_PROXY_TARGET || 'http://localhost:3000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/socket.io': { target: backend, changeOrigin: true, ws: true },
    },
  },
})
