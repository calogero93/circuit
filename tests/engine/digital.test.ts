// M3 (prima fetta): le porte logiche comportamentali producono le tavole di
// verità corrette quando risolte dal motore analogico (mixed-signal).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim, voltsAt } from './helpers.ts';

const VDD = 5;
const isHigh = (v: number) => v > 0.7 * VDD;
const isLow = (v: number) => v < 0.3 * VDD;

/** Risolve una porta con ingressi logici dati e ritorna la tensione d'uscita. */
function gateOut(type: string, inputs: boolean[]): number {
  const comps: [string, string, Record<string, boolean | number>?][] = [['G', type, { vdd: VDD }]];
  const wires: [[string, number], [string, number]][] = [];
  inputs.forEach((high, i) => {
    comps.push([`IN${i}`, 'logic_in', { high, vdd: VDD }]);
    wires.push([[`IN${i}`, 0], ['G', i]]); // IN.out → G.pin(i)
  });
  const circuit = buildCircuit(comps, wires);
  const compiled = compile(circuit);
  const res = sim.dcOperatingPoint(compiled);
  assert.equal(res.converged, true, `${type} non converge con ingressi ${inputs}`);
  return voltsAt(compiled, res, ['G', inputs.length]); // pin d'uscita = dopo gli ingressi
}

test('NOT: tavola di verità', () => {
  assert.ok(isHigh(gateOut('not_gate', [false])), 'NOT 0 = 1');
  assert.ok(isLow(gateOut('not_gate', [true])), 'NOT 1 = 0');
});

test('AND: tavola di verità', () => {
  assert.ok(isLow(gateOut('and_gate', [false, false])), '0·0=0');
  assert.ok(isLow(gateOut('and_gate', [true, false])), '1·0=0');
  assert.ok(isLow(gateOut('and_gate', [false, true])), '0·1=0');
  assert.ok(isHigh(gateOut('and_gate', [true, true])), '1·1=1');
});

test('OR: tavola di verità', () => {
  assert.ok(isLow(gateOut('or_gate', [false, false])), '0+0=0');
  assert.ok(isHigh(gateOut('or_gate', [true, false])), '1+0=1');
  assert.ok(isHigh(gateOut('or_gate', [false, true])), '0+1=1');
  assert.ok(isHigh(gateOut('or_gate', [true, true])), '1+1=1');
});

test('composizione: NOT(AND(a,b)) = NAND', () => {
  // AND alimenta un NOT: verifica il confine digitale→digitale in cascata
  const build = (a: boolean, b: boolean) => {
    const circuit = buildCircuit(
      [
        ['A', 'logic_in', { high: a, vdd: VDD }],
        ['B', 'logic_in', { high: b, vdd: VDD }],
        ['AND', 'and_gate', { vdd: VDD }],
        ['NOT', 'not_gate', { vdd: VDD }],
      ],
      [
        [['A', 0], ['AND', 0]],
        [['B', 0], ['AND', 1]],
        [['AND', 2], ['NOT', 0]],
      ],
    );
    const compiled = compile(circuit);
    const res = sim.dcOperatingPoint(compiled);
    assert.equal(res.converged, true);
    return voltsAt(compiled, res, ['NOT', 1]);
  };
  assert.ok(isHigh(build(false, false)), 'NAND 0,0 = 1');
  assert.ok(isHigh(build(true, false)), 'NAND 1,0 = 1');
  assert.ok(isLow(build(true, true)), 'NAND 1,1 = 0');
});
