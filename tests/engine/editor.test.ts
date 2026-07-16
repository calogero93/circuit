// Verifica temporanea del layer editor (giunzioni, routing, comandi).
import test from 'node:test';
import assert from 'node:assert/strict';
import { orthogonalRoute, projectOnRoute, splitRoute } from '../../src/editor/geometry.ts';
import { branchWire, flipWireElbow, moveComponents, addItems } from '../../src/store/commands.ts';
import { emptyCircuit, pinKey, type ComponentInstance, type Wire } from '../../src/model/types.ts';
import { compile } from '../../src/model/netlist.ts';
import { registerLibrary } from '../../src/library/index.ts';

registerLibrary();

test('compile: un nodo di giunzione fonde i fili nello stesso net', () => {
  const c = emptyCircuit();
  c.components = [
    { id: 'R1', type: 'resistor', x: 0, y: 0, rot: 0, params: {} },
    { id: 'R2', type: 'resistor', x: 100, y: 0, rot: 0, params: {} },
    { id: 'J1', type: 'node', x: 50, y: 0, rot: 0, params: {} },
  ];
  const nodePin = { component: 'J1', pin: 0 };
  c.wires = [
    { id: 'w1', from: { component: 'R1', pin: 1 }, to: nodePin },
    { id: 'w2', from: { component: 'R2', pin: 0 }, to: nodePin },
  ];
  const compiled = compile(c);
  const nR1 = compiled.netOfPin.get(pinKey({ component: 'R1', pin: 1 }));
  const nR2 = compiled.netOfPin.get(pinKey({ component: 'R2', pin: 0 }));
  const nJ = compiled.netOfPin.get(pinKey(nodePin));
  assert.notEqual(nR1, undefined);
  assert.equal(nR1, nR2); // R1.pin1 ed R2.pin0 sono lo stesso nodo elettrico
  assert.equal(nR1, nJ); // ...e coincidono col nodo di giunzione
});

test('orthogonalRoute: gomito orizzontale-prima vs verticale-prima', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 40, y: 20 };
  assert.deepEqual(orthogonalRoute(a, b, false), [a, { x: 40, y: 0 }, b]);
  assert.deepEqual(orthogonalRoute(a, b, true), [a, { x: 0, y: 20 }, b]);
  // allineati → segmento dritto, indipendente dal gomito
  assert.deepEqual(orthogonalRoute({ x: 0, y: 0 }, { x: 40, y: 0 }, true), [{ x: 0, y: 0 }, { x: 40, y: 0 }]);
});

test('splitRoute: il punto di taglio è sul percorso e i tronconi lo ricongiungono', () => {
  const route = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }]; // L orizzontale-prima
  const { point } = projectOnRoute(route, { x: 25, y: 3 }); // vicino al tratto orizzontale
  assert.equal(point.y, 0); // proiettato sul segmento orizzontale
  assert.equal(point.x, 25);
  const [ra, rb] = splitRoute(route, { x: 25, y: 3 });
  assert.deepEqual(ra[ra.length - 1], point);
  assert.deepEqual(rb[0], point);
  // concatenazione = percorso originale (senza duplicare il punto di giunzione)
  assert.deepEqual([...ra, ...rb.slice(1)], [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }]);
});

test('flipWireElbow: inverte elbow e azzera la route esplicita; revert ripristina', () => {
  let c = emptyCircuit();
  c.components = [];
  c.wires = [{ id: 'w1', from: { component: 'A', pin: 0 }, to: { component: 'B', pin: 0 }, route: [{ x: 0, y: 0 }] }];
  const cmd = flipWireElbow('w1');
  const after = cmd.apply(c);
  assert.equal(after.wires[0].elbow, true);
  assert.equal(after.wires[0].route, undefined);
  const back = cmd.revert(after);
  assert.equal(back.wires[0].elbow, false);
});

test('moveComponents: sposta il gruppo e il revert torna indietro', () => {
  const c = emptyCircuit();
  c.components = [
    { id: 'R1', type: 'resistor', x: 0, y: 0, rot: 0, params: {} },
    { id: 'R2', type: 'resistor', x: 20, y: 0, rot: 0, params: {} },
  ];
  const from = { R1: { x: 0, y: 0 }, R2: { x: 20, y: 0 } };
  const to = { R1: { x: 40, y: 40 }, R2: { x: 60, y: 40 } };
  const cmd = moveComponents(['R1', 'R2'], from, to);
  const moved = cmd.apply(c);
  assert.deepEqual(moved.components.map((x) => [x.x, x.y]), [[40, 40], [60, 40]]);
  const back = cmd.revert(moved);
  assert.deepEqual(back.components.map((x) => [x.x, x.y]), [[0, 0], [20, 0]]);
});

test('branchWire: inserisce nodo, rimuove il filo target, aggiunge i rami; revert è pulito', () => {
  const c = emptyCircuit();
  const target: Wire = { id: 'w1', from: { component: 'A', pin: 0 }, to: { component: 'B', pin: 0 } };
  c.wires = [target];
  const node: ComponentInstance = { id: 'J1', type: 'node', x: 20, y: 0, rot: 0, params: {} };
  const nodePin = { component: 'J1', pin: 0 };
  const news: Wire[] = [
    { id: 'w2', from: target.from, to: nodePin },
    { id: 'w3', from: nodePin, to: target.to },
    { id: 'w4', from: { component: 'C', pin: 0 }, to: nodePin },
  ];
  const cmd = branchWire(node, target, news);
  const after = cmd.apply(c);
  assert.equal(after.components.length, 1);
  assert.deepEqual(after.wires.map((w) => w.id).sort(), ['w2', 'w3', 'w4']);
  const back = cmd.revert(after);
  assert.equal(back.components.length, 0);
  assert.deepEqual(back.wires.map((w) => w.id), ['w1']);
});

test('addItems: aggiunge e revert rimuove', () => {
  const c = emptyCircuit();
  const comps: ComponentInstance[] = [{ id: 'R9', type: 'resistor', x: 0, y: 0, rot: 0, params: {} }];
  const cmd = addItems(comps, []);
  const after = cmd.apply(c);
  assert.equal(after.components.length, 1);
  assert.equal(cmd.revert(after).components.length, 0);
});
