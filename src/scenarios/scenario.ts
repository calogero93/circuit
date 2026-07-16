// Scenari (seam §4.7): lo stato COMPLETO della sessione — circuito, sonde,
// oscilloscopio, A/B, lezione, viste — serializzato in JSON: salvabile su
// file, condivisibile via link, ricaricabile identico. Chi insegna riusa gli
// stessi seam di chi impara.

import { circuitFromJSON, circuitToJSON, type CircuitJSON } from '../model/serialize.ts';
import type { PinRef } from '../model/types.ts';
import { PROBE_COLORS, useStudio, type ABConfig, type RightTab } from '../store/studio.ts';

export interface Scenario {
  version: 1;
  name: string;
  savedAt: string;
  circuit: CircuitJSON;
  probes: { pin: PinRef; label: string }[];
  scopeTimespan: number;
  scopeMode: 'time' | 'bode';
  timestep: number;
  ab: ABConfig | null;
  abGhost: boolean;
  lessonId: string | null;
  lessonStep: number;
  presentation: boolean;
  rightTab: RightTab;
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
    ab: s.ab,
    abGhost: s.abGhost,
    lessonId: s.lessonId,
    lessonStep: s.lessonStep,
    presentation: s.presentation,
    rightTab: s.rightTab,
  };
}

/** Applica uno scenario (difensivo: input arbitrario non manda in crash). */
export function applyScenario(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const sc = raw as Partial<Scenario>;
  const circuit = circuitFromJSON(sc.circuit);
  const s = useStudio.getState();
  const validTabs: RightTab[] = ['props', 'math', 'lesson', 'ai', 'scenari', 'logica'];
  s.hydrate({
    circuit,
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
  return true;
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
  try {
    return JSON.parse(fromBase64Url(h.slice(3)));
  } catch {
    return null;
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
