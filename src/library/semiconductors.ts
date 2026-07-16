// Semiconduttori: diodo (Shockley + Newton-Raphson con limiting), LED
// (diodo con indicatore luminoso legato alla corrente reale), BJT NPN con
// modello Ebers-Moll (formulazione di trasporto).

import type { ComponentDef, SymbolPrimitive } from '../model/registry.ts';
import type { DeviceModel } from '../model/device.ts';
import { SELF, type FormulaDef } from '../math/formula.ts';
import { VT, evalJunction, limitedJunctionVoltage, shockleyCurrent, vcritOf } from './junction.ts';

function makeDiodeModel(Is: number, n: number): DeviceModel {
  const nVt = n * VT;
  const vcrit = vcritOf(Is, nVt);
  return {
    nonlinear: true,
    stamp(ctx, _params, nodes) {
      const [a, k] = nodes;
      const vd = limitedJunctionVoltage(ctx, a, k, nVt, vcrit);
      const { id, gd } = evalJunction(vd, Is, nVt);
      const ieq = id - gd * vd;
      ctx.addG(a, k, gd + ctx.gmin);
      ctx.addCurrent(a, -ieq);
      ctx.addCurrent(k, ieq);
    },
    outputs(sol, _params, nodes) {
      const vd = sol.v(nodes[0]) - sol.v(nodes[1]);
      const id = shockleyCurrent(vd, Is, nVt);
      return { pinCurrents: [id, -id], data: { v: vd, i: id, vd, id, is: Is, n } };
    },
  };
}

function shockleyFormula(): FormulaDef {
  return {
    id: 'shockley',
    title: 'Equazione di Shockley',
    description:
      'La corrente cresce esponenzialmente con la tensione di giunzione: per questo il diodo "si accende" oltre la tensione di soglia e serve sempre qualcosa che limiti la corrente.',
    steps: [
      {
        latex:
          '\\htmlClass{fx-id}{I_D} = \\htmlClass{fx-is}{I_S}\\left(e^{\\htmlClass{fx-vd}{V_D}/(\\htmlClass{fx-n}{n}\\,\\htmlClass{fx-vt}{V_T})} - 1\\right)',
      },
      {
        latex: 'V_T = \\frac{kT}{q} \\approx 25{,}85\\,\\mathrm{mV}',
        note: 'tensione termica a temperatura ambiente',
      },
    ],
    terms: [
      { term: 'id', label: 'I_D', unit: 'A', target: { kind: 'componentData', component: SELF, key: 'id' }, highlight: { kind: 'component', id: SELF } },
      { term: 'vd', label: 'V_D', unit: 'V', target: { kind: 'componentData', component: SELF, key: 'vd' }, highlight: { kind: 'component', id: SELF } },
      { term: 'is', label: 'I_S', unit: 'A', target: { kind: 'componentData', component: SELF, key: 'is' } },
      { term: 'n', label: 'n', unit: '', target: { kind: 'componentData', component: SELF, key: 'n' } },
      { term: 'vt', label: 'V_T', unit: 'V', target: { kind: 'derived', expr: { op: 'const', value: VT } } },
    ],
  };
}

const diodeSymbol: SymbolPrimitive[] = [
  { kind: 'line', x1: -40, y1: 0, x2: -10, y2: 0 },
  { kind: 'polygon', points: '-10,-10 -10,10 10,0', fill: 'currentColor' },
  { kind: 'line', x1: 10, y1: -10, x2: 10, y2: 10 },
  { kind: 'line', x1: 10, y1: 0, x2: 40, y2: 0 },
];

export const diodeDef: ComponentDef = {
  type: 'diode',
  name: 'Diodo',
  category: 'semiconduttori',
  description:
    'Lascia passare la corrente in un solo verso (anodo → catodo), con una caduta di ~0,7 V. È il mattone di raddrizzatori e circuiti di clipping.',
  pins: [
    { x: -40, y: 0, name: 'anodo' },
    { x: 40, y: 0, name: 'catodo' },
  ],
  params: [],
  defaults: {},
  model: makeDiodeModel(2.52e-9, 1.752), // parametri tipo 1N4148
  symbol: () => diodeSymbol,
  symbol3d: 'diode-junction',
  formulas: [shockleyFormula()],
};

