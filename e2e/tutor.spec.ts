import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

const bridgeUrl = `127.0.0.1:${process.env.CIRCUIT_E2E_BRIDGE_PORT ?? 8799}`;

test('tutor: usa un solo endpoint LangGraph e mostra tool e revisione obsoleta', async ({ page }) => {
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/chat', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { response: 'R1 limita la corrente.', snapshot_revision: -1,
      tools: [{ tool: 'getCircuitSnapshot', input: {}, ok: true }] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Tutor AI' }).click();
  await page.locator('.tutor textarea').fill('Come funziona R1?');
  await page.getByRole('button', { name: 'Invia', exact: true }).click();
  await expect(page.locator('.tutor .msg.assistant')).toHaveText('R1 limita la corrente.');
  await expect(page.locator('.tutor-log')).toContainText('getCircuitSnapshot');
  await expect(page.locator('.tutor-log')).toContainText('configurazione precedente');
  expect(requests[0].query).toBe('Come funziona R1?');
  expect(typeof requests[0].thread_id).toBe('string');
  expect(requests[0]).not.toHaveProperty('tools');
  expect(requests[0]).not.toHaveProperty('system');
});

test('relay WebSocket: snapshot coerente e calcoli eseguiti dal browser live', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Lezioni' }).click();
  await page.locator('.lesson-card', { hasText: 'Partitore' }).getByRole('button', { name: 'Inizia' }).click();
  await expect.poll(async () => (await (await request.get(`http://${bridgeUrl}/healthz`)).json()).connected).toBe(true);
  const ws = new WebSocket(`ws://${bridgeUrl}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0;
  const call = (tool: string, input: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout tool live')), 10000);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      const msg = JSON.parse(raw.toString());
      if (msg.error) reject(new Error(msg.error)); else resolve(msg.result);
    });
    ws.send(JSON.stringify({ type: 'call', id: ++id, tool, input }));
  });
  try {
    const snapshot = await call('getCircuitSnapshot');
    expect(snapshot.measurementsAvailable).toBe(true);
    expect(snapshot.converged).toBe(true);
    expect(snapshot.netlist.components.length).toBeGreaterThan(2);
    expect(snapshot.time_s).toBeGreaterThan(0);
    expect(Object.keys(snapshot.components).length).toBe(snapshot.netlist.components.length);
    expect(snapshot.diagnostics.residual).toBeLessThanOrEqual(1);
    expect(snapshot.components.R1.data.ratedPower).toBe(0.25);
    expect(typeof snapshot.components.R1.data.meanPower).toBe('number');
    expect(typeof snapshot.components.R1.data.allowedPower).toBe('number');
    const dc = await call('runDC');
    expect(dc.revision).toBe(snapshot.revision);
    expect(dc.converged).toBe(true);
    expect(dc.diagnostics.floatingNets).toEqual([]);
    const transient = await call('runTransient', { duration_ms: 1, dt_us: 1000 });
    expect(transient.converged).toBe(true);
    expect(transient.truncated).toBe(false);
    expect(transient.actualDuration_s).toBeCloseTo(0.001, 9);
  } finally { ws.close(); }
});
