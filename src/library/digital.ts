// Dominio digitale (M3). Componenti logici come dispositivi comportamentali
// *mixed-signal* dentro il motore analogico (generatori controllati non lineari:
// leggono le tensioni agli ingressi, le sogliano in livelli logici e pilotano
// l'uscita a 0/Vdd). Le stesse definizioni logiche alimentano il MOTORE DIGITALE
// nativo (`engine/digital.ts`) via la tabella `DIGITAL` esportata in fondo, così
// c'è un'unica fonte di verità per il comportamento delle porte.

import type { ComponentDef } from '../model/registry.ts';
import type { DeviceModel, DeviceState, Params } from '../model/device.ts';

export const DEFAULT_VDD = 5;

/** Livello logico sfumato [0,1] e sua derivata rispetto a V (transconduttanza). */
export function logicLevel(v: number, vdd: number): { l: number; dl: number } {
  const vil = 0.3 * vdd;
  const vih = 0.7 * vdd;
  const span = vih - vil;
  const t = (v - vil) / span;
  if (t <= 0) return { l: 0, dl: 0 };
  if (t >= 1) return { l: 1, dl: 0 };
  return { l: t, dl: 1 / span };
}

/** Onda quadra 0/1 al 50% di duty per il clock. */
export function squareLevel(time: number, freq: number): number {
  if (!(freq > 0)) return 0;
  return (time * freq) % 1 < 0.5 ? 1 : 0;
}

interface GateSpec {
  inputs: number;
  /** Livello d'uscita [0,1] e derivate ∂o/∂(livello ingresso i). */
  logic(levels: number[]): { o: number; d: number[] };
}

// Con ingressi puliti a 0/1 questi danno la tavola di verità esatta; tra le
// soglie degradano con continuità (utile per la convergenza NR).
const GATES: Record<string, GateSpec> = {
  not: { inputs: 1, logic: ([a]) => ({ o: 1 - a, d: [-1] }) },
  buffer: { inputs: 1, logic: ([a]) => ({ o: a, d: [1] }) },
  and: { inputs: 2, logic: ([a, b]) => ({ o: a * b, d: [b, a] }) },
  or: { inputs: 2, logic: ([a, b]) => ({ o: a + b - a * b, d: [1 - b, 1 - a] }) },
  nand: { inputs: 2, logic: ([a, b]) => ({ o: 1 - a * b, d: [-b, -a] }) },
  nor: { inputs: 2, logic: ([a, b]) => ({ o: (1 - a) * (1 - b), d: [b - 1, a - 1] }) },
  xor: { inputs: 2, logic: ([a, b]) => ({ o: a + b - 2 * a * b, d: [1 - 2 * b, 1 - 2 * a] }) },
  xnor: { inputs: 2, logic: ([a, b]) => ({ o: 1 - a - b + 2 * a * b, d: [2 * b - 1, 2 * a - 1] }) },
};

function gateModel(kind: string): DeviceModel {
  const spec = GATES[kind];
  const nIn = spec.inputs;
  return {
    branches: 1,
    nonlinear: true,
    stamp(ctx, params, nodes, branches) {
      const vdd = (params.vdd as number) ?? DEFAULT_VDD;
      const br = ctx.branchIndex(branches[0]);
      const out = nodes[nIn];
      const levels: number[] = [];
      const dls: number[] = [];
      for (let i = 0; i < nIn; i++) {
        const { l, dl } = logicLevel(ctx.vNow(nodes[i]), vdd);
        levels.push(l);
        dls.push(dl);
      }
      const { o, d } = spec.logic(levels);
      const target = vdd * o;
      ctx.addA(br, out, 1);
      let rhs = target;
      for (let i = 0; i < nIn; i++) {
        const m = vdd * d[i] * dls[i]; // ∂target/∂Vin_i
        ctx.addA(br, nodes[i], -m);
        rhs -= m * ctx.vNow(nodes[i]);
      }
      ctx.addB(br, rhs);
      ctx.addA(out, br, 1);
      ctx.addG(out, -1, 1e-6);
    },
    outputs(sol, params, nodes, branches) {
      const vdd = (params.vdd as number) ?? DEFAULT_VDD;
      const levels = nodes.slice(0, nIn).map((n) => logicLevel(sol.v(n), vdd).l);
      const { o } = spec.logic(levels);
      const data: Record<string, number> = { level: o, logic: o > 0.5 ? 1 : 0, vout: sol.v(nodes[nIn]) };
      if (nIn >= 1) data.a = levels[0] > 0.5 ? 1 : 0;
      if (nIn >= 2) data.b = levels[1] > 0.5 ? 1 : 0;
      return { pinCurrents: [...Array(nIn).fill(0), sol.branch(branches[0])], data };
    },
  };
}

