import { defineConfig } from '@playwright/test';

const port = Number(process.env.CIRCUIT_E2E_PORT ?? 5189);
const bridgePort = Number(process.env.CIRCUIT_E2E_BRIDGE_PORT ?? 8799);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // Le prove condividono relay e libreria locale degli scenari.
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
  },
  webServer: [{
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    env: { TOOL_BRIDGE_URL: `ws://127.0.0.1:${bridgePort}` },
    reuseExistingServer: false,
    timeout: 30_000,
  }, {
    command: 'npm run tool-bridge',
    url: `http://127.0.0.1:${bridgePort}/healthz`,
    env: { TOOL_BRIDGE_PORT: String(bridgePort), TOOL_BRIDGE_ALLOWED_ORIGINS: `http://127.0.0.1:${port}` },
    reuseExistingServer: false,
    timeout: 30_000,
  }],
});
