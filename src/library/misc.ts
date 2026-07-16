// Massa (riferimento 0) e interruttore SPST ideale.

import type { ComponentDef } from '../model/registry.ts';
import type { DeviceModel } from '../model/device.ts';

const nodeModel: DeviceModel = {
  stamp() {
    // nessun contributo: è solo un punto di connessione fra fili
  },
  outputs: () => ({ pinCurrents: [0], data: {} }),
};

/** Nodo di giunzione: connette più fili nello stesso net (nessuna fisica). */
export const nodeDef: ComponentDef = {
  type: 'node',
  name: 'Nodo',
  category: 'altro',
  description: 'Punto di giunzione: connette più fili nello stesso nodo elettrico.',
  pins: [{ x: 0, y: 0, name: 'n' }],
  params: [],
  defaults: {},
  model: nodeModel,
  symbol: () => [{ kind: 'circle', cx: 0, cy: 0, r: 3, fill: 'currentColor' }],
};

const groundModel: DeviceModel = {
  stamp() {
    // nessun contributo: la massa definisce il riferimento via netlist
  },
  outputs: () => ({ pinCurrents: [0], data: {} }),
};

export const groundDef: ComponentDef = {
  type: 'ground',
  name: 'Massa',
  category: 'altro',
  description: 'Il riferimento a 0 V: tutte le tensioni dei nodi sono misurate rispetto a questo punto.',
  pins: [{ x: 0, y: -20, name: 'gnd' }],
  params: [],
  defaults: {},
  model: groundModel,
  isGround: true,
  symbol: () => [
    { kind: 'line', x1: 0, y1: -20, x2: 0, y2: 0 },
    { kind: 'line', x1: -14, y1: 0, x2: 14, y2: 0 },
    { kind: 'line', x1: -9, y1: 6, x2: 9, y2: 6 },
    { kind: 'line', x1: -4, y1: 12, x2: 4, y2: 12 },
  ],
};

const R_ON = 0.01;
const R_OFF = 1e9;

const switchModel: DeviceModel = {
  stamp(ctx, params, nodes) {
    const g = (params.closed as boolean) ? 1 / R_ON : 1 / R_OFF;
    ctx.addG(nodes[0], nodes[1], g);
  },
  outputs(sol, params, nodes) {
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    const i = v * ((params.closed as boolean) ? 1 / R_ON : 1 / R_OFF);
    return { pinCurrents: [i, -i], data: { v, i } };
  },
};

export const switchDef: ComponentDef = {
  type: 'switch',
  name: 'Interruttore SPST',
  category: 'altro',
  description: 'Apre o chiude il circuito: ideale per osservare i transitori (carica/scarica RC).',
  pins: [
    { x: -40, y: 0, name: 'a' },
    { x: 40, y: 0, name: 'b' },
  ],
  params: [{ key: 'closed', label: 'Chiuso', unit: '', kind: 'boolean' }],
  defaults: { closed: false },
  model: switchModel,
  symbol: (params) => [
    { kind: 'line', x1: -40, y1: 0, x2: -12, y2: 0 },
    { kind: 'circle', cx: -12, cy: 0, r: 3 },
    { kind: 'circle', cx: 12, cy: 0, r: 3 },
    params.closed
      ? { kind: 'line', x1: -12, y1: 0, x2: 12, y2: 0, width: 2.5 }
      : { kind: 'line', x1: -12, y1: 0, x2: 10, y2: -16, width: 2.5 },
    { kind: 'line', x1: 12, y1: 0, x2: 40, y2: 0 },
  ],
};
