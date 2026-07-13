// Passivi: resistore (stamp lineare), condensatore e induttore (companion
// model backward Euler). Voci di registro complete: metadati + simbolo + stamp.

import type { ComponentDef } from '../model/registry.ts';
import type { DeviceModel } from '../model/device.ts';
import { SELF, type FormulaDef } from '../math/formula.ts';

const resistorModel: DeviceModel = {
  stamp(ctx, params, nodes) {
    const g = 1 / Math.max(params.R as number, 1e-9);
    ctx.addG(nodes[0], nodes[1], g);
  },
  outputs(sol, params, nodes) {
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    const i = v / Math.max(params.R as number, 1e-9);
    return { pinCurrents: [i, -i], data: { v, i, p: v * i } };
  },
};

const ohmFormula: FormulaDef = {
  id: 'ohm',
  title: 'Legge di Ohm',
  description: 'La corrente in un resistore è proporzionale alla tensione ai suoi capi.',
  steps: [
    { latex: 'V = R\\,I', note: 'forma canonica' },
    {
      latex: '\\htmlClass{fx-i}{I} = \\frac{\\htmlClass{fx-v}{V}}{\\htmlClass{fx-r}{R}}',
      note: 'risolta per la corrente, con i valori vivi del circuito',
    },
  ],
  terms: [
    { term: 'i', label: 'I', unit: 'A', target: { kind: 'componentData', component: SELF, key: 'i' }, highlight: { kind: 'component', id: SELF } },
    { term: 'v', label: 'V', unit: 'V', target: { kind: 'componentData', component: SELF, key: 'v' }, highlight: { kind: 'component', id: SELF } },
    { term: 'r', label: 'R', unit: 'Ω', target: { kind: 'param', component: SELF, param: 'R' }, highlight: { kind: 'component', id: SELF } },
  ],
};

export const resistorDef: ComponentDef = {
  type: 'resistor',
  name: 'Resistore',
  category: 'passivi',
  description:
    'Limita e ripartisce la corrente convertendo energia in calore. La legge di Ohm V = R·I ne descrive completamente il comportamento.',
  pins: [
    { x: -40, y: 0, name: 'a' },
    { x: 40, y: 0, name: 'b' },
  ],
  params: [{ key: 'R', label: 'Resistenza', unit: 'Ω', kind: 'number', min: 1, max: 1e7, log: true }],
  defaults: { R: 1000 },
  model: resistorModel,
  symbol: () => [
    { kind: 'path', d: 'M -40 0 H -24 L -18 -9 L -6 9 L 6 -9 L 18 9 L 24 0 H 40' },
  ],
  symbol3d: 'resistor-internals',
  formulas: [ohmFormula],
};

const capacitorModel: DeviceModel = {
  initState: () => ({ v: 0 }),
  stamp(ctx, params, nodes, _branches, state) {
    if (ctx.dt === null) return; // in DC il condensatore è un circuito aperto
    const g = (params.C as number) / ctx.dt;
    ctx.addG(nodes[0], nodes[1], g);
    ctx.addCurrent(nodes[0], g * state.v);
    ctx.addCurrent(nodes[1], -g * state.v);
  },
  outputs(sol, params, nodes, _branches, state) {
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    const i = sol.dt === null ? 0 : ((params.C as number) / sol.dt) * (v - state.v);
    return { pinCurrents: [i, -i], data: { v, i } };
  },
  nextState(sol, _params, nodes) {
    return { v: sol.v(nodes[0]) - sol.v(nodes[1]) };
  },
};

const capFormula: FormulaDef = {
  id: 'cap-iv',
  title: 'Relazione corrente–tensione del condensatore',
  description: 'La corrente è proporzionale alla velocità con cui varia la tensione: a regime DC non passa corrente.',
  steps: [
    {
      latex: '\\htmlClass{fx-i}{i(t)} = \\htmlClass{fx-c}{C}\\,\\frac{d\\htmlClass{fx-v}{v}}{dt}',
    },
  ],
  terms: [
    { term: 'i', label: 'i(t)', unit: 'A', target: { kind: 'componentData', component: SELF, key: 'i' }, highlight: { kind: 'component', id: SELF } },
    { term: 'c', label: 'C', unit: 'F', target: { kind: 'param', component: SELF, param: 'C' }, highlight: { kind: 'component', id: SELF } },
    { term: 'v', label: 'v(t)', unit: 'V', target: { kind: 'componentData', component: SELF, key: 'v' }, highlight: { kind: 'component', id: SELF } },
  ],
};

