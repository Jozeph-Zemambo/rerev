import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Phones reach the dev server through a Cloudflare quick tunnel (WebXR needs https).
    allowedHosts: ['.trycloudflare.com'],
  },
});
