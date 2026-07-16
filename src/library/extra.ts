// Componenti Extra aggiunti alla libreria: Amplificatore Operazionale,
// Diodo Zener, Potenziometro, Fotoresistenza LDR, Termistori (NTC/PTC),
// Sensore di Pressione, Sensore Hall, Sensore Umidità, NMOS, PMOS, PNP,
// Diodo Schottky, Relè SPDT, Fusibile, Ponte di Graetz e Trasformatore Ideale.

import type { ComponentDef } from '../model/registry.ts';
import type { DeviceModel } from '../model/device.ts';
import { VT, evalJunction, limitedJunctionVoltage, shockleyCurrent, vcritOf } from './junction.ts';
import { useStudio } from '../store/studio.ts';

// ----------------------------------------------------------- UTILS
function getEnv() {
  return useStudio.getState().environment;
}

// ----------------------------------------------------------- OP-AMP (Amplificatore Operazionale)
const opampModel: DeviceModel = {
  branches: 1,
  stamp(ctx, params, nodes, branches) {
    const br = ctx.branchIndex(branches[0]);
    const [vp, vn, vout] = nodes;
    const aol = params.Aol as number;
    ctx.addA(br, vout, 1);
    ctx.addA(br, vp, -aol);
    ctx.addA(br, vn, aol);
    ctx.addA(vout, br, 1);
    ctx.addG(vout, -1, 1e-2); // piccola conduttanza per stabilità d'uscita
  },
  outputs(sol, params, nodes, branches) {
    const vp = sol.v(nodes[0]);
    const vn = sol.v(nodes[1]);
    const vout = sol.v(nodes[2]);
    const i = sol.branch(branches[0]);
    return {
      pinCurrents: [0, 0, i],
      data: { v: vout, i, diff: vp - vn, vp, vn, gain: params.Aol as number },
    };
  },
};

export const opampDef: ComponentDef = {
  type: 'opamp',
  name: 'Op-Amp Ideale',
  category: 'semiconduttori',
  description: 'Amplificatore operazionale ideale. Guadagno open-loop elevatissimo.',
  pins: [
    { x: -40, y: -20, name: '+' },
    { x: -40, y: 20, name: '−' },
    { x: 40, y: 0, name: 'out' },
  ],
  params: [
    { key: 'Aol', label: 'Guadagno Open Loop', unit: '', kind: 'number', min: 10, max: 1e6, log: true },
    { key: 'Vsat', label: 'Tensione Sat.', unit: 'V', kind: 'number', min: 1, max: 24 },
  ],
  defaults: { Aol: 100000, Vsat: 15 },
  model: opampModel,
  symbol: () => [
    { kind: 'polygon', points: '-20,-30 -20,30 20,0', fill: 'none' },
    { kind: 'line', x1: -40, y1: -20, x2: -20, y2: -20 },
    { kind: 'line', x1: -40, y1: 20, x2: -20, y2: 20 },
    { kind: 'line', x1: 20, y1: 0, x2: 40, y2: 0 },
    { kind: 'text', x: -16, y: -16, text: '+', size: 12 },
    { kind: 'text', x: -16, y: 24, text: '−', size: 12 },
  ],
};

// ----------------------------------------------------------- DIODO ZENER
const zenerModel = makeZenerModel(2.5e-9, 1.75);
function makeZenerModel(Is: number, n: number): DeviceModel {
  const nVt = n * VT;
  const vcrit = vcritOf(Is, nVt);
  return {
    nonlinear: true,
    stamp(ctx, params, nodes) {
      const [a, k] = nodes;
      const vz = (params.Vz as number) ?? 100; // Valore di sicurezza di 100V se non definito (Schottky)
      const vd = limitedJunctionVoltage(ctx, a, k, nVt, vcrit);
      const { id: id_f, gd: gd_f } = evalJunction(vd, Is, nVt);
      const { id: id_r, gd: gd_r } = evalJunction(-vd - vz, Is * 100, 0.05);
      const id = id_f - id_r;
      const gd = gd_f + gd_r;
      const ieq = id - gd * vd;
      ctx.addG(a, k, gd + ctx.gmin);
      ctx.addCurrent(a, -ieq);
      ctx.addCurrent(k, ieq);
    },
    outputs(sol, params, nodes) {
      const vd = sol.v(nodes[0]) - sol.v(nodes[1]);
      const vz = (params.Vz as number) ?? 100;
      const id_f = shockleyCurrent(vd, Is, nVt);
      const id_r = shockleyCurrent(-vd - vz, Is * 100, 0.05);
      const id = id_f - id_r;
      let stateStr = 'Interdetto (OFF)';
      if (vd > 0.6) stateStr = 'Conduzione Diretta (ON)';
      else if (vd < -vz + 0.1) stateStr = `Regolazione Zener (${vz}V)`;
      return { pinCurrents: [id, -id], data: { v: vd, i: id, state: stateStr, vz } };
    },
  };
}

export const zenerDef: ComponentDef = {
  type: 'zener',
  name: 'Diodo Zener',
  category: 'semiconduttori',
  description: 'Diodo progettato per regolare tensioni sfruttando il breakdown inverso Vz.',
  pins: [
    { x: -40, y: 0, name: 'anodo' },
    { x: 40, y: 0, name: 'catodo' },
  ],
  params: [{ key: 'Vz', label: 'Tensione Zener', unit: 'V', kind: 'number', min: 2, max: 24 }],
  defaults: { Vz: 5.1 },
  model: zenerModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -10, y2: 0 },
    { kind: 'polygon', points: '-10,-10 -10,10 10,0', fill: 'currentColor' },
    { kind: 'line', x1: 10, y1: -10, x2: 10, y2: 10 },
    { kind: 'line', x1: 10, y1: -10, x2: 6, y2: -12 },
    { kind: 'line', x1: 10, y1: 10, x2: 14, y2: 12 },
    { kind: 'line', x1: 10, y1: 0, x2: 40, y2: 0 },
  ],
};