/** Sorgente di tensione a valore fisso verso massa (per ingresso/clock/FF). */
function driveNode(ctx: Parameters<DeviceModel['stamp']>[0], node: number, branch: number, v: number): void {
  const br = ctx.branchIndex(branch);
  ctx.addA(node, br, 1);
  ctx.addA(br, node, 1);
  ctx.addB(br, v);
}

const vddParam = { key: 'vdd', label: 'Vdd', unit: 'V', kind: 'number' as const, min: 1, max: 24 };

// ─────────────────────────── Ingresso / uscita / clock ───────────────────────────

export const logicInDef: ComponentDef = {
  type: 'logic_in',
  name: 'Ingresso logico',
  category: 'digitale',
  description: 'Sorgente logica: doppio-click per commutare tra 0 e Vdd.',
  pins: [{ x: 40, y: 0, name: 'out' }],
  params: [{ key: 'high', label: 'Livello alto (1)', unit: '', kind: 'boolean' }, vddParam],
  defaults: { high: false, vdd: DEFAULT_VDD },
  model: {
    branches: 1,
    stamp(ctx, params, nodes, branches) {
      driveNode(ctx, nodes[0], branches[0], (params.high as boolean) ? (params.vdd as number) : 0);
    },
    outputs(sol, params, nodes, branches) {
      const high = params.high as boolean;
      return { pinCurrents: [sol.branch(branches[0])], data: { logic: high ? 1 : 0, level: high ? 1 : 0, v: sol.v(nodes[0]) } };
    },
  },
  symbol: (p) => [
    { kind: 'path', d: 'M -22 -14 L 12 -14 L 22 0 L 12 14 L -22 14 Z' },
    { kind: 'text', x: -5, y: 5, text: p.high ? '1' : '0', size: 15 },
    { kind: 'line', x1: 22, y1: 0, x2: 40, y2: 0 },
  ],
};

export const clockDef: ComponentDef = {
  type: 'clock',
  name: 'Clock',
  category: 'digitale',
  description: 'Onda quadra logica a frequenza f: la base dei circuiti sequenziali.',
  pins: [{ x: 40, y: 0, name: 'out' }],
  params: [{ key: 'freq', label: 'Frequenza', unit: 'Hz', kind: 'number', min: 0.1, max: 1e6, log: true }, vddParam],
  defaults: { freq: 5, vdd: DEFAULT_VDD },
  model: {
    branches: 1,
    stamp(ctx, params, nodes, branches) {
      const v = squareLevel(ctx.time, params.freq as number) ? (params.vdd as number) : 0;
      driveNode(ctx, nodes[0], branches[0], v);
    },
    outputs(sol, params, nodes, branches) {
      const lvl = squareLevel(sol.time, params.freq as number);
      return { pinCurrents: [sol.branch(branches[0])], data: { logic: lvl, level: lvl, v: sol.v(nodes[0]) } };
    },
  },
  symbol: () => [
    { kind: 'path', d: 'M -22 -14 L 12 -14 L 22 0 L 12 14 L -22 14 Z' },
    { kind: 'path', d: 'M -16 4 L -16 -4 L -8 -4 L -8 4 L 0 4 L 0 -4 L 8 -4 L 8 4', fill: 'none' },
    { kind: 'line', x1: 22, y1: 0, x2: 40, y2: 0 },
  ],
};

