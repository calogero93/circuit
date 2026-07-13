// Geometria dell'editor: griglia, rotazioni, posizione dei pin, instradamento
// ortogonale dei fili.

import type { ComponentInstance, PinRef } from '../model/types.ts';
import { getDef } from '../model/registry.ts';
import type { Circuit } from '../model/types.ts';

export const GRID = 20;

export const snap = (v: number): number => Math.round(v / GRID) * GRID;

export interface Pt {
  x: number;
  y: number;
}

/** Ruota un punto locale di rot·90° (coerente con transform rotate SVG). */
export function rotate(p: Pt, rot: number): Pt {
  switch (((rot % 4) + 4) % 4) {
    case 1:
      return { x: -p.y, y: p.x };
    case 2:
      return { x: -p.x, y: -p.y };
    case 3:
      return { x: p.y, y: -p.x };
    default:
      return p;
  }
}

export function pinPosition(inst: ComponentInstance, pin: number): Pt {
  const def = getDef(inst.type);
  const local = rotate(def.pins[pin], inst.rot);
  return { x: inst.x + local.x, y: inst.y + local.y };
}

export function pinPositionOf(circuit: Circuit, ref: PinRef): Pt | null {
  const inst = circuit.components.find((c) => c.id === ref.component);
  if (!inst) return null;
  return pinPosition(inst, ref.pin);
}

/** Percorso ortogonale a L tra due punti (orizzontale prima). */
export function orthogonalRoute(a: Pt, b: Pt): Pt[] {
  if (a.x === b.x || a.y === b.y) return [a, b];
  return [a, { x: b.x, y: a.y }, b];
}

export function routeLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
  }
  return len;
}

/** Punto lungo un percorso polilineare a distanza d dall'inizio. */
export function pointAlongRoute(pts: Pt[], d: number): Pt {
  let rest = d;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    if (rest <= seg && seg > 0) {
      const f = rest / seg;
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
      };
    }
    rest -= seg;
  }
  return pts[pts.length - 1];
}

export function pathOfRoute(pts: Pt[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}

/** Distanza punto-segmento (per hit-test dei fili). */
function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToRoute(p: Pt, pts: Pt[]): number {
  let min = Infinity;
  for (let i = 1; i < pts.length; i++) min = Math.min(min, distToSegment(p, pts[i - 1], pts[i]));
  return min;
}
