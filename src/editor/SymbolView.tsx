// Rendering delle primitive grafiche del simbolo (dati → SVG).

import type { SymbolPrimitive } from '../model/registry.ts';

export function SymbolView({ prims }: { prims: SymbolPrimitive[] }) {
  return (
    <>
      {prims.map((p, i) => {
        switch (p.kind) {
          case 'path':
            return (
              <path key={i} d={p.d} fill={p.fill ?? 'none'} strokeWidth={p.width} />
            );
          case 'line':
            return <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} strokeWidth={p.width} />;
          case 'circle':
            return <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill ?? 'none'} />;
          case 'polygon':
            return <polygon key={i} points={p.points} fill={p.fill ?? 'none'} />;
          case 'text':
            return (
              <text key={i} x={p.x} y={p.y} fontSize={p.size ?? 11} className="symbol-text">
                {p.text}
              </text>
            );
        }
      })}
    </>
  );
}
