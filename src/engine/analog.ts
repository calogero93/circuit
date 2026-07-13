// Motore analogico proprietario: Modified Nodal Analysis per stamping dei
// componenti, punto di lavoro DC con Newton-Raphson (gmin stepping come aiuto
// di convergenza; il limiting delle giunzioni sta nei modelli), transitoria
// backward Euler con companion model. Implementa l'interfaccia Simulator.

import { solveInPlace } from './matrix.ts';
import type { CompiledCircuit } from '../model/netlist.ts';
import type { DeviceState, SolutionReader, StampContext } from '../model/device.ts';
import type { SimResult, Simulator, TransientOptions, TransientSession } from './simulator.ts';

const ABSTOL = 1e-6;
const RELTOL = 1e-4;
const MAX_ITER = 80;
const GMIN_FLOOR = 1e-12;
const GMIN_SCHEDULE = [1e-2, 1e-4, 1e-6, 1e-8, 1e-10, GMIN_FLOOR];

type States = Map<string, DeviceState>;

function initialStates(circuit: CompiledCircuit, carryOver?: States): States {
  const states: States = new Map();
  for (const item of circuit.items) {
    const carried = carryOver?.get(item.inst.id);
    if (carried) {
      states.set(item.inst.id, carried);
    } else if (item.def.model.initState) {
      states.set(item.inst.id, item.def.model.initState(item.inst.params));
    } else {
      states.set(item.inst.id, {});
    }
  }
  return states;
}

function makeReader(x: Float64Array, nNodes: number, dt: number | null, time: number): SolutionReader {
  return {
    dt,
    time,
    v: (node) => (node < 0 ? 0 : x[node]),
    branch: (b) => x[nNodes + b],
  };
}

interface NRResult {
  x: Float64Array;
  converged: boolean;
}

function nrSolve(
  circuit: CompiledCircuit,
  states: States,
  dt: number | null,
  time: number,
  x0: Float64Array | null,
  gmin: number,
): NRResult {
  const nNodes = circuit.nNodes;
  const size = nNodes + circuit.nBranches;
  if (size === 0) return { x: new Float64Array(0), converged: true };

  let x: Float64Array = x0 ? Float64Array.from(x0) : new Float64Array(size);
  let xPrev: Float64Array = Float64Array.from(x);
  const A = new Float64Array(size * size);
  const b = new Float64Array(size);
  const memory = new Map<string, number>();

  for (let iter = 0; iter < MAX_ITER; iter++) {
    A.fill(0);
    b.fill(0);
    let devicesLimited = false;
    const xNow = x;
    const xOld = xPrev;
    const ctx: StampContext = {
      dt,
      time,
      gmin,
      vNow: (n) => (n < 0 ? 0 : xNow[n]),
      vPrev: (n) => (n < 0 ? 0 : xOld[n]),
      branchNow: (br) => xNow[nNodes + br],
      addA: (r, c, v) => {
        if (r >= 0 && c >= 0) A[r * size + c] += v;
      },
      addB: (r, v) => {
        if (r >= 0) b[r] += v;
      },
      addG: (na, nb, g) => {
        if (na >= 0) A[na * size + na] += g;
        if (nb >= 0) A[nb * size + nb] += g;
        if (na >= 0 && nb >= 0) {
          A[na * size + nb] -= g;
          A[nb * size + na] -= g;
        }
      },
      addCurrent: (n, i) => {
        if (n >= 0) b[n] += i;
      },
      branchIndex: (br) => nNodes + br,
      getMemory: (key) => memory.get(key),
      setMemory: (key, v) => {
        memory.set(key, v);
      },
      markNotConverged: () => {
        devicesLimited = true;
      },
    };

    for (const item of circuit.items) {
      item.def.model.stamp(ctx, item.inst.params, item.nodes, item.branches, states.get(item.inst.id)!);
    }
    // gmin verso massa su ogni nodo: evita singolarità da nodi flottanti
    for (let n = 0; n < nNodes; n++) A[n * size + n] += gmin;

    const xNew = solveInPlace(Float64Array.from(A), Float64Array.from(b), size);
    if (!xNew) return { x, converged: false };

    let converged = !devicesLimited;
    for (let i = 0; converged && i < size; i++) {
      if (Math.abs(xNew[i] - x[i]) > ABSTOL + RELTOL * Math.abs(xNew[i])) converged = false;
    }
    for (let i = 0; i < size; i++) {
      if (!Number.isFinite(xNew[i])) return { x, converged: false };
    }
    xPrev = x;
    x = xNew;
    if (converged) return { x, converged: true };
  }
  return { x, converged: false };
}

