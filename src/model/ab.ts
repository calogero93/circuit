import type { Circuit } from './types.ts';
import { getDef } from './registry.ts';

export interface ABConfig { componentId: string; mode: 'remove' | 'bypass' }

/** Applica la modifica A/B al circuito (per la sessione fantasma). */
export function applyAB(circuit: Circuit, ab: ABConfig): Circuit {
  if (ab.mode === 'remove') {
    // Il componente sparisce (circuito aperto), ma le net restano intatte:
    // i pin altrui che erano collegati TRAMITE un suo pin vengono ricuciti.
    const isTarget = (ref: { component: string }) => ref.component === ab.componentId;
    const kept = circuit.wires.filter((w) => !isTarget(w.from) && !isTarget(w.to));
    const stitched: Circuit['wires'] = [];
    const def = circuit.components.find((c) => c.id === ab.componentId);
    const pinCount = def ? getDef(def.type).pins.length : 0;
    for (let pin = 0; pin < pinCount; pin++) {
      const others = circuit.wires
        .filter((w) => (isTarget(w.from) && w.from.pin === pin) || (isTarget(w.to) && w.to.pin === pin))
        .map((w) => (isTarget(w.from) ? w.to : w.from));
      for (let i = 1; i < others.length; i++) {
        stitched.push({ id: `__ab_stitch_${pin}_${i}`, from: others[0], to: others[i] });
      }
    }
    return {
      ...circuit,
      components: circuit.components.filter((c) => c.id !== ab.componentId),
      wires: [...kept, ...stitched],
    };
  }
  // bypass: cortocircuito tra i primi due pin
  const inst = circuit.components.find((c) => c.id === ab.componentId);
  if (!inst || getDef(inst.type).pins.length < 2) return circuit;
  return {
    ...circuit,
    wires: [
      ...circuit.wires,
      {
        id: `__ab_bypass__`,
        from: { component: ab.componentId, pin: 0 },
        to: { component: ab.componentId, pin: 1 },
      },
    ],
  };
}

