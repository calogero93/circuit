import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile } from './helpers.ts';
import { importCircuit } from '../../src/model/serialize.ts';
import { SimController } from '../../src/viz/controller.ts';
import { useStudio } from '../../src/store/studio.ts';
import { addComponent, replaceCircuit } from '../../src/store/commands.ts';
import { DigitalSimulator, isPurelyDigital } from '../../src/engine/digital.ts';
import type { CompiledCircuit } from '../../src/model/netlist.ts';

const resistor = (id: string) => ({ id, type: 'resistor', x: 0, y: 0, rot: 0 as const, params: { R: 1000 } });

function withController(t: test.TestContext, circuit: ReturnType<typeof buildCircuit>, mode: 'time' | 'bode' = 'time') {
  const before = useStudio.getState();
  t.mock.method(globalThis, 'requestAnimationFrame', () => 1);
  t.mock.method(globalThis, 'cancelAnimationFrame', () => {});
  useStudio.setState({ circuit, scopeMode: mode, probes: [], running: false, ab: null, abGhost: false });
  const controller = new SimController();
  const sweeps: number[] = [];
  t.mock.method(controller, 'runBodeFor', (compiled: CompiledCircuit | null) => { sweeps.push(compiled!.nNodes + compiled!.nBranches); return []; });
  controller.start();
  t.after(() => { controller.stop(); useStudio.setState(before, true); });
  return { controller, sweeps };
}

// Node has no browser frame APIs. Restore the descriptors when this process exits.
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: () => 1, configurable: true, writable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: () => {}, configurable: true, writable: true });

test('bare import cannot start a 43-unknown Bode sweep or change the active session', t => {
  const initial = buildCircuit([['V1', 'vdc'], ['R0', 'resistor']], []);
  const { controller, sweeps } = withController(t, initial, 'bode');
  useStudio.getState().setProbes([{ id: 'p', label: 'V', color: '#fff', pin: { component: 'V1', pin: 0 } }]);
  const before = useStudio.getState();
  const internals = controller as unknown as { compiled: unknown; session: unknown; revision: number };
  const previous = { compiled: internals.compiled, session: internals.session, revision: internals.revision };
  const next = importCircuit(buildCircuit([['V1', 'vdc'], ...Array.from({ length: 20 }, (_, i) => [`R${i}`, 'resistor'] as [string, string])], []));
  assert.equal(compile(next).nNodes + compile(next).nBranches, 43);
  const count = sweeps.length;
  assert.doesNotThrow(() => useStudio.getState().execute(replaceCircuit('import', initial, next)));
  assert.equal(useStudio.getState().circuit, before.circuit);
  assert.equal(useStudio.getState().probes, before.probes);
  assert.equal(useStudio.getState().undoStack, before.undoStack);
  assert.equal(sweeps.length, count);
  assert.deepEqual({ compiled: internals.compiled, session: internals.session, revision: internals.revision }, previous);
});

test('over-limit edit preserves compiled/session/probes/history and valid editing plus undo still work', t => {
  const circuit = buildCircuit(Array.from({ length: 64 }, (_, i) => [`R${i}`, 'resistor'] as [string, string]), []);
  const { controller } = withController(t, circuit);
  const before = useStudio.getState();
  const internals = controller as unknown as { compiled: { nNodes: number }; session: unknown };
  const oldSession = internals.session, oldCompiled = internals.compiled;
  assert.equal(oldCompiled.nNodes, 128);
  assert.doesNotThrow(() => useStudio.getState().execute(addComponent(resistor('overflow'))));
  const after = useStudio.getState();
  assert.equal(after.circuit, before.circuit);
  assert.equal(after.probes, before.probes);
  assert.equal(after.undoStack, before.undoStack);
  assert.equal(internals.session, oldSession);
  assert.equal(internals.compiled, oldCompiled);
  const valid = { ...resistor('R0'), x: 40 };
  useStudio.getState().execute({ label: 'move', apply: c => ({ ...c, components: [valid, ...c.components.slice(1)] }), revert: () => circuit });
  assert.equal(useStudio.getState().circuit.components[0].x, 40);
  useStudio.getState().undo();
  assert.equal(useStudio.getState().circuit, circuit);
  assert.equal(controller.runDC().compiled.nNodes, 128);
});

test('65 NOT gates use the digital engine without the dense matrix limit', () => {
  const raw = buildCircuit(Array.from({ length: 65 }, (_, i) => [`N${i}`, 'not_gate'] as [string, string]), []);
  assert.ok(isPurelyDigital(raw));
  assert.equal(raw.components.length, 65);
  assert.equal(compile(raw).nNodes, 130);
  const circuit = importCircuit(raw);
  const result = new DigitalSimulator().dcOperatingPoint(compile(circuit));
  assert.ok(result.converged);
  for (const output of result.outputs.values()) assert.equal(output.data.logic, 1);
});

test('mode changes, retained probes and scenario hydration use the same Bode preflight', t => {
  const circuit = buildCircuit([['V1', 'vdc'], ...Array.from({ length: 20 }, (_, i) => [`R${i}`, 'resistor'] as [string, string])], []);
  const { sweeps } = withController(t, circuit);
  useStudio.getState().setProbes([{ id: 'p', label: 'V', color: '#fff', pin: { component: 'V1', pin: 0 } }]);
  const before = useStudio.getState();
  useStudio.getState().setScopeMode('bode');
  assert.equal(useStudio.getState().scopeMode, 'time');
  assert.equal(useStudio.getState().circuit, before.circuit);
  assert.equal(sweeps.length, 0);
  assert.equal(useStudio.getState().hydrate({ scopeMode: 'bode' }), false);
  assert.equal(sweeps.length, 0);
});

test('unexpected controller preparation failure rolls back store and controller together', t => {
  const circuit = buildCircuit([['R0', 'resistor']], []);
  const { controller } = withController(t, circuit);
  const before = useStudio.getState();
  const internals = controller as unknown as { compiled: unknown; session: unknown; revision: number };
  const previous = { compiled: internals.compiled, session: internals.session, revision: internals.revision };
  t.mock.method(controller.simulator, 'transient', () => { throw new Error('controlled initialization failure'); });
  assert.doesNotThrow(() => useStudio.getState().execute(addComponent(resistor('R1'))));
  const after = useStudio.getState();
  assert.equal(after.circuit, before.circuit);
  assert.equal(after.probes, before.probes);
  assert.equal(after.undoStack, before.undoStack);
  assert.deepEqual({ compiled: internals.compiled, session: internals.session, revision: internals.revision }, previous);
  assert.match(after.operationError!, /controlled initialization failure/);
});
