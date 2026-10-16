// MNA + Newton-Raphson con residui fisici e backward Euler adattivo.
// Ogni step pubblico mantiene l'intervallo richiesto: i sottopassi sono interni.
import { solveInPlace } from './matrix.ts';
import type { CompiledCircuit } from '../model/netlist.ts';
import type { DeviceState, SolutionReader, StampContext } from '../model/device.ts';
import type { SimDiagnostics, SimResult, Simulator, SolverTolerances, TransientOptions, TransientSession } from './simulator.ts';

const NEWTON: SolverTolerances = { voltageAbs: 1e-7, currentAbs: 1e-10, relative: 1e-5 };
const ERROR: SolverTolerances = { voltageAbs: 1e-7, currentAbs: 1e-10, relative: 2e-5 };
const GMIN = 1e-12;
const GMIN_SCHEDULE = [1e-2, 1e-4, 1e-6, 1e-8, 1e-10, GMIN];
type States = Map<string, DeviceState>;
const cloneStates = (states: States): States => new Map([...states].map(([id, state]) => [id, { ...state }]));

function initialStates(circuit: CompiledCircuit, carried?: States): States {
  return new Map(circuit.items.map(({ inst, def }) => [
    inst.id, { ...(carried?.get(inst.id) ?? def.model.initState?.(inst.params) ?? {}) },
  ]));
}
function reader(x: Float64Array, n: number, dt: number | null, time: number): SolutionReader {
  return { dt, time, v: (node) => node < 0 ? 0 : x[node], branch: (b) => x[n + b] };
}

/** Diagnostica conservativa: isole senza riferimento galvanico a massa.
 * Non è una prova di rango: i dispositivi non lineari possono richiedere altre verifiche.
 */
function floatingNets(circuit: CompiledCircuit, dt: number | null): string[] {
  const adjacent = new Map<number, Set<number>>();
  for (const item of circuit.items) {
    if (['node', 'ground', 'idc'].includes(item.inst.type) || (dt === null && item.inst.type === 'capacitor')) continue;
    for (const a of item.nodes) {
      const edges = adjacent.get(a) ?? new Set<number>();
      for (const b of item.nodes) edges.add(b);
      adjacent.set(a, edges);
    }
  }
  const reached = new Set<number>([-1]);
  const queue = [-1];
  for (let k = 0; k < queue.length; k++) {
    for (const n of adjacent.get(queue[k]) ?? []) {
      if (!reached.has(n)) { reached.add(n); queue.push(n); }
    }
  }
  const active = new Set(circuit.items.filter((it) => !['node', 'ground', '__boundary'].includes(it.inst.type)).flatMap((it) => it.nodes));
  // Le sorgenti sintetiche mixed-signal impongono la tensione rispetto a massa.
  const anchored = circuit.items.filter((it) => it.inst.type === '__boundary').flatMap((it) => it.nodes);
  for (const n of anchored) if (!reached.has(n)) { reached.add(n); queue.push(n); }
  for (let k = 0; k < queue.length; k++) for (const n of adjacent.get(queue[k]) ?? []) {
    if (!reached.has(n)) { reached.add(n); queue.push(n); }
  }
  return [...active].filter((n) => n >= 0 && !reached.has(n)).map(circuit.netLabel);
}

