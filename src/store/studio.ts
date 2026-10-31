// Store Zustand dell'applicazione: circuito (via command pattern), selezione,
// strumenti, sonde, oscilloscopio, A/B, lezione, presentazione.

import { create } from 'zustand';
import type { Circuit, ParamValue, PinRef, Rotation } from '../model/types.ts';
import { emptyCircuit } from '../model/types.ts';
import type { CircuitCommand } from './commands.ts';
import { isPlaybackSpeed, type PlaybackSpeed } from '../viz/playback.ts';
import { assertSimulationWorkload, validProbe } from '../model/workload.ts';
import type { ABConfig } from '../model/ab.ts';
export type { ABConfig } from '../model/ab.ts';

export type Tool =
  | { kind: 'select' }
  | { kind: 'place'; type: string; rot: Rotation }
  | { kind: 'wire'; from: PinRef | null; elbow?: boolean; waypoints?: { x: number; y: number }[] }
  | { kind: 'probe' };

export interface Probe {
  id: string;
  pin: PinRef;
  color: string;
  label: string;
}

// Palette Okabe-Ito adattata al tema scuro e validata (banda di luminosità,
// separazione CVD, contrasto ≥3:1 sulla superficie dello scope).
export const PROBE_COLORS = ['#2f93d0', '#bf8500', '#009e73', '#999000', '#b25e8f', '#d55e00'];

export type RightTab = 'props' | 'math' | 'lesson' | 'ai' | 'scenari' | 'logica' | '3d';

export interface HoverHighlight {
  components: string[];
  pins: PinRef[];
}

interface UndoEntry {
  cmd: CircuitCommand;
  at: number;
}

const COALESCE_WINDOW_MS = 800;

export interface StudioState {
  circuit: Circuit;
  operationError: string | null;
  simulationEpoch: number;
  undoStack: UndoEntry[];
  redoStack: CircuitCommand[];
  selection: string[];
  tool: Tool;
  probes: Probe[];
  scopeTimespan: number; // secondi visualizzati
  scopeMode: 'time' | 'bode';
  running: boolean;
  playbackSpeed: PlaybackSpeed; // secondi simulati per secondo reale attivo
  timestep: number; // dt della transitoria
  ab: ABConfig | null;
  abGhost: boolean; // confronto A/B attivo (traccia fantasma)
  lessonId: string | null;
  lessonStep: number;
  presentation: boolean;
  rightTab: RightTab;
  /** Tempo di simulazione dell'ultimo evento per componente (ancora del marcatore τ). */
  eventTimes: Record<string, number>;
  /** Evidenziazione richiesta dal pannello matematico (hover su un termine). */
  hover: HoverHighlight | null;
  /** Componente sotto il mouse nell'editor (evidenzia i termini in matematica). */
  hoveredComponent: string | null;
  /** Variabili ambientali fisiche per i sensori */
  environment: {
    light: number;        // 0-100% (LDR, Fotodiodi)
    temperature: number;  // -40 a 150 °C (NTC, PTC)
    pressure: number;     // 50 a 150 kPa (Sensore Pressione)
    magneticField: number;// -100 a 100 mT (Sensore Hall)
    humidity: number;     // 0-100% (Sensore Umidità)
  };

  execute(cmd: CircuitCommand): boolean;
  undo(): void;
  redo(): void;
  setSelection(ids: string[]): void;
  setTool(tool: Tool): void;
  addProbe(pin: PinRef): void;
  removeProbe(id: string): void;
  setProbes(probes: Probe[]): void;
  setScopeTimespan(s: number): void;
  setScopeMode(mode: 'time' | 'bode'): void;
  setRunning(running: boolean): void;
  setPlaybackSpeed(speed: PlaybackSpeed): void;
  setTimestep(dt: number): void;
  setAB(ab: ABConfig | null): void;
  setABGhost(on: boolean): void;
  setEnvironment(env: Partial<StudioState['environment']>): void;
  setLesson(id: string | null, step?: number): void;
  setLessonStep(step: number): void;
  setPresentation(on: boolean): void;
  setRightTab(tab: RightTab): void;
  markEvent(componentId: string, simTime: number): void;
  setHover(h: HoverHighlight | null): void;
  setHoveredComponent(id: string | null): void;
  /** Ripristino integrale da scenario (non passa dalla history). */
  hydrate(partial: Partial<StudioState>): boolean;
}

let probeCounter = 0;

