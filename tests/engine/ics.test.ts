// Circuiti integrati comportamentali: timer 555 (astabile), comparatore,
// regolatore di tensione.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim, voltsAt } from './helpers.ts';

test('555 astabile: l\'uscita oscilla', () => {
  // VCC=9; Ra=1k, Rb=1k, C=10µF; THR/TRG sul condensatore, DIS al nodo Ra/Rb
  const circuit = buildCircuit(
    [
      ['V', 'vdc', { V: 9 }],
      ['U', 'ne555'],
      ['Ra', 'resistor', { R: 1000 }],
      ['Rb', 'resistor', { R: 1000 }],
      ['C', 'capacitor', { C: 10e-6 }],
      ['G', 'ground'],
    ],
    [
      [['V', 0], ['U', 0]], // VCC
      [['U', 1], ['G', 0]], // GND
      [['V', 1], ['G', 0]],
      [['U', 6], ['V', 0]], // RESET → VCC
      [['V', 0], ['Ra', 0]], // Ra da VCC…
      [['Ra', 1], ['U', 4]], // …al nodo DIS
      [['Ra', 1], ['Rb', 0]],
      [['Rb', 1], ['C', 0]], // Rb al condensatore
      [['C', 1], ['G', 0]],
      [['U', 3], ['C', 0]], // THR sul condensatore
      [['U', 2], ['C', 0]], // TRG sul condensatore
    ],
  );
  const compiled = compile(circuit);
  const session = sim.transient(compiled, { dt: 1e-4 });
  const out: number[] = [];
  for (let i = 0; i < 2000; i++) out.push(voltsAt(compiled, session.step(), ['U', 5]) > 4.5 ? 1 : 0); // ~0.2 s
  const transitions = out.slice(1).filter((v, i) => v !== out[i]).length;
  assert.ok(transitions >= 4, `atteso oscillazione, transizioni=${transitions}`);
});

test('comparatore: commuta secondo il segno della differenza', () => {
  const build = (vp: number, vn: number) => {
    const circuit = buildCircuit(
      [
        ['VP', 'vdc', { V: vp }],
        ['VN', 'vdc', { V: vn }],
        ['K', 'comparator', { vhigh: 5, hyst: 0 }],
        ['G', 'ground'],
      ],
      [
        [['VP', 0], ['K', 0]],
        [['VP', 1], ['G', 0]],
        [['VN', 0], ['K', 1]],
        [['VN', 1], ['G', 0]],
      ],
    );
    const compiled = compile(circuit);
    return voltsAt(compiled, sim.dcOperatingPoint(compiled), ['K', 2]);
  };
  assert.ok(build(3, 1) > 4, 'V+ > V− → uscita alta');
  assert.ok(build(1, 3) < 1, 'V+ < V− → uscita bassa');
});

test('regolatore: fissa l\'uscita se ha margine, altrimenti la segue', () => {
  const build = (vin: number) => {
    const circuit = buildCircuit(
      [
        ['V', 'vdc', { V: vin }],
        ['REG', 'vreg', { vout: 5, dropout: 2 }],
        ['RL', 'resistor', { R: 1000 }],
        ['G', 'ground'],
      ],
      [
        [['V', 0], ['REG', 0]],
        [['REG', 1], ['RL', 0]],
        [['RL', 1], ['G', 0]],
        [['REG', 2], ['G', 0]],
        [['V', 1], ['G', 0]],
      ],
    );
    const compiled = compile(circuit);
    return voltsAt(compiled, sim.dcOperatingPoint(compiled), ['REG', 1]);
  };
  assert.ok(Math.abs(build(9) - 5) < 0.1, `9 V in → 5 V out, ottenuto ${build(9)}`);
  const low = build(4); // 4 V in: sotto 5+dropout → segue ~vin-dropout
  assert.ok(low < 4.9 && low > 1, `4 V in → uscita ridotta, ottenuto ${low}`);
});