// ----------------------------------------------------------- POTENZIOMETRO
const potentiometerModel: DeviceModel = {
  stamp(ctx, params, nodes) {
    const rTot = params.R as number;
    const w = params.wiper as number;
    const [na, nb, nw] = nodes;
    const rTop = Math.max(rTot * (1 - w), 1e-3);
    const rBot = Math.max(rTot * w, 1e-3);
    ctx.addG(na, nw, 1 / rTop);
    ctx.addG(nw, nb, 1 / rBot);
  },
  outputs(sol, params, nodes) {
    const rTot = params.R as number;
    const w = params.wiper as number;
    const [na, nb, nw] = nodes;
    const rTop = Math.max(rTot * (1 - w), 1e-3);
    const rBot = Math.max(rTot * w, 1e-3);
    const vTop = sol.v(na) - sol.v(nw);
    const vBot = sol.v(nw) - sol.v(nb);
    const iTop = vTop / rTop;
    const iBot = vBot / rBot;
    return {
      pinCurrents: [iTop, -iBot, iBot - iTop],
      data: { v: sol.v(na) - sol.v(nb), vWiper: sol.v(nw), rTop, rBot, wiper: w },
    };
  },
};

export const potentiometerDef: ComponentDef = {
  type: 'potentiometer',
  name: 'Potenziometro',
  category: 'passivi',
  description: 'Divisore resistivo regolabile a tre terminali.',
  pins: [
    { x: -40, y: -20, name: 'a' },
    { x: 40, y: -20, name: 'b' },
    { x: 0, y: 20, name: 'wiper' },
  ],
  params: [
    { key: 'R', label: 'Resistenza Tot.', unit: 'Ω', kind: 'number', min: 10, max: 1e6, log: true },
    { key: 'wiper', label: 'Cursore (Wiper)', unit: '', kind: 'number', min: 0.001, max: 0.999 },
  ],
  defaults: { R: 10000, wiper: 0.5 },
  model: potentiometerModel,
  symbol: (params) => {
    const w = params.wiper as number;
    return [
      { kind: 'line', x1: -40, y1: -20, x2: -24, y2: -20 },
      { kind: 'line', x1: 24, y1: -20, x2: 40, y2: -20 },
      { kind: 'line', x1: 0, y1: 20, x2: 0, y2: 6 },
      { kind: 'path', d: 'M -24 -20 L -18 -26 L -10 -14 L -2 -26 L 6 -14 L 14 -26 L 18 -14 L 24 -20' },
      { kind: 'line', x1: -16 + w * 32, y1: 6, x2: -16 + w * 32, y2: -12 },
      { kind: 'polygon', points: `${-16 + w * 32},-16 ${-20 + w * 32},-10 ${-12 + w * 32},-10`, fill: 'currentColor' },
    ];
  },
};

// ----------------------------------------------------------- LDR (Fotoresistenza reattiva a luce)
const ldrModel: DeviceModel = {
  stamp(ctx, params, nodes) {
    const rDark = params.R_dark as number;
    const light = getEnv().light; // Usa la luce globale dell'ambiente!
    const r = rDark / (1 + light * 15);
    ctx.addG(nodes[0], nodes[1], 1 / Math.max(r, 1e-9));
  },
  outputs(sol, params, nodes) {
    const rDark = params.R_dark as number;
    const light = getEnv().light;
    const r = rDark / (1 + light * 15);
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    const i = v / Math.max(r, 1e-9);
    return { pinCurrents: [i, -i], data: { v, i, r, light } };
  },
};

export const ldrDef: ComponentDef = {
  type: 'ldr',
  name: 'Fotoresistenza LDR',
  category: 'passivi',
  description: 'Sensore di luce. La sua resistenza scende al crescere dell\'illuminazione ambiente.',
  pins: [
    { x: -40, y: 0, name: 'a' },
    { x: 40, y: 0, name: 'b' },
  ],
  params: [{ key: 'R_dark', label: 'Resistenza Buio', unit: 'Ω', kind: 'number', min: 1000, max: 1e7, log: true }],
  defaults: { R_dark: 100000 },
  model: ldrModel,
  symbol: () => [
    { kind: 'path', d: 'M -40 0 H -24 L -18 -9 L -6 9 L 6 -9 L 18 9 L 24 0 H 40' },
    { kind: 'circle', cx: 0, cy: 0, r: 18, fill: 'none' },
    { kind: 'line', x1: -18, y1: -22, x2: -10, y2: -14 },
    { kind: 'polygon', points: '-10,-14 -15,-14 -12,-17', fill: 'currentColor' },
    { kind: 'line', x1: -24, y1: -16, x2: -16, y2: -8 },
    { kind: 'polygon', points: '-16,-8 -21,-8 -18,-11', fill: 'currentColor' },
  ],
};

// ----------------------------------------------------------- NTC (Termistore a coefficiente negativo)
const ntcModel: DeviceModel = {
  stamp(ctx, params, nodes) {
    const r25 = (params.R25 as number) ?? 10000;
    const b = (params.B as number) ?? 3950;
    const temp = getEnv().temperature; // Temperatura globale
    const tKelvin = temp + 273.15;
    const r = r25 * Math.exp(b * (1 / tKelvin - 1 / 298.15));
    ctx.addG(nodes[0], nodes[1], 1 / Math.max(r, 1e-9));
  },
  outputs(sol, params, nodes) {
    const r25 = (params.R25 as number) ?? 10000;
    const b = (params.B as number) ?? 3950;
    const temp = getEnv().temperature;
    const tKelvin = temp + 273.15;
    const r = r25 * Math.exp(b * (1 / tKelvin - 1 / 298.15));
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    const i = v / Math.max(r, 1e-9);
    return { pinCurrents: [i, -i], data: { v, i, r, temp } };
  },
};

export const ntcDef: ComponentDef = {
  type: 'ntc',
  name: 'Termistore NTC',
  category: 'passivi',
  description: 'Sensore di calore. La sua resistenza scende esponenzialmente all\'aumentare della temperatura.',
  pins: [
    { x: -40, y: 0, name: 'a' },
    { x: 40, y: 0, name: 'b' },
  ],
  params: [
    { key: 'R25', label: 'Resistenza a 25°C', unit: 'Ω', kind: 'number', min: 100, max: 1e6, log: true },
    { key: 'B', label: 'Parametro Beta', unit: 'K', kind: 'number', min: 1000, max: 6000 },
  ],
  defaults: { R25: 10000, B: 3950 },
  model: ntcModel,
  symbol: () => [
    { kind: 'path', d: 'M -40 0 H -24 L -18 -9 L -6 9 L 6 -9 L 18 9 L 24 0 H 40' },
    { kind: 'line', x1: -22, y1: 14, x2: 22, y2: -14, width: 2 },
    { kind: 'line', x1: -22, y1: 14, x2: -18, y2: 14, width: 2 },
    { kind: 'text', x: 8, y: -16, text: '-t°', size: 10 },
  ],
};

