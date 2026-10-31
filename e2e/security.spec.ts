import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function circuitState(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const path = '/src/store/studio.ts';
    const state = (await import(path)).useStudio.getState();
    return { circuit: state.circuit, running: state.running, epoch: state.simulationEpoch, probes: state.probes };
  });
}

test('file imports reject oversized and malformed data without changing the paused circuit', async ({ page }) => {
  const errors: string[] = [];
  page.on('dialog', async dialog => { errors.push(dialog.message()); await dialog.accept(); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Lezioni' }).click();
  await page.locator('.lesson-card', { hasText: 'Partitore' }).getByRole('button', { name: 'Inizia' }).click();
  await page.locator('.toolbar').getByRole('button', { name: /Pausa/ }).click();
  const before = await circuitState(page);
  const files = page.locator('input[type=file]');
  const upload = async (index: number, body: string) => {
    const count = errors.length;
    await files.nth(index).setInputFiles({ name: 'circuit.json', mimeType: 'application/json', buffer: Buffer.from(body) });
    await expect.poll(() => errors.length).toBe(count + 1);
    expect(await circuitState(page)).toEqual(before);
  };
  await upload(0, ' '.repeat(2 * 1024 * 1024 + 1));
  expect(errors.at(-1)).toContain('2 MiB');
  await upload(0, '{broken');
  await upload(0, JSON.stringify({ components: Array(257).fill({}), wires: [] }));
  await upload(0, JSON.stringify({ ...before.circuit, wires: Array(1025).fill({}) }));
  await upload(1, JSON.stringify({ version: 1, circuit: { components: Array(257).fill({}), wires: [] } }));
  await upload(1, JSON.stringify({ version: 1, circuit: before.circuit, timestep: 1e-300 }));
  await files.nth(0).setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(before.circuit)) });
  await expect.poll(async () => (await circuitState(page)).circuit.components.length).toBe(before.circuit.components.length);
  expect(errors).toHaveLength(6);
});

test('invalid shared scenario leaves the application usable and paused', async ({ page }) => {
  const errors: string[] = [];
  page.on('dialog', async dialog => { errors.push(dialog.message()); await dialog.accept(); });
  const hash = Buffer.from(JSON.stringify({ version: 1, circuit: { components: Array(257).fill({}), wires: [] } })).toString('base64url');
  await page.goto(`/#s=${hash}`);
  await expect(page.locator('.toolbar').getByRole('button', { name: /Esegui/ })).toBeVisible();
  expect(errors).toHaveLength(1);
  const state = await circuitState(page);
  expect(state.running).toBe(false);
  expect(state.circuit.components).toHaveLength(0);
});

for (const mode of ['time', 'bode'] as const) {
  test(`CSV ${mode}: imported formula-like labels are neutralized in downloaded files`, async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async mode => {
      const scenarioPath = '/src/scenarios/scenario.ts';
      const storePath = '/src/store/studio.ts';
      const lessonsPath = '/src/lessons/data.ts';
      const { applyScenario } = await import(scenarioPath);
      const { useStudio } = await import(storePath);
      const { LESSONS } = await import(lessonsPath);
      if (!applyScenario({ version: 1, circuit: LESSONS[0].circuit,
        probes: [{ pin: { component: 'R1', pin: 0 }, label: ' \t=SUM(1,2)"\nnext' }], scopeMode: mode })) throw new Error('test scenario rejected');
      useStudio.getState().setRunning(false);
      window.__circuitStudio!.controller.samples = [{ t: 0.001, v: [-1.25], g: null }];
      window.__circuitStudio!.controller.bodePoints = [{ f: 100, gainDb: [-3.12], phaseDeg: [-45] }];
    }, mode);
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '📊 Esporta CSV' }).click();
    const download = await downloading;
    const content = readFileSync((await download.path())!, 'utf8');
    expect(content).toContain('"\' \t=SUM(1,2)""\nnext');
    expect(content).toContain(mode === 'time' ? '\n0.001000,-1.2500' : '\n100.00,-3.12,-45.0');
  });
}
