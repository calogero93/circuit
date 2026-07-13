// Validazione: BJT NPN Ebers-Moll in zona attiva: IC ≈ βF·IB.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim, voltsAt } from './helpers.ts';

test('BJT in zona attiva: IC/IB ≈ βF e VCE coerente', () => {
  // VBB=5V → RB=430k → base; VCC=5V → RC=1k → collettore; emettitore a massa.
  const circuit = buildCircuit(
    [
      ['VCC', 'vdc', { V: 5 }],
      ['VBB', 'vdc', { V: 5 }],
      ['RB', 'resistor', { R: 430_000 }],
      ['RC', 'resistor', { R: 1_000 }],
      ['Q1', 'npn', { beta: 100 }],
      ['GND', 'ground'],
    ],
    [
      [['VBB', 0], ['RB', 0]],
      [['RB', 1], ['Q1', 0]], // base
      [['VCC', 0], ['RC', 0]],
      [['RC', 1], ['Q1', 1]], // collettore
      [['Q1', 2], ['GND', 0]], // emettitore
      [['VCC', 1], ['GND', 0]],
      [['VBB', 1], ['GND', 0]],
    ],
  );
  const compiled = compile(circuit);
  const result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged, 'deve convergere');
  const q = result.outputs.get('Q1')!.data;
  assert.ok(q.vbe > 0.5 && q.vbe < 0.8, `VBE di giunzione: ${q.vbe.toFixed(3)}`);
  assert.ok(q.vce > 1, `zona attiva, non saturazione: VCE=${q.vce.toFixed(3)}`);
  const ratio = q.ic / q.ib;
  assert.ok(Math.abs(ratio - 100) / 100 < 0.05, `IC/IB ≈ β: ${ratio.toFixed(1)}`);
  // KVL sul collettore: VCE = VCC − IC·RC
  const vceExpected = 5 - q.ic * 1_000;
  assert.ok(Math.abs(q.vce - vceExpected) < 0.01, 'KVL collettore');
  // il nodo di collettore letto dal partitore coincide
  const vc = voltsAt(compiled, result, ['Q1', 1]);
  assert.ok(Math.abs(vc - q.vce) < 1e-6);
});
