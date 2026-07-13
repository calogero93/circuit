// Scala divergente per la tensione di nodo: blu (negativa) → neutro (0 V) →
// arancio-rosso (positiva), normalizzata sul massimo corrente del circuito.

const NEG = [72, 132, 245];
const MID = [128, 138, 156];
const POS = [244, 98, 58];

function mix(a: number[], b: number[], f: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function voltageColor(v: number, vmax: number): string {
  if (!Number.isFinite(v) || vmax <= 0) return mix(MID, MID, 0);
  const f = Math.max(-1, Math.min(1, v / vmax));
  return f >= 0 ? mix(MID, POS, f) : mix(MID, NEG, -f);
}