export const logicOutDef: ComponentDef = {
  type: 'logic_out',
  name: 'Uscita logica',
  category: 'digitale',
  description: 'Indicatore: si accende quando il livello logico all’ingresso è 1.',
  pins: [{ x: -20, y: 0, name: 'in' }],
  params: [vddParam],
  defaults: { vdd: DEFAULT_VDD },
  model: {
    stamp(ctx, _params, nodes) {
      ctx.addG(nodes[0], -1, 1 / 100000); // 100 kΩ di carico: non lasciar flottare
    },
    outputs(sol, params, nodes) {
      const lvl = logicLevel(sol.v(nodes[0]), (params.vdd as number) ?? DEFAULT_VDD).l;
      return { pinCurrents: [0], data: { logic: lvl > 0.5 ? 1 : 0, level: lvl, v: sol.v(nodes[0]) } };
    },
  },
  symbol: () => [
    { kind: 'line', x1: -20, y1: 0, x2: -12, y2: 0 },
    { kind: 'circle', cx: 0, cy: 0, r: 12 },
  ],
};

// ─────────────────────────── Flip-flop D (sequenziale) ───────────────────────────

export const dffDef: ComponentDef = {
  type: 'dff',
  name: 'Flip-flop D',
  category: 'digitale',
  description: 'Memorizza il valore di D al fronte di salita del clock e lo presenta su Q.',
  pins: [
    { x: -40, y: -20, name: 'D' },
    { x: -40, y: 20, name: 'CLK' },
    { x: 40, y: 0, name: 'Q' },
  ],
  params: [vddParam],
  defaults: { vdd: DEFAULT_VDD },
  model: {
    branches: 1,
    initState: (): DeviceState => ({ q: 0, clkPrev: 0 }),
    stamp(ctx, params, nodes, branches, state) {
      driveNode(ctx, nodes[2], branches[0], state.q > 0.5 ? (params.vdd as number) : 0);
    },
    outputs(sol, params, nodes, branches, state) {
      const vdd = (params.vdd as number) ?? DEFAULT_VDD;
      return {
        pinCurrents: [0, 0, sol.branch(branches[0])],
        data: { q: state.q > 0.5 ? 1 : 0, logic: state.q > 0.5 ? 1 : 0, d: logicLevel(sol.v(nodes[0]), vdd).l > 0.5 ? 1 : 0 },
      };
    },
    nextState(sol, params, nodes, _branches, state): DeviceState {
      const vdd = (params.vdd as number) ?? DEFAULT_VDD;
      const clk = logicLevel(sol.v(nodes[1]), vdd).l;
      const d = logicLevel(sol.v(nodes[0]), vdd).l;
      const rising = state.clkPrev < 0.5 && clk >= 0.5;
      return { q: rising ? (d > 0.5 ? 1 : 0) : state.q, clkPrev: clk };
    },
  },
  symbol: () => [
    { kind: 'line', x1: -40, y1: -20, x2: -22, y2: -20 },
    { kind: 'line', x1: -40, y1: 20, x2: -22, y2: 20 },
    { kind: 'path', d: 'M -22 -26 L 22 -26 L 22 26 L -22 26 Z', fill: 'none' },
    { kind: 'text', x: -16, y: -15, text: 'D', size: 11 },
    { kind: 'path', d: 'M -22 14 L -14 20 L -22 26', fill: 'none' },
    { kind: 'text', x: 8, y: -15, text: 'Q', size: 11 },
    { kind: 'line', x1: 22, y1: 0, x2: 40, y2: 0 },
  ],
};

