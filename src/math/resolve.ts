// Risoluzione dei termini simbolici sui valori vivi: dal simbolo al numero.

import type { Circuit } from '../model/types.ts';
import { pinKey } from '../model/types.ts';
import type { SimFrame } from '../viz/controller.ts';
import type { DerivedExpr, TermTarget } from './formula.ts';

export interface ResolveCtx {
  circuit: Circuit;
  frame: SimFrame | null;
}

export function resolveTarget(target: TermTarget, ctx: ResolveCtx): number | null {
  switch (target.kind) {
    case 'param': {
      const inst = ctx.circuit.components.find((c) => c.id === target.component);
      const v = inst?.params[target.param];
      return typeof v === 'number' ? v : null;
    }
    case 'componentData': {
      const v = ctx.frame?.result.outputs.get(target.component)?.data[target.key];
      return typeof v === 'number' ? v : null;
    }
    case 'netVoltage': {
      if (!ctx.frame) return null;
      const net = ctx.frame.compiled.netOfPin.get(pinKey(target.pin));
      return net === undefined ? null : ctx.frame.result.voltageOfNet(net);
    }
    case 'time':
      return ctx.frame?.result.time ?? null;
    case 'derived':
      return evalExpr(target.expr, ctx);
  }
}

function evalExpr(expr: DerivedExpr, ctx: ResolveCtx): number | null {
  switch (expr.op) {
    case 'const':
      return expr.value;
    case 'value':
      return resolveTarget(expr.target, ctx);
    case 'mul': {
      let acc = 1;
      for (const a of expr.args) {
        const v = evalExpr(a, ctx);
        if (v === null) return null;
        acc *= v;
      }
      return acc;
    }
    case 'add': {
      let acc = 0;
      for (const a of expr.args) {
        const v = evalExpr(a, ctx);
        if (v === null) return null;
        acc += v;
      }
      return acc;
    }
    case 'div': {
      const a = evalExpr(expr.a, ctx);
      const b = evalExpr(expr.b, ctx);
      return a === null || b === null || b === 0 ? null : a / b;
    }
  }
}
