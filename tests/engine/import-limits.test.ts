import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim } from './helpers.ts';
import { emptyCircuit } from '../../src/model/types.ts';
import { circuitFromJSON, importCircuit } from '../../src/model/serialize.ts';
import { IMPORT_LIMITS, readImportFile, parseImportText } from '../../src/model/importLimits.ts';
import { LESSONS } from '../../src/lessons/data.ts';
import { applyScenario, captureScenario, scenarioFromHash } from '../../src/scenarios/scenario.ts';
import { useStudio } from '../../src/store/studio.ts';

const resistor = (id = 'R1') => ({ id, type: 'resistor', x: 0, y: 0, rot: 0 as const, params: { R: 1000 } });
const wire = (id = 'w1') => ({ id, from: { component: 'R1', pin: 0 }, to: { component: 'R1', pin: 1 } });

test('all existing lessons import, hydrate and simulate within the limits', () => {
  const before = useStudio.getState();
  try {
    for (const lesson of LESSONS) {
      const circuit = importCircuit(lesson.circuit);
      assert.equal(circuit.components.length, lesson.circuit.components.length);
      assert.ok(applyScenario({ ...captureScenario(lesson.title), circuit }));
      assert.ok(sim.dcOperatingPoint(compile(circuit)).converged, lesson.id);
    }
    const circuit = buildCircuit(Array.from({ length: 50 }, (_, i) => [`R${i}`, 'resistor'] as [string, string]), []);
    assert.equal(importCircuit(circuit).components.length, 50, 'larger normal circuits still fit');
  } finally { useStudio.setState(before, true); }
});

test('file size is rejected before reading; text limits count UTF-8 bytes', async () => {
  let read = false;
  await assert.rejects(readImportFile({ size: IMPORT_LIMITS.fileBytes + 1, text: async () => { read = true; return ''; } }), /2 MiB/);
  assert.equal(read, false);
  assert.throws(() => parseImportText('"' + 'è'.repeat(IMPORT_LIMITS.fileBytes / 2) + '"'), /2 MiB/);
  assert.deepEqual(await readImportFile({ size: 2, text: async () => '{}' }), {});
  assert.throws(() => parseImportText('{broken'), /JSON non valido/);
});

test('components, wires, individual and total route points are bounded', () => {
  assert.throws(() => importCircuit({ components: Array.from({ length: IMPORT_LIMITS.components + 1 }, (_, i) => resistor(`R${i}`)), wires: [] }), /componenti/);
  assert.throws(() => importCircuit({ components: [resistor()], wires: Array.from({ length: IMPORT_LIMITS.wires + 1 }, (_, i) => wire(`w${i}`)) }), /fili/);
  const points = Array.from({ length: IMPORT_LIMITS.pointsPerWire }, () => ({ x: 0, y: 0 }));
  assert.throws(() => circuitFromJSON({ components: [resistor()], wires: [{ ...wire(), route: [...points, { x: 1, y: 1 }] }] }), /punti per percorso/);
  assert.throws(() => importCircuit({ components: [resistor()], wires: Array.from({ length: 65 }, (_, i) => ({ ...wire(`w${i}`), waypoints: points })) }), /punti di percorso totali/);
  assert.equal(importCircuit({ components: [resistor()], wires: [{ ...wire(), route: points }] }).wires[0].route?.length, points.length);
});

test('malformed structure, text, IDs, references and solver dimensions are rejected', () => {
  for (const raw of [null, [], {}, { components: {}, wires: [] }, { components: [null], wires: [] },
    { components: [resistor()], wires: [{ ...wire(), to: { component: 'missing', pin: 0 } }] },
    { components: [resistor()], wires: [{ ...wire(), route: [{ x: 'x', y: 0 }] }] },
    { components: [{ ...resistor(), x: Infinity }], wires: [] },
    { components: [resistor()], wires: [], groups: [{ id: 'g', name: 'g', components: null }] },
  ]) assert.throws(() => importCircuit(raw));
  assert.throws(() => importCircuit({ components: [{ ...resistor(), label: 'x'.repeat(513) }], wires: [] }), /testo/);
  assert.throws(() => importCircuit({ components: [resistor('x'.repeat(129))], wires: [] }), /ID/);
  assert.throws(() => importCircuit({ components: Array.from({ length: 65 }, (_, i) => resistor(`R${i}`)), wires: [] }), /128 incognite/);
  const huge = { ...compile(emptyCircuit()), nNodes: 129 };
  assert.throws(() => sim.dcOperatingPoint(huge), /128 incognite/);
  assert.throws(() => sim.transient(huge, { dt: 1e-4 }), /128 incognite/);
});