export const tffDef: ComponentDef = {
  type: 'tff',
  name: 'Flip-flop T',
  category: 'digitale',
  description: 'Al fronte di salita del clock: se T=1 commuta Q, se T=0 lo mantiene. In cascata divide la frequenza.',
  pins: [
    { x: -40, y: -20, name: 'T' },
    { x: -40, y: 20, name: 'CLK' },
    { x: 40, y: 0, name: 'Q' },
  ],
  params: [vddParam],
  defaults: { vdd: DEFAULT_VDD },
  model: {
    branches: 1,
    initState: (): DeviceState => ({ q: 0, clkPrev: 0 }),
    stamp(ctx, params, nodes, branches, state) {
      driveNode(ctx, nodes[2], branches[0], state.q > 0.5 ? (params.vdd as number) : 0);
    },
    outputs(sol, params, nodes, branches, state) {
      const vdd = (params.vdd as number) ?? DEFAULT_VDD;
      return {
        pinCurrents: [0, 0, sol.branch(branches[0])],
        data: { q: state.q > 0.5 ? 1 : 0, logic: state.q > 0.5 ? 1 : 0, t: logicLevel(sol.v(nodes[0]), vdd).l > 0.5 ? 1 : 0 },
      };
    },
    nextState(sol, params, nodes, _branches, state): DeviceState {
      const vdd = (params.vdd as number) ?? DEFAULT_VDD;
      const clk = logicLevel(sol.v(nodes[1]), vdd).l;
      const t = logicLevel(sol.v(nodes[0]), vdd).l;
      const rising = state.clkPrev < 0.5 && clk >= 0.5;
      const q = rising && t > 0.5 ? (state.q > 0.5 ? 0 : 1) : state.q;
      return { q, clkPrev: clk };
    },
  },
  symbol: () => [
    { kind: 'line', x1: -40, y1: -20, x2: -22, y2: -20 },
    { kind: 'line', x1: -40, y1: 20, x2: -22, y2: 20 },
    { kind: 'path', d: 'M -22 -26 L 22 -26 L 22 26 L -22 26 Z', fill: 'none' },
    { kind: 'text', x: -16, y: -15, text: 'T', size: 11 },
    { kind: 'path', d: 'M -22 14 L -14 20 L -22 26', fill: 'none' },
    { kind: 'text', x: 8, y: -15, text: 'Q', size: 11 },
    { kind: 'line', x1: 22, y1: 0, x2: 40, y2: 0 },
  ],
};

// ─────────────── Display esadecimale a 7 segmenti (4 bit → cifra 0–F) ───────────────

/** Geometria dei 7 segmenti (a..g) come linee, condivisa fra simbolo e canvas. */
export const SEG_LINES: [number, number, number, number][] = [
  [-10, -22, 10, -22], // a  alto
  [12, -20, 12, -2], // b  alto-destra
  [12, 2, 12, 20], // c  basso-destra
  [-10, 22, 10, 22], // d  basso
  [-12, 2, -12, 20], // e  basso-sinistra
  [-12, -20, -12, -2], // f  alto-sinistra
  [-10, 0, 10, 0], // g  centro
];

/** Segmenti accesi per ogni cifra esadecimale 0–F (ordine a,b,c,d,e,f,g). */
export const SEGMENTS: number[][] = [
  [1, 1, 1, 1, 1, 1, 0], // 0
  [0, 1, 1, 0, 0, 0, 0], // 1
  [1, 1, 0, 1, 1, 0, 1], // 2
  [1, 1, 1, 1, 0, 0, 1], // 3
  [0, 1, 1, 0, 0, 1, 1], // 4
  [1, 0, 1, 1, 0, 1, 1], // 5
  [1, 0, 1, 1, 1, 1, 1], // 6
  [1, 1, 1, 0, 0, 0, 0], // 7
  [1, 1, 1, 1, 1, 1, 1], // 8
  [1, 1, 1, 1, 0, 1, 1], // 9
  [1, 1, 1, 0, 1, 1, 1], // A
  [0, 0, 1, 1, 1, 1, 1], // b
  [1, 0, 0, 1, 1, 1, 0], // C
  [0, 1, 1, 1, 1, 0, 1], // d
  [1, 0, 0, 1, 1, 1, 1], // E
  [1, 0, 0, 0, 1, 1, 1], // F
];

export const segDisplayDef: ComponentDef = {
  type: 'seg_display',
  name: 'Display 7 segmenti',
  category: 'digitale',
  description: 'Mostra la cifra esadecimale (0–F) dei 4 bit d’ingresso (b0 = meno significativo). Con contatori mostra il conteggio.',
  pins: [
    { x: -40, y: -30, name: 'b0' },
    { x: -40, y: -10, name: 'b1' },
    { x: -40, y: 10, name: 'b2' },
    { x: -40, y: 30, name: 'b3' },
  ],
  params: [vddParam],
  defaults: { vdd: DEFAULT_VDD },
  model: {
    stamp(ctx, _params, nodes) {
      for (const n of nodes) ctx.addG(n, -1, 1 / 100000); // ingressi ad alta impedenza, non flottanti
    },
    outputs(sol, params, nodes) {
      const vdd = (params.vdd as number) ?? DEFAULT_VDD;
      let value = 0;
      nodes.forEach((n, i) => {
        if (logicLevel(sol.v(n), vdd).l > 0.5) value |= 1 << i;
      });
      const segs = SEGMENTS[value];
      const data: Record<string, number> = { value };
      segs.forEach((on, i) => (data[`s${i}`] = on));
      return { pinCurrents: [0, 0, 0, 0], data };
    },
  },
  symbol: () => [
    { kind: 'path', d: 'M -26 -34 L 26 -34 L 26 34 L -26 34 Z', fill: 'none' },
    ...SEG_LINES.map(([x1, y1, x2, y2]) => ({ kind: 'line' as const, x1, y1, x2, y2, width: 3 })),
  ],
};

