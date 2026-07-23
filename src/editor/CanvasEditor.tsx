// Editor 2D su griglia SVG: piazzamento, trascinamento con snap, rotazione,
// strumento filo (pin → pin, instradamento ortogonale, merge dei nodi),
// sonde, pan/zoom. Sopra al circuito vivono i layer di visualizzazione:
// colore dei fili ∝ tensione di nodo e puntini di corrente animati.
// Tutto il rendering legge dal modello e dagli OUTPUT della simulazione.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getDef } from '../model/registry.ts';
import { compile } from '../model/netlist.ts';
import { pinKey, type ComponentInstance, type PinRef, type Wire, freshId } from '../model/types.ts';
import { formatSI } from '../model/units.ts';
import { SEG_LINES } from '../library/digital.ts';
import { bridgedComponent, multimeterReading } from './instruments.ts';
import {
  addComponent,
  addWire,
  branchWire,
  flipWireElbow,
  moveComponents,
  setParam,
} from '../store/commands.ts';
import { useStudio } from '../store/studio.ts';
import { simController, useSimTick } from '../viz/controller.ts';
import { voltageColor } from '../viz/colors.ts';
import {
  GRID,
  distToRoute,
  pathOfRoute,
  pinPosition,
  pointAlongRoute,
  projectOnRoute,
  routeLength,
  routeThroughPoints,
  snap,
  splitRoute,
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
  node: 'J',
  logic_in: 'IN',
  clock: 'CLK',
  logic_out: 'OUT',
  not_gate: 'INV',
  buffer_gate: 'BUF',
  and_gate: 'AND',
  or_gate: 'OR',
  nand_gate: 'NAND',
  nor_gate: 'NOR',
  xor_gate: 'XOR',
  xnor_gate: 'XNOR',
  dff: 'FF',
  tff: 'FF',
  counter4: 'CNT',
  shiftreg4: 'SR',
  decoder24: 'DEC',
  seg_display: 'DISP',
  multimeter: 'MM',
  ammeter: 'AM',
  ne555: 'U',
  comparator: 'CMP',
  vreg: 'VR',
  opamp: 'OA',
  zener: 'Z',
  potentiometer: 'POT',
  ldr: 'LDR',
  ntc: 'NTC',
  ptc: 'PTC',
  barometer: 'BAR',
  hall_sensor: 'HALL',
  humidity_sensor: 'HUM',
  nmos: 'M',
  pmos: 'M',
  pnp: 'Q',
  schottky: 'D',
  relay: 'K',
  fuse: 'F',
  bridge_rectifier: 'BR',
  transformer: 'T',
  pulse: 'V',
  vsin_phase: 'V',
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
          const route = wireRoute(w, a, b);
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

/** Percorso di un filo: esplicito, oppure ortogonale attraverso i waypoint. */
function wireRoute(w: Wire, a: Pt, b: Pt): Pt[] {
  return w.route ?? routeThroughPoints([a, ...(w.waypoints ?? []), b], w.elbow ?? false);
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
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [hoverNet, setHoverNet] = useState<number | null>(null); // net evidenziato all'hover
  const panMode = useRef(false); // Spazio premuto → pan invece di selezione a rettangolo
  const drag = useRef<
    | {
        kind: 'component';
        ids: string[];
        grabId: string;
        dx: number;
        dy: number;
        from: Record<string, Pt>;
        lastdx: number;
        lastdy: number;
        moved: boolean;
      }
    | { kind: 'pan'; startX: number; startY: number; tx: number; ty: number; moved: boolean }
    | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; moved: boolean }
    | null
  >(null);

  useEffect(() => {
    const inField = () =>
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement ||
      document.activeElement instanceof HTMLSelectElement;
    const down = (e: KeyboardEvent) => {
      if (e.key === ' ' && !inField()) {
        panMode.current = true;
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') panMode.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

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

  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).__circuitStudio) {
      (window as any).__circuitStudio.exportSVG = () => {
        const svg = svgRef.current;
        if (!svg) return;

        // Clona l'elemento SVG
        const cloned = svg.cloneNode(true) as SVGSVGElement;

        // Applica sfondo scuro SURFACE del tema
        cloned.style.background = '#14171f';

        // Rimuove i pallini di corrente animati
        const dots = cloned.querySelector('.dots-layer');
        if (dots) dots.parentNode?.removeChild(dots);

        // Rimuove evidenziazioni di selezione e matematiche
        cloned.querySelectorAll('.selected').forEach((el) => el.classList.remove('selected'));
        cloned.querySelectorAll('.highlighted').forEach((el) => el.classList.remove('highlighted'));

        const serializer = new XMLSerializer();
        const source = '<?xml version="1.0" standalone="no"?>\r\n' + serializer.serializeToString(cloned);

        const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'schema-circuito.svg';
        a.click();
        URL.revokeObjectURL(url);
      };
    }
  }, [circuit, probes, tool, selection, view]);

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
      const r = inst.type === 'node' ? 10 : 46; // il nodo di giunzione è piccolo
      if (Math.abs(p.x - inst.x) <= r && Math.abs(p.y - inst.y) <= r) return inst;
    }
    return null;
  };

  const findWireNear = (p: Pt): string | null => {
    for (const w of circuit.wires) {
      const a = pinPositionOfInst(circuit.components, w.from);
      const b = pinPositionOfInst(circuit.components, w.to);
      if (!a || !b) continue;
      const route = wireRoute(w, a, b);
      if (distToRoute(p, route) < 8) return w.id;
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
      // raggio d'aggancio generoso: chiudere sul pin deve essere facile, un
      // click nel vuoto (per il gomito) o su un filo (giunzione) resta possibile
      const pin = findPinNear(p, 24);
      const elbow = tool.elbow ?? false;
      if (!tool.from) {
        // primo click: aggancia il pin di partenza
        if (pin) setTool({ kind: 'wire', from: pin, elbow, waypoints: [] });
        return;
      }
      if (!pin) {
        // click su un filo esistente → giunzione a T; nel vuoto → punto di passaggio
        const targetId = findWireNear(p);
        const target = targetId ? circuit.wires.find((w) => w.id === targetId) : null;
        const start = pinPositionOfInst(circuit.components, tool.from);
        const ta = target && pinPositionOfInst(circuit.components, target.from);
        const tb = target && pinPositionOfInst(circuit.components, target.to);
        if (target && ta && tb && start) {
          const targetRoute = wireRoute(target, ta, tb);
          const P = projectOnRoute(targetRoute, p).point;
          const takenC = (id: string) => circuit.components.some((c) => c.id === id);
          const node: ComponentInstance = { id: freshId('J', takenC), type: 'node', x: P.x, y: P.y, rot: 0, params: {} };
          const nodePin: PinRef = { component: node.id, pin: 0 };
          const [rA, rB] = splitRoute(targetRoute, P);
          const takenW = (id: string) => circuit.wires.some((w) => w.id === id);
          const w1: Wire = { id: freshId('w', takenW), from: target.from, to: nodePin, route: rA };
          const w2: Wire = { id: freshId('w', takenW), from: nodePin, to: target.to, route: rB };
          const w3: Wire = { id: freshId('w', takenW), from: tool.from, to: nodePin, elbow, waypoints: tool.waypoints?.length ? tool.waypoints : undefined };
          execute(branchWire(node, target, [w1, w2, w3]));
          setTool({ kind: 'wire', from: null, elbow });
          return;
        }
        // vuoto: aggiungi un punto di passaggio (instradamento a più segmenti)
        setTool({ kind: 'wire', from: tool.from, elbow, waypoints: [...(tool.waypoints ?? []), { x: snap(p.x), y: snap(p.y) }] });
        return;
      }
      // click su un pin diverso: chiude il filo (auto-instradato attraverso i waypoint)
      if (pinKey(tool.from) !== pinKey(pin)) {
        const taken = (id: string) => circuit.wires.some((w) => w.id === id);
        const id = freshId('w', taken);
        execute(addWire({ id, from: tool.from, to: pin, elbow, waypoints: tool.waypoints?.length ? tool.waypoints : undefined }));
        setTool({ kind: 'wire', from: null, elbow });
      }
      return;
    }

    if (tool.kind === 'probe') {
      // allow placing probe on a pin or on a wire (mid-air)
      let pin = findPinNear(p, 18);
      const compiled = compile(circuit);
      if (!pin) {
        const wireId = findWireNear(p);
        if (!wireId) return;
        const wire = circuit.wires.find((w) => w.id === wireId);
        if (!wire) return;
        const net = compiled.netOfPin.get(pinKey(wire.from));
        if (net === undefined) return;
        // find a representative pin on this net
        for (const [k, v] of compiled.netOfPin.entries()) {
          if (v === net) {
            const [component, pinIdx] = k.split(':');
            pin = { component, pin: Number(pinIdx) };
            break;
          }
        }
        if (!pin) return;
      }
      const net = compiled.netOfPin.get(pinKey(pin));
      const existing = probes.find((pr) => compiled.netOfPin.get(pinKey(pr.pin)) === net);
      if (existing) removeProbe(existing.id);
      else addProbe(pin);
      return;
    }

    // select
    const comp = findComponentNear(p);
    if (comp) {
      // se il componente è già in una selezione multipla, trascina l'intero gruppo
      const already = selection.includes(comp.id);
      const groupIds =
        already && selection.length > 1
          ? selection.filter((id) => circuit.components.some((c) => c.id === id))
          : [comp.id];
      if (!already) setSelection([comp.id]);
      const from: Record<string, Pt> = {};
      for (const id of groupIds) {
        const inst = circuit.components.find((c) => c.id === id);
        if (inst) from[id] = { x: inst.x, y: inst.y };
      }
      drag.current = {
        kind: 'component',
        ids: Object.keys(from),
        grabId: comp.id,
        dx: comp.x - p.x,
        dy: comp.y - p.y,
        from,
        lastdx: 0,
        lastdy: 0,
        moved: false,
      };
      return;
    }
    const wireId = findWireNear(p);
    if (wireId) {
      setSelection([wireId]);
      return;
    }
    // area vuota: Spazio o tasto centrale → pan; altrimenti rettangolo di selezione
    if (panMode.current || e.button === 1) {
      drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty, moved: false };
    } else {
      drag.current = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false };
      setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toWorld(e);
    setMouse(p);
    const d = drag.current;
    if (d?.kind === 'component') {
      const grab = d.from[d.grabId];
      const ddx = snap(p.x + d.dx) - grab.x;
      const ddy = snap(p.y + d.dy) - grab.y;
      if (ddx !== d.lastdx || ddy !== d.lastdy) {
        d.lastdx = ddx;
        d.lastdy = ddy;
        d.moved = true;
        const to: Record<string, Pt> = {};
        for (const id of d.ids) to[id] = { x: d.from[id].x + ddx, y: d.from[id].y + ddy };
        execute(moveComponents(d.ids, d.from, to));
      }
      return;
    }
    if (d?.kind === 'marquee') {
      d.x1 = p.x;
      d.y1 = p.y;
      if (Math.abs(d.x1 - d.x0) + Math.abs(d.y1 - d.y0) > 3) d.moved = true;
      setMarquee({ x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 });
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
        setHoverNet(net ?? null);
        const v = net === undefined ? NaN : frame.result.voltageOfNet(net);
        setHoverInfo({ ...at, lines: [`nodo ${net === undefined ? '?' : frame.compiled.netLabel(net)}`, `V = ${formatSI(v, 'V')}`] });
        return;
      }
      const comp = findComponentNear(p);
      if (comp) {
        setHoverNet(null);
        setHoveredComponent(comp.id);
        const out = frame.result.outputs.get(comp.id);
        const lines = [`${getDef(comp.type).name} ${comp.id}`];
        if (out) {
          if (out.data.v !== undefined) lines.push(`V = ${formatSI(Number(out.data.v), 'V')}`);
          if (out.data.i !== undefined) lines.push(`I = ${formatSI(Number(out.data.i), 'A')}`);
          if (out.data.ic !== undefined) lines.push(`IC = ${formatSI(Number(out.data.ic), 'A')}  IB = ${formatSI(Number(out.data.ib), 'A')}`);
          if (out.data.vce !== undefined) lines.push(`VCE = ${formatSI(Number(out.data.vce), 'V')}`);
          if (out.data.logic !== undefined) {
            const parts: string[] = [];
            if (out.data.a !== undefined) parts.push(`A=${out.data.a}`);
            if (out.data.b !== undefined) parts.push(`B=${out.data.b}`);
            parts.push(`→ ${out.data.logic}`);
            lines.push(`logica: ${parts.join('  ')}`);
          }
        }
        setHoverInfo({ ...at, lines });
        return;
      }
      setHoveredComponent(null);
      const wid = findWireNear(p);
      const w = wid ? circuit.wires.find((x) => x.id === wid) : null;
      setHoverNet(w ? netOf(w.from) ?? null : null);
    } else {
      setHoverNet(null);
    }
    setHoverInfo(null);
  };

  const onPointerUp = () => {
    const d = drag.current;
    if (d?.kind === 'pan' && !d.moved) setSelection([]);
    if (d?.kind === 'marquee') {
      if (!d.moved) {
        setSelection([]);
      } else {
        const xmin = Math.min(d.x0, d.x1);
        const xmax = Math.max(d.x0, d.x1);
        const ymin = Math.min(d.y0, d.y1);
        const ymax = Math.max(d.y0, d.y1);
        const inBox = (x: number, y: number) => x >= xmin && x <= xmax && y >= ymin && y <= ymax;
        const ids: string[] = [];
        for (const c of circuit.components) if (inBox(c.x, c.y)) ids.push(c.id);
        for (const w of circuit.wires) {
          const a = pinPositionOfInst(circuit.components, w.from);
          const b = pinPositionOfInst(circuit.components, w.to);
          if (!a || !b) continue;
          const route = wireRoute(w, a, b);
          if (route.some((pt) => inBox(pt.x, pt.y))) ids.push(w.id);
        }
        setSelection(ids);
      }
      setMarquee(null);
    }
    drag.current = null;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = toWorld(e);
    const comp = findComponentNear(p);
    if (comp && comp.type === 'switch') {
      execute(setParam(comp.id, 'closed', comp.params.closed, !comp.params.closed));
      markEvent(comp.id, simController.time);
      return;
    }
    if (comp && comp.type === 'logic_in') {
      execute(setParam(comp.id, 'high', comp.params.high, !comp.params.high));
      markEvent(comp.id, simController.time);
      return;
    }
    // doppio-click su un filo: inverte il verso del gomito (re-instrada)
    const wireId = findWireNear(p);
    if (wireId) execute(flipWireElbow(wireId));
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
            const highlighted = net !== undefined && (highlightNets.has(net) || net === hoverNet);
            const route = wireRoute(w, a, b);
            return (
              <path
                key={w.id}
                d={pathOfRoute(route)}
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
            const ledI = inst.type === 'led' ? Math.abs(Number(out?.data.id ?? 0)) : 0;
            const ledColor = inst.type === 'led' ? String(inst.params.color ?? '#ff5c5c') : '#ff5c5c';
            const logicLit = inst.type === 'logic_out' ? Number(out?.data.level ?? 0) : 0;
            let instrReading: string | null = null;
            if (frame && inst.type === 'multimeter') {
              const mode = String(inst.params.mode ?? 'V');
              const bridged = mode === 'V' ? null : bridgedComponent(circuit, frame.compiled.netOfPin, inst.id);
              instrReading = multimeterReading(inst, out, bridged, bridged ? frame.result.outputs.get(bridged.id) : undefined);
            } else if (frame && inst.type === 'ammeter') {
              instrReading = formatSI(Number(out?.data.i ?? 0), 'A', 3);
            }
            const burned = def.maxCurrent !== undefined && ledI > 5 * def.maxCurrent;
            const mainParam = def.params[0];
            const isAB = ab?.componentId === inst.id;
            return (
              <g key={inst.id}>
                <g
                  transform={`translate(${inst.x},${inst.y}) rotate(${inst.rot * 90})`}
                  className={`symbol${selected ? ' selected' : ''}${highlighted ? ' highlighted' : ''}`}
                >
                  {inst.type === 'led' && ledI > 1e-6 && (
                    <circle cx={0} cy={0} r={16 + 10 * Math.min(1, ledI / 0.02)} className="led-glow"
                      style={{ fill: ledColor, opacity: Math.min(0.9, 0.2 + ledI / 0.015) }} />
                  )}
                  {inst.type === 'logic_out' && logicLit > 0.5 && (
                    <circle cx={0} cy={0} r={16} className="led-glow" style={{ opacity: 0.2 + 0.6 * logicLit }} />
                  )}
                  <SymbolView prims={def.symbol(inst.params)} />
                  {inst.type === 'seg_display' &&
                    SEG_LINES.map(([x1, y1, x2, y2], i) =>
                      Number(out?.data[`s${i}`] ?? 0) > 0.5 ? (
                        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="seg-on" />
                      ) : null,
                    )}
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
                {inst.type !== 'node' && (
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
                )}
                {instrReading !== null && (
                  <text x={inst.x} y={inst.y - 24} className="instrument-reading" textAnchor="middle">
                    {instrReading}
                  </text>
                )}
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
            const start = pinPositionOfInst(circuit.components, tool.from);
            if (!start) return null;
            const route = routeThroughPoints([start, ...(tool.waypoints ?? []), mouse], tool.elbow ?? false);
            return <path d={pathOfRoute(route)} className="wire preview" />;
          })()}

          {/* rettangolo di selezione */}
          {marquee && (
            <rect
              x={Math.min(marquee.x0, marquee.x1)}
              y={Math.min(marquee.y0, marquee.y1)}
              width={Math.abs(marquee.x1 - marquee.x0)}
              height={Math.abs(marquee.y1 - marquee.y0)}
              className="marquee"
              pointerEvents="none"
            />
          )}
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
