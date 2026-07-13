// Contenuto matematico come DATO (seam §4.8): formule con termini simbolici
// mappati su componenti/nodi del circuito e sui loro valori simulati correnti.
// Nel LaTeX i termini vivi sono marcati con \htmlClass{fx-<term>}{...}.

import type { PinRef } from '../model/types.ts';

/** A cosa è agganciato un termine simbolico. */
export type TermTarget =
  | { kind: 'param'; component: string; param: string } // valore di un parametro (R, C, ...)
  | { kind: 'componentData'; component: string; key: string } // uscita del dispositivo (id, vd, ic, ...)
  | { kind: 'netVoltage'; pin: PinRef } // tensione del nodo a cui appartiene il pin
  | { kind: 'derived'; expr: DerivedExpr } // combinazione (es. τ = R·C)
  | { kind: 'time' };

/** Espressioni derivate componibili, serializzabili (niente funzioni). */
export type DerivedExpr =
  | { op: 'value'; target: Exclude<TermTarget, { kind: 'derived' }> }
  | { op: 'mul'; args: DerivedExpr[] }
  | { op: 'add'; args: DerivedExpr[] }
  | { op: 'div'; a: DerivedExpr; b: DerivedExpr }
  | { op: 'const'; value: number };

export interface FormulaTerm {
  /** Suffisso di classe usato nel LaTeX: \htmlClass{fx-<term>}{...}. */
  term: string;
  /** Etichetta leggibile (es. "R₂", "V_out"). */
  label: string;
  target: TermTarget;
  unit: string;
  /**
   * Cosa evidenziare nell'editor al passaggio del mouse:
   * il componente stesso o il nodo (net) di un pin.
   */
  highlight?: { kind: 'component'; id: string } | { kind: 'net'; pin: PinRef };
}

export interface FormulaStep {
  latex: string;
  note?: string;
}

export interface FormulaDef {
  id: string;
  title: string;
  description?: string;
  /** Derivazione completa, passo per passo. */
  steps: FormulaStep[];
  terms: FormulaTerm[];
}

/**
 * Formula "di componente": i riferimenti usano il segnaposto 'self',
 * risolto sull'istanza selezionata nell'editor.
 */
export const SELF = 'self';

export function bindFormulaToInstance(def: FormulaDef, instanceId: string): FormulaDef {
  const fix = <T,>(v: T): T => JSON.parse(JSON.stringify(v).replaceAll(`"${SELF}"`, JSON.stringify(instanceId)));
  return { ...def, terms: def.terms.map((t) => fix(t)) };
}
