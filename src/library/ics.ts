// Circuiti integrati (comportamentali): timer 555, comparatore, regolatore di
// tensione. Come l'op-amp e il flip-flop, sono device stateful che leggono le
// tensioni di nodo e pilotano le uscite — nessuna modifica al motore.

import type { ComponentDef } from '../model/registry.ts';
import type { DeviceModel, DeviceState } from '../model/device.ts';

// ───────────────────────────── Timer 555 ─────────────────────────────
// Latch SR interno (state.q): THRES > ⅔Vcc resetta, TRIG < ⅓Vcc setta.
// OUT segue VCC (q=1) o GND (q=0); DISCH va a massa quando q=0.

const ne555Model: DeviceModel = {
  branches: 1,
  initState: (): DeviceState => ({ q: 0 }),
  stamp(ctx, _params, nodes, branches, state) {
    const [VCC, GND, , , DISCH, OUT, RESET] = nodes;
    const br = ctx.branchIndex(branches[0]);
    const rail = state.q > 0.5 ? VCC : GND;
    // OUT = rail (sorgente di tensione OUT↔rail a 0 V)
    ctx.addA(OUT, br, 1);
    ctx.addA(rail, br, -1);
    ctx.addA(br, OUT, 1);
    ctx.addA(br, rail, -1);
    ctx.addB(br, 0);
    if (state.q < 0.5) ctx.addG(DISCH, GND, 1 / 10); // transistor di scarica ~10 Ω
    ctx.addG(RESET, VCC, 1e-6); // pull-up debole: RESET scollegato resta alto
  },
  outputs(sol, _params, nodes, branches, state) {
    const pinCurrents = new Array(nodes.length).fill(0);
    pinCurrents[5] = sol.branch(branches[0]);
    return { pinCurrents, data: { out: state.q > 0.5 ? 1 : 0, vcc: sol.v(nodes[0]) - sol.v(nodes[1]) } };
  },
  nextState(sol, _params, nodes, _branches, state): DeviceState {
    const [VCC, GND, TRIG, THRES, , , RESET] = nodes;
    const vcc = sol.v(VCC) - sol.v(GND);
    let q = state.q;
    if (vcc < 0.1) q = 0;
    else if (sol.v(RESET) - sol.v(GND) < 0.3 * vcc) q = 0;
    else if (sol.v(THRES) - sol.v(GND) > (2 / 3) * vcc) q = 0;
    else if (sol.v(TRIG) - sol.v(GND) < (1 / 3) * vcc) q = 1;
    return { q };
  },
};

export const ne555Def: ComponentDef = {
  type: 'ne555',
  name: 'Timer 555',
  category: 'circuiti integrati',
  description: 'Il timer per eccellenza. Con R e C ai piedini THR/TRG/DIS costruisci oscillatori (astabile) e temporizzatori (monostabile). RESET scollegato = attivo.',
  pins: [
    { x: 0, y: -40, name: 'VCC' },
    { x: 0, y: 40, name: 'GND' },
    { x: -40, y: -20, name: 'TRG' },
    { x: -40, y: 0, name: 'THR' },
    { x: 40, y: 10, name: 'DIS' },
    { x: 40, y: -10, name: 'OUT' },
    { x: -40, y: 20, name: 'RST' },
  ],
  params: [],
  defaults: {},
  model: ne555Model,
  symbol: () => [
    { kind: 'path', d: 'M -30 -34 L 30 -34 L 30 34 L -30 34 Z', fill: 'none' },
    { kind: 'text', x: -12, y: 5, text: '555', size: 14 },
  ],
};

// ───────────────────────────── Comparatore ─────────────────────────────
// Alto guadagno saturante (VCVS non lineare), uscita 0..vhigh riferita a massa,
// con isteresi opzionale (Schmitt) tramite lo stato.

const COMP_BAND = 0.1; // larghezza della transizione (V)

function comparatorModel(): DeviceModel {
  return {
    branches: 1,
    nonlinear: true,
    initState: (): DeviceState => ({ out: 0 }),
    stamp(ctx, params, nodes, branches, state) {
      const vhigh = (params.vhigh as number) ?? 5;
      const hyst = (params.hyst as number) ?? 0;
      const [inp, inn, out] = nodes;
      const br = ctx.branchIndex(branches[0]);
      const center = state.out > 0.5 ? -hyst : hyst; // isteresi
      const diff = ctx.vNow(inp) - ctx.vNow(inn);
      const x = (diff - center) / COMP_BAND + 0.5;
      const s = x <= 0 ? 0 : x >= 1 ? 1 : x;
      const ds = x <= 0 || x >= 1 ? 0 : 1 / COMP_BAND;
      const target = vhigh * s;
      const m = vhigh * ds; // ∂target/∂diff
      ctx.addA(br, out, 1);
      ctx.addA(br, inp, -m);
      ctx.addA(br, inn, m);
      ctx.addB(br, target - m * (ctx.vNow(inp) - ctx.vNow(inn)));
      ctx.addA(out, br, 1);
      ctx.addG(out, -1, 1e-6);
    },
    outputs(sol, params, nodes, branches) {
      const vhigh = (params.vhigh as number) ?? 5;
      const vout = sol.v(nodes[2]);
      return {
        pinCurrents: [0, 0, sol.branch(branches[0])],
        data: { out: vout > vhigh / 2 ? 1 : 0, vout, diff: sol.v(nodes[0]) - sol.v(nodes[1]) },
      };
    },
    nextState(sol, params, nodes): DeviceState {
      const vhigh = (params.vhigh as number) ?? 5;
      return { out: sol.v(nodes[2]) > vhigh / 2 ? 1 : 0 };
    },
  };
}

