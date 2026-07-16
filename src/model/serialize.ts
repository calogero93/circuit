// Serializzazione JSON del circuito (seam §4.1): salva/carica, e formato che
// l'AI legge. La deserializzazione è difensiva: scarta riferimenti rotti e
// tipi sconosciuti, integra i parametri mancanti con i default.

import type { Circuit, ComponentInstance, PinRef, Rotation, Wire } from './types.ts';
import { emptyCircuit } from './types.ts';
import { getDef, hasDef } from './registry.ts';

export const CIRCUIT_FORMAT_VERSION = 1;

export interface CircuitJSON {
  version: number;
  components: ComponentInstance[];
  wires: Wire[];
  groups?: Circuit['groups'];
  boundaries?: PinRef[];
}

export function circuitToJSON(c: Circuit): CircuitJSON {
  return {
    version: CIRCUIT_FORMAT_VERSION,
    components: c.components,
    wires: c.wires,
    groups: c.groups,
    boundaries: c.boundaries,
  };
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function sanitizeComponent(raw: unknown): ComponentInstance | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.type !== 'string') return null;
  if (!hasDef(r.type)) return null;
  if (!isFiniteNum(r.x) || !isFiniteNum(r.y)) return null;
  const def = getDef(r.type);
  const rot: Rotation = r.rot === 1 || r.rot === 2 || r.rot === 3 ? r.rot : 0;
  const params: ComponentInstance['params'] = { ...def.defaults };
  if (typeof r.params === 'object' && r.params !== null) {
    for (const p of def.params) {
      const v = (r.params as Record<string, unknown>)[p.key];
      if (p.kind === 'number' && isFiniteNum(v)) params[p.key] = v;
      if (p.kind === 'boolean' && typeof v === 'boolean') params[p.key] = v;
    }
  }
  return {
    id: r.id,
    type: r.type,
    x: r.x,
    y: r.y,
    rot,
    params,
    ...(typeof r.label === 'string' ? { label: r.label } : {}),
  };
}

function sanitizePinRef(raw: unknown, comps: Map<string, ComponentInstance>): PinRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.component !== 'string' || !isFiniteNum(r.pin)) return null;
  const inst = comps.get(r.component);
  if (!inst) return null;
  const def = getDef(inst.type);
  if (r.pin < 0 || r.pin >= def.pins.length || !Number.isInteger(r.pin)) return null;
  return { component: r.component, pin: r.pin };
}

/** Deserializzazione robusta: non lancia mai su input malformato, ripulisce. */
export function circuitFromJSON(raw: unknown): Circuit {
  const out = emptyCircuit();
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;

  const compMap = new Map<string, ComponentInstance>();
  if (Array.isArray(r.components)) {
    for (const c of r.components) {
      const inst = sanitizeComponent(c);
      if (inst && !compMap.has(inst.id)) compMap.set(inst.id, inst);
    }
  }
  out.components = [...compMap.values()];

  if (Array.isArray(r.wires)) {
    const seen = new Set<string>();
    for (const w of r.wires) {
      if (typeof w !== 'object' || w === null) continue;
      const ww = w as Record<string, unknown>;
      const from = sanitizePinRef(ww.from, compMap);
      const to = sanitizePinRef(ww.to, compMap);
      const id = typeof ww.id === 'string' ? ww.id : null;
      if (from && to && id && !seen.has(id)) {
        // optional route: array of {x:number,y:number}
        let route: { x: number; y: number }[] | undefined;
        if (Array.isArray(ww.route)) {
          const pts: { x: number; y: number }[] = [];
          let ok = true;
          for (const p of ww.route) {
            if (typeof p !== 'object' || p === null) {
              ok = false;
              break;
            }
            const px = (p as Record<string, unknown>).x;
            const py = (p as Record<string, unknown>).y;
            if (!isFiniteNum(px) || !isFiniteNum(py)) {
              ok = false;
              break;
            }
            pts.push({ x: px, y: py });
          }
          if (ok) route = pts;
        }
        const elbow = typeof ww.elbow === 'boolean' ? ww.elbow : undefined;
        seen.add(id);
        const wire: Wire = { id, from, to };
        if (elbow !== undefined) wire.elbow = elbow;
        if (route) wire.route = route;
        out.wires.push(wire);
      }
    }
  }

  if (Array.isArray(r.groups)) {
    for (const g of r.groups) {
      if (typeof g !== 'object' || g === null) continue;
      const gg = g as Record<string, unknown>;
      if (typeof gg.id === 'string' && typeof gg.name === 'string' && Array.isArray(gg.components)) {
        out.groups.push({
          id: gg.id,
          name: gg.name,
          components: gg.components.filter((c): c is string => typeof c === 'string' && compMap.has(c)),
        });
      }
    }
  }

  if (Array.isArray(r.boundaries)) {
    for (const b of r.boundaries) {
      const ref = sanitizePinRef(b, compMap);
      if (ref) out.boundaries.push(ref);
    }
  }

  return out;
}