interface System { A: Float64Array; b: Float64Array; limited: boolean }
function assemble(circuit: CompiledCircuit, states: States, dt: number | null, time: number,
  x: Float64Array, previous: Float64Array, gmin: number, memory: Map<string, number>): System {
  const n = circuit.nNodes;
  const size = n + circuit.nBranches;
  const A = new Float64Array(size * size);
  const b = new Float64Array(size);
  let limited = false;
  const ctx: StampContext = {
    dt, time, gmin,
    vNow: (k) => k < 0 ? 0 : x[k],
    vPrev: (k) => k < 0 ? 0 : previous[k],
    branchNow: (k) => x[n + k],
    branchIndex: (k) => n + k,
    addA: (r, c, value) => { if (r >= 0 && c >= 0) A[r * size + c] += value; },
    addB: (r, value) => { if (r >= 0) b[r] += value; },
    addG: (a, z, g) => {
      if (a >= 0) A[a * size + a] += g;
      if (z >= 0) A[z * size + z] += g;
      if (a >= 0 && z >= 0) { A[a * size + z] -= g; A[z * size + a] -= g; }
    },
    addCurrent: (k, value) => { if (k >= 0) b[k] += value; },
    getMemory: (key) => memory.get(key),
    setMemory: (key, value) => { memory.set(key, value); },
    markNotConverged: () => { limited = true; },
  };
  for (const { inst, def, nodes, branches } of circuit.items) {
    def.model.stamp(ctx, inst.params, nodes, branches, states.get(inst.id)!);
  }
  for (let k = 0; k < n; k++) A[k * size + k] += gmin;
  return { A, b, limited };
}
function normalizedResidual(system: System, x: Float64Array, nNodes: number): number {
  const size = x.length;
  let worst = 0;
  for (let r = 0; r < size; r++) {
    let sum = 0;
    let scale = Math.abs(system.b[r]);
    for (let c = 0; c < size; c++) {
      const term = system.A[r * size + c] * x[c];
      sum += term;
      scale += Math.abs(term);
    }
    // KCL (righe nodo) in ampere; vincoli di branch in volt.
    const abs = r < nNodes ? NEWTON.currentAbs : NEWTON.voltageAbs;
    const value = Math.abs(sum - system.b[r]) / (abs + NEWTON.relative * scale);
    if (!Number.isFinite(value)) return Infinity;
    worst = Math.max(worst, value);
  }
  return worst;
}
interface Solve { x: Float64Array; converged: boolean; iterations: number; residual: number }
function nrSolve(circuit: CompiledCircuit, states: States, dt: number | null, time: number,
  initial: Float64Array | null, gmin: number): Solve {
  const size = circuit.nNodes + circuit.nBranches;
  let x: Float64Array = initial ? Float64Array.from(initial) : new Float64Array(size);
  let previous: Float64Array = Float64Array.from(x);
  const memory = new Map<string, number>();
  let residual = Infinity;
  for (let iter = 1; iter <= 80; iter++) {
    const system = assemble(circuit, states, dt, time, x, previous, gmin, memory);
    const next = solveInPlace(system.A, system.b, size);
    if (!next || !next.every(Number.isFinite)) return { x, converged: false, iterations: iter, residual };
    const settled = next.every((v, i) => Math.abs(v - x[i]) <=
      (i < circuit.nNodes ? NEWTON.voltageAbs : NEWTON.currentAbs) + NEWTON.relative * Math.max(Math.abs(v), Math.abs(x[i])));
    if (settled && !system.limited) {
      // Ricostruisce le equazioni al candidato: non basta il residuo del sistema linearizzato precedente.
      const check = assemble(circuit, states, dt, time, next, x, gmin, memory);
      residual = normalizedResidual(check, next, circuit.nNodes);
      if (!check.limited && residual <= 1) return { x: next, converged: true, iterations: iter, residual };
    }
    previous = x;
    x = next;
  }
  return { x, converged: false, iterations: 80, residual };
}
function robustSolve(circuit: CompiledCircuit, states: States, dt: number | null, time: number, x: Float64Array | null): Solve {
  const direct = nrSolve(circuit, states, dt, time, x, GMIN);
  if (direct.converged) return direct;
  let last = direct;
  let seed: Float64Array | null = null;
  let iterations = direct.iterations;
  for (const gmin of GMIN_SCHEDULE) {
    last = nrSolve(circuit, states, dt, time, seed, gmin);
    iterations += last.iterations;
    if (!last.converged) return { ...last, iterations };
    seed = last.x;
  }
  return { ...last, iterations };
}
function result(circuit: CompiledCircuit, states: States, solve: Solve, dt: number | null, time: number,
  diagnostics: SimDiagnostics): SimResult {
  const sol = reader(solve.x, circuit.nNodes, dt, time);
  const outputs = new Map(circuit.items.map(({ inst, def, nodes, branches }) => [
    inst.id, def.model.outputs(sol, inst.params, nodes, branches, states.get(inst.id)!),
  ]));
  return { converged: solve.converged, time, voltageOfNet: sol.v, outputs, diagnostics };
}
function advanceStates(circuit: CompiledCircuit, states: States, solve: Solve, dt: number, time: number, continuousOnly = false): States {
  const next = cloneStates(states);
  const sol = reader(solve.x, circuit.nNodes, dt, time);
  for (const { inst, def, nodes, branches } of circuit.items) {
    if (continuousOnly && def.model.discreteState) continue;
    const updated = def.model.nextState?.(sol, inst.params, nodes, branches, next.get(inst.id)!);
    if (updated) next.set(inst.id, updated);
  }
  return next;
}
function diagnostics(circuit: CompiledCircuit, dt: number | null): SimDiagnostics {
  const floating = floatingNets(circuit, dt);
  return { iterations: 0, residual: 0, floatingNets: floating,
    warnings: floating.length ? [`Possibili nodi flottanti, regolarizzati con gmin: ${floating.join(', ')}`] : [] };
}

