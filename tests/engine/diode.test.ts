// Validazione: diodo. I-V monotona, coerente con Shockley, e KCL rispettata
// nel circuito sorgente + resistore + diodo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim } from './helpers.ts';
import { shockleyCurrent, VT } from '../../src/library/junction.ts';

function solveDiodeCircuit(V: number) {
  const circuit = buildCircuit(
    [
      ['V1', 'vdc', { V }],
      ['R1', 'resistor', { R: 1_000 }],
      ['D1', 'diode'],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['D1', 0]],
      [['D1', 1], ['V1', 1]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  const compiled = compile(circuit);
  const result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged, `deve convergere con V=${V}`);
  return result.outputs.get('D1')!.data as any;
}

test('diodo: I-V monotona e coerente con Shockley', () => {
  const Is = 2.52e-9;
  const nVt = 1.752 * VT;
  let prev = -Infinity;
  for (const V of [0.2, 0.5, 1, 2, 5, 10, 20]) {
    const { vd, id } = solveDiodeCircuit(V);
    assert.ok(id > prev, `corrente crescente con la sorgente (V=${V})`);
    prev = id;
    const expected = shockleyCurrent(vd, Is, nVt);
    const err = Math.abs(id - expected) / Math.max(Math.abs(expected), 1e-12);
    assert.ok(err < 1e-6, `Shockley rispettata a V=${V}`);
    // KCL: la corrente nel resistore (V−vd)/R è la stessa del diodo
    const iR = (V - vd) / 1_000;
    assert.ok(Math.abs(iR - id) < 1e-6, `KCL a V=${V}: iR=${iR}, id=${id}`);
  }
});

test('diodo in inversa: corrente ≈ −Is', () => {
  const circuit = buildCircuit(
    [
      ['V1', 'vdc', { V: -10 }],
      ['R1', 'resistor', { R: 1_000 }],
      ['D1', 'diode'],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['D1', 0]],
      [['D1', 1], ['V1', 1]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  const compiled = compile(circuit);
  const result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged);
  const { id } = result.outputs.get('D1')!.data as any;
  assert.ok(id < 0 && id > -1e-6, `corrente inversa trascurabile: ${id}`);
});
