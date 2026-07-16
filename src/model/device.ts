// Interfaccia di stamping: ogni componente sa contribuire da sé alla matrice
// MNA (seam §4.1). Il motore NON conosce i tipi concreti dei dispositivi.

import type { ParamValue } from './types.ts';

export type Params = Record<string, ParamValue>;

/** Stato interno di un dispositivo tra un passo temporale e il successivo (es. V del condensatore). */
export type DeviceState = Record<string, number>;

/**
 * Contesto di assemblaggio MNA passato a `stamp`.
 * Indici: nodi 0..n-1 (massa = -1, ignorata), righe di branch = n + branchIndex.
 * Convenzione: le righe dei nodi sono KCL "somma correnti uscenti = iniezioni";
 * `addCurrent(n, i)` inietta la corrente i NEL nodo n (lato destro).
 */
export interface StampContext {
  /** null = punto di lavoro DC; altrimenti passo temporale dell'analisi transitoria. */
  readonly dt: number | null;
  /** Tempo di simulazione corrente (fine del passo per backward Euler). */
  readonly time: number;
  /** gmin corrente (per giunzioni in parallelo, aiuto di convergenza). */
  readonly gmin: number;
  /** Tensione del nodo all'iterata Newton-Raphson corrente. */
  vNow(node: number): number;
  /** Tensione del nodo all'iterata precedente (per il limiting delle giunzioni). */
  vPrev(node: number): number;
  /** Corrente di branch all'iterata corrente. */
  branchNow(branch: number): number;
  /** A[r][c] += v (r, c: indice di incognita; -1 = massa, ignorato). */
  addA(r: number, c: number, v: number): void;
  /** z[r] += v. */
  addB(r: number, v: number): void;
  /** Conduttanza g tra i nodi a e b. */
  addG(a: number, b: number, g: number): void;
  /** Corrente iniettata nel nodo (positiva = entrante). */
  addCurrent(node: number, i: number): void;
  /** Indice di riga/colonna globale di un branch. */
  branchIndex(branch: number): number;
  /** Memoria per-chiave che persiste tra le iterate NR (es. limiting giunzioni). */
  getMemory(key: string): number | undefined;
  setMemory(key: string, v: number): void;
  /**
   * Il dispositivo segnala di aver alterato il punto di linearizzazione
   * (limiting): l'iterata corrente non può essere accettata come convergente.
   */
  markNotConverged(): void;
}

/** Lettura della soluzione dopo la convergenza. */
export interface SolutionReader {
  readonly dt: number | null;
  readonly time: number;
  v(node: number): number;
  branch(branch: number): number;
}

/**
 * Uscite di un dispositivo dopo un solve. `pinCurrents[i]` = corrente che ENTRA
 * nel dispositivo dal pin i. `data` espone grandezze didattiche (vd, ic, ...)
 * usate da probe, pannello matematico, tutor AI e — in M2 — dai campi.
 */
export interface DeviceOutputs {
  pinCurrents: number[];
  data: Record<string, number | string | boolean>;
}

/**
 * Modello elettrico di un dispositivo: il "comportamento" della voce di
 * registro. Il motore analogico orchestra; la fisica sta qui.
 */
export interface DeviceModel {
  /** Numero di correnti di branch richieste (sorgenti di tensione, induttori). */
  branches?: number;
  /** true se lo stamp dipende dalla soluzione (richiede iterazione NR). */
  nonlinear?: boolean;
  /** Stato iniziale (es. condensatore scarico). */
  initState?(params: Params): DeviceState;
  /** Contribuisce alla matrice MNA. `nodes[i]` = nodo del pin i. */
  stamp(ctx: StampContext, params: Params, nodes: number[], branches: number[], state: DeviceState): void;
  /** Uscite dal punto convergente. */
  outputs(sol: SolutionReader, params: Params, nodes: number[], branches: number[], state: DeviceState): DeviceOutputs;
  /** Nuovo stato dopo un passo transitorio accettato. */
  nextState?(sol: SolutionReader, params: Params, nodes: number[], branches: number[], state: DeviceState): DeviceState;
}
