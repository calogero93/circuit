// Integrazione: induttore in DC, raddrizzatore con/senza condensatore di
// livellamento (il caso didattico di punta di M1) e interruttore.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim, voltsAt } from './helpers.ts';
import type { Circuit } from '../../src/model/types.ts';

test('induttore in DC: cortocircuito, I = V/R', () => {
  const circuit = buildCircuit(
    [
      ['V1', 'vdc', { V: 5 }],
      ['R1', 'resistor', { R: 100 }],
      ['L1', 'inductor', { L: 0.1 }],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['L1', 0]],
      [['L1', 1], ['V1', 1]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  const compiled = compile(circuit);
  const result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged);
  assert.ok(Math.abs(result.outputs.get('L1')!.data.i - 0.05) < 1e-6, 'I = 50 mA');
});

function rectifier(withCap: boolean): Circuit {
  const comps: Parameters<typeof buildCircuit>[0] = [
    ['V1', 'vsin', { amp: 5, freq: 50, offset: 0 }],
    ['D1', 'diode'],
    ['RL', 'resistor', { R: 1_000 }],
    ['GND', 'ground'],
  ];
  const wires: Parameters<typeof buildCircuit>[1] = [
    [['V1', 0], ['D1', 0]],
    [['D1', 1], ['RL', 0]],
    [['RL', 1], ['V1', 1]],
    [['V1', 1], ['GND', 0]],
  ];
  if (withCap) {
    comps.push(['C1', 'capacitor', { C: 100e-6 }]);
    wires.push([['C1', 0], ['RL', 0]], [['C1', 1], ['RL', 1]]);
  }
  return buildCircuit(comps, wires);
}

function rippleOf(circuit: Circuit): number {
  const compiled = compile(circuit);
  const dt = 1e-4;
  const session = sim.transient(compiled, { dt });
  const total = Math.round(0.2 / dt); // 200 ms = 10 periodi a 50 Hz
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < total; k++) {
    const res = session.step();
    assert.ok(res.converged, `raddrizzatore: passo ${k} converge`);
    if (k >= total - Math.round(0.04 / dt)) {
      // ultimi 2 periodi, a regime
      const v = voltsAt(compiled, res, ['RL', 0]);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  return max - min;
}

test('raddrizzatore: il condensatore di livellamento riduce visibilmente l’ondulazione', () => {
  const rippleSenza = rippleOf(rectifier(false));
  const rippleCon = rippleOf(rectifier(true));
  assert.ok(rippleSenza > 3, `senza C l’uscita pulsa: ripple=${rippleSenza.toFixed(2)} V`);
  assert.ok(rippleCon < rippleSenza / 3, `con C il ripple crolla: ${rippleCon.toFixed(2)} V vs ${rippleSenza.toFixed(2)} V`);
});

test('interruttore SPST: aperto blocca, chiuso conduce', () => {
  const make = (closed: boolean) =>
    buildCircuit(
      [
        ['V1', 'vdc', { V: 5 }],
        ['SW', 'switch', { closed }],
        ['R1', 'resistor', { R: 1_000 }],
        ['GND', 'ground'],
      ],
      [
        [['V1', 0], ['SW', 0]],
        [['SW', 1], ['R1', 0]],
        [['R1', 1], ['V1', 1]],
        [['V1', 1], ['GND', 0]],
      ],
    );
  const open = sim.dcOperatingPoint(compile(make(false)));
  const closed = sim.dcOperatingPoint(compile(make(true)));
  assert.ok(Math.abs(open.outputs.get('R1')!.data.i) < 1e-6, 'aperto: niente corrente');
  assert.ok(Math.abs(closed.outputs.get('R1')!.data.i - 5e-3) < 1e-4, 'chiuso: ~5 mA');
});
