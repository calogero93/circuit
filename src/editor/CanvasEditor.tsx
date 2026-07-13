// Editor 2D su griglia SVG: piazzamento, trascinamento con snap, rotazione,
// strumento filo (pin → pin, instradamento ortogonale, merge dei nodi),
// sonde, pan/zoom. Sopra al circuito vivono i layer di visualizzazione:
// colore dei fili ∝ tensione di nodo e puntini di corrente animati.
// Tutto il rendering legge dal modello e dagli OUTPUT della simulazione.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getDef } from '../model/registry.ts';
import { compile } from '../model/netlist.ts';
import { pinKey, type ComponentInstance, type PinRef, freshId } from '../model/types.ts';
import { formatSI } from '../model/units.ts';
import { addComponent, addWire, moveComponent, setParam } from '../store/commands.ts';
import { useStudio } from '../store/studio.ts';
import { simController, useSimTick } from '../viz/controller.ts';
import { voltageColor } from '../viz/colors.ts';
import {
  GRID,
  distToRoute,
  orthogonalRoute,
  pathOfRoute,
  pinPosition,
  pointAlongRoute,
  routeLength,
  snap,
  type Pt,
} from './geometry.ts';
import { SymbolView } from './SymbolView.tsx';

const ID_PREFIX: Record<string, string> = {
  resistor: 'R',
  capacitor: 'C',
  inductor: 'L',
  diode: 'D',
  led: 'LED',
  vdc: 'V',
  vsin: 'V',
  idc: 'I',
  switch: 'SW',
  npn: 'Q',
  ground: 'GND',
};

interface HoverInfo {
  x: number;
  y: number;
  lines: string[];
}

