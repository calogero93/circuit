// Compilazione della netlist: dai fili ai nodi elettrici (union-find).
// Produce la struttura che il motore consuma; la UI la usa per mappare
// pin → net (visualizzazione), senza toccare lo stato interno del motore.

import type { Circuit, ComponentInstance } from './types.ts';
import { pinKey } from './types.ts';
import type { ComponentDef } from './registry.ts';
import { getDef } from './registry.ts';

export interface CompiledItem {
  inst: ComponentInstance;
  def: ComponentDef;
  /** Indice di net per ciascun pin (-1 = massa). */
  nodes: number[];
  /** Indici globali dei branch richiesti dal modello. */
  branches: number[];
}

export interface CompiledCircuit {
  items: CompiledItem[];
  /** Numero di net diverse dalla massa. */
  nNodes: number;
  nBranches: number;
  /** pinKey → indice di net (-1 = massa). */
  netOfPin: Map<string, number>;
  /** Etichette leggibili: 'gnd' per -1, 'n1'.. per le altre. */
  netLabel(net: number): string;
  /** Pin appartenenti a ogni net (per evidenziazioni e probe). */
  pinsOfNet: Map<number, string[]>;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let r = this.parent.get(x) ?? x;
    if (r !== x) {
      r = this.find(r);
      this.parent.set(x, r);
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function compile(circuit: Circuit): CompiledCircuit {
  const uf = new UnionFind();
  const allPins: string[] = [];
  const groundRoots = new Set<string>();

  for (const inst of circuit.components) {
    const def = getDef(inst.type);
    def.pins.forEach((_, i) => allPins.push(pinKey({ component: inst.id, pin: i })));
  }
  for (const w of circuit.wires) {
    uf.union(pinKey(w.from), pinKey(w.to));
  }
  for (const inst of circuit.components) {
    const def = getDef(inst.type);
    if (def.isGround) {
      def.pins.forEach((_, i) => groundRoots.add(uf.find(pinKey({ component: inst.id, pin: i }))));
    }
  }

  const netIndex = new Map<string, number>(); // root → indice
  const netOfPin = new Map<string, number>();
  const pinsOfNet = new Map<number, string[]>();
  let n = 0;
  for (const pk of allPins) {
    const root = uf.find(pk);
    let idx: number;
    if (groundRoots.has(root)) {
      idx = -1;
    } else if (netIndex.has(root)) {
      idx = netIndex.get(root)!;
    } else {
      idx = n++;
      netIndex.set(root, idx);
    }
    netOfPin.set(pk, idx);
    const list = pinsOfNet.get(idx) ?? [];
    list.push(pk);
    pinsOfNet.set(idx, list);
  }

  let nBranches = 0;
  const items: CompiledItem[] = circuit.components.map((inst) => {
    const def = getDef(inst.type);
    const nodes = def.pins.map((_, i) => netOfPin.get(pinKey({ component: inst.id, pin: i }))!);
    const count = def.model.branches ?? 0;
    const branches = Array.from({ length: count }, () => nBranches++);
    return { inst, def, nodes, branches };
  });

  return {
    items,
    nNodes: n,
    nBranches,
    netOfPin,
    pinsOfNet,
    netLabel: (net) => (net < 0 ? 'gnd' : `n${net + 1}`),
  };
}