// ----------------------------------------------------------- PTC (Termistore a coefficiente positivo)
const ptcModel: DeviceModel = {
  stamp(ctx, params, nodes) {
    const r25 = (params.R25 as number) ?? 1000;
    const alpha = (params.alpha as number) ?? 0.0075;
    const temp = getEnv().temperature;
    const r = r25 * (1 + alpha * (temp - 25));
    ctx.addG(nodes[0], nodes[1], 1 / Math.max(r, 1e-3));
  },
  outputs(sol, params, nodes) {
    const r25 = (params.R25 as number) ?? 1000;
    const alpha = (params.alpha as number) ?? 0.0075;
    const temp = getEnv().temperature;
    const r = r25 * (1 + alpha * (temp - 25));
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    const i = v / Math.max(r, 1e-3);
    return { pinCurrents: [i, -i], data: { v, i, r, temp } };
  },
};

export const ptcDef: ComponentDef = {
  type: 'ptc',
  name: 'Termistore PTC',
  category: 'passivi',
  description: 'Sensore di calore. La sua resistenza sale linearmente all\'aumentare della temperatura.',
  pins: [
    { x: -40, y: 0, name: 'a' },
    { x: 40, y: 0, name: 'b' },
  ],
  params: [
    { key: 'R25', label: 'Resistenza a 25°C', unit: 'Ω', kind: 'number', min: 100, max: 1e6, log: true },
    { key: 'alpha', label: 'Coeff. Temp (α)', unit: '/°C', kind: 'number', min: 0.001, max: 0.1 },
  ],
  defaults: { R25: 1000, alpha: 0.0075 },
  model: ptcModel,
  symbol: () => [
    { kind: 'path', d: 'M -40 0 H -24 L -18 -9 L -6 9 L 6 -9 L 18 9 L 24 0 H 40' },
    { kind: 'line', x1: -22, y1: 14, x2: 22, y2: -14, width: 2 },
    { kind: 'line', x1: -22, y1: 14, x2: -18, y2: 14, width: 2 },
    { kind: 'text', x: 8, y: -16, text: '+t°', size: 10 },
  ],
};

// ----------------------------------------------------------- BAROMETER (Sensore di Pressione)
const barometerModel: DeviceModel = {
  stamp(ctx, params, nodes) {
    const r0 = params.R0 as number;
    const sens = params.S as number; // variazione Ω/kPa
    const press = getEnv().pressure; // Pressione globale
    const r = Math.max(r0 + sens * (press - 101.3), 1);
    ctx.addG(nodes[0], nodes[1], 1 / r);
  },
  outputs(sol, params, nodes) {
    const r0 = params.R0 as number;
    const sens = params.S as number;
    const press = getEnv().pressure;
    const r = Math.max(r0 + sens * (press - 101.3), 1);
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    const i = v / r;
    return { pinCurrents: [i, -i], data: { v, i, r, pressure: press } };
  },
};

export const barometerDef: ComponentDef = {
  type: 'barometer',
  name: 'Sensore di Pressione',
  category: 'passivi',
  description: 'Sensore piezoresistivo. Varia la sua resistenza proporzionalmente alla pressione dell\'aria.',
  pins: [
    { x: -40, y: 0, name: 'a' },
    { x: 40, y: 0, name: 'b' },
  ],
  params: [
    { key: 'R0', label: 'Resistenza nominale', unit: 'Ω', kind: 'number', min: 100, max: 1e5 },
    { key: 'S', label: 'Sensibilità', unit: 'Ω/kPa', kind: 'number', min: 1, max: 1000 },
  ],
  defaults: { R0: 1000, S: 10 },
  model: barometerModel,
  symbol: () => [
    { kind: 'path', d: 'M -40 0 H -24 L -18 -9 L -6 9 L 6 -9 L 18 9 L 24 0 H 40' },
    { kind: 'circle', cx: 0, cy: 0, r: 18, fill: 'none' },
    { kind: 'line', x1: 0, y1: -28, x2: 0, y2: -18, width: 2 },
    { kind: 'polygon', points: '0,-18 -4,-22 4,-22', fill: 'currentColor' },
    { kind: 'text', x: 6, y: -24, text: 'P', size: 10 },
  ],
};

// ----------------------------------------------------------- SENS_HALL (Sensore Effetto Hall)
// Pin 0: VCC (+), Pin 1: GND (-), Pin 2: OUT (Uscita)
// Vout = V_bias + Sens * CampoMagnetico
const hallModel: DeviceModel = {
  branches: 1,
  stamp(ctx, params, nodes, branches) {
    const br = ctx.branchIndex(branches[0]);
    const [, gnd, out] = nodes;
    const sens = params.S as number; // V/mT
    const bField = getEnv().magneticField; // Campo magnetico globale
    const voutVal = 2.5 + (sens * bField);

    // Vout - Vgnd = voutVal -> OUT e GND
    ctx.addA(br, out, 1);
    ctx.addA(br, gnd, -1);
    ctx.addA(out, br, 1);
    ctx.addB(br, voutVal);
  },
  outputs(sol, _params, nodes, branches) {
    const gnd = sol.v(nodes[1]);
    const out = sol.v(nodes[2]);
    const i = sol.branch(branches[0]);
    return {
      pinCurrents: [0, -i, i],
      data: { v: out - gnd, i, magneticField: getEnv().magneticField },
    };
  },
};

export const hallDef: ComponentDef = {
  type: 'hall_sensor',
  name: 'Sensore Hall',
  category: 'semiconduttori',
  description: 'Rilevatore magnetico. Emette una tensione proporzionale al campo magnetico globale (mT).',
  pins: [
    { x: -40, y: -20, name: 'vcc' },
    { x: -40, y: 20, name: 'gnd' },
    { x: 40, y: 0, name: 'out' },
  ],
  params: [
    { key: 'S', label: 'Sensibilità', unit: 'V/mT', kind: 'number', min: 0.001, max: 0.1 },
  ],
  defaults: { S: 0.02 },
  model: hallModel,
  symbol: () => [
    { kind: 'polygon', points: '-20,-24 -20,24 20,24 20,-24', fill: 'none' },
    { kind: 'line', x1: -40, y1: -20, x2: -20, y2: -20 },
    { kind: 'line', x1: -40, y1: 20, x2: -20, y2: 20 },
    { kind: 'line', x1: 20, y1: 0, x2: 40, y2: 0 },
    { kind: 'text', x: -14, y: 6, text: 'HAL', size: 10 },
  ],
};

