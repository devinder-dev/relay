import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Development only. The browser calls /v1 on this server and Vite forwards it to a real API,
// so the app is same-origin while developing and CORS never comes into it. In production the
// dashboard calls api.myrelay.tech directly, which the API's CORS list already allows.
//
// The default target is an API running on this machine (`bun run dev` in ../api). To point it
// at the real one, say so explicitly:
//
//   RELAY_API=https://api.myrelay.tech npm run dev
//
// Be careful with that: it reads and writes real production data.
const target = process.env.RELAY_API ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // changeOrigin rewrites the Host header to the target, which Traefik needs to route by host.
    proxy: { '/v1': { target, changeOrigin: true } },
  },
})
