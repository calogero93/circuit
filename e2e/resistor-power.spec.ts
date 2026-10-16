import { test, expect } from '@playwright/test';

const scenario = {
  version: 1, name: 'Dimensionamento', savedAt: '2026-10-16',
  circuit: { version: 1, components: [
    { id: 'V1', type: 'vdc', x: 140, y: 180, rot: 1, params: { V: 10 } },
    { id: 'R1', type: 'resistor', x: 320, y: 180, rot: 0, params: { R: 100, ratedPower: 0.25, thermalCapacity: 100 } },
    { id: 'G1', type: 'ground', x: 140, y: 300, rot: 0, params: {} },
  ], wires: [
    { id: 'w1', from: { component: 'V1', pin: 0 }, to: { component: 'R1', pin: 0 } },
    { id: 'w2', from: { component: 'R1', pin: 1 }, to: { component: 'G1', pin: 0 } },
    { id: 'w3', from: { component: 'V1', pin: 1 }, to: { component: 'G1', pin: 0 } },
  ] },
  timestep: 0.001, rightTab: 'props', probes: [], environment: { temperature: 25 },
};

test('resistenza: avviso live, cambio potenza nominale e derating a temperatura ambiente alta', async ({ page }) => {
  await page.goto(`/#s=${Buffer.from(JSON.stringify(scenario)).toString('base64url')}`);
  await page.locator('.toolbar').getByRole('button', { name: 'Pausa' }).click();
  const resistor = page.locator('.symbol[data-component-id="R1"]');
  await expect(resistor.locator('.power-warning')).toBeVisible();
  await resistor.locator('path').click();
  const panel = page.getByRole('region', { name: 'Dimensionamento di potenza' });
  await expect(panel).toContainText('400.0%');
  await expect(panel).toContainText('1 W');
  const rating = page.getByRole('textbox', { name: 'Potenza nominale', exact: true });
  await rating.fill('2');
  await rating.press('Enter');
  await expect(panel).toContainText('50.0%');
  await expect(panel.getByRole('status')).toHaveText('Entro il limite');
  await expect(resistor.locator('.power-warning')).toHaveCount(0);
  const ambient = page.locator('.env-panel label').filter({ hasText: 'Temperatura:' }).locator('input');
  await ambient.focus();
  await ambient.press('End');
  await expect(panel).toContainText('Consentita a 150.0 °C');
  await expect(panel.getByRole('status')).toContainText('Limite termico');
  await expect(resistor.locator('.power-warning')).toBeVisible();
  const reading = await page.evaluate(() => window.__circuitStudio!.controller.frame!.result.outputs.get('R1')!.data);
  expect(reading.ratedPower).toBe(2);
  expect(Number(reading.allowedPower)).toBeCloseTo(2 * 5 / 85, 8);
  expect(Number(reading.p)).toBeCloseTo(1, 8);
  expect(reading.meanPowerOverload).toBe(true);
});
