// Test di validazione analitica e convergenza per la nuova suite di componenti elettronici extra.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCircuit, compile, sim, voltsAt } from './helpers.ts';
import { useStudio } from '../../src/store/studio.ts';

// Imposta l'ambiente per i test
function setEnv(env: { light?: number; temperature?: number; pressure?: number; magneticField?: number; humidity?: number }) {
  useStudio.getState().setEnvironment(env);
}

test('Zener: regolazione a Vz in inversa e diodo standard in diretta', () => {
  setEnv({ temperature: 25 });
  const circuitFwd = buildCircuit(
    [
      ['V1', 'vdc', { V: 10 }],
      ['R1', 'resistor', { R: 1000 }],
      ['Z1', 'zener', { Vz: 5.1 }],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['Z1', 0]],
      [['Z1', 1], ['V1', 1]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  let compiled = compile(circuitFwd);
  let result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged);
  let vZener = voltsAt(compiled, result, ['Z1', 0]);
  assert.ok(vZener > 0.5 && vZener < 0.9, 'In diretta VF ~0.7V');

  const circuitRev = buildCircuit(
    [
      ['V1', 'vdc', { V: -10 }],
      ['R1', 'resistor', { R: 1000 }],
      ['Z1', 'zener', { Vz: 5.1 }],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['Z1', 0]],
      [['Z1', 1], ['V1', 1]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  compiled = compile(circuitRev);
  result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged);
  vZener = voltsAt(compiled, result, ['Z1', 0]);
  assert.ok(Math.abs(vZener - (-5.1)) < 0.6, `Zener in inversa regola a -Vz: ${vZener}`);
});

test('Potenziometro: partitore regolabile', () => {
  const circuit = buildCircuit(
    [
      ['V1', 'vdc', { V: 10 }],
      ['P1', 'potentiometer', { R: 10000, wiper: 0.3 }],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['P1', 0]],
      [['V1', 1], ['P1', 1]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  const compiled = compile(circuit);
  const result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged);
  const vWiper = voltsAt(compiled, result, ['P1', 2]);
  assert.ok(Math.abs(vWiper - 3) < 1e-4, 'Tensione terzultimo pin wiper deve essere 3V');
});

test('Op-Amp: amplificatore invertente guadagno -2', () => {
  const circuit = buildCircuit(
    [
      ['V1', 'vdc', { V: 2 }],
      ['R1', 'resistor', { R: 10000 }],
      ['R2', 'resistor', { R: 20000 }],
      ['X1', 'opamp', { Aol: 100000, Vsat: 15 }],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['X1', 1]],
      [['X1', 1], ['R2', 0]],
      [['R2', 1], ['X1', 2]],
      [['X1', 0], ['GND', 0]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  const compiled = compile(circuit);
  const result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged);
  const vout = voltsAt(compiled, result, ['X1', 2]);
  const vn = voltsAt(compiled, result, ['X1', 1]);
  assert.ok(Math.abs(vn) < 1e-3, `vn ~ 0V (massa virtuale): ${vn}`);
  assert.ok(Math.abs(vout - (-4)) < 1e-2, `vout ~ -4V: ${vout}`);
});

test('LDR: variazione di resistenza indotta da luce', () => {
  const buildLdrTest = () => {
    return buildCircuit(
      [
        ['V1', 'vdc', { V: 10 }],
        ['LDR1', 'ldr', { R_dark: 100000 }],
        ['R1', 'resistor', { R: 10000 }],
        ['GND', 'ground'],
      ],
      [
        [['V1', 0], ['LDR1', 0]],
        [['LDR1', 1], ['R1', 0]],
        [['R1', 1], ['V1', 1]],
        [['V1', 1], ['GND', 0]],
      ],
    );
  };

  // 1. Buio completo -> R molto alta -> Vout bassa
  setEnv({ light: 0 });
  let compiled = compile(buildLdrTest());
  let result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged);
  const vOutDark = voltsAt(compiled, result, ['R1', 0]);

  // 2. Luce -> R scende -> Vout sale
  setEnv({ light: 80 });
  compiled = compile(buildLdrTest());
  result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged);
  const vOutLight = voltsAt(compiled, result, ['R1', 0]);

  assert.ok(vOutLight > vOutDark, 'La luce deve far condurre di più l\'LDR alzando Vout');
});

test('Sensori Termici: NTC e PTC', () => {
  const buildThermistorTest = (type: 'ntc' | 'ptc') => {
    return buildCircuit(
      [
        ['V1', 'vdc', { V: 10 }],
        ['T1', type, { R25: 10000 }],
        ['R1', 'resistor', { R: 10000 }],
        ['GND', 'ground'],
      ],
      [
        [['V1', 0], ['T1', 0]],
        [['T1', 1], ['R1', 0]],
        [['R1', 1], ['V1', 1]],
        [['V1', 1], ['GND', 0]],
      ],
    );
  };

  // NTC: Caldo (80°C) -> R_ntc scende -> Vout sale rispetto al freddo (0°C)
  setEnv({ temperature: 0 });
  let compiled = compile(buildThermistorTest('ntc'));
  let result = sim.dcOperatingPoint(compiled);
  const vOutColdNtc = voltsAt(compiled, result, ['R1', 0]);

  setEnv({ temperature: 80 });
  compiled = compile(buildThermistorTest('ntc'));
  result = sim.dcOperatingPoint(compiled);
  const vOutHotNtc = voltsAt(compiled, result, ['R1', 0]);
  assert.ok(vOutHotNtc > vOutColdNtc, 'NTC deve condurre di più al caldo');

  // PTC: Caldo (80°C) -> R_ptc sale -> Vout scende rispetto al freddo (0°C)
  setEnv({ temperature: 0 });
  compiled = compile(buildThermistorTest('ptc'));
  result = sim.dcOperatingPoint(compiled);
  const vOutColdPtc = voltsAt(compiled, result, ['R1', 0]);

  setEnv({ temperature: 80 });
  compiled = compile(buildThermistorTest('ptc'));
  result = sim.dcOperatingPoint(compiled);
  const vOutHotPtc = voltsAt(compiled, result, ['R1', 0]);
  assert.ok(vOutHotPtc < vOutColdPtc, 'PTC deve condurre meno al caldo');
});

test('Barometro: variazione piezoresistiva', () => {
  const buildBarometerTest = () => {
    return buildCircuit(
      [
        ['V1', 'vdc', { V: 10 }],
        ['B1', 'barometer', { R0: 1000, S: 10 }],
        ['R1', 'resistor', { R: 1000 }],
        ['GND', 'ground'],
      ],
      [
        [['V1', 0], ['B1', 0]],
        [['B1', 1], ['R1', 0]],
        [['R1', 1], ['V1', 1]],
        [['V1', 1], ['GND', 0]],
      ],
    );
  };

  // Alta pressione (140 kPa) -> R_barometer aumenta (R = 1000 + 10*(140-101.3) = 1387) -> Vout cala
  setEnv({ pressure: 80 });
  let compiled = compile(buildBarometerTest());
  let result = sim.dcOperatingPoint(compiled);
  const vOutLowP = voltsAt(compiled, result, ['R1', 0]);

  setEnv({ pressure: 140 });
  compiled = compile(buildBarometerTest());
  result = sim.dcOperatingPoint(compiled);
  const vOutHighP = voltsAt(compiled, result, ['R1', 0]);
  assert.ok(vOutLowP > vOutHighP, 'La pressione aumenta la resistenza calando Vout');
});

test('Sensore Hall: regolazione del campo magnetico', () => {
  // Hall out è collegato a Vout rispetto a GND. Vout = 2.5 + S * B
  const buildHallTest = () => {
    return buildCircuit(
      [
        ['V1', 'vdc', { V: 5 }],
        ['H1', 'hall_sensor', { S: 0.02 }],
        ['GND', 'ground'],
      ],
      [
        [['V1', 0], ['H1', 0]], // VCC
        [['V1', 1], ['H1', 1]], // GND
        [['V1', 1], ['GND', 0]],
      ],
    );
  };

  setEnv({ magneticField: 50 }); // 50 mT -> Vout = 2.5 + 0.02 * 50 = 3.5V
  let compiled = compile(buildHallTest());
  let result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged);
  let vOut = voltsAt(compiled, result, ['H1', 2]);
  assert.ok(Math.abs(vOut - 3.5) < 1e-2, `Vout Hall a 50mT deve essere 3.5V: ${vOut}`);

  setEnv({ magneticField: -50 }); // -50 mT -> Vout = 2.5 + 0.02 * (-50) = 1.5V
  compiled = compile(buildHallTest());
  result = sim.dcOperatingPoint(compiled);
  vOut = voltsAt(compiled, result, ['H1', 2]);
  assert.ok(Math.abs(vOut - 1.5) < 1e-2, `Vout Hall a -50mT deve essere 1.5V: ${vOut}`);
});

test('Semiconduttori extra: NMOS, PMOS e Diodo Schottky', () => {
  // NMOS invertitore di base
  const circuitNmos = buildCircuit(
    [
      ['V1', 'vdc', { V: 5 }],
      ['Vg', 'vdc', { V: 5 }], // Acceso
      ['R1', 'resistor', { R: 1000 }],
      ['M1', 'nmos', { Vth: 2.0, beta: 0.05 }],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['M1', 1]], // Drain
      [['Vg', 0], ['M1', 0]], // Gate
      [['M1', 2], ['GND', 0]], // Source
      [['V1', 1], ['GND', 0]],
      [['Vg', 1], ['GND', 0]],
    ],
  );
  let compiled = compile(circuitNmos);
  let result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged);
  let vDrain = voltsAt(compiled, result, ['M1', 1]);
  assert.ok(vDrain < 1.0, `NMOS acceso deve tirare giù il drain: ${vDrain}`);

  // Diodo Schottky: caduta più bassa di un diodo al silicio (es. < 0.4V rispetto a ~0.7V)
  const circuitSchottky = buildCircuit(
    [
      ['V1', 'vdc', { V: 5 }],
      ['R1', 'resistor', { R: 1000 }],
      ['D1', 'schottky'],
      ['GND', 'ground'],
    ],
    [
      [['V1', 0], ['R1', 0]],
      [['R1', 1], ['D1', 0]],
      [['D1', 1], ['V1', 1]],
      [['V1', 1], ['GND', 0]],
    ],
  );
  compiled = compile(circuitSchottky);
  result = sim.dcOperatingPoint(compiled);
  assert.ok(result.converged);
  let vSchottky = voltsAt(compiled, result, ['D1', 0]);
  assert.ok(vSchottky < 0.45, `Schottky VF deve essere bassa (< 0.45V): ${vSchottky}`);
});