// ----------------------------------------------------------- HUMIDITY_SENS (Igro-condensatore)
// Capacità che varia con l'umidità dell'aria: C = C0 * (1 + beta * H)
const humiditySensModel: DeviceModel = {
  initState: () => ({ v: 0 }),
  stamp(ctx, params, nodes, _branches, state) {
    if (ctx.dt === null) return;
    const c0 = params.C0 as number;
    const beta = params.beta as number;
    const hum = getEnv().humidity; // Umidità globale
    const c = c0 * (1 + beta * hum);
    const g = c / ctx.dt;
    ctx.addG(nodes[0], nodes[1], g);
    ctx.addCurrent(nodes[0], g * state.v);
    ctx.addCurrent(nodes[1], -g * state.v);
  },
  outputs(sol, params, nodes, _branches, state) {
    const c0 = params.C0 as number;
    const beta = params.beta as number;
    const hum = getEnv().humidity;
    const c = c0 * (1 + beta * hum);
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    const i = sol.dt === null ? 0 : (c / sol.dt) * (v - state.v);
    return { pinCurrents: [i, -i], data: { v, i, capacitance: c, humidity: hum } };
  },
  nextState(sol, _params, nodes) {
    return { v: sol.v(nodes[0]) - sol.v(nodes[1]) };
  },
};

export const humiditySensDef: ComponentDef = {
  type: 'humidity_sensor',
  name: 'Sensore Umidità',
  category: 'passivi',
  description: 'Igro-capacimetro. La sua capacità interna varia con l\'umidità relativa dell\'ambiente.',
  pins: [
    { x: -40, y: 0, name: 'a' },
    { x: 40, y: 0, name: 'b' },
  ],
  params: [
    { key: 'C0', label: 'Capacità a 0% RH', unit: 'F', kind: 'number', min: 1e-12, max: 1e-3, log: true },
    { key: 'beta', label: 'Coeff. Umidità (β)', unit: '/%RH', kind: 'number', min: 0.001, max: 0.1 },
  ],
  defaults: { C0: 100e-9, beta: 0.01 },
  model: humiditySensModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -6, y2: 0 },
    { kind: 'line', x1: -6, y1: -14, x2: -6, y2: 14 },
    { kind: 'line', x1: 6, y1: -14, x2: 6, y2: 14 },
    { kind: 'line', x1: 6, y1: 0, x2: 40, y2: 0 },
    { kind: 'text', x: -4, y: -18, text: 'H%', size: 9 },
  ],
};

// ----------------------------------------------------------- MOSFET CANALE N (NMOS)
const nmosModel: DeviceModel = {
  nonlinear: true,
  stamp(ctx, params, nodes) {
    const vth = params.Vth as number;
    const beta = params.beta as number; // Kn in A/V^2
    const [ng, nd, ns] = nodes;

    const vg = ctx.vNow(ng);
    const vd = ctx.vNow(nd);
    const vs = ctx.vNow(ns);

    const vgs = vg - vs;
    const vds = vd - vs;

    let ids = 0;
    let gds = 1e-5; // conduttanza minima di shunt
    let gm = 0;

    if (vgs > vth) {
      if (vds < vgs - vth) {
        // Zona lineare (triodo)
        ids = beta * (2 * (vgs - vth) * vds - vds * vds);
        gm = 2 * beta * vds;
        gds = 2 * beta * (vgs - vth - vds);
      } else {
        // Zona di saturazione (attiva)
        ids = beta * (vgs - vth) * (vgs - vth);
        gm = 2 * beta * (vgs - vth);
        gds = 1e-5;
      }
    }

    const ieq = ids - gm * vgs - gds * vds;

    ctx.addG(nd, ns, gds);
    ctx.addA(nd, ng, gm);
    ctx.addA(nd, ns, -gm);
    ctx.addA(ns, ng, -gm);
    ctx.addA(ns, ns, gm);

    ctx.addCurrent(nd, -ieq);
    ctx.addCurrent(ns, ieq);
    ctx.addG(nd, ns, ctx.gmin); // anti-singolarità
  },
  outputs(sol, params, nodes) {
    const vth = params.Vth as number;
    const beta = params.beta as number;
    const vgs = sol.v(nodes[0]) - sol.v(nodes[2]);
    const vds = sol.v(nodes[1]) - sol.v(nodes[2]);
    let ids = 0;
    let modeStr = 'Spento (Cut-off)';
    if (vgs > vth) {
      if (vds < vgs - vth) {
        ids = beta * (2 * (vgs - vth) * vds - vds * vds);
        modeStr = 'Ohmico (Lineare)';
      } else {
        ids = beta * (vgs - vth) * (vgs - vth);
        modeStr = 'Saturazione (Attivo)';
      }
    }
    return { pinCurrents: [0, ids, -ids], data: { vgs, vds, ids, mode: modeStr } };
  },
};

export const nmosDef: ComponentDef = {
  type: 'nmos',
  name: 'MOSFET Canale N',
  category: 'semiconduttori',
  description: 'Transistor ad effetto di campo a canale N. Ottimo come switch elettronico.',
  pins: [
    { x: -40, y: 0, name: 'gate' },
    { x: 20, y: -40, name: 'drain' },
    { x: 20, y: 40, name: 'source' },
  ],
  params: [
    { key: 'Vth', label: 'Tensione di Soglia', unit: 'V', kind: 'number', min: 0.5, max: 5 },
    { key: 'beta', label: 'Kn (Guadagno)', unit: 'A/V²', kind: 'number', min: 1e-4, max: 1 },
  ],
  defaults: { Vth: 2.0, beta: 0.05 },
  model: nmosModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -10, y2: 0 },
    { kind: 'line', x1: -10, y1: -20, x2: -10, y2: 20, width: 3 }, // barra del Gate
    { kind: 'line', x1: 0, y1: -20, x2: 0, y2: 20, width: 2 }, // canale isolato
    { kind: 'line', x1: 0, y1: -20, x2: 20, y2: -20 },
    { kind: 'line', x1: 20, y1: -20, x2: 20, y2: -40 }, // drain
    { kind: 'line', x1: 0, y1: 20, x2: 20, y2: 20 },
    { kind: 'line', x1: 20, y1: 20, x2: 20, y2: 40 }, // source
    { kind: 'polygon', points: '0,0 12,-6 12,6', fill: 'currentColor' }, // freccia entrante
    { kind: 'line', x1: 0, y1: 0, x2: 20, y2: 0 },
    { kind: 'line', x1: 20, y1: 0, x2: 20, y2: 20 },
  ],
};

