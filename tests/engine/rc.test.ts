// Validazione analitica: carica RC. V(t) = Vin·(1 − e^(−t/τ)), τ = RC.
// A t = τ la tensione deve valere il 63,2% di Vin.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim, voltsAt } from './helpers.ts';

test('carica RC: 63,2% a t = τ (backward Euler)', () => {
  const R = 1_000;
  const C = 1e-3;
  const tau = R * C; // 1 s
  const Vin = 5;
  const circuit = buildCircuit(
    [
      ['V1', 'vdc', { V: Vin }],
      ['R1', 'resistor', { R }],
      ['C1', 'capacitor', { C }],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['C1', 0]],
      [['C1', 1], ['V1', 1]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  const compiled = compile(circuit);
  const dt = tau / 1000;
  const session = sim.transient(compiled, { dt });
  let vAtTau = NaN;
  const steps = Math.round(tau / dt);
  for (let k = 0; k < steps; k++) {
    const res = session.step();
    assert.ok(res.converged, `passo ${k} deve convergere`);
    if (k === steps - 1) vAtTau = voltsAt(compiled, res, ['C1', 0]);
  }
  const expected = Vin * (1 - Math.exp(-1)); // 3.1606 V
  const err = Math.abs(vAtTau - expected) / expected;
  assert.ok(err < 0.01, `V(τ) = ${vAtTau.toFixed(4)}, atteso ${expected.toFixed(4)} (err ${(err * 100).toFixed(2)}%)`);
});

test('scarica RC: continuità dello stato tra sessioni', () => {
  const circuit = buildCircuit(
    [
      ['V1', 'vdc', { V: 5 }],
      ['R1', 'resistor', { R: 1_000 }],
      ['C1', 'capacitor', { C: 1e-3 }],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['C1', 0]],
      [['C1', 1], ['V1', 1]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  const compiled = compile(circuit);
  const s1 = sim.transient(compiled, { dt: 1e-3 });
  for (let k = 0; k < 5000; k++) s1.step(); // ~5τ: quasi a regime
  // riparte una nuova sessione con gli stati travasati (come dopo un edit live)
  const s2 = sim.transient(compiled, { dt: 1e-3, initialStates: s1.states(), t0: 5 });
  const res = s2.step();
  const v = voltsAt(compiled, res, ['C1', 0]);
  assert.ok(Math.abs(v - 5) < 0.05, `condensatore ancora carico: ${v.toFixed(3)} V`);
});
