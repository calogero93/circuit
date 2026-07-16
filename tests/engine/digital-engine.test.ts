// Motore digitale nativo (M3, item 1): combinatoria a punto fisso e sequenziale
// (flip-flop D su fronte di clock), dietro l'interfaccia Simulator.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, voltsAt } from './helpers.ts';
import { DigitalSimulator, isPurelyDigital } from '../../src/engine/digital.ts';

const VDD = 5;
const sim = new DigitalSimulator();
const hi = (v: number) => v > 0.5 * VDD;

test('isPurelyDigital: distingue i domini', () => {
  const dig = buildCircuit([['IN', 'logic_in', { high: true }], ['G', 'not_gate']], [[['IN', 0], ['G', 0]]]);
  assert.equal(isPurelyDigital(dig), true);
  const mixed = buildCircuit([['R', 'resistor'], ['G', 'not_gate']], []);
  assert.equal(isPurelyDigital(mixed), false);
  assert.equal(isPurelyDigital(buildCircuit([], [])), false);
});

test('motore digitale: XOR e NAND danno la tavola di verità', () => {
  const out = (type: string, a: boolean, b: boolean) => {
    const c = buildCircuit(
      [['A', 'logic_in', { high: a }], ['B', 'logic_in', { high: b }], ['G', type]],
      [[['A', 0], ['G', 0]], [['B', 0], ['G', 1]]],
    );
    const compiled = compile(c);
    return voltsAt(compiled, sim.dcOperatingPoint(compiled), ['G', 2]);
  };
  // XOR
  assert.ok(!hi(out('xor_gate', false, false)));
  assert.ok(hi(out('xor_gate', true, false)));
  assert.ok(hi(out('xor_gate', false, true)));
  assert.ok(!hi(out('xor_gate', true, true)));
  // NAND
  assert.ok(hi(out('nand_gate', false, false)));
  assert.ok(hi(out('nand_gate', true, false)));
  assert.ok(!hi(out('nand_gate', true, true)));
});

test('flip-flop D: Q segue D ai fronti di salita del clock', () => {
  const run = (dHigh: boolean) => {
    const c = buildCircuit(
      [['CK', 'clock', { freq: 10 }], ['D', 'logic_in', { high: dHigh }], ['FF', 'dff']],
      [[['D', 0], ['FF', 0]], [['CK', 0], ['FF', 1]]],
    );
    const compiled = compile(c);
    const session = sim.transient(compiled, { dt: 0.005 });
    let last = session.step();
    for (let i = 0; i < 60; i++) last = session.step(); // ~0.3 s, diversi fronti
    return voltsAt(compiled, last, ['FF', 2]); // Q
  };
  assert.ok(hi(run(true)), 'D=1 → Q=1 dopo un fronte');
  assert.ok(!hi(run(false)), 'D=0 → Q=0');
});

test('divisore di frequenza: FF con Q̄→D dimezza la frequenza (toggle)', () => {
  // Q pilota un NOT che torna su D: a ogni fronte Q si inverte.
  const c = buildCircuit(
    [['CK', 'clock', { freq: 10 }], ['INV', 'not_gate'], ['FF', 'dff']],
    [
      [['CK', 0], ['FF', 1]], // clock → CLK
      [['FF', 2], ['INV', 0]], // Q → NOT.in
      [['INV', 1], ['FF', 0]], // NOT.out → D
    ],
  );
  const compiled = compile(c);
  const session = sim.transient(compiled, { dt: 0.0025 });
  const qHist: number[] = [];
  for (let i = 0; i < 160; i++) {
    const r = session.step();
    qHist.push(hi(voltsAt(compiled, r, ['FF', 2])) ? 1 : 0);
  }
  // Q deve cambiare valore più volte (toggle), non restare fisso
  const transitions = qHist.slice(1).filter((v, i) => v !== qHist[i]).length;
  assert.ok(transitions >= 4, `atteso toggling, transizioni=${transitions}`);
});