// ----------------------------------------------------------- MOSFET CANALE P (PMOS)
const pmosModel: DeviceModel = {
  nonlinear: true,
  stamp(ctx, params, nodes) {
    const vth = params.Vth as number; // vth è negativo per PMOS
    const beta = params.beta as number;
    const [ng, nd, ns] = nodes;

    const vg = ctx.vNow(ng);
    const vd = ctx.vNow(nd);
    const vs = ctx.vNow(ns);

    const vsg = vs - vg;
    const vsd = vs - vd;
    const vth_abs = Math.abs(vth);

    let isd = 0;
    let gds = 1e-5;
    let gm = 0;

    if (vsg > vth_abs) {
      if (vsd < vsg - vth_abs) {
        isd = beta * (2 * (vsg - vth_abs) * vsd - vsd * vsd);
        gm = 2 * beta * vsd;
        gds = 2 * beta * (vsg - vth_abs - vsd);
      } else {
        isd = beta * (vsg - vth_abs) * (vsg - vth_abs);
        gm = 2 * beta * (vsg - vth_abs);
        gds = 1e-5;
      }
    }

    const ieq = isd - gm * vsg - gds * vsd;

    ctx.addG(ns, nd, gds);
    ctx.addA(ns, ng, -gm);
    ctx.addA(ns, ns, gm);
    ctx.addA(nd, ng, gm);
    ctx.addA(nd, ns, -gm);

    ctx.addCurrent(ns, -ieq);
    ctx.addCurrent(nd, ieq);
    ctx.addG(nd, ns, ctx.gmin);
  },
  outputs(sol, params, nodes) {
    const vth = Math.abs(params.Vth as number);
    const beta = params.beta as number;
    const vsg = sol.v(nodes[2]) - sol.v(nodes[0]);
    const vsd = sol.v(nodes[2]) - sol.v(nodes[1]);
    let ids = 0;
    let modeStr = 'Spento (Cut-off)';
    if (vsg > vth) {
      if (vsd < vsg - vth) {
        ids = -beta * (2 * (vsg - vth) * vsd - vsd * vsd);
        modeStr = 'Ohmico (Lineare)';
      } else {
        ids = -beta * (vsg - vth) * (vsg - vth);
        modeStr = 'Saturazione (Attivo)';
      }
    }
    return { pinCurrents: [0, ids, -ids], data: { vsg, vsd, ids, mode: modeStr } };
  },
};

export const pmosDef: ComponentDef = {
  type: 'pmos',
  name: 'MOSFET Canale P',
  category: 'semiconduttori',
  description: 'Transistor ad effetto di campo a canale P. Complementare al NMOS.',
  pins: [
    { x: -40, y: 0, name: 'gate' },
    { x: 20, y: -40, name: 'drain' },
    { x: 20, y: 40, name: 'source' },
  ],
  params: [
    { key: 'Vth', label: 'Tensione di Soglia', unit: 'V', kind: 'number', min: -5, max: -0.5 },
    { key: 'beta', label: 'Kp (Guadagno)', unit: 'A/V²', kind: 'number', min: 1e-4, max: 1 },
  ],
  defaults: { Vth: -2.0, beta: 0.05 },
  model: pmosModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -10, y2: 0 },
    { kind: 'line', x1: -10, y1: -20, x2: -10, y2: 20, width: 3 }, // barra del Gate
    { kind: 'line', x1: 0, y1: -20, x2: 0, y2: 20, width: 2 }, // canale
    { kind: 'line', x1: 0, y1: -20, x2: 20, y2: -20 },
    { kind: 'line', x1: 20, y1: -20, x2: 20, y2: -40 }, // drain
    { kind: 'line', x1: 0, y1: 20, x2: 20, y2: 20 },
    { kind: 'line', x1: 20, y1: 20, x2: 20, y2: 40 }, // source
    { kind: 'polygon', points: '12,0 0,-6 0,6', fill: 'currentColor' }, // freccia uscente
    { kind: 'line', x1: 12, y1: 0, x2: 20, y2: 0 },
    { kind: 'line', x1: 20, y1: 0, x2: 20, y2: 20 },
  ],
};

// ----------------------------------------------------------- TRANSISTOR PNP (Ebers-Moll complementare)
const pnpModel: DeviceModel = {
  nonlinear: true,
  stamp(ctx, params, nodes) {
    const bf = params.beta as number;
    const [nb, nc, ne] = nodes;
    const vcrit = vcritOf(1e-14, VT);

    const veb = limitedJunctionVoltage(ctx, ne, nb, VT, vcrit);
    const vcb = limitedJunctionVoltage(ctx, nc, nb, VT, vcrit);

    const f = evalJunction(veb, 1e-14, VT); // giunzione E-B
    const r = evalJunction(vcb, 1e-14, VT); // giunzione C-B
    const ieb = f.id / bf;
    const geb = f.gd / bf;
    const icb = r.id / 1;
    const gcb = r.gd / 1;
    const it = f.id - r.id; // trasporto E -> C
    const gitf = f.gd;
    const gitr = r.gd;

    const stampTerminal = (node: number, i0: number, dVeb: number, dVcb: number) => {
      ctx.addA(node, nb, -(dVeb + dVcb));
      ctx.addA(node, ne, dVeb);
      ctx.addA(node, nc, dVcb);
      ctx.addB(node, dVeb * veb + dVcb * vcb - i0);
    };

    stampTerminal(nb, -(ieb + icb), -geb, -gcb);
    stampTerminal(nc, -(it - icb), -gitf, (gitr + gcb));
    stampTerminal(ne, (ieb + icb) + (it - icb), (geb + gitf), -gitr);

    ctx.addG(nb, ne, ctx.gmin);
    ctx.addG(nb, nc, ctx.gmin);
  },
  outputs(sol, params, nodes) {
    const bf = params.beta as number;
    const veb = sol.v(nodes[2]) - sol.v(nodes[0]);
    const vcb = sol.v(nodes[1]) - sol.v(nodes[0]);
    const vec = sol.v(nodes[2]) - sol.v(nodes[1]);
    const icc = shockleyCurrent(veb, 1e-14, VT);
    const iec = shockleyCurrent(vcb, 1e-14, VT);
    const ib = -(icc / bf + iec / 1);
    const ic = -(icc - iec - iec / 1);
    const ie = -(ib + ic);
    return { pinCurrents: [ib, ic, ie], data: { veb, vcb, vec, ib, ic, ie, beta: ib !== 0 ? ic / ib : 0 } };
  },
};

