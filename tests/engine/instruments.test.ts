// Strumenti di misura: voltmetro/multimetro (parallelo, alta impedenza) e
// amperometro (serie, ideale), e l'individuazione del componente misurato.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim } from './helpers.ts';
import { bridgedComponent } from '../../src/editor/instruments.ts';

test('multimetro (V): legge la tensione ai capi senza perturbare il partitore', () => {
  const circuit = buildCircuit(
    [
      ['V', 'vdc', { V: 10 }],
      ['R1', 'resistor', { R: 1000 }],
      ['R2', 'resistor', { R: 1000 }],
      ['MM', 'multimeter', { mode: 'V' }],
      ['G', 'ground'],
    ],
    [
      [['V', 0], ['R1', 0]],
      [['R1', 1], ['R2', 0]],
      [['R2', 1], ['G', 0]],
      [['V', 1], ['G', 0]],
      [['MM', 0], ['R2', 0]], // puntali ai capi di R2 (mid → gnd)
      [['MM', 1], ['R2', 1]],
    ],
  );
  const compiled = compile(circuit);
  const res = sim.dcOperatingPoint(compiled);
  const v = Number(res.outputs.get('MM')!.data.v);
  assert.ok(Math.abs(v - 5) < 0.02, `multimetro legge ~5 V, ottenuto ${v}`);
});

test('amperometro (serie): legge la corrente del ramo', () => {
  const circuit = buildCircuit(
    [
      ['V', 'vdc', { V: 10 }],
      ['R', 'resistor', { R: 1000 }],
      ['AM', 'ammeter'],
      ['G', 'ground'],
    ],
    [
      [['V', 0], ['R', 0]],
      [['R', 1], ['AM', 0]],
      [['AM', 1], ['G', 0]],
      [['V', 1], ['G', 0]],
    ],
  );
  const compiled = compile(circuit);
  const i = Math.abs(Number(sim.dcOperatingPoint(compiled).outputs.get('AM')!.data.i));
  assert.ok(Math.abs(i - 0.01) < 1e-4, `amperometro legge ~10 mA, ottenuto ${i}`);
});

test('più multimetri in parallelo: letture indipendenti', () => {
  const circuit = buildCircuit(
    [
      ['V', 'vdc', { V: 10 }],
      ['R1', 'resistor', { R: 1000 }],
      ['R2', 'resistor', { R: 1000 }],
      ['MM1', 'multimeter', { mode: 'V' }],
      ['MM2', 'multimeter', { mode: 'V' }],
      ['G', 'ground'],
    ],
    [
      [['V', 0], ['R1', 0]],
      [['R1', 1], ['R2', 0]],
      [['R2', 1], ['G', 0]],
      [['V', 1], ['G', 0]],
      [['MM1', 0], ['R1', 0]], // ai capi di R1
      [['MM1', 1], ['R1', 1]],
      [['MM2', 0], ['R2', 0]], // ai capi di R2
      [['MM2', 1], ['R2', 1]],
    ],
  );
  const compiled = compile(circuit);
  const res = sim.dcOperatingPoint(compiled);
  assert.ok(Math.abs(Math.abs(Number(res.outputs.get('MM1')!.data.v)) - 5) < 0.02);
  assert.ok(Math.abs(Math.abs(Number(res.outputs.get('MM2')!.data.v)) - 5) < 0.02);
  // riconosce quale componente misura ciascuno
  assert.equal(bridgedComponent(circuit, compiled.netOfPin, 'MM1')?.id, 'R1');
  assert.equal(bridgedComponent(circuit, compiled.netOfPin, 'MM2')?.id, 'R2');
});
