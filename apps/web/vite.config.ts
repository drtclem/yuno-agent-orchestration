import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Allow idle SSE between 15-second heartbeats, but bound a stalled stream.
      '/api/events': {
        target: 'http://127.0.0.1:3000',
        timeout: 45_000,
        proxyTimeout: 45_000,
      },
      '/api': {
        target: 'http://127.0.0.1:3000',
        timeout: 5000,
        proxyTimeout: 5000,
      },
    },
  },
});