export const pnpDef: ComponentDef = {
  type: 'pnp',
  name: 'Transistor PNP',
  category: 'semiconduttori',
  description: 'Transistor bipolare a giunzione PNP. Complementare al transistor NPN.',
  pins: [
    { x: -40, y: 0, name: 'base' },
    { x: 20, y: -40, name: 'collettore' },
    { x: 20, y: 40, name: 'emettitore' },
  ],
  params: [{ key: 'beta', label: 'β_F', unit: '', kind: 'number', min: 10, max: 1000 }],
  defaults: { beta: 100 },
  model: pnpModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -8, y2: 0 },
    { kind: 'line', x1: -8, y1: -16, x2: -8, y2: 16, width: 3 },
    { kind: 'line', x1: -8, y1: -8, x2: 20, y2: -22 },
    { kind: 'line', x1: 20, y1: -22, x2: 20, y2: -40 }, // colletore
    { kind: 'line', x1: -8, y1: 8, x2: 20, y2: 22 },
    { kind: 'line', x1: 20, y1: 22, x2: 20, y2: 40 }, // emettitore
    { kind: 'polygon', points: '3,11 13,20 12,8', fill: 'currentColor' },
    { kind: 'circle', cx: 2, cy: 0, r: 26 },
  ],
};

// ----------------------------------------------------------- DIODO SCHOTTKY (bassa caduta)
export const schottkyDef: ComponentDef = {
  type: 'schottky',
  name: 'Diodo Schottky',
  category: 'semiconduttori',
  description: 'Diodo rapido a bassa caduta di tensione diretta (VF ≈ 0.3V).',
  pins: [
    { x: -40, y: 0, name: 'anodo' },
    { x: 40, y: 0, name: 'catodo' },
  ],
  params: [],
  defaults: {},
  model: makeZenerModel(1e-6, 1.2), // Is più elevata per barriera più bassa
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -10, y2: 0 },
    { kind: 'polygon', points: '-10,-10 -10,10 10,0', fill: 'currentColor' },
    { kind: 'line', x1: 10, y1: -10, x2: 10, y2: 10 },
    { kind: 'line', x1: 10, y1: -10, x2: 14, y2: -10 },
    { kind: 'line', x1: 14, y1: -10, x2: 14, y2: -6 },
    { kind: 'line', x1: 10, y1: 10, x2: 6, y2: 10 },
    { kind: 'line', x1: 6, y1: 10, x2: 6, y2: 6 },
    { kind: 'line', x1: 10, y1: 0, x2: 40, y2: 0 },
  ],
};

// ----------------------------------------------------------- RELAY SPDT (Relè Elettromeccanico)
const relayModel: DeviceModel = {
  stamp(ctx, params, nodes) {
    const [c1, c2, com, nc, no] = nodes;
    const rCoil = params.Rcoil as number;
    const vTh = params.Vth as number;
    ctx.addG(c1, c2, 1 / rCoil);

    const vCoil = Math.abs(ctx.vNow(c1) - ctx.vNow(c2));
    const isActivated = vCoil >= vTh;
    const rOn = 0.01;
    const rOff = 1e9;

    ctx.addG(com, nc, isActivated ? 1 / rOff : 1 / rOn);
    ctx.addG(com, no, isActivated ? 1 / rOn : 1 / rOff);
  },
  outputs(sol, params, nodes) {
    const [c1, c2] = nodes;
    const rCoil = params.Rcoil as number;
    const vTh = params.Vth as number;
    const vCoil = sol.v(c1) - sol.v(c2);
    const iCoil = vCoil / rCoil;
    const isActivated = Math.abs(vCoil) >= vTh;
    return {
      pinCurrents: [iCoil, -iCoil, 0, 0, 0],
      data: { vCoil, iCoil, active: isActivated },
    };
  },
};

export const relayDef: ComponentDef = {
  type: 'relay',
  name: 'Relè SPDT',
  category: 'altro',
  description: 'Deviatore elettromeccanico attivato dalla tensione applicata sulla bobina (in1-in2).',
  pins: [
    { x: -40, y: -20, name: 'in1' },
    { x: -40, y: 20, name: 'in2' },
    { x: 0, y: 0, name: 'com' },
    { x: 40, y: -20, name: 'nc' },
    { x: 40, y: 20, name: 'no' },
  ],
  params: [
    { key: 'Rcoil', label: 'Resistenza Bobina', unit: 'Ω', kind: 'number', min: 10, max: 1000 },
    { key: 'Vth', label: 'Tensione di Soglia', unit: 'V', kind: 'number', min: 1, max: 24 },
  ],
  defaults: { Rcoil: 100, Vth: 3.5 },
  model: relayModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: -20, x2: -20, y2: -20 },
    { kind: 'line', x1: -40, y1: 20, x2: -20, y2: 20 },
    { kind: 'polygon', points: '-20,-14 -20,14 -12,14 -12,-14', fill: 'none' },
    { kind: 'line', x1: -8, y1: -10, x2: -8, y2: 10 },
    { kind: 'line', x1: 0, y1: 0, x2: 12, y2: 0 },
    { kind: 'line', x1: 24, y1: -20, x2: 40, y2: -20 },
    { kind: 'line', x1: 24, y1: 20, x2: 40, y2: 20 },
    { kind: 'circle', cx: 12, cy: 0, r: 2.5 },
    { kind: 'circle', cx: 24, cy: -20, r: 2.5 },
    { kind: 'circle', cx: 24, cy: 20, r: 2.5 },
    { kind: 'line', x1: 12, y1: 0, x2: 24, y2: -18, width: 2 },
  ],
};

