// Interfaccia `Simulator` astratta (seam §4.2): la UI e l'AI parlano con
// questa interfaccia, mai con l'implementazione analogica. Il motore digitale
// e il coordinatore mixed-signal (M3) si innestano qui senza toccare la UI.
// I confini tra domini sono nodi espliciti nel modello (Circuit.boundaries).

import type { CompiledCircuit } from '../model/netlist.ts';
import type { DeviceOutputs, DeviceState } from '../model/device.ts';

export type DomainId = 'analog' | 'digital' | 'mixed';

export interface SimResult {
  converged: boolean;
  time: number;
  /** Tensione per indice di net (la massa è implicitamente 0). */
  voltageOfNet(net: number): number;
  /** Uscite per componente: correnti ai pin + grandezze didattiche. */
  outputs: Map<string, DeviceOutputs>;
  diagnostics?: SimDiagnostics;
}

export interface SimDiagnostics {
  iterations: number;
  /** Massimo residuo normalizzato: <= 1 soddisfa le tolleranze delle equazioni. */
  residual: number;
  floatingNets: string[];
  warnings: string[];
  acceptedSubsteps?: number;
  rejectedSubsteps?: number;
  minStep?: number;
  maxStep?: number;
  errorEstimate?: number;
}

export interface SolverTolerances {
  voltageAbs: number;
  currentAbs: number;
  relative: number;
}

export interface AdaptiveOptions {
  enabled?: boolean;
  minStep?: number;
  maxAttempts?: number;
  tolerances?: Partial<SolverTolerances>;
}

export interface TransientOptions {
  /** Passo temporale (s). */
  dt: number;
  /** Stati iniziali per componente (per continuità quando il circuito viene modificato al volo). */
  initialStates?: Map<string, DeviceState>;
  /** Tempo iniziale. */
  t0?: number;
  /** Sottopassi adattivi interni; l'intervallo di uscita rimane dt. */
  adaptive?: boolean | AdaptiveOptions;
}

export interface TransientSession {
  readonly time: number;
  /** Avanza di un passo dt e restituisce il risultato. */
  step(interval?: number): SimResult;
  /** Stati correnti dei componenti (per travaso in una nuova sessione). */
  states(): Map<string, DeviceState>;
}

export interface Simulator {
  readonly domain: DomainId;
  /** Punto di lavoro DC. */
  dcOperatingPoint(circuit: CompiledCircuit): SimResult;
  /** Analisi transitoria incrementale. */
  transient(circuit: CompiledCircuit, opts: TransientOptions): TransientSession;
}
