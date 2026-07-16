// Coordinatore mixed-signal (M3, seam §4.2): co-simula un circuito che mescola
// dominio analogico e digitale. Partiziona i componenti per dominio e accoppia
// i due motori ai NODI DI CONFINE:
//   • digitale → analogico: ogni uscita logica che tocca l'analogico diventa una
//     sorgente di tensione (livello × Vdd) nel problema analogico ridotto;
//   • analogico → digitale: le tensioni analogiche ai confini sono lette come
//     livelli logici (soglia) dal motore digitale.
// Accoppiamento con lag di un passo (Jacobi): a dt piccolo l'errore è trascurabile
// e si riusa il modello a sessioni dei due motori senza iterare nel tempo.

import type { CompiledCircuit, CompiledItem } from '../model/netlist.ts';
import type { DeviceModel, DeviceOutputs, DeviceState, SolutionReader } from '../model/device.ts';
import type { ComponentDef } from '../model/registry.ts';
import type { ComponentInstance, Circuit } from '../model/types.ts';
import { DIGITAL, logicLevel } from '../library/digital.ts';
import { AnalogSimulator } from './analog.ts';
import { evaluateDigital, initDigitalStates, netLevel, updateSequential, vddOf } from './digital.ts';
import type { Simulator, SimResult, TransientOptions, TransientSession } from './simulator.ts';

type States = Map<string, DeviceState>;

/** Sorgente di confine: impone la tensione `v` su un net rispetto a massa. */
const boundaryModel: DeviceModel = {
  branches: 1,
  stamp(ctx, params, nodes, branches) {
    const br = ctx.branchIndex(branches[0]);
    ctx.addA(nodes[0], br, 1);
    ctx.addA(br, nodes[0], 1);
    ctx.addB(br, params.v as number);
  },
  outputs(sol, _p, _n, branches) {
    return { pinCurrents: [sol.branch(branches[0])], data: {} };
  },
};

const boundaryDef: ComponentDef = {
  type: '__boundary',
  name: 'Confine',
  category: 'altro',
  description: '',
  pins: [{ x: 0, y: 0, name: 'b' }],
  params: [],
  defaults: {},
  model: boundaryModel,
  symbol: () => [],
};

const isDigitalItem = (it: CompiledItem): boolean => it.inst.type in DIGITAL;

interface AnalogPartition {
  reduced: CompiledCircuit;
  boundaries: { net: number; inst: ComponentInstance }[];
  analogNets: Set<number>;
  /** Net su cui il digitale è letto dall'analogico (analog-driven, non uscite digitali). */
  readNets: Set<number>;
}

/** Costruisce il problema analogico ridotto + le sorgenti di confine. */
function buildAnalog(compiled: CompiledCircuit): AnalogPartition {
  const analogItems = compiled.items.filter((it) => !isDigitalItem(it));
  const analogNets = new Set<number>();
  for (const it of analogItems) for (const n of it.nodes) if (n >= 0) analogNets.add(n);

  // net pilotati da un'uscita digitale (non vanno letti dall'analogico ma imposti)
  const digitalOutNets = new Set<number>();
  for (const it of compiled.items) {
    if (!isDigitalItem(it)) continue;
    const spec = DIGITAL[it.inst.type];
    if (spec.outPin == null) continue;
    const net = it.nodes[spec.outPin];
    if (net >= 0) digitalOutNets.add(net);
  }
  // confine digitale→analogico: uscita digitale che tocca l'analogico
  const boundaryNets = new Set<number>();
  for (const net of digitalOutNets) if (analogNets.has(net)) boundaryNets.add(net);
  // confine analogico→digitale: net analogici non pilotati dal digitale
  const readNets = new Set<number>();
  for (const net of analogNets) if (!digitalOutNets.has(net)) readNets.add(net);

  const boundaries = [...boundaryNets].map((net) => ({
    net,
    inst: { id: `__b${net}`, type: '__boundary', x: 0, y: 0, rot: 0, params: { v: 0 } } as ComponentInstance,
  }));

  // rinumerazione contigua dei branch (analogici + sorgenti di confine)
  let b = 0;
  const reItems: CompiledItem[] = analogItems.map((it) => ({ ...it, branches: it.branches.map(() => b++) }));
  const bItems: CompiledItem[] = boundaries.map((bd) => ({ inst: bd.inst, def: boundaryDef, nodes: [bd.net], branches: [b++] }));

  const reduced: CompiledCircuit = {
    items: [...reItems, ...bItems],
    nNodes: compiled.nNodes,
    nBranches: b,
    netOfPin: compiled.netOfPin,
    pinsOfNet: compiled.pinsOfNet,
    netLabel: compiled.netLabel,
  };
  return { reduced, boundaries, analogNets, readNets };
}