// ----------------------------------------------------------- FUSIBILE DIDATTICO (Salvavita)
const fuseModel: DeviceModel = {
  initState: () => ({ blown: 0 }),
  stamp(ctx, _params, nodes, _branches, state) {
    const isBlown = state.blown === 1;
    const g = isBlown ? 1e-10 : 100; // se bruciato, R=10 GOhm, altrimenti R=0.01 Ohm
    ctx.addG(nodes[0], nodes[1], g);
  },
  outputs(sol, _params, nodes, _branches, state) {
    const isBlown = state.blown === 1;
    const g = isBlown ? 1e-10 : 100;
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    const i = v * g;
    return { pinCurrents: [i, -i], data: { v, i, blown: isBlown } };
  },
  nextState(sol, params, nodes, _branches, state) {
    const isBlown = state.blown === 1;
    if (isBlown) return { blown: 1 };
    const v = sol.v(nodes[0]) - sol.v(nodes[1]);
    const i = Math.abs(v * 100);
    const imax = params.Imax as number;
    if (i > imax) {
      return { blown: 1 }; // Si fonde!
    }
    return { blown: 0 };
  },
};

export const fuseDef: ComponentDef = {
  type: 'fuse',
  name: 'Fusibile',
  category: 'altro',
  description: 'Si fonde e isola il circuito (per sempre) se la corrente supera la soglia Imax.',
  pins: [
    { x: -40, y: 0, name: 'a' },
    { x: 40, y: 0, name: 'b' },
  ],
  params: [{ key: 'Imax', label: 'Corrente Fusione', unit: 'A', kind: 'number', min: 0.05, max: 10 }],
  defaults: { Imax: 1.0 },
  model: fuseModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -20, y2: 0 },
    { kind: 'line', x1: 20, y1: 0, x2: 40, y2: 0 },
    { kind: 'polygon', points: '-20,-6 -20,6 20,6 20,-6', fill: 'none' },
    { kind: 'path', d: 'M -20 0 Q -10 4 0 0 T 20 0', fill: 'none' },
  ],
};

// ----------------------------------------------------------- PONTE DI GRAETZ (Graetz Bridge)
const bridgeModel: DeviceModel = {
  nonlinear: true,
  stamp(ctx, _params, nodes) {
    const [ac1, ac2, pos, neg] = nodes;
    const Is = 2.5e-9;
    const nVt = 1.75 * VT;
    const vcrit = vcritOf(Is, nVt);

    const evaluateAndStampDiode = (anode: number, cathode: number) => {
      const vd = limitedJunctionVoltage(ctx, anode, cathode, nVt, vcrit);
      const { id, gd } = evalJunction(vd, Is, nVt);
      const ieq = id - gd * vd;
      ctx.addG(anode, cathode, gd + ctx.gmin);
      ctx.addCurrent(anode, -ieq);
      ctx.addCurrent(cathode, ieq);
    };

    evaluateAndStampDiode(neg, ac1);
    evaluateAndStampDiode(neg, ac2);
    evaluateAndStampDiode(ac1, pos);
    evaluateAndStampDiode(ac2, pos);
  },
  outputs(sol, _params, nodes) {
    const [ac1, ac2, pos, neg] = nodes;
    const vAC = sol.v(ac1) - sol.v(ac2);
    const vDC = sol.v(pos) - sol.v(neg);
    return { pinCurrents: [0, 0, 0, 0], data: { vAC, vDC } };
  },
};

export const bridgeDef: ComponentDef = {
  type: 'bridge_rectifier',
  name: 'Ponte Graetz',
  category: 'semiconduttori',
  description: 'Ponte a doppia semionda integrato a 4 terminali. Converte la corrente alternata in continua pulsante.',
  pins: [
    { x: -40, y: -20, name: 'ac1' },
    { x: -40, y: 20, name: 'ac2' },
    { x: 40, y: -20, name: 'pos' },
    { x: 40, y: 20, name: 'neg' },
  ],
  params: [],
  defaults: {},
  model: bridgeModel,
  symbol: () => [
    { kind: 'polygon', points: '-20,0 0,-20 20,0 0,20', fill: 'none' },
    { kind: 'line', x1: -40, y1: -20, x2: -14, y2: -6 },
    { kind: 'line', x1: -40, y1: 20, x2: -14, y2: 6 },
    { kind: 'line', x1: 14, y1: -6, x2: 40, y2: -20 },
    { kind: 'line', x1: 14, y1: 6, x2: 40, y2: 20 },
    { kind: 'text', x: -16, y: -6, text: '~', size: 12 },
    { kind: 'text', x: -16, y: 16, text: '~', size: 12 },
    { kind: 'text', x: 6, y: -6, text: '+', size: 10 },
    { kind: 'text', x: 6, y: 14, text: '−', size: 10 },
  ],
};

// ----------------------------------------------------------- TRASFORMATORE IDEALE
const transformerModel: DeviceModel = {
  branches: 1,
  stamp(ctx, params, nodes, branches) {
    const br = ctx.branchIndex(branches[0]);
    const [pa, pb, sa, sb] = nodes;
    const n = params.N as number;

    ctx.addA(br, sa, 1);
    ctx.addA(br, sb, -1);
    ctx.addA(br, pa, -n);
    ctx.addA(br, pb, n);

    ctx.addA(pa, br, -n);
    ctx.addA(pb, br, n);
    ctx.addA(sa, br, 1);
    ctx.addA(sb, br, -1);
  },
  outputs(sol, params, nodes, branches) {
    const [pa, pb, sa, sb] = nodes;
    const n = params.N as number;
    const vPrim = sol.v(pa) - sol.v(pb);
    const vSec = sol.v(sa) - sol.v(sb);
    const iSec = sol.branch(branches[0]);
    const iPrim = -n * iSec;
    return {
      pinCurrents: [iPrim, -iPrim, iSec, -iSec],
      data: { vPrim, vSec, iPrim, iSec },
    };
  },
};

