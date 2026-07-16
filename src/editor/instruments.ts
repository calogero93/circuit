// Helper per gli strumenti di misura: trova il componente "a ponte" fra i due
// puntali (quello i cui pin stanno sui due nodi dello strumento) e formatta la
// lettura del multimetro secondo la modalità scelta.

import { getDef } from '../model/registry.ts';
import { formatSI } from '../model/units.ts';
import { pinKey, type Circuit, type ComponentInstance } from '../model/types.ts';
import type { DeviceOutputs } from '../model/device.ts';

/** Componente i cui pin coprono entrambi i nodi dei puntali (misura in parallelo). */
export function bridgedComponent(circuit: Circuit, netOfPin: Map<string, number>, instId: string): ComponentInstance | null {
  const a = netOfPin.get(pinKey({ component: instId, pin: 0 }));
  const b = netOfPin.get(pinKey({ component: instId, pin: 1 }));
  if (a === undefined || b === undefined || a === b) return null;
  for (const c of circuit.components) {
    if (c.id === instId) continue;
    const def = getDef(c.type);
    let hasA = false;
    let hasB = false;
    for (let i = 0; i < def.pins.length; i++) {
      const n = netOfPin.get(pinKey({ component: c.id, pin: i }));
      if (n === a) hasA = true;
      if (n === b) hasB = true;
    }
    if (hasA && hasB) return c;
  }
  return null;
}

/** Lettura compatta del multimetro per il canvas, secondo la modalità. */
export function multimeterReading(
  inst: ComponentInstance,
  selfOut: DeviceOutputs | undefined,
  bridged: ComponentInstance | null,
  bridgedOut: DeviceOutputs | undefined,
): string {
  const mode = String(inst.params.mode ?? 'V');
  if (mode === 'V') return formatSI(Number(selfOut?.data.v ?? 0), 'V', 3);
  if (!bridged) return '— —';
  const bp = bridged.params;
  switch (mode) {
    case 'R':
      return formatSI(Number(bridgedOut?.data.r ?? bp.R ?? bp.R25 ?? bp.R0 ?? 0), 'Ω', 3);
    case 'C':
      return formatSI(Number(bp.C ?? bp.C0 ?? 0), 'F', 3);
    case 'L':
      return formatSI(Number(bp.L ?? 0), 'H', 3);
    case 'diode':
      return formatSI(Number(bridgedOut?.data.v ?? bridgedOut?.data.vd ?? 0), 'V', 3);
    default:
      return '— —';
  }
}