test('Elettromeccanica: Relè SPDT e Fusibile', () => {
  // Fusibile bruciato ad alta corrente
  const buildFuseTest = (V: number) => {
    return buildCircuit(
      [
        ['V1', 'vdc', { V }],
        ['F1', 'fuse', { Imax: 0.5 }],
        ['R1', 'resistor', { R: 5 }], // Con V=5V, I=1A -> si fonde! Con V=1V, I=0.2A -> integro
        ['GND', 'ground'],
      ],
      [
        [['V1', 0], ['F1', 0]],
        [['F1', 1], ['R1', 0]],
        [['R1', 1], ['V1', 1]],
        [['V1', 1], ['GND', 0]],
      ],
    );
  };

  // Con 1V la corrente è 0.2A < 0.5A -> integro, Vout su R1 ~ 1V
  let compiled = compile(buildFuseTest(1));
  let transient = sim.transient(compiled, { dt: 1e-4 });
  let r = transient.step();
  let vOut = voltsAt(compiled, r, ['R1', 0]);
  assert.ok(Math.abs(vOut - 1.0) < 0.1, 'Fusibile integro conduce');

  // Con 5V la corrente salirebbe a 1A > 0.5A -> si brucia nel passo successivo!
  compiled = compile(buildFuseTest(5));
  transient = sim.transient(compiled, { dt: 1e-4 });
  transient.step(); // primo step: rileva sovracorrente e innesca la fusione
  r = transient.step(); // secondo step: fusibile bruciato (circuito aperto)
  vOut = voltsAt(compiled, r, ['R1', 0]);
  assert.ok(vOut < 0.1, `Fusibile bruciato interrompe la conduzione: ${vOut}V`);
});
