import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim } from './helpers.ts';
import type { ParamValue } from '../../src/model/types.ts';
import { resistorPowerData } from '../../src/library/resistorPower.ts';
import { circuitFromJSON, circuitToJSON } from '../../src/model/serialize.ts';
import { captureScenario, applyScenario } from '../../src/scenarios/scenario.ts';
import { useStudio } from '../../src/store/studio.ts';
import { executeTool } from '../../src/ai/tools.ts';

function resistor(params: Record<string, ParamValue> = {}, voltage = 10) {
  return compile(buildCircuit([
    ['V1', 'vdc', { V: voltage }], ['R1', 'resistor', { R: 100, ...params }], ['G', 'ground'],
  ], [[['V1', 0], ['R1', 0]], [['R1', 1], ['G', 0]], [['V1', 1], ['G', 0]]]));
}
const close = (actual: number, expected: number, tolerance = 1e-7) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);

test('dimensionamento: 100 ohm a 10 V dissipa 1 W, senza cambiare corrente al cambio di taglia', () => {
  const small = sim.dcOperatingPoint(resistor()).outputs.get('R1')!;
  const large = sim.dcOperatingPoint(resistor({ ratedPower: 2 })).outputs.get('R1')!;
  close(Number(small.data.p), 1);
  close(Number(small.data.powerLoadPercent), 400);
  assert.equal(small.data.meanPowerOverload, true);
  assert.equal(small.data.temperatureMode, 'steady-state');
  assert.equal(large.data.powerStatus, 'ok');
  close(Number(large.data.powerLoadPercent), 50);
  close(small.pinCurrents[0], large.pinCurrents[0]);
});

test('derating: potenza piena a 70°C, metà a 112.5°C e nulla a 155°C', () => {
  for (const [ambientTemperature, allowed] of [[25, 0.25], [70, 0.25], [112.5, 0.125], [155, 0], [175, 0]]) {
    const result = sim.dcOperatingPoint(resistor(), { ambientTemperature });
    close(Number(result.outputs.get('R1')!.data.allowedPower), allowed);
    for (const value of Object.values(result.outputs.get('R1')!.data)) {
      if (typeof value === 'number') assert.ok(Number.isFinite(value));
    }
  }
});

test('temperatura transitoria ed energia: soluzione termica esatta a potenza costante', () => {
  const c = resistor({ ratedPower: 2, thermalResistance: 10, thermalCapacity: 0.1 });
  const session = sim.transient(c, { dt: 0.1, ambientTemperature: 25 });
  let result = session.step();
  for (let k = 1; k < 10; k++) result = session.step();
  assert.ok(result.converged);
  const data = result.outputs.get('R1')!.data;
  close(Number(data.temperature), 25 + 10 * (1 - Math.exp(-1)));
  close(Number(data.energy), 1);
  close(Number(data.meanPower), 1);
  close(Number(data.powerDuration), 1);
  assert.equal(data.temperatureMode, 'transient');
  assert.equal(data.temperatureExceeded, false);
  // Il trasferimento degli stati preserva il calore; a sorgente spenta si raffredda.
  const cooling = sim.transient(resistor({ ratedPower: 2, thermalResistance: 10, thermalCapacity: 0.1 }, 0),
    { dt: 0.1, t0: 1, initialStates: session.states(), ambientTemperature: 25 });
  for (let k = 0; k < 10; k++) result = cooling.step();
  close(Number(result.outputs.get('R1')!.data.temperature), 25 + (Number(data.temperature) - 25) * Math.exp(-1));
  close(Number(result.outputs.get('R1')!.data.energy), 1);
});

test('AC: potenza media e picchi sono distinti, senza dichiarare un guasto', () => {
  const c = compile(buildCircuit([
    ['V1', 'vsin', { amp: 10, freq: 10, offset: 0 }],
    ['R1', 'resistor', { R: 100, ratedPower: 0.75 }], ['G', 'ground'],
  ], [[['V1', 0], ['R1', 0]], [['R1', 1], ['G', 0]], [['V1', 1], ['G', 0]]]));
  const session = sim.transient(c, { dt: 0.001 });
  let result = session.step();
  let peakObserved = false;
  for (let k = 1; k < 1000; k++) {
    result = session.step();
    const d = result.outputs.get('R1')!.data;
    if (k > 200 && d.peakPowerOverload && !d.meanPowerOverload && d.powerStatus === 'peak-overload') peakObserved = true;
  }
  assert.ok(peakObserved);
  close(Number(result.outputs.get('R1')!.data.meanPower), 0.5, 1e-6);
  assert.ok(result.converged);
  assert.ok(Number(result.outputs.get('R1')!.data.temperature) < 155);
});

test('profili termici incoerenti sono segnalati, non producono NaN', () => {
  const data = resistorPowerData({ deratingStart: 150, maxTemperature: 100 }, 1, 25);
  assert.equal(data.powerStatus, 'invalid-rating');
  assert.equal(data.powerRatingValid, false);
  for (const value of Object.values(data)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
});

test('compatibilità e salvataggio: vecchie resistenze hanno default, profili personalizzati restano nel JSON', () => {
  const circuit = buildCircuit([['R1', 'resistor', { R: 100 }]], []);
  const restored = circuitFromJSON(circuitToJSON(circuit));
  assert.equal(restored.components[0].params.ratedPower, 0.25);
  restored.components[0].params.ratedPower = 2;
  restored.components[0].params.thermalCapacity = 0.5;
  const again = circuitFromJSON(JSON.parse(JSON.stringify(circuitToJSON(restored))));
  assert.equal(again.components[0].params.ratedPower, 2);
  assert.equal(again.components[0].params.thermalCapacity, 0.5);
});

test('scenario: temperatura ambiente ripristinata e input legacy compatibile', () => {
  const previous = useStudio.getState();
  try {
    previous.setEnvironment({ temperature: 112.5 });
    const scenario = captureScenario('caldo');
    useStudio.getState().setEnvironment({ temperature: 25 });
    assert.ok(applyScenario(scenario));
    assert.equal(useStudio.getState().environment.temperature, 112.5);
    const { environment: _, ...legacy } = scenario;
    assert.ok(applyScenario(legacy));
    assert.equal(useStudio.getState().environment.temperature, 25);
  } finally { useStudio.setState(previous, true); }
});

test('tool AI: DC e transitoria usano la temperatura ambiente e restituiscono i dati termici', () => {
  const previous = useStudio.getState();
  try {
    const circuit = buildCircuit([
      ['V1', 'vdc', { V: 10 }], ['R1', 'resistor', { R: 100, ratedPower: 2 }], ['G', 'ground'],
    ], [[['V1', 0], ['R1', 0]], [['R1', 1], ['G', 0]], [['V1', 1], ['G', 0]]]);
    useStudio.setState({ circuit, environment: { ...previous.environment, temperature: 150 } });
    for (const tool of ['runDC', 'runTransient']) {
      const result = executeTool(tool, { duration_ms: 1, dt_us: 1000 });
      const data = (result.components as Record<string, { data: Record<string, unknown> }>).R1.data;
      assert.equal(result.converged, true);
      assert.equal(data.ambientTemperature, 150);
      close(Number(data.allowedPower), 2 * 5 / 85, 1e-6);
      assert.equal(data.meanPowerOverload, true);
    }
  } finally { useStudio.setState(previous, true); }
});
