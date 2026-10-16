// Confronto indipendente offline. ngspice è un eseguibile di sviluppo, non entra nel bundle.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCircuit, compile, sim, voltsAt } from '../tests/engine/helpers.ts';
import type { Circuit } from '../src/model/types.ts';
import type { SimResult } from '../src/engine/simulator.ts';

interface Case {
  name: string;
  circuit: Circuit;
  netlist: string;
  tau?: number;
  read: (compiled: ReturnType<typeof compile>, result: SimResult) => number;
  tolerance: number;
}
const cases: Case[] = [];
for (const R of [100, 1000, 1e6]) {
  cases.push({ name: `divider R=${R}`, tolerance: 2e-5,
    circuit: buildCircuit([['V', 'vdc', { V: 5 }], ['R1', 'resistor', { R }], ['R2', 'resistor', { R: 2 * R }], ['G', 'ground']],
      [[['V', 0], ['R1', 0]], [['R1', 1], ['R2', 0]], [['R2', 1], ['G', 0]], [['V', 1], ['G', 0]]]),
    netlist: `V1 in 0 5\nR1 in out ${R}\nR2 out 0 ${2 * R}`,
    read: (c, r) => voltsAt(c, r, ['R2', 0]),
  });
}
for (const tau of [1e-4, 1e-3, 0.1]) {
  cases.push({ name: `RC tau=${tau}`, tau, tolerance: 0.003,
    circuit: buildCircuit([['V', 'vdc', { V: 5 }], ['R', 'resistor', { R: 1000 }], ['C', 'capacitor', { C: tau / 1000 }], ['G', 'ground']],
      [[['V', 0], ['R', 0]], [['R', 1], ['C', 0]], [['C', 1], ['G', 0]], [['V', 1], ['G', 0]]]),
    netlist: `V1 in 0 5\nR1 in out 1000\nC1 out 0 ${tau / 1000} IC=0`,
    read: (c, r) => voltsAt(c, r, ['C', 0]),
  });
  cases.push({ name: `RL tau=${tau}`, tau, tolerance: 0.003,
    circuit: buildCircuit([['V', 'vdc', { V: 5 }], ['R', 'resistor', { R: 1000 }], ['L', 'inductor', { L: tau * 1000 }], ['G', 'ground']],
      [[['V', 0], ['R', 0]], [['R', 1], ['L', 0]], [['L', 1], ['G', 0]], [['V', 1], ['G', 0]]]),
    netlist: `V1 in 0 5\nR1 in out 1000\nL1 out 0 ${tau * 1000} IC=0`,
    read: (c, r) => voltsAt(c, r, ['L', 0]),
  });
}
for (const voltage of [0.5, 5, 12]) {
  cases.push({ name: `diode Vin=${voltage}`, tolerance: 0.001,
    circuit: buildCircuit([['V', 'vdc', { V: voltage }], ['R', 'resistor', { R: 1000 }], ['D', 'diode'], ['G', 'ground']],
      [[['V', 0], ['R', 0]], [['R', 1], ['D', 0]], [['D', 1], ['G', 0]], [['V', 1], ['G', 0]]]),
    netlist: `V1 in 0 ${voltage}\nR1 in out 1000\nD1 out 0 DM\n.model DM D(IS=2.52n N=1.752)`,
    read: (c, r) => voltsAt(c, r, ['D', 0]),
  });
}

const binary = process.env.NGSPICE_BIN || 'ngspice';
if (spawnSync(binary, ['--version'], { encoding: 'utf8' }).error) {
  console.error('ngspice non disponibile. Installa il riferimento offline o imposta NGSPICE_BIN.');
  process.exit(2);
}
const directory = mkdtempSync(join(tmpdir(), 'circuit-validation-'));
let failures = 0;
try {
  for (const [index, item] of cases.entries()) {
    const path = join(directory, `${index}.cir`);
    const operation = item.tau
      ? `tran ${item.tau / 1000} ${item.tau} uic\nmeas tran reference FIND v(out) AT=${item.tau}`
      : 'op\nlet reference = v(out)\nprint reference';
    writeFileSync(path, `Circuit Studio reference\n.temp 26.85\n.options tnom=26.85 reltol=1e-8 abstol=1e-12 vntol=1e-10 method=gear maxord=2\n${item.netlist}\n.control\nset numdgt=15\n${operation}\n.endc\n.end\n`);
    const reference = spawnSync(binary, ['-b', path], { encoding: 'utf8', timeout: 30000 });
    const output = reference.stdout + reference.stderr;
    const match = output.match(/reference\s*=\s*([-+\d.eE]+)/i);
    if (!match) throw new Error(`Nessun valore ngspice per ${item.name}: ${output}`);
    const expected = Number(match[1]);
    const compiled = compile(item.circuit);
    let result = sim.dcOperatingPoint(compiled);
    if (item.tau) {
      const session = sim.transient(compiled, { dt: item.tau / 10 });
      for (let k = 0; k < 10; k++) result = session.step();
    }
    const actual = item.read(compiled, result);
    const error = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-9);
    const ok = result.converged && Number.isFinite(error) && error <= item.tolerance;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${item.name}: motore=${actual.toPrecision(8)}, ngspice=${expected.toPrecision(8)}, errore=${(100 * error).toFixed(5)}%`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