export const comparatorDef: ComponentDef = {
  type: 'comparator',
  name: 'Comparatore',
  category: 'circuiti integrati',
  description: 'Uscita alta se V(+) > V(−), bassa altrimenti. Con isteresi diventa un trigger di Schmitt. Ideale per sogliare i sensori.',
  pins: [
    { x: -40, y: -16, name: '+' },
    { x: -40, y: 16, name: '−' },
    { x: 40, y: 0, name: 'out' },
  ],
  params: [
    { key: 'vhigh', label: 'Uscita alta', unit: 'V', kind: 'number', min: 1, max: 24 },
    { key: 'hyst', label: 'Isteresi', unit: 'V', kind: 'number', min: 0, max: 5 },
  ],
  defaults: { vhigh: 5, hyst: 0 },
  model: comparatorModel(),
  symbol: () => [
    { kind: 'line', x1: -40, y1: -16, x2: -30, y2: -16 },
    { kind: 'line', x1: -40, y1: 16, x2: -30, y2: 16 },
    { kind: 'polygon', points: '-30,-26 -30,26 30,0', fill: 'none' },
    { kind: 'text', x: -26, y: -8, text: '+', size: 12 },
    { kind: 'text', x: -26, y: 20, text: '−', size: 12 },
    { kind: 'line', x1: 30, y1: 0, x2: 40, y2: 0 },
  ],
};

// ─────────────────────────── Regolatore di tensione ───────────────────────────
// 78xx-style: elemento di passaggio serie IN→OUT che regola V(OUT) a `vout`
// finché V(IN) ha margine (dropout); altrimenti l'uscita segue V(IN) − dropout.

const regulatorModel: DeviceModel = {
  branches: 1,
  nonlinear: true,
  stamp(ctx, params, nodes, branches) {
    const vout = (params.vout as number) ?? 5;
    const dropout = (params.dropout as number) ?? 2;
    const [IN, OUT, GND] = nodes;
    const headroom = ctx.vNow(IN) - ctx.vNow(GND) - dropout;
    const vreg = Math.min(vout, Math.max(0, headroom));
    const br = ctx.branchIndex(branches[0]);
    // corrente serie IN→OUT; V(OUT) − V(GND) = vreg
    ctx.addA(OUT, br, 1);
    ctx.addA(IN, br, -1);
    ctx.addA(br, OUT, 1);
    ctx.addA(br, GND, -1);
    ctx.addB(br, vreg);
  },
  outputs(sol, params, nodes, branches) {
    const vout = (params.vout as number) ?? 5;
    const i = sol.branch(branches[0]);
    const v = sol.v(nodes[1]) - sol.v(nodes[2]);
    return {
      pinCurrents: [i, -i, 0],
      data: { v, vin: sol.v(nodes[0]) - sol.v(nodes[2]), i, inRegulation: v > vout - 0.1 ? 1 : 0 },
    };
  },
};

export const regulatorDef: ComponentDef = {
  type: 'vreg',
  name: 'Regolatore di tensione',
  category: 'circuiti integrati',
  description: 'Tiene l’uscita a una tensione fissa (es. 5 V) finché l’ingresso è abbastanza alto (dropout). La base di ogni alimentatore.',
  pins: [
    { x: -40, y: 0, name: 'IN' },
    { x: 40, y: 0, name: 'OUT' },
    { x: 0, y: 40, name: 'GND' },
  ],
  params: [
    { key: 'vout', label: 'Uscita', unit: 'V', kind: 'number', min: 1, max: 24 },
    { key: 'dropout', label: 'Dropout', unit: 'V', kind: 'number', min: 0, max: 5 },
  ],
  defaults: { vout: 5, dropout: 2 },
  model: regulatorModel,
  symbol: () => [
    { kind: 'path', d: 'M -28 -22 L 28 -22 L 28 22 L -28 22 Z', fill: 'none' },
    { kind: 'text', x: -20, y: 5, text: 'REG', size: 12 },
    { kind: 'line', x1: -40, y1: 0, x2: -28, y2: 0 },
    { kind: 'line', x1: 28, y1: 0, x2: 40, y2: 0 },
    { kind: 'line', x1: 0, y1: 22, x2: 0, y2: 40 },
  ],
};

export const icDefs: ComponentDef[] = [ne555Def, comparatorDef, regulatorDef];
