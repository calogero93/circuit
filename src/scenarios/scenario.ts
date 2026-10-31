// Scenari (seam §4.7): lo stato COMPLETO della sessione — circuito, sonde,
// oscilloscopio, A/B, lezione, viste — serializzato in JSON: salvabile su
// file, condivisibile via link, ricaricabile identico. Chi insegna riusa gli
// stessi seam di chi impara.

import { importCircuit, circuitToJSON, type CircuitJSON } from '../model/serialize.ts';
import { IMPORT_LIMITS, assertImportBudget, importError, parseImportText } from '../model/importLimits.ts';
import { getDef } from '../model/registry.ts';
import type { PinRef } from '../model/types.ts';
import { PROBE_COLORS, useStudio, type ABConfig, type RightTab } from '../store/studio.ts';
import { isPlaybackSpeed, type PlaybackSpeed } from '../viz/playback.ts';

export interface Scenario {
  version: 1;
  name: string;
  savedAt: string;
  circuit: CircuitJSON;
  probes: { pin: PinRef; label: string }[];
  scopeTimespan: number;
  scopeMode: 'time' | 'bode';
  timestep: number;
  playbackSpeed?: PlaybackSpeed;
  ab: ABConfig | null;
  abGhost: boolean;
  lessonId: string | null;
  lessonStep: number;
  presentation: boolean;
  rightTab: RightTab;
  environment?: ReturnType<typeof useStudio.getState>['environment'];
}

export function captureScenario(name: string): Scenario {
  const s = useStudio.getState();
  return {
    version: 1,
    name,
    savedAt: new Date().toISOString(),
    circuit: circuitToJSON(s.circuit),
    probes: s.probes.map((p) => ({ pin: p.pin, label: p.label })),
    scopeTimespan: s.scopeTimespan,
    scopeMode: s.scopeMode,
    timestep: s.timestep,
    playbackSpeed: s.playbackSpeed,
    ab: s.ab,
    abGhost: s.abGhost,
    lessonId: s.lessonId,
    lessonStep: s.lessonStep,
    presentation: s.presentation,
    rightTab: s.rightTab,
    environment: { ...s.environment },
  };
}

/** Applica uno scenario (difensivo: input arbitrario non manda in crash). */
export function applyScenario(raw: unknown, onError?: (message: string) => void): boolean {
  try {
    const accepted = hydrateScenario(raw);
    if (!accepted) onError?.(useStudio.getState().operationError ?? 'Scenario rifiutato');
    return accepted;
  } catch (error) {
    onError?.(error instanceof Error ? error.message : 'Scenario non valido');
    return false;
  }
}

function hydrateScenario(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) importError('scenario non valido');
  assertImportBudget(raw, true);
  const sc = raw as Partial<Scenario>;
  if (sc.version !== undefined && sc.version !== 1) importError('versione scenario non supportata');
  const circuit = importCircuit(sc.circuit);
  for (const [key, low, high] of [['timestep', 1e-6, 0.01], ['scopeTimespan', 1e-4, 60]] as const) {
    const value = sc[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high)) importError(`${key} deve essere tra ${low} e ${high} secondi`);
  }
  if (sc.probes !== undefined && (!Array.isArray(sc.probes) || sc.probes.length > IMPORT_LIMITS.probes)) importError(`massimo ${IMPORT_LIMITS.probes} sonde`);
  for (const probe of sc.probes ?? []) {
    const component = circuit.components.find(c => c.id === probe?.pin?.component);
    if (!component || !Number.isInteger(probe.pin.pin) || probe.pin.pin < 0 || probe.pin.pin >= getDef(component.type).pins.length || typeof probe.label !== 'string') importError('sonda o pin non valido');
  }
  if (sc.ab && (typeof sc.ab !== 'object' || !['remove', 'bypass'].includes(sc.ab.mode) || !circuit.components.some(c => c.id === sc.ab!.componentId))) importError('confronto A/B non valido');
  if (sc.lessonStep !== undefined && (!Number.isSafeInteger(sc.lessonStep) || sc.lessonStep < 0 || sc.lessonStep > 1000)) importError('passo della lezione non valido');
  const s = useStudio.getState();
  const environment = { ...useStudio.getInitialState().environment };
  const limits = { light: [0, 100], temperature: [-40, 150], pressure: [50, 150], magneticField: [-100, 100], humidity: [0, 100] };
  for (const key of Object.keys(environment) as (keyof typeof environment)[]) {
    const value = sc.environment?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) environment[key] = Math.min(limits[key][1], Math.max(limits[key][0], value));
  }
  const validTabs: RightTab[] = ['props', 'math', 'lesson', 'ai', 'scenari', 'logica', '3d'];
  return s.hydrate({
    circuit,
    environment,
    simulationEpoch: s.simulationEpoch + 1,
    undoStack: [],
    redoStack: [],
    selection: [],
    probes: Array.isArray(sc.probes)
      ? sc.probes
          .filter((p) => p && typeof p === 'object' && p.pin && circuit.components.some((c) => c.id === p.pin.component))
          .map((p, i) => ({
            id: `sc-probe-${i}`,
            pin: p.pin,
            label: typeof p.label === 'string' ? p.label : `S${i + 1}`,
            color: PROBE_COLORS[i % PROBE_COLORS.length],
          }))
      : [],
    scopeTimespan: typeof sc.scopeTimespan === 'number' && sc.scopeTimespan > 0 ? sc.scopeTimespan : 0.1,
    scopeMode: sc.scopeMode === 'bode' ? 'bode' : 'time',
    timestep: typeof sc.timestep === 'number' && sc.timestep > 0 ? sc.timestep : 1e-4,
    playbackSpeed: isPlaybackSpeed(sc.playbackSpeed) ? sc.playbackSpeed : 1,
    ab:
      sc.ab && typeof sc.ab === 'object' && circuit.components.some((c) => c.id === sc.ab!.componentId)
        ? sc.ab
        : null,
    abGhost: sc.abGhost === true && !!sc.ab,
    lessonId: typeof sc.lessonId === 'string' ? sc.lessonId : null,
    lessonStep: typeof sc.lessonStep === 'number' ? sc.lessonStep : 0,
    presentation: sc.presentation === true,
    rightTab: validTabs.includes(sc.rightTab as RightTab) ? (sc.rightTab as RightTab) : 'props',
    running: true,
  });
}

function toBase64Url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
  return decodeURIComponent(escape(atob(b64)));
}

/** Link condivisibile: lo scenario vive nell'hash dell'URL. */
export function scenarioLink(sc: Scenario): string {
  const url = new URL(window.location.href);
  url.hash = `s=${toBase64Url(JSON.stringify(sc))}`;
  return url.toString();
}

export function scenarioFromHash(): unknown | null {
  const h = window.location.hash;
  if (!h.startsWith('#s=')) return null;
  if (h.length > Math.ceil(IMPORT_LIMITS.fileBytes * 4 / 3) + 4) importError('link scenario oltre 2 MiB');
  try {
    const raw = parseImportText(fromBase64Url(h.slice(3)));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) importError('scenario condiviso non valido');
    return raw;
  } catch {
    return importError('link scenario non valido o troppo grande');
  }
}

export function downloadJSON(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