export const useStudio = create<StudioState>((set, get) => {
  // Validate the complete effective workload before publishing any new state.
  const commit = (partial: Partial<StudioState>): boolean => {
    const before = get();
    const candidate = { ...before, ...partial, operationError: null };
    try {
      if (partial.probes && partial.probes.some(p => !validProbe(candidate.circuit, p.pin))) throw new Error('Sonda non valida');
      assertSimulationWorkload(candidate);
    } catch (error) {
      set({ operationError: error instanceof Error ? error.message : 'Operazione rifiutata' });
      return false;
    }
    try {
      set(candidate);
      return true;
    } catch (error) {
      // The controller restores its own snapshot before propagating a failure.
      set(before, true);
      set({ operationError: error instanceof Error ? error.message : 'Operazione rifiutata' });
      return false;
    }
  };
  return ({
  circuit: emptyCircuit(),
  operationError: null,
  simulationEpoch: 0,
  undoStack: [],
  redoStack: [],
  selection: [],
  tool: { kind: 'select' },
  probes: [],
  scopeTimespan: 0.1,
  scopeMode: 'time',
  running: true,
  playbackSpeed: 1,
  timestep: 1e-4,
  ab: null,
  abGhost: false,
  lessonId: null,
  lessonStep: 0,
  presentation: false,
  rightTab: 'props',
  eventTimes: {},
  hover: null,
  hoveredComponent: null,
  environment: {
    light: 10,
    temperature: 25,
    pressure: 101.3,
    magneticField: 0,
    humidity: 40,
  },

  execute(cmd) {
    const { circuit, undoStack } = get();
    const now = Date.now();
    const top = undoStack[undoStack.length - 1];
    let entry: UndoEntry = { cmd, at: now };
    let stack = undoStack;
    if (
      top &&
      cmd.coalesceKey &&
      top.cmd.coalesceKey === cmd.coalesceKey &&
      now - top.at < COALESCE_WINDOW_MS &&
      top.cmd.mergeWith
    ) {
      const merged = top.cmd.mergeWith(cmd);
      if (merged) {
        entry = { cmd: merged, at: now };
        stack = undoStack.slice(0, -1);
      }
    }
    return commit({
      circuit: cmd.apply(circuit),
      simulationEpoch: get().simulationEpoch + (cmd.resetSimulation ? 1 : 0),
      undoStack: [...stack, entry],
      redoStack: [],
    });
  },

  undo() {
    const { circuit, undoStack, redoStack, selection } = get();
    const top = undoStack[undoStack.length - 1];
    if (!top) return;
    const next = top.cmd.revert(circuit);
    const alive = new Set([...next.components.map((c) => c.id), ...next.wires.map((w) => w.id)]);
    commit({
      circuit: next,
      undoStack: undoStack.slice(0, -1),
      simulationEpoch: get().simulationEpoch + (top.cmd.resetSimulation ? 1 : 0),
      redoStack: [...redoStack, top.cmd],
      selection: selection.filter((id) => alive.has(id)),
    });
  },

  redo() {
    const { circuit, undoStack, redoStack, selection } = get();
    const cmd = redoStack[redoStack.length - 1];
    if (!cmd) return;
    const next = cmd.apply(circuit);
    const alive = new Set([...next.components.map((c) => c.id), ...next.wires.map((w) => w.id)]);
    commit({
      circuit: next,
      undoStack: [...undoStack, { cmd, at: 0 }], // at:0 → mai coalescato con comandi futuri
      simulationEpoch: get().simulationEpoch + (cmd.resetSimulation ? 1 : 0),
      redoStack: redoStack.slice(0, -1),
      selection: selection.filter((id) => alive.has(id)),
    });
  },

  setSelection: (ids) => set({ selection: ids }),
  setTool: (tool) => set({ tool }),

  addProbe(pin) {
    const { probes } = get();
    probeCounter += 1;
    const color = PROBE_COLORS[probes.length % PROBE_COLORS.length];
    commit({ probes: [...probes, { id: `probe${probeCounter}`, pin, color, label: `S${probes.length + 1}` }] });
  },
  removeProbe: (id) => set({ probes: get().probes.filter((p) => p.id !== id) }),
  setProbes: (probes) => { commit({ probes }); },

  setScopeTimespan: (s) => { commit({ scopeTimespan: s }); },
  setScopeMode: (scopeMode) => { commit({ scopeMode }); },
  setRunning: (running) => set({ running }),
  setPlaybackSpeed: (playbackSpeed) => {
    if (isPlaybackSpeed(playbackSpeed)) set({ playbackSpeed });
  },
  setTimestep: (dt) => { commit({ timestep: dt }); },
  setAB: (ab) => { commit({ ab, abGhost: ab ? get().abGhost : false }); },
  setABGhost: (on) => { commit({ abGhost: on }); },
  setLesson: (id, step = 0) => set({ lessonId: id, lessonStep: step }),
  setLessonStep: (step) => set({ lessonStep: step }),
  setPresentation: (on) => set({ presentation: on }),
  setRightTab: (tab) => set({ rightTab: tab }),
  setEnvironment: (env) => { commit({ environment: { ...get().environment, ...env } }); },
  markEvent: (componentId, simTime) =>
    set({ eventTimes: { ...get().eventTimes, [componentId]: simTime } }),
  setHover: (h) => set({ hover: h }),
  setHoveredComponent: (id) => set({ hoveredComponent: id }),

  hydrate: (partial) => commit(partial),
  });
});

/** Comodità: circuito con un componente aggiornato al volo (per selettori). */
export function findComponent(circuit: Circuit, id: string) {
  return circuit.components.find((c) => c.id === id) ?? null;
}

export type { ParamValue };