// ─────────────────────────── Porte combinatorie ───────────────────────────

function makeGateDef(type: string, kind: string, name: string, description: string, symbol: ComponentDef['symbol']): ComponentDef {
  const nIn = GATES[kind].inputs;
  const pins =
    nIn === 1
      ? [{ x: -40, y: 0, name: 'in' }, { x: 40, y: 0, name: 'out' }]
      : [{ x: -40, y: -20, name: 'a' }, { x: -40, y: 20, name: 'b' }, { x: 40, y: 0, name: 'out' }];
  return { type, name, category: 'digitale', description, pins, params: [vddParam], defaults: { vdd: DEFAULT_VDD }, model: gateModel(kind), symbol };
}

const bubble = { kind: 'circle' as const, cx: 27, cy: 0, r: 5 };

export const notGateDef = makeGateDef('not_gate', 'not', 'Porta NOT', 'Invertitore: l’uscita è il negato dell’ingresso.', () => [
  { kind: 'line', x1: -40, y1: 0, x2: -18, y2: 0 },
  { kind: 'polygon', points: '-18,-16 -18,16 16,0' },
  { kind: 'circle', cx: 22, cy: 0, r: 5 },
  { kind: 'line', x1: 27, y1: 0, x2: 40, y2: 0 },
]);

export const bufferGateDef = makeGateDef('buffer_gate', 'buffer', 'Buffer', 'Ripete l’ingresso (rinforza il segnale).', () => [
  { kind: 'line', x1: -40, y1: 0, x2: -18, y2: 0 },
  { kind: 'polygon', points: '-18,-16 -18,16 18,0' },
  { kind: 'line', x1: 18, y1: 0, x2: 40, y2: 0 },
]);

const andBody: ComponentDef['symbol'] = () => [
  { kind: 'line', x1: -40, y1: -20, x2: -16, y2: -20 },
  { kind: 'line', x1: -40, y1: 20, x2: -16, y2: 20 },
  { kind: 'path', d: 'M -16 -22 L 2 -22 A 22 22 0 0 1 2 22 L -16 22 Z' },
  { kind: 'line', x1: 24, y1: 0, x2: 40, y2: 0 },
];

const orBody: ComponentDef['symbol'] = () => [
  { kind: 'line', x1: -40, y1: -20, x2: -12, y2: -20 },
  { kind: 'line', x1: -40, y1: 20, x2: -12, y2: 20 },
  { kind: 'path', d: 'M -20 -22 Q -4 0 -20 22 Q 12 18 24 0 Q 12 -18 -20 -22 Z' },
  { kind: 'line', x1: 24, y1: 0, x2: 40, y2: 0 },
];

export const andGateDef = makeGateDef('and_gate', 'and', 'Porta AND', 'L’uscita è 1 solo se entrambi gli ingressi sono 1.', andBody);
export const orGateDef = makeGateDef('or_gate', 'or', 'Porta OR', 'L’uscita è 1 se almeno un ingresso è 1.', orBody);

export const nandGateDef = makeGateDef('nand_gate', 'nand', 'Porta NAND', 'AND negato: 0 solo con entrambi gli ingressi a 1.', () => [...andBody({}).slice(0, 3), bubble, { kind: 'line', x1: 32, y1: 0, x2: 40, y2: 0 }]);
export const norGateDef = makeGateDef('nor_gate', 'nor', 'Porta NOR', 'OR negato: 1 solo con entrambi gli ingressi a 0.', () => [...orBody({}).slice(0, 3), bubble, { kind: 'line', x1: 32, y1: 0, x2: 40, y2: 0 }]);
export const xorGateDef = makeGateDef('xor_gate', 'xor', 'Porta XOR', 'L’uscita è 1 quando gli ingressi sono diversi.', () => [
  { kind: 'line', x1: -40, y1: -20, x2: -14, y2: -20 },
  { kind: 'line', x1: -40, y1: 20, x2: -14, y2: 20 },
  { kind: 'path', d: 'M -24 -22 Q -8 0 -24 22', fill: 'none' },
  { kind: 'path', d: 'M -20 -22 Q -4 0 -20 22 Q 12 18 24 0 Q 12 -18 -20 -22 Z' },
  { kind: 'line', x1: 24, y1: 0, x2: 40, y2: 0 },
]);

