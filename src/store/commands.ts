// Command pattern per undo/redo: ogni modifica al circuito è un comando con
// apply/revert espliciti. I comandi con lo stesso coalesceKey ravvicinati nel
// tempo si fondono (trascinamenti, slider) in un'unica voce di undo.

import type { Circuit, ComponentInstance, ParamValue, Wire } from '../model/types.ts';

export interface CircuitCommand {
  label: string;
  coalesceKey?: string;
  apply(c: Circuit): Circuit;
  revert(c: Circuit): Circuit;
  /** Fonde questo comando con quello successivo (stesso coalesceKey). */
  mergeWith?(next: CircuitCommand): CircuitCommand | null;
}

export function addComponent(inst: ComponentInstance): CircuitCommand {
  return {
    label: `aggiungi ${inst.type}`,
    apply: (c) => ({ ...c, components: [...c.components, inst] }),
    revert: (c) => ({ ...c, components: c.components.filter((x) => x.id !== inst.id) }),
  };
}

export function addWire(wire: Wire): CircuitCommand {
  return {
    label: 'aggiungi filo',
    apply: (c) => ({ ...c, wires: [...c.wires, wire] }),
    revert: (c) => ({ ...c, wires: c.wires.filter((w) => w.id !== wire.id) }),
  };
}

/** Cancella componenti e fili (inclusi i fili attaccati ai componenti rimossi). */
export function removeItems(circuit: Circuit, ids: string[]): CircuitCommand {
  const idSet = new Set(ids);
  const comps = circuit.components.filter((x) => idSet.has(x.id));
  const compIds = new Set(comps.map((x) => x.id));
  const wires = circuit.wires.filter(
    (w) => idSet.has(w.id) || compIds.has(w.from.component) || compIds.has(w.to.component),
  );
  const wireIds = new Set(wires.map((w) => w.id));
  return {
    label: 'cancella',
    apply: (c) => ({
      ...c,
      components: c.components.filter((x) => !compIds.has(x.id)),
      wires: c.wires.filter((w) => !wireIds.has(w.id)),
      groups: c.groups.map((g) => ({ ...g, components: g.components.filter((id) => !compIds.has(id)) })),
      boundaries: c.boundaries.filter((b) => !compIds.has(b.component)),
    }),
    revert: (c) => ({
      ...c,
      components: [...c.components, ...comps],
      wires: [...c.wires, ...wires],
    }),
  };
}

function updateComponent(c: Circuit, id: string, patch: Partial<ComponentInstance>): Circuit {
  return {
    ...c,
    components: c.components.map((x) => (x.id === id ? { ...x, ...patch } : x)),
  };
}

export function moveComponent(id: string, from: { x: number; y: number }, to: { x: number; y: number }): CircuitCommand {
  return {
    label: 'sposta',
    coalesceKey: `move:${id}`,
    apply: (c) => updateComponent(c, id, to),
    revert: (c) => updateComponent(c, id, from),
    mergeWith: (next) => (next.coalesceKey === `move:${id}` ? { ...next, revert: (c) => updateComponent(c, id, from) } : null),
  };
}

export function rotateComponent(id: string, from: ComponentInstance['rot'], to: ComponentInstance['rot']): CircuitCommand {
  return {
    label: 'ruota',
    apply: (c) => updateComponent(c, id, { rot: to }),
    revert: (c) => updateComponent(c, id, { rot: from }),
  };
}

export function setParam(id: string, key: string, from: ParamValue, to: ParamValue): CircuitCommand {
  const coalesceKey = `param:${id}:${key}`;
  const patch = (c: Circuit, v: ParamValue): Circuit => ({
    ...c,
    components: c.components.map((x) => (x.id === id ? { ...x, params: { ...x.params, [key]: v } } : x)),
  });
  return {
    label: `modifica ${key}`,
    coalesceKey,
    apply: (c) => patch(c, to),
    revert: (c) => patch(c, from),
    mergeWith: (next) => (next.coalesceKey === coalesceKey ? { ...next, revert: (c) => patch(c, from) } : null),
  };
}

/** Sostituzione integrale (carica file, carica lezione, svuota). */
export function replaceCircuit(label: string, before: Circuit, after: Circuit): CircuitCommand {
  return {
    label,
    apply: () => after,
    revert: () => before,
  };
}