/** Prova diretta; se non converge, gmin stepping da zero (continuazione). */
function robustSolve(
  circuit: CompiledCircuit,
  states: States,
  dt: number | null,
  time: number,
  x0: Float64Array | null,
): NRResult {
  const direct = nrSolve(circuit, states, dt, time, x0, GMIN_FLOOR);
  if (direct.converged) return direct;

  let x: Float64Array | null = null;
  let last: NRResult = direct;
  for (const gmin of GMIN_SCHEDULE) {
    last = nrSolve(circuit, states, dt, time, x, gmin);
    if (!last.converged) return { x: last.x, converged: false };
    x = last.x;
  }
  return last;
}

function buildResult(
  circuit: CompiledCircuit,
  states: States,
  x: Float64Array,
  dt: number | null,
  time: number,
  converged: boolean,
): SimResult {
  const reader = makeReader(x, circuit.nNodes, dt, time);
  const outputs = new Map<string, ReturnType<typeof circuit.items[number]['def']['model']['outputs']>>();
  for (const item of circuit.items) {
    outputs.set(
      item.inst.id,
      item.def.model.outputs(reader, item.inst.params, item.nodes, item.branches, states.get(item.inst.id)!),
    );
  }
  return {
    converged,
    time,
    voltageOfNet: (net) => (net < 0 ? 0 : x[net] ?? 0),
    outputs,
  };
}

class AnalogTransient implements TransientSession {
  time: number;
  private x: Float64Array | null = null;
  private stateMap: States;
  private circuit: CompiledCircuit;
  private dt: number;

  constructor(circuit: CompiledCircuit, dt: number, opts: TransientOptions) {
    this.circuit = circuit;
    this.dt = dt;
    this.time = opts.t0 ?? 0;
    this.stateMap = initialStates(circuit, opts.initialStates);
  }

  step(): SimResult {
    const t = this.time + this.dt;
    const { x, converged } = robustSolve(this.circuit, this.stateMap, this.dt, t, this.x);
    if (!converged) {
      const xShown = this.x ?? x;
      return buildResult(this.circuit, this.stateMap, xShown, this.dt, this.time, false);
    }
    this.time = t;
    this.x = x;
    // le uscite (es. i = C·dv/dt) usano lo stato PRIMA dell'aggiornamento
    const result = buildResult(this.circuit, this.stateMap, x, this.dt, t, true);
    const reader = makeReader(x, this.circuit.nNodes, this.dt, t);
    for (const item of this.circuit.items) {
      const next = item.def.model.nextState?.(
        reader,
        item.inst.params,
        item.nodes,
        item.branches,
        this.stateMap.get(item.inst.id)!,
      );
      if (next) this.stateMap.set(item.inst.id, next);
    }
    return result;
  }

  states(): States {
    return new Map(this.stateMap);
  }
}

export class AnalogSimulator implements Simulator {
  readonly domain = 'analog' as const;

  dcOperatingPoint(circuit: CompiledCircuit): SimResult {
    const states = initialStates(circuit);
    const { x, converged } = robustSolve(circuit, states, null, 0, null);
    return buildResult(circuit, states, x, null, 0, converged);
  }

  transient(circuit: CompiledCircuit, opts: TransientOptions): TransientSession {
    return new AnalogTransient(circuit, opts.dt, opts);
  }
}