export const transformerDef: ComponentDef = {
  type: 'transformer',
  name: 'Trasformatore',
  category: 'altro',
  description: 'Trasformatore magnetico ideale. Riduce o aumenta le tensioni alternate in base al rapporto spire N.',
  pins: [
    { x: -40, y: -20, name: 'p_a' },
    { x: -40, y: 20, name: 'p_b' },
    { x: 40, y: -20, name: 's_a' },
    { x: 40, y: 20, name: 's_b' },
  ],
  params: [{ key: 'N', label: 'Rapporto Spire (N)', unit: '', kind: 'number', min: 0.01, max: 100 }],
  defaults: { N: 0.1 },
  model: transformerModel,
  symbol: () => [
    { kind: 'path', d: 'M -40 -20 H -20 A 5 5 0 0 1 -20 -10 A 5 5 0 0 1 -20 0 A 5 5 0 0 1 -20 10 A 5 5 0 0 1 -20 20 H -40', fill: 'none' },
    { kind: 'line', x1: -6, y1: -20, x2: -6, y2: 20, width: 2 },
    { kind: 'line', x1: 6, y1: -20, x2: 6, y2: 20, width: 2 },
    { kind: 'path', d: 'M 40 -20 H 20 A 5 5 0 0 1 20 -10 A 5 5 0 0 1 20 0 A 5 5 0 0 1 20 10 A 5 5 0 0 1 20 20 H 40', fill: 'none' },
  ],
};

// ----------------------------------------------------------- GENERATORE DI IMPULSI / ONDA QUADRA
function pulseValue(params: any, t: number): number {
  const vh = params.Vh as number;
  const vl = params.Vl as number;
  const f = params.freq as number;
  const d = params.duty as number / 100;
  const T = 1 / f;
  const tMod = t % T;
  return tMod < T * d ? vh : vl;
}

const pulseModel: DeviceModel = {
  branches: 1,
  stamp(ctx, params, nodes, branches) {
    const br = ctx.branchIndex(branches[0]);
    const [a, b] = nodes;
    ctx.addA(a, br, 1);
    ctx.addA(b, br, -1);
    ctx.addA(br, a, 1);
    ctx.addA(br, b, -1);
    ctx.addB(br, pulseValue(params, ctx.time));
  },
  outputs(sol, params, _nodes, branches) {
    const i = sol.branch(branches[0]);
    return { pinCurrents: [i, -i], data: { v: pulseValue(params, sol.time), i } };
  },
};

export const pulseDef: ComponentDef = {
  type: 'pulse',
  name: 'Generatore Impulsi',
  category: 'sorgenti',
  description: 'Generatore di impulsi PWM con frequenza, livelli di tensione e duty cycle regolabili.',
  pins: [
    { x: -40, y: 0, name: '+' },
    { x: 40, y: 0, name: '−' },
  ],
  params: [
    { key: 'Vh', label: 'Tensione Alta (Vh)', unit: 'V', kind: 'number', min: -50, max: 50 },
    { key: 'Vl', label: 'Tensione Bassa (Vl)', unit: 'V', kind: 'number', min: -50, max: 50 },
    { key: 'freq', label: 'Frequenza', unit: 'Hz', kind: 'number', min: 0.1, max: 1e5, log: true },
    { key: 'duty', label: 'Duty Cycle', unit: '%', kind: 'number', min: 1, max: 99 },
  ],
  defaults: { Vh: 5, Vl: 0, freq: 1000, duty: 50 },
  model: pulseModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -18, y2: 0 },
    { kind: 'circle', cx: 0, cy: 0, r: 18 },
    { kind: 'path', d: 'M -10 4 H -4 V -4 H 4 V 4 H 10', fill: 'none' },
    { kind: 'line', x1: 18, y1: 0, x2: 40, y2: 0 },
  ],
};

// ----------------------------------------------------------- SORGENTE AC CON FASE
function vsinPhaseValue(params: any, t: number): number {
  const amp = params.amp as number;
  const freq = params.freq as number;
  const offset = params.offset as number;
  const phase = params.phase as number * (Math.PI / 180);
  return offset + amp * Math.sin(2 * Math.PI * freq * t + phase);
}

const vsinPhaseModel: DeviceModel = {
  branches: 1,
  stamp(ctx, params, nodes, branches) {
    const br = ctx.branchIndex(branches[0]);
    const [a, b] = nodes;
    ctx.addA(a, br, 1);
    ctx.addA(b, br, -1);
    ctx.addA(br, a, 1);
    ctx.addA(br, b, -1);
    ctx.addB(br, vsinPhaseValue(params, ctx.time));
  },
  outputs(sol, params, _nodes, branches) {
    const i = sol.branch(branches[0]);
    return { pinCurrents: [i, -i], data: { v: vsinPhaseValue(params, sol.time), i } };
  },
};

export const vsinPhaseDef: ComponentDef = {
  type: 'vsin_phase',
  name: 'Sorgente AC con Fase',
  category: 'sorgenti',
  description: 'Generatore di tensione AC sinusoidale con offset e fase iniziale (gradi) regolabile.',
  pins: [
    { x: -40, y: 0, name: '+' },
    { x: 40, y: 0, name: '−' },
  ],
  params: [
    { key: 'amp', label: 'Ampiezza', unit: 'V', kind: 'number', min: 0, max: 100 },
    { key: 'freq', label: 'Frequenza', unit: 'Hz', kind: 'number', min: 0.1, max: 1e6, log: true },
    { key: 'offset', label: 'Offset', unit: 'V', kind: 'number', min: -50, max: 50 },
    { key: 'phase', label: 'Fase (θ)', unit: '°', kind: 'number', min: -360, max: 360 },
  ],
  defaults: { amp: 5, freq: 50, offset: 0, phase: 90 },
  model: vsinPhaseModel,
  symbol: () => [
    { kind: 'line', x1: -40, y1: 0, x2: -18, y2: 0 },
    { kind: 'circle', cx: 0, cy: 0, r: 18 },
    { kind: 'path', d: 'M -10 0 Q -5 -10 0 0 Q 5 10 10 0' },
    { kind: 'text', x: -6, y: 14, text: 'φ', size: 9 },
    { kind: 'line', x1: 18, y1: 0, x2: 40, y2: 0 },
  ],
};
