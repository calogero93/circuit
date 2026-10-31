import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { thirdPartyNotices } from './build/thirdPartyNotices';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const origins = (env.TOOL_BRIDGE_ALLOWED_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173').split(',').map(value => value.trim());
  return {
    plugins: [react(), thirdPartyNotices(fileURLToPath(new URL('.', import.meta.url)))],
    server: {
      host: '127.0.0.1',
      strictPort: true,
      cors: { origin: origins },
      fs: {
        allow: [fileURLToPath(new URL('.', import.meta.url))],
        deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.local-notes/**', '**/circuit-studio-*/**'],
      },
      proxy: {
        '/api': env.AI_SERVICE_URL || 'http://127.0.0.1:8080',
        '/tool-bridge': { target: env.TOOL_BRIDGE_URL || 'ws://127.0.0.1:8787', ws: true },
      },
    },
    preview: { host: '127.0.0.1', strictPort: true, cors: { origin: origins } },
  };
});
