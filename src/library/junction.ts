// Fisica delle giunzioni p-n condivisa da diodo, LED e BJT: equazione di
// Shockley, esponenziale protetto e limiting di tensione (stile SPICE pnjlim)
// per la convergenza del Newton-Raphson.

/** Tensione termica a ~300 K. */
export const VT = 0.025852;

/** exp con estensione lineare oltre x=200: evita overflow e Jacobiane infinite. */
export function safeExp(x: number): number {
  if (x > 200) return Math.exp(200) * (1 + (x - 200));
  return Math.exp(x);
}

/** Tensione critica oltre cui il limiting entra in funzione. */
export function vcritOf(Is: number, nVt: number): number {
  return nVt * Math.log(nVt / (Math.SQRT2 * Is));
}

/**
 * Limita la nuova tensione di giunzione rispetto alla precedente iterata:
 * la crescita oltre vcrit diventa logaritmica, come in SPICE.
 */
export function pnjlim(vnew: number, vold: number, nVt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * nVt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / nVt;
      return arg > 0 ? vold + nVt * Math.log(arg) : vcrit;
    }
    return nVt * Math.log(vnew / nVt);
  }
  return vnew;
}

export interface JunctionPoint {
  /** Tensione (limitata) usata come punto di linearizzazione. */
  vd: number;
  /** Corrente di Shockley in vd. */
  id: number;
  /** Conduttanza differenziale dI/dV in vd. */
  gd: number;
}

export function evalJunction(vd: number, Is: number, nVt: number): JunctionPoint {
  const e = safeExp(vd / nVt);
  return { vd, id: Is * (e - 1), gd: (Is * e) / nVt };
}

export function shockleyCurrent(vd: number, Is: number, nVt: number): number {
  return Is * (safeExp(vd / nVt) - 1);
}

import type { StampContext } from '../model/device.ts';

/**
 * Tensione di giunzione limitata per l'iterata NR corrente, con memoria del
 * punto di linearizzazione precedente nel contesto (stile SPICE). Se il
 * limiting interviene, l'iterata non può essere dichiarata convergente.
 */
export function limitedJunctionVoltage(
  ctx: StampContext,
  a: number,
  b: number,
  nVt: number,
  vcrit: number,
): number {
  const key = `j:${a}:${b}`;
  const vnew = ctx.vNow(a) - ctx.vNow(b);
  const vold = ctx.getMemory(key) ?? ctx.vPrev(a) - ctx.vPrev(b);
  const vd = pnjlim(vnew, vold, nVt, vcrit);
  ctx.setMemory(key, vd);
  if (Math.abs(vd - vnew) > 1e-9) ctx.markNotConverged();
  return vd;
}
