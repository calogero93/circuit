// Utilità per costruire circuiti di test in modo compatto.

import { registerLibrary } from '../../src/library/index.ts';
import { compile, type CompiledCircuit } from '../../src/model/netlist.ts';
import { emptyCircuit, pinKey, type Circuit, type ComponentInstance, type ParamValue } from '../../src/model/types.ts';
import { AnalogSimulator } from '../../src/engine/analog.ts';
import type { SimResult } from '../../src/engine/simulator.ts';

registerLibrary();

export const sim = new AnalogSimulator();

export type PinSpec = [string, number];

export function buildCircuit(
  components: [id: string, type: string, params?: Record<string, ParamValue>][],
  wires: [PinSpec, PinSpec][],
): Circuit {
  const c = emptyCircuit();
  c.components = components.map(
    ([id, type, params]): ComponentInstance => ({ id, type, x: 0, y: 0, rot: 0, params: params ?? {} }),
  );
  c.wires = wires.map(([from, to], i) => ({
    id: `w${i}`,
    from: { component: from[0], pin: from[1] },
    to: { component: to[0], pin: to[1] },
  }));
  return c;
}

export function voltsAt(compiled: CompiledCircuit, result: SimResult, pin: PinSpec): number {
  const net = compiled.netOfPin.get(pinKey({ component: pin[0], pin: pin[1] }));
  if (net === undefined) throw new Error(`pin sconosciuto: ${pin[0]}:${pin[1]}`);
  return result.voltageOfNet(net);
}

export { compile };
