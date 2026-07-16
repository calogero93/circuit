// Validazione analitica: partitore di tensione Vout = Vin·R2/(R1+R2).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim, voltsAt } from './helpers.ts';

test('partitore di tensione: valore esatto', () => {
  const circuit = buildCircuit(
    [
      ['V1', 'vdc', { V: 9 }],
      ['R1', 'resistor', { R: 10_000 }],
      ['R2', 'resistor', { R: 10_000 }],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['R2', 0]],
      [['R2', 1], ['V1', 1]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  const compiled = compile(circuit);
  const result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged, 'deve convergere');
  assert.ok(Math.abs(voltsAt(compiled, result, ['R1', 1]) - 4.5) < 1e-6, 'Vout = 4.5 V');
  assert.ok(Math.abs(voltsAt(compiled, result, ['V1', 0]) - 9) < 1e-6, 'Vin = 9 V');
  // corrente nel ramo: 9 / 20k = 0.45 mA
  const iR1 = (result.outputs.get('R1')!.data as any).i;
  assert.ok(Math.abs(iR1 - 0.45e-3) < 1e-9, 'I = 0.45 mA');
});

test('partitore asimmetrico: Vout = Vin·R2/(R1+R2)', () => {
  const circuit = buildCircuit(
    [
      ['V1', 'vdc', { V: 12 }],
      ['R1', 'resistor', { R: 3_300 }],
      ['R2', 'resistor', { R: 1_800 }],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['R2', 0]],
      [['R2', 1], ['V1', 1]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  const compiled = compile(circuit);
  const result = sim.dcOperatingPoint(compiled);
  const expected = (12 * 1800) / (3300 + 1800);
  assert.ok(result.converged);
  assert.ok(Math.abs(voltsAt(compiled, result, ['R2', 0]) - expected) < 1e-6);
});