export const LED_MAX_CURRENT = 0.02;

export const ledDef: ComponentDef = {
  type: 'led',
  name: 'LED',
  category: 'semiconduttori',
  description:
    'Diodo che emette luce: l’intensità cresce con la corrente reale. Oltre ~20 mA si danneggia — per questo serve la resistenza di limitazione.',
  pins: [
    { x: -40, y: 0, name: 'anodo' },
    { x: 40, y: 0, name: 'catodo' },
  ],
  params: [
    {
      key: 'color',
      label: 'Colore',
      unit: '',
      kind: 'select',
      options: [
        { value: '#ff3b30', label: 'Rosso' },
        { value: '#34c759', label: 'Verde' },
        { value: '#0a84ff', label: 'Blu' },
        { value: '#ffd60a', label: 'Giallo' },
        { value: '#ff9f0a', label: 'Arancione' },
        { value: '#ffffff', label: 'Bianco' },
      ],
    },
  ],
  defaults: { color: '#ff3b30' },
  model: makeDiodeModel(1.5e-19, 2), // LED rosso: ~2 V a 10 mA
  symbol: (p) => {
    const c = String(p.color ?? '#ff3b30');
    return [
      { kind: 'line', x1: -40, y1: 0, x2: -10, y2: 0 },
      { kind: 'polygon', points: '-10,-10 -10,10 10,0', fill: c }, // corpo del LED nel suo colore
      { kind: 'line', x1: 10, y1: -10, x2: 10, y2: 10 },
      { kind: 'line', x1: 10, y1: 0, x2: 40, y2: 0 },
      { kind: 'line', x1: 2, y1: -12, x2: 10, y2: -20 },
      { kind: 'polygon', points: '10,-20 4,-18 8,-14', fill: 'currentColor' },
      { kind: 'line', x1: 9, y1: -8, x2: 17, y2: -16 },
      { kind: 'polygon', points: '17,-16 11,-14 15,-10', fill: 'currentColor' },
    ];
  },
  symbol3d: 'led-junction',
  formulas: [shockleyFormula()],
  maxCurrent: LED_MAX_CURRENT,
};

// --- BJT NPN, Ebers-Moll (trasporto) ---------------------------------------
// pin 0 = base, pin 1 = collettore, pin 2 = emettitore.

const BJT_IS = 1e-14;
const BJT_BR = 1;

const bjtModel: DeviceModel = {
  nonlinear: true,
  stamp(ctx, params, nodes) {
    const bf = params.beta as number;
    const [nb, nc, ne] = nodes;
    const vcrit = vcritOf(BJT_IS, VT);
    const vbe = limitedJunctionVoltage(ctx, nb, ne, VT, vcrit);
    const vbc = limitedJunctionVoltage(ctx, nb, nc, VT, vcrit);

    const f = evalJunction(vbe, BJT_IS, VT); // giunzione B-E
    const r = evalJunction(vbc, BJT_IS, VT); // giunzione B-C
    const ibe = f.id / bf;
    const gbe = f.gd / bf;
    const ibc = r.id / BJT_BR;
    const gbc = r.gd / BJT_BR;
    const it = f.id - r.id; // corrente di trasporto C→E
    const gitf = f.gd;
    const gitr = r.gd;

    // Correnti ENTRANTI nel dispositivo per terminale, con derivate rispetto
    // a vbe e vbc. Linearizzazione: I ≈ I0 + gbe·(vbe−vbe0) + gbc·(vbc−vbc0).
    const stampTerminal = (node: number, i0: number, dVbe: number, dVbc: number) => {
      ctx.addA(node, nb, dVbe + dVbc);
      ctx.addA(node, ne, -dVbe);
      ctx.addA(node, nc, -dVbc);
      ctx.addB(node, dVbe * vbe + dVbc * vbc - i0);
    };
    stampTerminal(nb, ibe + ibc, gbe, gbc);
    stampTerminal(nc, it - ibc, gitf, -(gitr + gbc));
    stampTerminal(ne, -(ibe + ibc) - (it - ibc), -(gbe + gitf), gitr);

    // gmin sulle giunzioni: aiuta la continuazione
    ctx.addG(nb, ne, ctx.gmin);
    ctx.addG(nb, nc, ctx.gmin);
  },
  outputs(sol, params, nodes) {
    const bf = params.beta as number;
    const vbe = sol.v(nodes[0]) - sol.v(nodes[2]);
    const vbc = sol.v(nodes[0]) - sol.v(nodes[1]);
    const vce = sol.v(nodes[1]) - sol.v(nodes[2]);
    const icc = shockleyCurrent(vbe, BJT_IS, VT);
    const iec = shockleyCurrent(vbc, BJT_IS, VT);
    const ib = icc / bf + iec / BJT_BR;
    const ic = icc - iec - iec / BJT_BR;
    const ie = -(ib + ic);
    return { pinCurrents: [ib, ic, ie], data: { vbe, vbc, vce, ib, ic, ie, beta: ib !== 0 ? ic / ib : 0 } };
  },
};

