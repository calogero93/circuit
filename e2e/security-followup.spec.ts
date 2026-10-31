import { test, expect } from '@playwright/test';

for (const source of ['file', 'scenario'] as const) {
  test(`${source}: effective Bode configuration rejects 43 unknowns before any sweep`, async ({ page }) => {
    await page.goto('/');
    const before = await page.evaluate(async () => {
      const storePath = '/src/store/studio.ts', lessonsPath = '/src/lessons/data.ts';
      const { useStudio } = await import(storePath);
      const { LESSONS } = await import(lessonsPath);
      const s = useStudio.getState();
      s.hydrate({ circuit: LESSONS[0].circuit, probes: [{ id: 'p', label: 'V', color: '#fff', pin: { component: 'V1', pin: 0 } }], scopeMode: 'bode', running: false });
      const controller = window.__circuitStudio!.controller;
      const original = controller.runBodeFor.bind(controller);
      (window as any).__followupSweeps = 0;
      controller.runBodeFor = compiled => { (window as any).__followupSweeps++; return original(compiled); };
      return JSON.stringify({ circuit: useStudio.getState().circuit, probes: useStudio.getState().probes, time: controller.time });
    });
    const components = [{ id: 'V1', type: 'vdc', x: 0, y: 0, params: { V: 1 } },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `R${i}`, type: 'resistor', x: i * 20, y: 0, params: { R: 1000 } }))];
    const circuit = { components, wires: [] };
    const payload = source === 'file' ? circuit : { version: 1, circuit, scopeMode: 'bode', probes: [{ label: 'V', pin: { component: 'V1', pin: 0 } }] };
    page.on('dialog', dialog => dialog.accept());
    await page.locator('input[type=file]').nth(source === 'file' ? 0 : 1).setInputFiles({ name: 'test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
    await expect(page.getByRole('alert')).toContainText('32 incognite');
    const after = await page.evaluate(async () => {
      const path = '/src/store/studio.ts';
      const { useStudio } = await import(path);
      return { state: JSON.stringify({ circuit: useStudio.getState().circuit, probes: useStudio.getState().probes, time: window.__circuitStudio!.controller.time }), sweeps: (window as any).__followupSweeps };
    });
    expect(after.state).toBe(before);
    expect(after.sweeps).toBe(0);
  });
}

test('over-limit editor command is rejected visibly; valid edit and undo still work', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const storePath = '/src/store/studio.ts', commandPath = '/src/store/commands.ts';
    const { useStudio } = await import(storePath);
    const { addComponent } = await import(commandPath);
    const resistor = (id: string) => ({ id, type: 'resistor', x: 0, y: 0, rot: 0, params: { R: 1000 } });
    const s = useStudio.getState();
    s.hydrate({ circuit: { components: Array.from({ length: 64 }, (_, i) => resistor(`R${i}`)), wires: [], groups: [], boundaries: [] }, scopeMode: 'time', probes: [], running: false, undoStack: [], redoStack: [] });
    const before = useStudio.getState();
    const accepted = before.execute(addComponent(resistor('overflow')));
    return { accepted, sameCircuit: before.circuit === useStudio.getState().circuit, sameProbes: before.probes === useStudio.getState().probes, count: useStudio.getState().circuit.components.length };
  });
  expect(result).toEqual({ accepted: false, sameCircuit: true, sameProbes: true, count: 64 });
  await expect(page.getByRole('alert')).toContainText('128 incognite');
  const recovered = await page.evaluate(async () => {
    const storePath = '/src/store/studio.ts', commandPath = '/src/store/commands.ts';
    const { useStudio } = await import(storePath);
    const { moveComponent } = await import(commandPath);
    const circuit = useStudio.getState().circuit;
    useStudio.getState().execute(moveComponent('R0', { x: 0, y: 0 }, { x: 40, y: 0 }));
    const moved = useStudio.getState().circuit.components[0].x === 40;
    useStudio.getState().undo();
    return { moved, restored: useStudio.getState().circuit.components[0].x === circuit.components[0].x,
      converged: window.__circuitStudio!.controller.runDC().result.converged };
  });
  expect(recovered).toEqual({ moved: true, restored: true, converged: true });
});
