// Serializzazione JSON: roundtrip fedele e deserializzazione difensiva.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit } from './helpers.ts';
import { circuitFromJSON, circuitToJSON } from '../../src/model/serialize.ts';

test('roundtrip JSON fedele', () => {
  const circuit = buildCircuit(
    [
      ['V1', 'vdc', { V: 9 }],
      ['R1', 'resistor', { R: 4_700 }],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['V1', 1]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  const back = circuitFromJSON(JSON.parse(JSON.stringify(circuitToJSON(circuit))));
  assert.equal(back.components.length, 3);
  assert.equal(back.wires.length, 3);
  assert.equal(back.components.find((c) => c.id === 'R1')!.params.R, 4_700);
});

test('deserializzazione difensiva: input malformato non lancia', () => {
  assert.deepEqual(circuitFromJSON(null).components, []);
  assert.deepEqual(circuitFromJSON('spazzatura').components, []);
  const dirty = circuitFromJSON({
    components: [
      { id: 'R1', type: 'resistor', x: 0, y: 0, params: { R: 'non-un-numero' } },
      { id: 'X1', type: 'tipo-inesistente', x: 0, y: 0 },
      { id: 'R2', type: 'resistor', x: Number.NaN, y: 0 },
    ],
    wires: [
      { id: 'w1', from: { component: 'R1', pin: 0 }, to: { component: 'X1', pin: 0 } },
      { id: 'w2', from: { component: 'R1', pin: 0 }, to: { component: 'R1', pin: 99 } },
    ],
  });
  assert.equal(dirty.components.length, 1, 'sopravvive solo R1');
  assert.equal(dirty.components[0].params.R, 1000, 'parametro invalido → default');
  assert.equal(dirty.wires.length, 0, 'fili con riferimenti rotti scartati');
});