export const xnorGateDef = makeGateDef('xnor_gate', 'xnor', 'Porta XNOR', 'XOR negato: l’uscita è 1 quando gli ingressi sono uguali.', () => [
  ...xorGateDef.symbol({}).slice(0, 4),
  { kind: 'circle', cx: 29, cy: 0, r: 5 },
  { kind: 'line', x1: 34, y1: 0, x2: 40, y2: 0 },
]);

export const digitalDefs: ComponentDef[] = [
  logicInDef,
  clockDef,
  logicOutDef,
  notGateDef,
  bufferGateDef,
  andGateDef,
  orGateDef,
  nandGateDef,
  norGateDef,
  xorGateDef,
  xnorGateDef,
  dffDef,
  tffDef,
  segDisplayDef,
];

// ─────────────────── Specifiche per il MOTORE DIGITALE nativo ───────────────────
// Un'unica fonte di verità: il motore digitale (engine/digital.ts) legge da qui
// come ogni componente pilota il suo net, riusando l'algebra delle porte.

export interface DigitalSpec {
  /** Indici dei pin d'ingresso. */
  inPins: number[];
  /** Indice del pin che il componente pilota (null = solo lettura, es. uscita). */
  outPin: number | null;
  /** Livello d'uscita 0/1 dato lo stato dei net d'ingresso. */
  drive(inLevels: number[], params: Params, state: DeviceState, time: number): number;
  /** Comportamento sequenziale (flip-flop): stato iniziale + aggiornamento a fine passo. */
  sequential?: {
    init(): DeviceState;
    update(inLevels: number[], params: Params, state: DeviceState, time: number): DeviceState;
  };
}

const gateSpec = (kind: string, out: number): DigitalSpec => ({
  inPins: GATES[kind].inputs === 1 ? [0] : [0, 1],
  outPin: out,
  drive: (lvls) => GATES[kind].logic(lvls).o,
});

export const DIGITAL: Record<string, DigitalSpec> = {
  logic_in: { inPins: [], outPin: 0, drive: (_l, p) => ((p.high as boolean) ? 1 : 0) },
  clock: { inPins: [], outPin: 0, drive: (_l, p, _s, t) => squareLevel(t, p.freq as number) },
  logic_out: { inPins: [0], outPin: null, drive: () => 0 },
  not_gate: gateSpec('not', 1),
  buffer_gate: gateSpec('buffer', 1),
  and_gate: gateSpec('and', 2),
  or_gate: gateSpec('or', 2),
  nand_gate: gateSpec('nand', 2),
  nor_gate: gateSpec('nor', 2),
  xor_gate: gateSpec('xor', 2),
  xnor_gate: gateSpec('xnor', 2),
  seg_display: { inPins: [0, 1, 2, 3], outPin: null, drive: () => 0 },
  dff: {
    inPins: [0, 1],
    outPin: 2,
    drive: (_l, _p, s) => (s.q > 0.5 ? 1 : 0),
    sequential: {
      init: () => ({ q: 0, clkPrev: 0 }),
      update: ([d, clk], _p, s) => ({ q: s.clkPrev < 0.5 && clk >= 0.5 ? (d > 0.5 ? 1 : 0) : s.q, clkPrev: clk }),
    },
  },
  tff: {
    inPins: [0, 1],
    outPin: 2,
    drive: (_l, _p, s) => (s.q > 0.5 ? 1 : 0),
    sequential: {
      init: () => ({ q: 0, clkPrev: 0 }),
      update: ([t, clk], _p, s) => ({
        q: s.clkPrev < 0.5 && clk >= 0.5 && t > 0.5 ? (s.q > 0.5 ? 0 : 1) : s.q,
        clkPrev: clk,
      }),
    },
  },
};

export function isDigitalType(type: string): boolean {
  return type in DIGITAL || type === 'node';
}
