// Nuovi componenti digitali: XNOR, flip-flop T (divisore di frequenza) e
// display esadecimale a 7 segmenti.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, voltsAt } from './helpers.ts';
import { DigitalSimulator } from '../../src/engine/digital.ts';
import { SEGMENTS } from '../../src/library/digital.ts';

const sim = new DigitalSimulator();
const VDD = 5;
const hi = (v: number) => v > 0.5 * VDD;

test('XNOR: 1 se gli ingressi sono uguali', () => {
  const out = (a: boolean, b: boolean) => {
    const c = buildCircuit(
      [['A', 'logic_in', { high: a }], ['B', 'logic_in', { high: b }], ['G', 'xnor_gate']],
      [[['A', 0], ['G', 0]], [['B', 0], ['G', 1]]],
    );
    const compiled = compile(c);
    return voltsAt(compiled, sim.dcOperatingPoint(compiled), ['G', 2]);
  };
  assert.ok(hi(out(false, false)));
  assert.ok(!hi(out(true, false)));
  assert.ok(!hi(out(false, true)));
  assert.ok(hi(out(true, true)));
});

test('flip-flop T: con T=1 divide la frequenza del clock', () => {
  const c = buildCircuit(
    [['CK', 'clock', { freq: 10 }], ['T', 'logic_in', { high: true }], ['FF', 'tff']],
    [[['T', 0], ['FF', 0]], [['CK', 0], ['FF', 1]]],
  );
  const compiled = compile(c);
  const session = sim.transient(compiled, { dt: 0.0025 });
  const q: number[] = [];
  for (let i = 0; i < 160; i++) q.push(hi(voltsAt(compiled, session.step(), ['FF', 2])) ? 1 : 0);
  const transitions = q.slice(1).filter((v, i) => v !== q[i]).length;
  assert.ok(transitions >= 4, `atteso toggling, transizioni=${transitions}`);
});

test('display 7 segmenti: decodifica i 4 bit nella cifra e nei segmenti', () => {
  const readValue = (bits: boolean[]) => {
    const comps: [string, string, Record<string, boolean>?][] = [['D', 'seg_display']];
    const wires: [[string, number], [string, number]][] = [];
    bits.forEach((b, i) => {
      comps.push([`B${i}`, 'logic_in', { high: b }]);
      wires.push([[`B${i}`, 0], ['D', i]]);
    });
    const compiled = compile(buildCircuit(comps, wires));
    const res = sim.dcOperatingPoint(compiled);
    return res.outputs.get('D')!.data;
  };
  // 5 = 0101 (b0=1,b1=0,b2=1,b3=0)
  const d = readValue([true, false, true, false]);
  assert.equal(d.value, 5);
  SEGMENTS[5].forEach((on, i) => assert.equal(d[`s${i}`], on, `segmento ${i} della cifra 5`));

  // 0 e F agli estremi
  assert.equal(readValue([false, false, false, false]).value, 0);
  assert.equal(readValue([true, true, true, true]).value, 15);
});