test('rejected scenarios preserve the complete state and do not start simulation', () => {
  const original = useStudio.getState();
  try {
    useStudio.setState({ circuit: { ...emptyCircuit(), components: [resistor()] }, running: false });
    const before = useStudio.getState();
    const valid = captureScenario('test');
    const bad = [null, {}, { ...valid, circuit: { ...valid.circuit, components: Array(257).fill(resistor()) } },
      { ...valid, timestep: 1e-300 }, { ...valid, scopeTimespan: Infinity },
      { ...valid, probes: Array(33).fill({ pin: { component: 'R1', pin: 0 }, label: 'p' }) },
      { ...valid, probes: [{ pin: { component: 'R1', pin: 99 }, label: 'p' }] },
      { ...valid, ab: { componentId: 'R1', mode: 'unknown' } }];
    for (const raw of bad) {
      let message = '';
      assert.equal(applyScenario(raw, error => { message = error; }), false);
      assert.ok(message.length);
      assert.equal(useStudio.getState(), before);
      assert.equal(useStudio.getState().running, false);
    }
    const large = { components: [{ id: 'V1', type: 'vdc', x: 0, y: 0, params: {} }, ...Array.from({ length: 17 }, (_, i) => resistor(`R${i}`))], wires: [] };
    assert.equal(applyScenario({ ...valid, circuit: large, probes: [{ pin: { component: 'V1', pin: 0 }, label: 'V' }], scopeMode: 'bode' }), false);
    assert.equal(useStudio.getState().circuit, before.circuit);
    assert.equal(useStudio.getState().probes, before.probes);
    assert.equal(useStudio.getState().undoStack, before.undoStack);
  } finally { useStudio.setState(original, true); }
});

test('mixed-signal internal branches are counted before hydration', () => {
  const circuit = buildCircuit(
    Array.from({ length: 43 }, (_, i) => [[`C${i}`, 'clock'], [`R${i}`, 'resistor']] as [string, string][]).flat(),
    Array.from({ length: 43 }, (_, i) => [[`C${i}`, 0], [`R${i}`, 0]]),
  );
  assert.ok(compile(circuit).nNodes < IMPORT_LIMITS.solverDimension);
  assert.throws(() => importCircuit(circuit), /128 incognite/);
  const before = useStudio.getState();
  assert.equal(applyScenario({ version: 1, circuit }), false);
  assert.equal(useStudio.getState(), before);
});

test('shared hashes enforce byte and hydration limits just like uploaded scenarios', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const hash = (raw: unknown) => '#s=' + Buffer.from(JSON.stringify(raw)).toString('base64url');
  try {
    const location = { hash: '#s=' + 'x'.repeat(Math.ceil(IMPORT_LIMITS.fileBytes * 4 / 3) + 10) };
    Object.defineProperty(globalThis, 'window', { value: { location }, configurable: true });
    assert.throws(() => scenarioFromHash(), /2 MiB/);
    location.hash = hash(null);
    assert.throws(() => scenarioFromHash(), /non valido/);
    location.hash = hash({ circuit: { components: Array(257).fill(resistor()), wires: [] } });
    const before = useStudio.getState();
    assert.equal(applyScenario(scenarioFromHash()), false);
    assert.equal(useStudio.getState(), before);
    location.hash = hash({ circuit: { components: [resistor()], wires: [] } });
    assert.ok(scenarioFromHash());
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