const bjtFormula: FormulaDef = {
  id: 'ebers-moll',
  title: 'Ebers-Moll (zona attiva)',
  description: 'In zona attiva il collettore amplifica la corrente di base di un fattore β.',
  steps: [
    {
      latex:
        '\\htmlClass{fx-ic}{I_C} \\approx \\htmlClass{fx-beta}{\\beta_F}\\,\\htmlClass{fx-ib}{I_B}',
      note: 'valida quando la giunzione B-C è polarizzata inversamente',
    },
    {
      latex:
        'I_C = I_S\\left(e^{\\htmlClass{fx-vbe}{V_{BE}}/V_T} - e^{V_{BC}/V_T}\\right) - \\frac{I_S}{\\beta_R}\\left(e^{V_{BC}/V_T}-1\\right)',
      note: 'modello di trasporto completo usato dal simulatore',
    },
  ],
  terms: [
    { term: 'ic', label: 'I_C', unit: 'A', target: { kind: 'componentData', component: SELF, key: 'ic' }, highlight: { kind: 'component', id: SELF } },
    { term: 'ib', label: 'I_B', unit: 'A', target: { kind: 'componentData', component: SELF, key: 'ib' }, highlight: { kind: 'component', id: SELF } },
    { term: 'beta', label: 'β_F', unit: '', target: { kind: 'param', component: SELF, param: 'beta' } },
    { term: 'vbe', label: 'V_BE', unit: 'V', target: { kind: 'componentData', component: SELF, key: 'vbe' }, highlight: { kind: 'component', id: SELF } },
  ],
};

export const bjtDef: ComponentDef = {
  type: 'npn',
  name: 'Transistor NPN',
  category: 'semiconduttori',
  description:
    'Amplificatore di corrente: una piccola corrente di base controlla una corrente di collettore β volte più grande (Ebers-Moll).',
  pins: [
    { x: -40, y: 0, name: 'base' },
    { x: 20, y: -40, name: 'collettore' },
    { x: 20, y: 40, name: 'emettitore' },
  ],
  params: [{ key: 'beta', label: 'β_F', unit: '', kind: 'number', min: 10, max: 1000 }],
  defaults: { beta: 100 },
  model: bjtModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -8, y2: 0 },
    { kind: 'line', x1: -8, y1: -16, x2: -8, y2: 16, width: 3 },
    { kind: 'line', x1: -8, y1: -8, x2: 20, y2: -22 },
    { kind: 'line', x1: 20, y1: -22, x2: 20, y2: -40 },
    { kind: 'line', x1: -8, y1: 8, x2: 20, y2: 22 },
    { kind: 'line', x1: 20, y1: 22, x2: 20, y2: 40 },
    { kind: 'polygon', points: '20,22 8,10 13,20', fill: 'currentColor' },
    { kind: 'circle', cx: 2, cy: 0, r: 26 },
  ],
  symbol3d: 'bjt-junctions',
  formulas: [bjtFormula],
};
