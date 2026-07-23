// Motore digitale nativo (M3, seam §4.2): simula i circuiti *interamente
// digitali* dietro l'interfaccia `Simulator`, senza Newton-Raphson. Valuta la
// logica combinatoria a punto fisso e aggiorna lo stato sequenziale (flip-flop)
// sul fronte di clock. Il coordinatore (controller) instrada qui i circuiti
// digitali e all'analogico tutti gli altri — la partizione per dominio del
// Charter, nella sua prima forma. Il comportamento dei componenti è definito una
// sola volta in `library/digital.ts` (tabella `DIGITAL`).

import type { CompiledCircuit } from '../model/netlist.ts';
import type { DeviceOutputs, DeviceState, SolutionReader } from '../model/device.ts';
import type { Circuit } from '../model/types.ts';
import { DEFAULT_VDD, DIGITAL, isDigitalType } from '../library/digital.ts';
import type { Simulator, SimResult, TransientOptions, TransientSession } from './simulator.ts';

type States = Map<string, DeviceState>;

export const netLevel = (levels: Float64Array, net: number): number => (net < 0 ? 0 : levels[net] || 0);

export function vddOf(circuit: CompiledCircuit): number {
  for (const it of circuit.items) {
    const v = it.inst.params.vdd;
    if (typeof v === 'number') return v;
  }
  return DEFAULT_VDD;
}

export function initDigitalStates(circuit: CompiledCircuit, carried?: States): States {
  const m: States = new Map();
  for (const it of circuit.items) {
    const spec = DIGITAL[it.inst.type];
    if (spec?.sequential) m.set(it.inst.id, carried?.get(it.inst.id) ?? spec.sequential.init());
  }
  return m;
}

/**
 * Propaga la logica combinatoria fino al punto fisso. `override(net)` fornisce i
 * livelli imposti dall'esterno (confini pilotati dall'analogico): quei net non
 * vengono ricalcolati dalle porte.
 */
export function evaluateDigital(
  circuit: CompiledCircuit,
  states: States,
  time: number,
  override?: (net: number) => number | undefined,
): Float64Array {
  const levels = new Float64Array(circuit.nNodes);
  const fixed = new Set<number>();
  if (override) {
    for (let net = 0; net < circuit.nNodes; net++) {
      const o = override(net);
      if (o !== undefined) {
        levels[net] = o;
        fixed.add(net);
      }
    }
  }
  const drivers = circuit.items.filter((it) => {
    const s = DIGITAL[it.inst.type];
    return s && (s.outPin != null || s.outPins);
  });
  const setNet = (net: number, v: number): boolean => {
    if (net < 0 || fixed.has(net) || levels[net] === v) return false;
    levels[net] = v;
    return true;
  };
  for (let iter = 0; iter < 64; iter++) {
    let changed = false;
    for (const it of drivers) {
      const spec = DIGITAL[it.inst.type];
      const inLevels = spec.inPins.map((pin) => netLevel(levels, it.nodes[pin]));
      const state = states.get(it.inst.id) ?? {};
      if (spec.outPins && spec.driveMany) {
        const outs = spec.driveMany(inLevels, it.inst.params, state, time);
        spec.outPins.forEach((pin, k) => {
          if (setNet(it.nodes[pin], outs[k])) changed = true;
        });
      } else if (spec.outPin != null && spec.drive) {
        if (setNet(it.nodes[spec.outPin], spec.drive(inLevels, it.inst.params, state, time))) changed = true;
      }
    }
    if (!changed) break;
  }
  return levels;
}

/** Aggiornamento sequenziale (flip-flop) a fine passo, dai livelli assestati. */
export function updateSequential(circuit: CompiledCircuit, states: States, levels: Float64Array, time: number): void {
  for (const it of circuit.items) {
    const spec = DIGITAL[it.inst.type];
    if (spec?.sequential) {
      const inLevels = spec.inPins.map((pin) => netLevel(levels, it.nodes[pin]));
      const st = states.get(it.inst.id) ?? spec.sequential.init();
      states.set(it.inst.id, spec.sequential.update(inLevels, it.inst.params, st, time));
    }
  }
}

function buildResult(circuit: CompiledCircuit, states: States, levels: Float64Array, vdd: number, time: number): SimResult {
  const reader: SolutionReader = {
    dt: null,
    time,
    v: (net) => netLevel(levels, net) * vdd,
    branch: () => 0,
  };
  const outputs = new Map<string, DeviceOutputs>();
  for (const it of circuit.items) {
    outputs.set(it.inst.id, it.def.model.outputs(reader, it.inst.params, it.nodes, it.branches, states.get(it.inst.id) ?? {}));
  }
  return { converged: true, time, voltageOfNet: (net) => netLevel(levels, net) * vdd, outputs };
}

class DigitalTransient implements TransientSession {
  time: number;
  private circuit: CompiledCircuit;
  private dt: number;
  private stateMap: States;
  private vdd: number;

  constructor(circuit: CompiledCircuit, dt: number, opts: TransientOptions) {
    this.circuit = circuit;
    this.dt = dt;
    this.time = opts.t0 ?? 0;
    this.vdd = vddOf(circuit);
    this.stateMap = initDigitalStates(circuit, opts.initialStates);
  }

  step(): SimResult {
    const t = this.time + this.dt;
    const levels = evaluateDigital(this.circuit, this.stateMap, t);
    const result = buildResult(this.circuit, this.stateMap, levels, this.vdd, t);
    updateSequential(this.circuit, this.stateMap, levels, t);
    this.time = t;
    return result;
  }

  states(): States {
    return new Map(this.stateMap);
  }
}

export class DigitalSimulator implements Simulator {
  readonly domain = 'digital' as const;

  dcOperatingPoint(circuit: CompiledCircuit): SimResult {
    const states = initDigitalStates(circuit);
    return buildResult(circuit, states, evaluateDigital(circuit, states, 0), vddOf(circuit), 0);
  }

  transient(circuit: CompiledCircuit, opts: TransientOptions): TransientSession {
    return new DigitalTransient(circuit, opts.dt, opts);
  }
}

/** Vero se il circuito è interamente digitale (nodi di giunzione ammessi). */
export function isPurelyDigital(circuit: Circuit): boolean {
  if (circuit.components.length === 0) return false;
  let hasDigital = false;
  for (const c of circuit.components) {
    if (!isDigitalType(c.type)) return false;
    if (c.type in DIGITAL) hasDigital = true;
  }
  return hasDigital;
}
