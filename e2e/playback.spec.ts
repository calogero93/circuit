import { expect, test, type Page } from '@playwright/test';

const scenario = {
  version: 1, name: 'Clock lento', savedAt: '2026-10-29',
  circuit: { version: 1, components: [
    { id: 'CK', type: 'clock', x: 200, y: 180, rot: 0, params: { freq: 0.2, vdd: 5 } },
    { id: 'OUT', type: 'logic_out', x: 420, y: 180, rot: 0, params: { vdd: 5 } },
  ], wires: [
    { id: 'w1', from: { component: 'CK', pin: 0 }, to: { component: 'OUT', pin: 0 } },
  ] },
  timestep: 0.005, rightTab: 'props', scopeTimespan: 10,
  probes: [{ pin: { component: 'CK', pin: 0 }, label: 'Clock' }],
};

async function prepare(page: Page) {
  await page.clock.install({ time: new Date('2026-10-29T12:00:00Z') });
  await page.goto(`/#s=${Buffer.from(JSON.stringify(scenario)).toString('base64url')}`);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await page.evaluate(async (saved) => {
    const path = '/src/scenarios/scenario.ts';
    (await import(path)).applyScenario(saved);
  }, scenario);
}

const reading = (page: Page) => page.evaluate(() => {
  const controller = window.__circuitStudio!.controller;
  return { time: controller.time, logic: controller.frame?.result.outputs.get('CK')?.data.logic };
});

test('1× e frequenza con virgola: High e Low durano cinque secondi del clock reale controllato', async ({ page }, info) => {
  await prepare(page);
  const speed = page.getByRole('combobox', { name: 'Velocità simulazione' });
  await expect(speed).toHaveValue('1');
  await page.locator('.symbol[data-component-id="CK"]').locator('path').first().click({ force: true });
  const frequency = page.getByRole('textbox', { name: 'Frequenza', exact: true });
  await frequency.fill('0,1');
  await frequency.press('Enter');
  await expect(frequency).toHaveValue('0.1');

  await page.clock.runFor(4900);
  let value = await reading(page);
  expect(value.time).toBeCloseTo(4.9, 1);
  expect(value.logic).toBe(1);
  await page.clock.runFor(200);
  value = await reading(page);
  expect(value.time).toBeCloseTo(5.1, 1);
  expect(value.logic).toBe(0);
  await page.clock.runFor(4800);
  expect((await reading(page)).logic).toBe(0);
  await page.clock.runFor(200);
  value = await reading(page);
  expect(value.time).toBeCloseTo(10.1, 1);
  expect(value.logic).toBe(1);
  await page.screenshot({ path: info.outputPath('playback-1x.png') });
});

test('pausa, velocità 2× e background conservano il tempo senza recuperare le sospensioni', async ({ page }) => {
  await prepare(page);
  await page.clock.runFor(1000);
  const initial = (await reading(page)).time;
  expect(initial).toBeCloseTo(1, 1);
  await page.locator('.toolbar').getByRole('button', { name: 'Pausa' }).click({ force: true });
  await page.clock.fastForward(30000);
  expect((await reading(page)).time).toBe(initial);
  await page.locator('.toolbar').getByRole('button', { name: 'Esegui' }).click({ force: true });
  await page.clock.runFor(1000);
  const resumed = (await reading(page)).time;
  expect(resumed - initial).toBeCloseTo(1, 1);
  await page.getByRole('combobox', { name: 'Velocità simulazione' }).selectOption('2');
  await page.clock.runFor(1000);
  const doubled = (await reading(page)).time;
  expect(doubled - resumed).toBeCloseTo(2, 1);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(60000);
  expect((await reading(page)).time).toBe(doubled);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(1000);
  expect((await reading(page)).time - doubled).toBeCloseTo(2, 1);
});
