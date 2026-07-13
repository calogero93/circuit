// Smoke e2e: carica l'app, apre la lezione di punta (raddrizzatore), verifica
// che il canvas non sia vuoto e che l'oscilloscopio disegni davvero tracce
// (metrica a pixel), piazza un componente e verifica undo.

import { expect, test } from '@playwright/test';

/** Conta i pixel del canvas dello scope diversi dal fondo. */
async function scopeInkPixels(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.scope-canvas-wrap canvas');
    if (!canvas) return -1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return -1;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      // fondo #14171f ≈ (20,23,31): tutto ciò che se ne discosta è "inchiostro"
      if (Math.abs(data[i] - 20) + Math.abs(data[i + 1] - 23) + Math.abs(data[i + 2] - 31) > 40) ink++;
    }
    return ink;
  });
}

test('carica, apre la lezione raddrizzatore, simula e piazza componenti', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.brand')).toContainText('Circuit Studio');

  // palette presente
  await expect(page.locator('.palette-item')).toHaveCount(11);

  // apri la lezione di punta
  await page.getByRole('button', { name: 'Lezioni' }).click();
  const card = page.locator('.lesson-card', { hasText: 'Raddrizzatore' });
  await card.getByRole('button', { name: 'Inizia' }).click();

  // il circuito della lezione è sul canvas (6 componenti + anteprime escluse)
  await expect(page.locator('.canvas-svg .symbol:not(.ghost)')).toHaveCount(6);
  // i fili sono renderizzati
  expect(await page.locator('.canvas-svg path.wire').count()).toBeGreaterThanOrEqual(6);

  // la simulazione gira: lo scope disegna tracce (pixel non di fondo)
  await page.waitForTimeout(1500);
  const ink = await scopeInkPixels(page);
  expect(ink).toBeGreaterThan(500);

  // il tempo di simulazione avanza
  const t1 = await page.locator('.sim-status').textContent();
  await page.waitForTimeout(700);
  const t2 = await page.locator('.sim-status').textContent();
  expect(t1).not.toEqual(t2);

  // piazza un resistore: click in palette, click sul canvas
  await page.getByRole('button', { name: 'Resistore', exact: true }).click();
  await page.locator('.canvas-svg').click({ position: { x: 300, y: 420 } });
  await expect(page.locator('.canvas-svg .symbol:not(.ghost)')).toHaveCount(7);

  // undo lo rimuove
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.canvas-svg .symbol:not(.ghost)')).toHaveCount(6);
});

test('confronto A/B: togliere il condensatore fa ricomparire l\'ondulazione', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Lezioni' }).click();
  await page
    .locator('.lesson-card', { hasText: 'Raddrizzatore' })
    .getByRole('button', { name: 'Inizia' })
    .click();
  await page.waitForTimeout(1200);

  // attiva il confronto A/B dalla lezione (C1 tolto → semionde pulsanti)
  await page.getByRole('button', { name: /A\/B/ }).click();
  await expect(page.locator('.legend-item', { hasText: 'fantasma' })).toBeVisible();
  await page.waitForTimeout(1500);

  // criterio di accettazione M1, misurato sui campioni reali dello scope:
  // con C l'uscita resta livellata; senza C (fantasma) pulsa tra ~0 e il picco
  const stats = await page.evaluate(() => {
    const controller = window.__circuitStudio!.controller;
    const recent = controller.samples.slice(-400).filter((s) => s.g !== null);
    const vout = recent.map((s) => s.v[1]);
    const gout = recent.map((s) => s.g![1]);
    return {
      n: recent.length,
      mainMin: Math.min(...vout),
      ghostMin: Math.min(...gout),
      ghostMax: Math.max(...gout),
    };
  });
  expect(stats.n).toBeGreaterThan(100);
  expect(stats.mainMin).toBeGreaterThan(3); // livellato (ripple piccolo)
  expect(stats.ghostMin).toBeLessThan(0.5); // senza C l'uscita crolla a ~0
  expect(stats.ghostMax).toBeGreaterThan(3.5); // ...e risale fino al picco
});