/** Puntini di corrente animati: densità/velocità ∝ |I|, direzione ∝ segno. */
function CurrentDots() {
  const gRef = useRef<SVGGElement>(null);
  const phases = useRef(new Map<string, number>());

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const SPACING = 26;
    const tickLoop = (now: number) => {
      raf = requestAnimationFrame(tickLoop);
      const dtms = Math.min(100, now - last);
      last = now;
      const g = gRef.current;
      const frame = simController.frame;
      if (!g) return;
      while (g.firstChild) g.removeChild(g.firstChild);
      if (!frame || !useStudio.getState().running) return;
      const { circuit } = useStudio.getState();

      // normalizzazione: velocità relativa alla corrente massima del circuito
      let imax = 0;
      const currents = new Map<string, number>();
      for (const w of circuit.wires) {
        const inst = circuit.components.find((c) => c.id === w.from.component);
        if (!inst) continue;
        const out = frame.result.outputs.get(inst.id);
        if (!out) continue;
        const i = -(out.pinCurrents[w.from.pin] ?? 0); // corrente che esce dal pin nel filo
        currents.set(w.id, i);
        imax = Math.max(imax, Math.abs(i));
      }
      if (imax < 1e-12) return;

      for (const w of circuit.wires) {
        const i = currents.get(w.id) ?? 0;
        if (Math.abs(i) < imax * 1e-4 || Math.abs(i) < 1e-12) continue;
        const a = pinPositionOfInst(circuit.components, w.from);
        const b = pinPositionOfInst(circuit.components, w.to);
        if (!a || !b) continue;
        const route = orthogonalRoute(a, b);
        const len = routeLength(route);
        if (len < 4) continue;
        const speed = 90 * (i / imax); // px/s con segno
        const phase = ((phases.current.get(w.id) ?? 0) + (speed * dtms) / 1000) % SPACING;
        phases.current.set(w.id, phase);
        const offset = ((phase % SPACING) + SPACING) % SPACING;
        for (let d = offset; d <= len; d += SPACING) {
          const p = pointAlongRoute(route, d);
          const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          dot.setAttribute('cx', String(p.x));
          dot.setAttribute('cy', String(p.y));
          dot.setAttribute('r', '2.6');
          dot.setAttribute('class', 'current-dot');
          g.appendChild(dot);
        }
      }
    };
    raf = requestAnimationFrame(tickLoop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <g ref={gRef} className="dots-layer" />;
}

function pinPositionOfInst(components: ComponentInstance[], ref: PinRef): Pt | null {
  const inst = components.find((c) => c.id === ref.component);
  return inst ? pinPosition(inst, ref.pin) : null;
}

export function CanvasEditor() {
  const circuit = useStudio((s) => s.circuit);
  const tool = useStudio((s) => s.tool);
  const setTool = useStudio((s) => s.setTool);
  const selection = useStudio((s) => s.selection);
  const setSelection = useStudio((s) => s.setSelection);
  const execute = useStudio((s) => s.execute);
  const probes = useStudio((s) => s.probes);
  const addProbe = useStudio((s) => s.addProbe);
  const removeProbe = useStudio((s) => s.removeProbe);
  const ab = useStudio((s) => s.ab);
  const mathHover = useStudio((s) => s.hover);
  const setHoveredComponent = useStudio((s) => s.setHoveredComponent);
  const markEvent = useStudio((s) => s.markEvent);
  useSimTick((s) => s.tick); // re-render a bassa frequenza per i valori vivi

  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ tx: 40, ty: 20, scale: 1 });
  const [mouse, setMouse] = useState<Pt>({ x: 0, y: 0 });
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const drag = useRef<
    | { kind: 'component'; id: string; dx: number; dy: number; moved: boolean }
    | { kind: 'pan'; startX: number; startY: number; tx: number; ty: number; moved: boolean }
    | null
  >(null);

  const frame = simController.frame;
  const netOf = (ref: PinRef): number | undefined => frame?.compiled.netOfPin.get(pinKey(ref));
  const vmax = useMemo(() => {
    if (!frame) return 1;
    let m = 0;
    for (let n = 0; n < frame.compiled.nNodes; n++) m = Math.max(m, Math.abs(frame.result.voltageOfNet(n)));
    return Math.max(m, 1e-3);
  }, [frame?.result]); // eslint-disable-line react-hooks/exhaustive-deps

  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - view.tx) / view.scale,
      y: (e.clientY - rect.top - view.ty) / view.scale,
    };
  };

  const findPinNear = (p: Pt, radius = 14): PinRef | null => {
    for (const inst of circuit.components) {
      const def = getDef(inst.type);
      for (let i = 0; i < def.pins.length; i++) {
        const pos = pinPosition(inst, i);
        if (Math.hypot(pos.x - p.x, pos.y - p.y) <= radius) return { component: inst.id, pin: i };
      }
    }
    return null;
  };

  const findComponentNear = (p: Pt): ComponentInstance | null => {
    for (let k = circuit.components.length - 1; k >= 0; k--) {
      const inst = circuit.components[k];
      if (Math.abs(p.x - inst.x) <= 46 && Math.abs(p.y - inst.y) <= 46) return inst;
    }
    return null;
  };

  const findWireNear = (p: Pt): string | null => {
    for (const w of circuit.wires) {
      const a = pinPositionOfInst(circuit.components, w.from);
      const b = pinPositionOfInst(circuit.components, w.to);
      if (a && b && distToRoute(p, orthogonalRoute(a, b)) < 8) return w.id;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    const p = toWorld(e);
    svgRef.current?.setPointerCapture(e.pointerId);

    if (tool.kind === 'place') {
      const def = getDef(tool.type);
      const prefix = ID_PREFIX[tool.type] ?? 'U';
      const taken = (id: string) => circuit.components.some((c) => c.id === id);
      const inst: ComponentInstance = {
        id: freshId(prefix, taken),
        type: tool.type,
        x: snap(p.x),
        y: snap(p.y),
        rot: tool.rot,
        params: { ...def.defaults },
      };
      execute(addComponent(inst));
      setSelection([inst.id]);
      return;
    }

    if (tool.kind === 'wire') {
      const pin = findPinNear(p);
      if (!pin) return;
      if (!tool.from) {
        setTool({ kind: 'wire', from: pin });
      } else if (pinKey(tool.from) !== pinKey(pin)) {
        const taken = (id: string) => circuit.wires.some((w) => w.id === id);
        execute(addWire({ id: freshId('w', taken), from: tool.from, to: pin }));
        setTool({ kind: 'wire', from: null });
      }
      return;
    }

    if (tool.kind === 'probe') {
      const pin = findPinNear(p, 18);
      if (!pin) return;
      const compiled = compile(circuit);
      const net = compiled.netOfPin.get(pinKey(pin));
      const existing = probes.find((pr) => compiled.netOfPin.get(pinKey(pr.pin)) === net);
      if (existing) removeProbe(existing.id);
      else addProbe(pin);
      return;
    }

    // select
    const comp = findComponentNear(p);
    if (comp) {
      setSelection([comp.id]);
      drag.current = { kind: 'component', id: comp.id, dx: comp.x - p.x, dy: comp.y - p.y, moved: false };
      return;
    }
    const wireId = findWireNear(p);
    if (wireId) {
      setSelection([wireId]);
      return;
    }
    drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toWorld(e);
    setMouse(p);
    const d = drag.current;
    if (d?.kind === 'component') {
      const inst = circuit.components.find((c) => c.id === d.id);
      if (inst) {
        const nx = snap(p.x + d.dx);
        const ny = snap(p.y + d.dy);
        if (nx !== inst.x || ny !== inst.y) {
          d.moved = true;
          execute(moveComponent(d.id, { x: inst.x, y: inst.y }, { x: nx, y: ny }));
        }
      }
      return;
    }
    if (d?.kind === 'pan') {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
      return;
    }

    // tooltip probe: hover su pin o componente
    if (tool.kind === 'select' && frame) {
      const pin = findPinNear(p, 10);
      const rect = svgRef.current!.getBoundingClientRect();
      const at = { x: e.clientX - rect.left + 14, y: e.clientY - rect.top + 14 };
      if (pin) {
        const net = netOf(pin);
        const v = net === undefined ? NaN : frame.result.voltageOfNet(net);
        setHoverInfo({ ...at, lines: [`nodo ${net === undefined ? '?' : frame.compiled.netLabel(net)}`, `V = ${formatSI(v, 'V')}`] });
        return;
      }
      const comp = findComponentNear(p);
      if (comp) {
        setHoveredComponent(comp.id);
        const out = frame.result.outputs.get(comp.id);
        const lines = [`${getDef(comp.type).name} ${comp.id}`];
        if (out) {
          if (out.data.v !== undefined) lines.push(`V = ${formatSI(out.data.v, 'V')}`);
          if (out.data.i !== undefined) lines.push(`I = ${formatSI(out.data.i, 'A')}`);
          if (out.data.ic !== undefined) lines.push(`IC = ${formatSI(out.data.ic, 'A')}  IB = ${formatSI(out.data.ib, 'A')}`);
          if (out.data.vce !== undefined) lines.push(`VCE = ${formatSI(out.data.vce, 'V')}`);
        }
        setHoverInfo({ ...at, lines });
        return;
      }
      setHoveredComponent(null);
    }
    setHoverInfo(null);
  };

  const onPointerUp = () => {
    const d = drag.current;
    if (d?.kind === 'pan' && !d.moved) setSelection([]);
    drag.current = null;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = toWorld(e);
    const comp = findComponentNear(p);
    if (comp && comp.type === 'switch') {
      execute(setParam(comp.id, 'closed', comp.params.closed, !comp.params.closed));
      markEvent(comp.id, simController.time);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const rect = svgRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setView((v) => {
      const scale = Math.min(3, Math.max(0.35, v.scale * factor));
      const k = scale / v.scale;
      return { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  };

  // insiemi evidenziati dal pannello matematico
  const highlightComps = new Set(mathHover?.components ?? []);
  const highlightNets = new Set(
    (mathHover?.pins ?? []).map((ref) => netOf(ref)).filter((n): n is number => n !== undefined),
  );

  // pallini di giunzione: pin condivisi da 2+ fili
  const wireCountByPin = new Map<string, number>();
  for (const w of circuit.wires) {
    for (const ref of [w.from, w.to]) {
      const k = pinKey(ref);
      wireCountByPin.set(k, (wireCountByPin.get(k) ?? 0) + 1);
    }
  }

  return (
    <div className="canvas-wrap" data-testid="canvas">
      <svg
        ref={svgRef}
        className={`canvas-svg tool-${tool.kind}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={(e) => {
          e.preventDefault();
          setTool({ kind: 'select' });
        }}
      >
        <defs>
          <pattern id="grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
            <circle cx={0.75} cy={0.75} r={0.75} className="grid-dot" />
          </pattern>
        </defs>
        <g transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
          <rect x={-2000} y={-2000} width={6000} height={6000} fill="url(#grid)" pointerEvents="none" />

          {/* fili colorati per tensione di nodo */}
          {circuit.wires.map((w) => {
            const a = pinPositionOfInst(circuit.components, w.from);
            const b = pinPositionOfInst(circuit.components, w.to);
            if (!a || !b) return null;
            const net = netOf(w.from);
            const v = net === undefined || !frame ? NaN : frame.result.voltageOfNet(net);
            const selected = selection.includes(w.id);
            const highlighted = net !== undefined && highlightNets.has(net);
            return (
              <path
                key={w.id}
                d={pathOfRoute(orthogonalRoute(a, b))}
                className={`wire${selected ? ' selected' : ''}${highlighted ? ' highlighted' : ''}`}
                stroke={Number.isFinite(v) ? voltageColor(v, vmax) : undefined}
              />
            );
          })}

          {/* pallini di giunzione */}
          {[...wireCountByPin.entries()]
            .filter(([, n]) => n >= 2)
            .map(([k]) => {
              const [component, pin] = k.split(':');
              const pos = pinPositionOfInst(circuit.components, { component, pin: Number(pin) });
              return pos ? <circle key={k} cx={pos.x} cy={pos.y} r={3.5} className="junction" /> : null;
            })}

          <CurrentDots />

          {/* componenti */}
          {circuit.components.map((inst) => {
            const def = getDef(inst.type);
            const selected = selection.includes(inst.id);
            const highlighted = highlightComps.has(inst.id);
            const out = frame?.result.outputs.get(inst.id);
            const ledI = inst.type === 'led' ? Math.abs(out?.data.id ?? 0) : 0;
            const burned = def.maxCurrent !== undefined && ledI > 5 * def.maxCurrent;
            const mainParam = def.params[0];
            const isAB = ab?.componentId === inst.id;
            return (
              <g key={inst.id}>
                <g
                  transform={`translate(${inst.x},${inst.y}) rotate(${inst.rot * 90})`}
                  className={`symbol${selected ? ' selected' : ''}${highlighted ? ' highlighted' : ''}`}
                >
                  {inst.type === 'led' && ledI > 1e-5 && (
                    <circle cx={0} cy={0} r={18 + 8 * Math.min(1, ledI / 0.02)} className="led-glow"
                      style={{ opacity: Math.min(0.85, 0.15 + ledI / 0.02) }} />
                  )}
                  <SymbolView prims={def.symbol(inst.params)} />
                  {def.pins.map((pin, i) => (
                    <circle key={i} cx={pin.x} cy={pin.y} r={3.2} className="pin" />
                  ))}
                  {burned && (
                    <g className="burned">
                      <line x1={-10} y1={-26} x2={10} y2={-8} />
                      <line x1={10} y1={-26} x2={-10} y2={-8} />
                    </g>
                  )}
                  {isAB && <rect x={-46} y={-46} width={92} height={92} className="ab-badge" rx={8} />}
                </g>
                <text
                  x={inst.rot % 2 === 0 ? inst.x : inst.x + 34}
                  y={inst.rot % 2 === 0 ? inst.y + 36 : inst.y + 4}
                  className="comp-label"
                  textAnchor={inst.rot % 2 === 0 ? 'middle' : 'start'}
                >
                  {inst.id}
                  {mainParam && mainParam.kind === 'number'
                    ? ` · ${formatSI(inst.params[mainParam.key] as number, mainParam.unit)}`
                    : ''}
                </text>
              </g>
            );
          })}

          {/* sonde */}
          {probes.map((probe) => {
            const pos = pinPositionOfInst(circuit.components, probe.pin);
            if (!pos) return null;
            return (
              <g key={probe.id} className="probe" transform={`translate(${pos.x},${pos.y})`}>
                <line x1={0} y1={0} x2={14} y2={-18} stroke={probe.color} />
                <circle cx={0} cy={0} r={4.5} fill={probe.color} />
                <rect x={10} y={-34} width={26} height={17} rx={4} fill={probe.color} />
                <text x={23} y={-21.5} textAnchor="middle" className="probe-label">
                  {probe.label}
                </text>
              </g>
            );
          })}

          {/* anteprime: piazzamento e filo */}
          {tool.kind === 'place' && (
            <g
              transform={`translate(${snap(mouse.x)},${snap(mouse.y)}) rotate(${tool.rot * 90})`}
              className="symbol ghost"
            >
              <SymbolView prims={getDef(tool.type).symbol(getDef(tool.type).defaults)} />
            </g>
          )}
          {tool.kind === 'wire' && tool.from && (() => {
            const a = pinPositionOfInst(circuit.components, tool.from);
            return a ? (
              <path d={pathOfRoute(orthogonalRoute(a, mouse))} className="wire preview" />
            ) : null;
          })()}
        </g>
      </svg>

      {hoverInfo && (
        <div className="canvas-tooltip" style={{ left: hoverInfo.x, top: hoverInfo.y }}>
          {hoverInfo.lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}