/** Unisce il risultato analogico e i livelli digitali in un SimResult unico. */
function combine(
  compiled: CompiledCircuit,
  aRes: SimResult,
  levels: Float64Array,
  analogNets: Set<number>,
  vdd: number,
  digStates: States,
  time: number,
): SimResult {
  const voltageOfNet = (net: number): number =>
    net < 0 ? 0 : analogNets.has(net) ? aRes.voltageOfNet(net) : netLevel(levels, net) * vdd;
  const reader: SolutionReader = { dt: null, time, v: voltageOfNet, branch: () => 0 };
  const outputs = new Map<string, DeviceOutputs>();
  for (const it of compiled.items) {
    if (isDigitalItem(it)) {
      outputs.set(it.inst.id, it.def.model.outputs(reader, it.inst.params, it.nodes, it.branches, digStates.get(it.inst.id) ?? {}));
    } else {
      const o = aRes.outputs.get(it.inst.id);
      if (o) outputs.set(it.inst.id, o);
    }
  }
  return { converged: aRes.converged, time, voltageOfNet, outputs };
}

class MixedTransient implements TransientSession {
  time: number;
  private dt: number;
  private vdd: number;
  private compiled: CompiledCircuit;
  private analog: TransientSession;
  private boundaries: { net: number; inst: ComponentInstance }[];
  private analogNets: Set<number>;
  private readNets: Set<number>;
  private digStates: States;
  private lastAnalog: SimResult | null = null;

  constructor(compiled: CompiledCircuit, dt: number, opts: TransientOptions, analogSim: AnalogSimulator) {
    this.compiled = compiled;
    this.dt = dt;
    this.time = opts.t0 ?? 0;
    this.vdd = vddOf(compiled);
    const part = buildAnalog(compiled);
    this.boundaries = part.boundaries;
    this.analogNets = part.analogNets;
    this.readNets = part.readNets;
    this.analog = analogSim.transient(part.reduced, opts);
    this.digStates = initDigitalStates(compiled, opts.initialStates);
  }

  private override = (net: number): number | undefined =>
    this.readNets.has(net) ? logicLevel(this.lastAnalog?.voltageOfNet(net) ?? 0, this.vdd).l : undefined;

  step(): SimResult {
    const t = this.time + this.dt;
    const levels = evaluateDigital(this.compiled, this.digStates, t, this.override);
    updateSequential(this.compiled, this.digStates, levels, t);
    for (const bd of this.boundaries) bd.inst.params.v = netLevel(levels, bd.net) * this.vdd;
    const aRes = this.analog.step();
    this.lastAnalog = aRes;
    this.time = t;
    return combine(this.compiled, aRes, levels, this.analogNets, this.vdd, this.digStates, t);
  }

  states(): States {
    const m = new Map(this.analog.states());
    for (const [k, v] of this.digStates) m.set(k, v);
    return m;
  }
}

export class MixedSignalSimulator implements Simulator {
  readonly domain = 'mixed' as const;
  private analogSim = new AnalogSimulator();

  dcOperatingPoint(compiled: CompiledCircuit): SimResult {
    const vdd = vddOf(compiled);
    const { reduced, boundaries, analogNets, readNets } = buildAnalog(compiled);
    const states = initDigitalStates(compiled);
    let aRes: SimResult = this.analogSim.dcOperatingPoint(reduced);
    let levels = evaluateDigital(compiled, states, 0);
    // iterazione al punto di lavoro (nessun avanzamento nel tempo)
    for (let iter = 0; iter < 8; iter++) {
      const override = (net: number): number | undefined =>
        readNets.has(net) ? logicLevel(aRes.voltageOfNet(net), vdd).l : undefined;
      levels = evaluateDigital(compiled, states, 0, override);
      for (const bd of boundaries) bd.inst.params.v = netLevel(levels, bd.net) * vdd;
      aRes = this.analogSim.dcOperatingPoint(reduced);
    }
    return combine(compiled, aRes, levels, analogNets, vdd, states, 0);
  }

  transient(compiled: CompiledCircuit, opts: TransientOptions): TransientSession {
    return new MixedTransient(compiled, opts.dt, opts, this.analogSim);
  }
}

/** Vero se il circuito mescola componenti digitali e analogici. */
export function isMixed(circuit: Circuit): boolean {
  let dig = false;
  let ana = false;
  for (const c of circuit.components) {
    if (c.type in DIGITAL) dig = true;
    else if (c.type !== 'node') ana = true;
  }
  return dig && ana;
}
