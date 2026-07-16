// Coordinatore mixed-signal (M3): co-simulazione analogico↔digitale. Verificato
// contro il motore analogico comportamentale (oracolo) sullo stesso circuito.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim, voltsAt } from './helpers.ts';
import { MixedSignalSimulator, isMixed } from '../../src/engine/mixed.ts';

const mixed = new MixedSignalSimulator();
const VDD = 5;

test('isMixed: riconosce i circuiti misti', () => {
  assert.equal(isMixed(buildCircuit([['IN', 'logic_in'], ['R', 'resistor'], ['G', 'ground']], [])), true);
  assert.equal(isMixed(buildCircuit([['IN', 'logic_in'], ['N', 'not_gate']], [])), false); // solo digitale
  assert.equal(isMixed(buildCircuit([['R', 'resistor'], ['G', 'ground']], [])), false); // solo analogico
});

test('digitale → analogico: un ingresso logico pilota un carico resistivo', () => {
  const build = (high: boolean) =>
    buildCircuit(
      [['IN', 'logic_in', { high, vdd: VDD }], ['R', 'resistor', { R: 1000 }], ['G', 'ground']],
      [[['IN', 0], ['R', 0]], [['R', 1], ['G', 0]]],
    );
  const vOut = (high: boolean) => {
    const c = compile(build(high));
    return voltsAt(c, mixed.dcOperatingPoint(c), ['R', 0]); // net pilotato dal digitale
  };
  assert.ok(vOut(true) > 4.5, `alto → ~Vdd, ottenuto ${vOut(true)}`);
  assert.ok(Math.abs(vOut(false)) < 0.5, `basso → ~0, ottenuto ${vOut(false)}`);
});

test('analogico → digitale: un partitore pilota una NOT (coordinatore = oracolo)', () => {
  // mid = 5·9k/10k = 4.5 V > soglia → logica 1 → NOT = 0
  const circuit = buildCircuit(
    [
      ['V', 'vdc', { V: 5 }],
      ['R1', 'resistor', { R: 1000 }],
      ['R2', 'resistor', { R: 9000 }],
      ['N', 'not_gate', { vdd: VDD }],
      ['G', 'ground'],
    ],
    [
      [['V', 0], ['R1', 0]],
      [['R1', 1], ['R2', 0]],
      [['R2', 1], ['G', 0]],
      [['V', 1], ['G', 0]],
      [['R1', 1], ['N', 0]], // mid → NOT.in
    ],
  );
  const c = compile(circuit);
  const coord = voltsAt(c, mixed.dcOperatingPoint(c), ['N', 1]);
  const oracle = voltsAt(c, sim.dcOperatingPoint(c), ['N', 1]); // motore comportamentale
  assert.ok(coord < 1, `NOT dell'1 → 0, ottenuto ${coord}`);
  assert.ok(Math.abs(coord - oracle) < 0.6, `coordinatore≈oracolo: ${coord} vs ${oracle}`);
});

test('transitoria mista: clock pilota una RC (coordinatore ≈ oracolo)', () => {
  const circuit = buildCircuit(
    [
      ['CK', 'clock', { freq: 5, vdd: VDD }],
      ['R', 'resistor', { R: 1000 }],
      ['C', 'capacitor', { C: 100e-6 }],
      ['G', 'ground'],
    ],
    [[['CK', 0], ['R', 0]], [['R', 1], ['C', 0]], [['C', 1], ['G', 0]]],
  );
  const c = compile(circuit);
  const runFinal = (engine: typeof mixed | typeof sim) => {
    const session = engine.transient(c, { dt: 1e-3 });
    let last = session.step();
    for (let i = 0; i < 500; i++) last = session.step(); // ~0.5 s
    return voltsAt(c, last, ['C', 0]);
  };
  const vCoord = runFinal(mixed);
  const vOracle = runFinal(sim);
  assert.ok(vCoord >= -0.1 && vCoord <= VDD + 0.1, `vcap in [0,Vdd]: ${vCoord}`);
  assert.ok(Math.abs(vCoord - vOracle) < 0.7, `coordinatore≈oracolo sulla RC: ${vCoord} vs ${vOracle}`);
});
