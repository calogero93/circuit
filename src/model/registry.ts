// Registro componenti estensibile: dati + comportamento (seam §4.4).
// Aggiungere un componente = registrare una voce; il nucleo non cambia.

import type { DeviceModel } from './device.ts';
import type { ParamValue } from './types.ts';
import type { FormulaDef } from '../math/formula.ts';

/** Primitiva grafica del simbolo 2D (dato, non JSX: usabile ovunque). */
export type SymbolPrimitive =
  | { kind: 'path'; d: string; fill?: string; width?: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; width?: number }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill?: string }
  | { kind: 'polygon'; points: string; fill?: string }
  | { kind: 'text'; x: number; y: number; text: string; size?: number };

export interface PinDef {
  x: number;
  y: number;
  name: string;
}

export interface ParamDef {
  key: string;
  label: string;
  unit: string;
  kind: 'number' | 'boolean' | 'select';
  min?: number;
  max?: number;
  /** slider logaritmico (per R, C, L...) */
  log?: boolean;
  /** opzioni per kind 'select' (valore = stringa memorizzata). */
  options?: { value: string; label: string }[];
}

/**
 * Voce del registro: metadati didattici + simbolo 2D + riferimento 3D (M2)
 * + modello elettrico (stamp) + formule (seam §4.8).
 */
export interface ComponentDef {
  type: string;
  name: string;
  category: 'sorgenti' | 'passivi' | 'semiconduttori' | 'digitale' | 'strumenti' | 'altro';
  /** Metadato didattico: a cosa serve, quando si usa. */
  description: string;
  pins: PinDef[];
  params: ParamDef[];
  defaults: Record<string, ParamValue>;
  model: DeviceModel;
  /** Simbolo 2D come dati; può dipendere dai parametri (es. interruttore). */
  symbol(params: Record<string, ParamValue>): SymbolPrimitive[];
  /** Riferimento all'asset 3D degli interni (visore M2). */
  symbol3d?: string;
  /** Formule del componente, con riferimenti 'self' (seam §4.8). */
  formulas?: FormulaDef[];
  /** Corrente massima consigliata (per indicatori didattici, es. LED bruciato). */
  maxCurrent?: number;
  /** Questo componente forza il suo nodo a massa (riferimento 0). */
  isGround?: boolean;
}

const registry = new Map<string, ComponentDef>();

export function registerComponent(def: ComponentDef): void {
  if (registry.has(def.type)) throw new Error(`componente già registrato: ${def.type}`);
  registry.set(def.type, def);
}

export function getDef(type: string): ComponentDef {
  const def = registry.get(type);
  if (!def) throw new Error(`componente sconosciuto: ${type}`);
  return def;
}

export function hasDef(type: string): boolean {
  return registry.has(type);
}

export function listDefs(): ComponentDef[] {
  return [...registry.values()];
}
