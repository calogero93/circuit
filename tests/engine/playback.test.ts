import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit } from './helpers.ts';
import { SimController, useSimTick } from '../../src/viz/controller.ts';
import { PlaybackClock, type PlaybackSpeed } from '../../src/viz/playback.ts';
import { useStudio } from '../../src/store/studio.ts';
import { DigitalSimulator } from '../../src/engine/digital.ts';
import type { CompiledCircuit } from '../../src/model/netlist.ts';
import type { TransientOptions } from '../../src/engine/simulator.ts';
import { applyScenario, captureScenario } from '../../src/scenarios/scenario.ts';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

function playback(t: TestContext, ab = false) {
  const previous = useStudio.getState();
  const previousTick = useSimTick.getState();
  const pending = new Map<number, FrameRequestCallback>();
  let now = 0, cpu = 0, next = 0;
  const doc = new EventTarget();
  let hidden = false;
  Object.defineProperty(doc, 'hidden', { get: () => hidden });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    requestAnimationFrame: (callback: FrameRequestCallback) => { pending.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => pending.delete(id), document: doc,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.mock.method(performance, 'now', () => now + cpu);
  useStudio.setState({ ...previous, circuit: buildCircuit([
    ['CK', 'clock', { freq: 0.1, vdd: 5 }], ['OUT', 'logic_out', { vdd: 5 }],
  ], [[['CK', 0], ['OUT', 0]]]), running: true, playbackSpeed: 1, timestep: 0.01,
    simulationEpoch: previous.simulationEpoch + 1, scopeMode: 'time', probes: [{
      id: 'clock', pin: { component: 'CK', pin: 0 }, color: '#fff', label: 'Clock',
    }], ab: ab ? { componentId: 'OUT', mode: 'remove' } : null, abGhost: ab }, true);
  const controller = new SimController();
  t.after(() => {
    controller.stop();
    useStudio.setState(previous, true);
    useSimTick.setState(previousTick, true);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    controller,
    spend: (ms: number) => { cpu += ms; },
    frame: (time: number) => {
      now = time; cpu = 0;
      const [id, callback] = pending.entries().next().value!;
      pending.delete(id); callback(time);
    },
    visibility: (value: boolean) => { hidden = value; doc.dispatchEvent(new Event('visibilitychange')); },
    pending,
  };
}

test('1×: il clock a 0.1 Hz resta alto e basso per cinque secondi simulati', (t) => {
  const { controller, frame } = playback(t);
  controller.start();
  frame(4900); near(controller.time, 4.9);
  assert.equal(controller.frame!.result.outputs.get('CK')!.data.logic, 1);
  frame(5100); near(controller.time, 5.1);
  assert.equal(controller.frame!.result.outputs.get('CK')!.data.logic, 0);
  frame(9900); near(controller.time, 9.9);
  assert.equal(controller.frame!.result.outputs.get('CK')!.data.logic, 0);
  frame(10100); near(controller.time, 10.1);
  assert.equal(controller.frame!.result.outputs.get('CK')!.data.logic, 1);
});

test('velocità e pausa non cambiano dt e non recuperano il tempo trascorso in pausa', (t) => {
  const { controller, frame } = playback(t);
  controller.start(); frame(1000); near(controller.time, 1);
  useStudio.getState().setRunning(false);
  frame(61000); near(controller.time, 1);
  useStudio.getState().setRunning(true);
  frame(61020); near(controller.time, 1.02);
  useStudio.getState().setPlaybackSpeed(2);
  frame(62020); near(controller.time, 3.02);
  useStudio.getState().setPlaybackSpeed(0.5);
  frame(63020); near(controller.time, 3.52);
  assert.equal(useStudio.getState().timestep, 0.01);
});

test('scheda nascosta sospesa, ritorno senza recupero e start/stop senza loop duplicati', (t) => {
  const { controller, frame, visibility, pending } = playback(t);
  controller.start(); controller.start(); assert.equal(pending.size, 1);
  frame(1000); near(controller.time, 1);
  visibility(true); frame(121000); near(controller.time, 1);
  visibility(false); frame(122000); near(controller.time, 2);
  controller.stop(); assert.equal(pending.size, 0);
  controller.start(); frame(123000); near(controller.time, 3);
});

test('budget esaurito: conserva il tempo ancora da calcolare e segnala il ritardo', (t) => {
  const { controller, frame, spend } = playback(t);
  const simulator = new DigitalSimulator();
  let cost = 9;
  controller.simFor = () => simulator;
  t.mock.method(simulator, 'transient', (circuit: CompiledCircuit, opts: TransientOptions) => {
    const session = new DigitalSimulator().transient(circuit, opts);
    const step = session.step.bind(session);
    session.step = (interval) => { const result = step(interval); spend(cost); return result; };
    return session;
  });
  controller.start(); frame(1000);
  near(controller.time, 0.01);
  assert.ok(useSimTick.getState().playbackLag > 0.9);
  cost = 0; frame(1016);
  near(controller.time, 1.01); // Il residuo inferiore a dt resta in attesa.
  frame(1080); near(controller.time, 1.08); // Aggiornamento UI diradato a 60 ms.
  assert.ok(useSimTick.getState().playbackLag < 0.01);
});

test('le sessioni A/B avanzano con gli stessi istanti e velocità', (t) => {
  const { controller, frame } = playback(t, true);
  controller.start(); frame(1000);
  near(controller.time, 1);
  near(controller.frame!.ghost!.time, controller.time);
  useStudio.getState().setPlaybackSpeed(5); frame(2000);
  near(controller.time, 6);
  near(controller.frame!.ghost!.time, controller.time);
  assert.ok(controller.samples.every((sample) => sample.g !== null && sample.v[0] === sample.g[0]));
});

test('un passo A/B non convergente non lascia avanzata soltanto la sessione principale', (t) => {
  const { controller, frame } = playback(t, true);
  const main = new DigitalSimulator(), ghost = new DigitalSimulator();
  controller.simFor = (circuit) => circuit.components.some((c) => c.id === 'OUT') ? main : ghost;
  t.mock.method(ghost, 'transient', (circuit: CompiledCircuit, opts: TransientOptions) => ({
    time: opts.t0 ?? 0, states: () => new Map(),
    step: () => ({ ...ghost.dcOperatingPoint(circuit), converged: false, time: opts.t0 ?? 0 }),
  }));
  controller.start(); frame(1000);
  near(controller.time, 0);
  assert.equal(controller.frame!.result.converged, false);
  assert.equal(controller.samples.length, 0);
});

test('scenari: velocità salvata, default 1× per legacy e valori non ammessi', () => {
  const previous = useStudio.getState();
  try {
    useStudio.getState().setPlaybackSpeed(5);
    const scenario = captureScenario('velocità');
    useStudio.getState().setPlaybackSpeed(0.25);
    applyScenario(scenario); assert.equal(useStudio.getState().playbackSpeed, 5);
    const { playbackSpeed: _, ...legacy } = scenario;
    applyScenario(legacy); assert.equal(useStudio.getState().playbackSpeed, 1);
    applyScenario({ ...scenario, playbackSpeed: '2' }); assert.equal(useStudio.getState().playbackSpeed, 1);
    useStudio.getState().setPlaybackSpeed(NaN as PlaybackSpeed);
    assert.equal(useStudio.getState().playbackSpeed, 1);
  } finally { useStudio.setState(previous, true); }
});

test('accumulo frazionario del clock: nessun passo prima di averne maturato la durata', () => {
  const clock = new PlaybackClock();
  clock.reset(0); clock.update(4, true, 1); assert.equal(clock.ready(0.01), false);
  clock.update(10, true, 1); assert.equal(clock.ready(0.01), true);
  clock.consume(0.01); near(clock.pendingSeconds, 0);
});