class AnalogTransient implements TransientSession {
  time: number;
  private x: Float64Array | null = null;
  private stateMap: States;
  private nextStep: number;
  private enabled: boolean;
  private minStep: number;
  private maxAttempts: number;
  private tolerance: SolverTolerances;
  private sourceLimit: number;
  private baseDiagnostics: SimDiagnostics;
  private circuit: CompiledCircuit;
  private dt: number;
  constructor(circuit: CompiledCircuit, dt: number, opts: TransientOptions) {
    this.circuit = circuit;
    this.dt = dt;
    if (!(dt > 0) || !Number.isFinite(dt)) throw new Error('dt deve essere positivo e finito');
    const config = typeof opts.adaptive === 'object' ? opts.adaptive : {};
    this.enabled = typeof opts.adaptive === 'boolean' ? opts.adaptive : config.enabled !== false;
    this.minStep = config.minStep ?? Math.max(1e-15, dt * 1e-8);
    this.maxAttempts = config.maxAttempts ?? 4096;
    this.tolerance = { ...ERROR, ...config.tolerances };
    if (!(this.minStep > 0) || !Number.isFinite(this.minStep) || !Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 ||
      Object.values(this.tolerance).some((v) => !(v > 0) || !Number.isFinite(v))) throw new Error('Opzioni adattive non valide');
    this.time = opts.t0 ?? 0;
    this.stateMap = initialStates(circuit, opts.initialStates);
    this.sourceLimit = dt;
    for (const { inst } of circuit.items) {
      if (!['vsin', 'vsin_phase', 'pulse'].includes(inst.type)) continue;
      const f = Number(inst.params.freq);
      if (!(f > 0)) continue;
      const duty = Number(inst.params.duty) / 100;
      const limit = inst.type === 'pulse' ? Math.min(duty, 1 - duty) / (8 * f) : 1 / (40 * f);
      if (limit > 0) this.sourceLimit = Math.min(this.sourceLimit, limit);
    }
    this.nextStep = this.sourceLimit;
    this.baseDiagnostics = diagnostics(circuit, dt);
  }
  step(interval = this.dt): SimResult {
    if (!(interval > 0) || !Number.isFinite(interval)) throw new Error('Intervallo non valido');
    const target = this.time + interval;
    let time = this.time;
    let x = this.x;
    let states = cloneStates(this.stateMap);
    const info: SimDiagnostics = { ...this.baseDiagnostics, warnings: [...this.baseDiagnostics.warnings],
      iterations: 0, acceptedSubsteps: 0, rejectedSubsteps: 0, minStep: Infinity, maxStep: 0, errorEstimate: 0 };
    let h = this.enabled ? Math.min(this.nextStep, this.sourceLimit, interval) : interval;
    let last: SimResult | null = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const remaining = target - time;
      h = Math.min(h, remaining);
      if (!(h > 0) || time + h === time) break;
      const full = robustSolve(this.circuit, states, h, time + h, x);
      info.iterations += full.iterations;
      let accepted = full;
      let finalStates = states;
      let finalDt = h;
      let error = 0;
      if (this.enabled && full.converged) {
        const half = robustSolve(this.circuit, states, h / 2, time + h / 2, x);
        info.iterations += half.iterations;
        if (half.converged) {
          const middle = advanceStates(this.circuit, states, half, h / 2, time + h / 2, true);
          accepted = robustSolve(this.circuit, middle, h / 2, time + h, half.x);
          info.iterations += accepted.iterations;
          if (accepted.converged) {
            for (let i = 0; i < accepted.x.length; i++) {
              const abs = i < this.circuit.nNodes ? this.tolerance.voltageAbs : this.tolerance.currentAbs;
              const scale = abs + this.tolerance.relative * Math.max(Math.abs(accepted.x[i]), Math.abs(full.x[i]));
              error = Math.max(error, Math.abs(accepted.x[i] - full.x[i]) / scale);
            }
            finalStates = middle;
            finalDt = h / 2;
          }
        } else accepted = half;
      }
      if (!accepted.converged || !Number.isFinite(error) || error > 1) {
        info.rejectedSubsteps!++;
        h *= 0.5;
        if (h < this.minStep) break;
        continue;
      }
      info.residual = Math.max(info.residual, accepted.residual);
      info.acceptedSubsteps!++;
      info.minStep = Math.min(info.minStep!, finalDt);
      info.maxStep = Math.max(info.maxStep!, finalDt);
      info.errorEstimate = Math.max(info.errorEstimate!, error);
      time = h === remaining ? target : time + h;
      last = result(this.circuit, finalStates, accepted, finalDt, time, info);
      states = advanceStates(this.circuit, finalStates, accepted, finalDt, time);
      x = accepted.x;
      if (time === target) {
        this.time = target;
        this.stateMap = states;
        this.x = x;
        this.nextStep = Math.min(this.sourceLimit, h * (error > 0 ? Math.min(2, Math.max(0.5, 0.9 / Math.sqrt(error))) : 2));
        return last;
      }
      h = Math.min(this.sourceLimit, h * (error > 0 ? Math.min(2, Math.max(0.5, 0.9 / Math.sqrt(error))) : 2));
    }
    // Rollback dell'intero intervallo pubblico: tempo e stati non vengono committati.
    info.warnings.push('Passo rifiutato: limite dei sottopassi o passo minimo raggiunto');
    const failed: Solve = { x: this.x ?? new Float64Array(this.circuit.nNodes + this.circuit.nBranches),
      converged: false, iterations: info.iterations, residual: Infinity };
    info.residual = Infinity;
    if (!Number.isFinite(info.minStep)) info.minStep = 0;
    return result(this.circuit, this.stateMap, failed, null, this.time, info);
  }
  states(): States { return cloneStates(this.stateMap); }
}

export class AnalogSimulator implements Simulator {
  readonly domain = 'analog' as const;
  dcOperatingPoint(circuit: CompiledCircuit): SimResult {
    const states = initialStates(circuit);
    const solve = robustSolve(circuit, states, null, 0, null);
    return result(circuit, states, solve, null, 0, { ...diagnostics(circuit, null), iterations: solve.iterations, residual: solve.residual });
  }
  transient(circuit: CompiledCircuit, opts: TransientOptions): TransientSession {
    return new AnalogTransient(circuit, opts.dt, opts);
  }
}
