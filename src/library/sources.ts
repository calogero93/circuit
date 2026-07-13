// Sorgenti: tensione DC, tensione sinusoidale, corrente DC.
// Convenzione: pin 0 = terminale + ; la corrente di branch i è la corrente
// che ENTRA nel dispositivo dal pin +.

import type { ComponentDef } from '../model/registry.ts';
import type { DeviceModel, Params, StampContext } from '../model/device.ts';
import { SELF, type FormulaDef } from '../math/formula.ts';

function stampVoltageSource(ctx: StampContext, nodes: number[], branches: number[], value: number): void {
  const br = ctx.branchIndex(branches[0]);
  const [a, b] = nodes;
  ctx.addA(a, br, 1);
  ctx.addA(b, br, -1);
  ctx.addA(br, a, 1);
  ctx.addA(br, b, -1);
  ctx.addB(br, value);
}

const vdcModel: DeviceModel = {
  branches: 1,
  stamp(ctx, params, nodes, branches) {
    stampVoltageSource(ctx, nodes, branches, params.V as number);
  },
  outputs(sol, params, _nodes, branches) {
    const i = sol.branch(branches[0]);
    return { pinCurrents: [i, -i], data: { v: params.V as number, i } };
  },
};

export const vdcDef: ComponentDef = {
  type: 'vdc',
  name: 'Sorgente DC',
  category: 'sorgenti',
  description: 'Impone una tensione costante tra i suoi terminali, qualunque sia la corrente richiesta.',
  pins: [
    { x: -40, y: 0, name: '+' },
    { x: 40, y: 0, name: '−' },
  ],
  params: [{ key: 'V', label: 'Tensione', unit: 'V', kind: 'number', min: -100, max: 100 }],
  defaults: { V: 9 },
  model: vdcModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -18, y2: 0 },
    { kind: 'circle', cx: 0, cy: 0, r: 18 },
    { kind: 'line', x1: -12, y1: 0, x2: -4, y2: 0 },
    { kind: 'line', x1: -8, y1: -4, x2: -8, y2: 4 },
    { kind: 'line', x1: 4, y1: 0, x2: 12, y2: 0 },
    { kind: 'line', x1: 18, y1: 0, x2: 40, y2: 0 },
  ],
};

function sineValue(params: Params, t: number): number {
  const amp = params.amp as number;
  const freq = params.freq as number;
  const offset = params.offset as number;
  return offset + amp * Math.sin(2 * Math.PI * freq * t);
}

const vsinModel: DeviceModel = {
  branches: 1,
  stamp(ctx, params, nodes, branches) {
    stampVoltageSource(ctx, nodes, branches, sineValue(params, ctx.time));
  },
  outputs(sol, params, _nodes, branches) {
    const i = sol.branch(branches[0]);
    return { pinCurrents: [i, -i], data: { v: sineValue(params, sol.time), i } };
  },
};

const sineFormula: FormulaDef = {
  id: 'vsin',
  title: 'Tensione sinusoidale',
  steps: [
    {
      latex:
        '\\htmlClass{fx-v}{v(t)} = \\htmlClass{fx-off}{V_0} + \\htmlClass{fx-amp}{A}\\,\\sin\\!\\big(2\\pi \\htmlClass{fx-f}{f}\\,\\htmlClass{fx-t}{t}\\big)',
    },
  ],
  terms: [
    { term: 'v', label: 'v(t)', unit: 'V', target: { kind: 'componentData', component: SELF, key: 'v' }, highlight: { kind: 'component', id: SELF } },
    { term: 'off', label: 'V₀', unit: 'V', target: { kind: 'param', component: SELF, param: 'offset' }, highlight: { kind: 'component', id: SELF } },
    { term: 'amp', label: 'A', unit: 'V', target: { kind: 'param', component: SELF, param: 'amp' }, highlight: { kind: 'component', id: SELF } },
    { term: 'f', label: 'f', unit: 'Hz', target: { kind: 'param', component: SELF, param: 'freq' }, highlight: { kind: 'component', id: SELF } },
    { term: 't', label: 't', unit: 's', target: { kind: 'time' } },
  ],
};

export const vsinDef: ComponentDef = {
  type: 'vsin',
  name: 'Sorgente sinusoidale',
  category: 'sorgenti',
  description: 'Tensione alternata v(t) = V₀ + A·sin(2πft): l’ingresso tipico di raddrizzatori e filtri.',
  pins: [
    { x: -40, y: 0, name: '+' },
    { x: 40, y: 0, name: '−' },
  ],
  params: [
    { key: 'amp', label: 'Ampiezza', unit: 'V', kind: 'number', min: 0, max: 100 },
    { key: 'freq', label: 'Frequenza', unit: 'Hz', kind: 'number', min: 0.1, max: 1e6, log: true },
    { key: 'offset', label: 'Offset', unit: 'V', kind: 'number', min: -50, max: 50 },
  ],
  defaults: { amp: 5, freq: 50, offset: 0 },
  model: vsinModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -18, y2: 0 },
    { kind: 'circle', cx: 0, cy: 0, r: 18 },
    { kind: 'path', d: 'M -10 0 Q -5 -10 0 0 Q 5 10 10 0' },
    { kind: 'line', x1: 18, y1: 0, x2: 40, y2: 0 },
  ],
  formulas: [sineFormula],
};

const idcModel: DeviceModel = {
  stamp(ctx, params, nodes) {
    const i = params.I as number;
    // la corrente esce dal pin + ed entra nel nodo collegato
    ctx.addCurrent(nodes[0], i);
    ctx.addCurrent(nodes[1], -i);
  },
  outputs(sol, params, nodes) {
    const i = params.I as number;
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    return { pinCurrents: [-i, i], data: { v, i } };
  },
};

export const idcDef: ComponentDef = {
  type: 'idc',
  name: 'Sorgente di corrente DC',
  category: 'sorgenti',
  description: 'Impone una corrente costante, qualunque sia la tensione necessaria a sostenerla.',
  pins: [
    { x: -40, y: 0, name: '+' },
    { x: 40, y: 0, name: '−' },
  ],
  params: [{ key: 'I', label: 'Corrente', unit: 'A', kind: 'number', min: -10, max: 10 }],
  defaults: { I: 0.01 },
  model: idcModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -18, y2: 0 },
    { kind: 'circle', cx: 0, cy: 0, r: 18 },
    { kind: 'line', x1: 10, y1: 0, x2: -6, y2: 0 },
    { kind: 'polygon', points: '-10,0 -4,-5 -4,5', fill: 'currentColor' },
    { kind: 'line', x1: 18, y1: 0, x2: 40, y2: 0 },
  ],
};
