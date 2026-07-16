// Strumenti di misura piazzabili: voltmetro/multimetro (in parallelo, alta
// impedenza) e amperometro (in serie, ideale). Se ne possono mettere quanti si
// vuole; la lettura live compare sul canvas e — alla selezione — nel pannello
// ricco (DMM) riferito a ciò che i puntali stanno misurando.

import type { ComponentDef } from '../model/registry.ts';
import type { DeviceModel } from '../model/device.ts';

const R_METER = 1e7; // 10 MΩ: voltmetro ad alta impedenza, non carica il circuito

const multimeterModel: DeviceModel = {
  stamp(ctx, _params, nodes) {
    ctx.addG(nodes[0], nodes[1], 1 / R_METER);
  },
  outputs(sol, _params, nodes) {
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    return { pinCurrents: [v / R_METER, -v / R_METER], data: { v } };
  },
};

const MODE_LABEL: Record<string, string> = { V: 'V', R: 'Ω', C: 'C', L: 'L', diode: '⏵' };

export const multimeterDef: ComponentDef = {
  type: 'multimeter',
  name: 'Multimetro',
  category: 'strumenti',
  description:
    'Strumento ad alta impedenza da collegare in parallelo. La manopola sceglie cosa misurare (tensione, resistenza, capacità, induttanza, diodo); selezionandolo vedi tutti i dettagli di ciò che misura. Puoi metterne quanti vuoi.',
  pins: [
    { x: -40, y: 0, name: '+' },
    { x: 40, y: 0, name: '−' },
  ],
  params: [
    {
      key: 'mode',
      label: 'Misura',
      unit: '',
      kind: 'select',
      options: [
        { value: 'V', label: 'Tensione (V)' },
        { value: 'R', label: 'Resistenza (Ω)' },
        { value: 'C', label: 'Capacità (F)' },
        { value: 'L', label: 'Induttanza (H)' },
        { value: 'diode', label: 'Diodo (VF)' },
      ],
    },
  ],
  defaults: { mode: 'V' },
  model: multimeterModel,
  symbol: (p) => [
    { kind: 'line', x1: -40, y1: 0, x2: -16, y2: 0 },
    { kind: 'circle', cx: 0, cy: 0, r: 16 },
    { kind: 'text', x: -5, y: 5, text: MODE_LABEL[String(p.mode ?? 'V')] ?? 'V', size: 14 },
    { kind: 'line', x1: 16, y1: 0, x2: 40, y2: 0 },
  ],
};

const ammeterModel: DeviceModel = {
  branches: 1,
  stamp(ctx, _params, nodes, branches) {
    // amperometro ideale = cortocircuito a 0 V; la corrente di branch è la misura
    const br = ctx.branchIndex(branches[0]);
    ctx.addA(nodes[0], br, 1);
    ctx.addA(nodes[1], br, -1);
    ctx.addA(br, nodes[0], 1);
    ctx.addA(br, nodes[1], -1);
    ctx.addB(br, 0);
  },
  outputs(sol, _params, _nodes, branches) {
    const i = sol.branch(branches[0]);
    return { pinCurrents: [i, -i], data: { i } };
  },
};

export const ammeterDef: ComponentDef = {
  type: 'ammeter',
  name: 'Amperometro',
  category: 'strumenti',
  description:
    'Strumento ideale (resistenza nulla) da inserire IN SERIE nel ramo: interrompi il filo e mettilo in mezzo per misurare la corrente che lo attraversa.',
  pins: [
    { x: -40, y: 0, name: '+' },
    { x: 40, y: 0, name: '−' },
  ],
  params: [],
  defaults: {},
  model: ammeterModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -16, y2: 0 },
    { kind: 'circle', cx: 0, cy: 0, r: 16 },
    { kind: 'text', x: -5, y: 5, text: 'A', size: 14 },
    { kind: 'line', x1: 16, y1: 0, x2: 40, y2: 0 },
  ],
};

export const instrumentDefs: ComponentDef[] = [multimeterDef, ammeterDef];
