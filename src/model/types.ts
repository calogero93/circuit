// Modello di circuito (netlist) — unica fonte di verità, indipendente dal motore.
// Seam §4.1 del Charter.

export type ParamValue = number | boolean;

/** Riferimento a un pin di un componente. */
export interface PinRef {
  component: string;
  pin: number;
}

export const pinKey = (ref: PinRef): string => `${ref.component}:${ref.pin}`;

export type Rotation = 0 | 1 | 2 | 3; // multipli di 90°

/** Istanza di componente piazzata sul canvas. */
export interface ComponentInstance {
  id: string;
  type: string; // chiave nel registro componenti
  x: number;
  y: number;
  rot: Rotation;
  params: Record<string, ParamValue>;
  label?: string;
}

/** Filo: connette due pin. La connettività (merge dei nodi) emerge dai fili. */
export interface Wire {
  id: string;
  from: PinRef;
  to: PinRef;
  /**
   * Verso del gomito ortogonale (false = orizzontale-prima). Quando `route` è
   * assente il percorso è ricalcolato dal vivo dalle posizioni dei pin, così il
   * filo segue i componenti spostati.
   */
  elbow?: boolean;
  /** Percorso esplicito opzionale (usato per i tronconi di una giunzione). */
  route?: { x: number; y: number }[];
}

/** Sotto-circuito / gruppo (strutturale in M1; predispone la partizione mixed-signal di M3). */
export interface Group {
  id: string;
  name: string;
  components: string[];
}

/**
 * Circuito completo. `boundaries` elenca i nodi (via pin) che fungono da
 * confine esplicito tra domini di simulazione (analogico/digitale, M3).
 */
export interface Circuit {
  components: ComponentInstance[];
  wires: Wire[];
  groups: Group[];
  boundaries: PinRef[];
}

export const emptyCircuit = (): Circuit => ({
  components: [],
  wires: [],
  groups: [],
  boundaries: [],
});

let idCounter = 0;
export function freshId(prefix: string, taken: (id: string) => boolean): string {
  for (;;) {
    idCounter += 1;
    const id = `${prefix}${idCounter}`;
    if (!taken(id)) return id;
  }
}
