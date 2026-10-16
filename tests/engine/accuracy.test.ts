import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim, voltsAt } from './helpers.ts';

function rc(tau: number) {
  return compile(buildCircuit([
    ['V', 'vdc', { V: 5 }], ['R', 'resistor', { R: 1000 }],
    ['C', 'capacitor', { C: tau / 1000 }], ['G', 'ground'],
  ], [[['V', 0], ['R', 0]], [['R', 1], ['C', 0]], [['C', 1], ['G', 0]], [['V', 1], ['G', 0]]]));
}

test('RC: sottopassi adattivi migliorano il passo fisso su tre scale temporali', () => {
  const exact = 5 * (1 - Math.exp(-1));
  for (const tau of [1e-4, 1e-3, 0.1]) {
    const circuit = rc(tau);
    const dt = tau / 5;
    const adaptive = sim.transient(circuit, { dt });
    const fixed = sim.transient(circuit, { dt, adaptive: false });
    let a, f;
    for (let k = 0; k < 5; k++) { a = adaptive.step(); f = fixed.step(); }
    assert.ok(a!.converged);
    assert.ok(Math.abs(a!.time - tau) < tau * 1e-12, 'griglia pubblica invariata');
    const ae = Math.abs(voltsAt(circuit, a!, ['C', 0]) - exact);
    const fe = Math.abs(voltsAt(circuit, f!, ['C', 0]) - exact);
    assert.ok(ae / exact < 0.003, `errore RC tau=${tau}: ${ae / exact}`);
    assert.ok(ae < fe / 10, 'miglioramento rispetto al passo fisso');
    assert.ok(a!.diagnostics!.errorEstimate! <= 1);
    assert.ok(a!.diagnostics!.residual <= 1);
  }
});

test('passo rifiutato: tempo e carica non cambiano', () => {
  const session = sim.transient(rc(1e-3), { dt: 1e-3, adaptive: { maxAttempts: 1 } });
  const before = session.states();
  const result = session.step();
  assert.equal(result.converged, false);
  assert.equal(session.time, 0);
  assert.deepEqual(session.states(), before);
  assert.ok(result.diagnostics!.rejectedSubsteps! > 0);
});

test('RL: transitoria confrontata con soluzione esponenziale', () => {
  for (const R of [10, 1000]) {
    const L = R * 0.01;
    const c = compile(buildCircuit([
      ['V', 'vdc', { V: 5 }], ['R', 'resistor', { R }], ['L', 'inductor', { L }], ['G', 'ground'],
    ], [[['V', 0], ['R', 0]], [['R', 1], ['L', 0]], [['L', 1], ['G', 0]], [['V', 1], ['G', 0]]]));
    const session = sim.transient(c, { dt: 0.002 });
    let result;
    for (let k = 0; k < 5; k++) result = session.step();
    const exact = 5 / R * (1 - Math.exp(-1));
    assert.ok(result!.converged);
    assert.ok(Math.abs(Number(result!.outputs.get('L')!.data.i) - exact) / exact < 0.003);
  }
});

test('partitori: tolleranze separate e residui su resistenze molto diverse', () => {
  for (const R of [10, 1e3, 1e6]) for (const ratio of [0.01, 1, 100]) {
    const c = compile(buildCircuit([
      ['V', 'vdc', { V: 5 }], ['A', 'resistor', { R }], ['B', 'resistor', { R: R * ratio }], ['G', 'ground'],
    ], [[['V', 0], ['A', 0]], [['A', 1], ['B', 0]], [['B', 1], ['G', 0]], [['V', 1], ['G', 0]]]));
    const result = sim.dcOperatingPoint(c);
    const expected = 5 * ratio / (1 + ratio);
    assert.ok(result.converged);
    assert.ok(result.diagnostics!.residual <= 1);
    assert.deepEqual(result.diagnostics!.floatingNets, []);
    assert.ok(Math.abs(voltsAt(c, result, ['B', 0]) - expected) / expected < 2e-6);
  }
});

test('diagnostica: un’isola senza massa viene segnalata', () => {
  const c = compile(buildCircuit([['R', 'resistor', { R: 1000 }], ['G', 'ground']], []));
  const result = sim.dcOperatingPoint(c);
  assert.equal(result.diagnostics!.floatingNets.length, 2);
  assert.ok(result.diagnostics!.warnings.some((s) => s.includes('flottanti')));
});

test('sorgenti ideali incompatibili: fallimento esplicito e residuo non valido', () => {
  const c = compile(buildCircuit([
    ['A', 'vdc', { V: 5 }], ['B', 'vdc', { V: 9 }], ['G', 'ground'],
  ], [[['A', 0], ['B', 0]], [['A', 1], ['G', 0]], [['B', 1], ['G', 0]]]));
  assert.equal(sim.dcOperatingPoint(c).converged, false);
});