export const capacitorDef: ComponentDef = {
  type: 'capacitor',
  name: 'Condensatore',
  category: 'passivi',
  description:
    'Accumula carica: si oppone alle variazioni di tensione. Con un resistore forma la costante di tempo τ = RC; livella le ondulazioni.',
  pins: [
    { x: -40, y: 0, name: 'a' },
    { x: 40, y: 0, name: 'b' },
  ],
  params: [{ key: 'C', label: 'Capacità', unit: 'F', kind: 'number', min: 1e-12, max: 1, log: true }],
  defaults: { C: 100e-6 },
  model: capacitorModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -6, y2: 0 },
    { kind: 'line', x1: -6, y1: -14, x2: -6, y2: 14 },
    { kind: 'line', x1: 6, y1: -14, x2: 6, y2: 14 },
    { kind: 'line', x1: 6, y1: 0, x2: 40, y2: 0 },
  ],
  symbol3d: 'capacitor-internals',
  formulas: [capFormula],
};

const inductorModel: DeviceModel = {
  branches: 1,
  initState: () => ({ i: 0 }),
  stamp(ctx, params, nodes, branches, state) {
    const br = ctx.branchIndex(branches[0]);
    const [a, b] = nodes;
    ctx.addA(a, br, 1);
    ctx.addA(b, br, -1);
    ctx.addA(br, a, 1);
    ctx.addA(br, b, -1);
    if (ctx.dt !== null) {
      const lOverDt = (params.L as number) / ctx.dt;
      ctx.addA(br, br, -lOverDt);
      ctx.addB(br, -lOverDt * state.i);
    }
    // in DC: v(a) - v(b) = 0 (cortocircuito ideale)
  },
  outputs(sol, _params, nodes, branches) {
    const i = sol.branch(branches[0]);
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    return { pinCurrents: [i, -i], data: { v, i } };
  },
  nextState(sol, _params, _nodes, branches) {
    return { i: sol.branch(branches[0]) };
  },
};

const indFormula: FormulaDef = {
  id: 'ind-iv',
  title: 'Relazione tensione–corrente dell’induttore',
  steps: [
    {
      latex: '\\htmlClass{fx-v}{v(t)} = \\htmlClass{fx-l}{L}\\,\\frac{d\\htmlClass{fx-i}{i}}{dt}',
    },
  ],
  terms: [
    { term: 'v', label: 'v(t)', unit: 'V', target: { kind: 'componentData', component: SELF, key: 'v' }, highlight: { kind: 'component', id: SELF } },
    { term: 'l', label: 'L', unit: 'H', target: { kind: 'param', component: SELF, param: 'L' }, highlight: { kind: 'component', id: SELF } },
    { term: 'i', label: 'i(t)', unit: 'A', target: { kind: 'componentData', component: SELF, key: 'i' }, highlight: { kind: 'component', id: SELF } },
  ],
};

export const inductorDef: ComponentDef = {
  type: 'inductor',
  name: 'Induttore',
  category: 'passivi',
  description:
    'Accumula energia nel campo magnetico: si oppone alle variazioni di corrente. In DC è un cortocircuito ideale.',
  pins: [
    { x: -40, y: 0, name: 'a' },
    { x: 40, y: 0, name: 'b' },
  ],
  params: [{ key: 'L', label: 'Induttanza', unit: 'H', kind: 'number', min: 1e-9, max: 100, log: true }],
  defaults: { L: 0.1 },
  model: inductorModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -30, y2: 0 },
    {
      kind: 'path',
      d: 'M -30 0 A 7.5 7.5 0 0 1 -15 0 A 7.5 7.5 0 0 1 0 0 A 7.5 7.5 0 0 1 15 0 A 7.5 7.5 0 0 1 30 0',
    },
    { kind: 'line', x1: 30, y1: 0, x2: 40, y2: 0 },
  ],
  symbol3d: 'inductor-internals',
  formulas: [indFormula],
};
