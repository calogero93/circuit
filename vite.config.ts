import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy AI: la chiave API sta solo in server/proxy.mjs (mai nel client).
      '/api': 'http://localhost:8787',
    },
  },
});
