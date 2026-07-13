// Oscilloscopio: plotta V(t) delle sonde su canvas, con traccia "fantasma"
// A/B tratteggiata sovrapposta, marcatore τ = RC (63,2%) e crosshair su hover.
// Legge esclusivamente i campioni pubblicati dal controller (output della sim).

import { useEffect, useRef, useState } from 'react';
import { formatSI } from '../model/units.ts';
import { useStudio } from '../store/studio.ts';
import { simController, useSimTick } from './controller.ts';
import type { ScopeMarker } from './markers.ts';

const SURFACE = '#14171f';
const GRID_COLOR = 'rgba(148,160,184,0.12)';
const AXIS_INK = 'rgba(148,160,184,0.75)';
const MARKER = '#8ab4f8';

function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  return (r >= 5 ? 10 : r >= 2 ? 5 : r >= 1 ? 2 : 1) * mag;
}

export function Scope({ markers = [] }: { markers?: ScopeMarker[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const probes = useStudio((s) => s.probes);
  const timespan = useStudio((s) => s.scopeTimespan);
  const setTimespan = useStudio((s) => s.setScopeTimespan);
  const running = useStudio((s) => s.running);
  const setRunning = useStudio((s) => s.setRunning);
  const abGhost = useStudio((s) => s.abGhost);
  const tick = useSimTick((s) => s.tick);
  const [size, setSize] = useState({ w: 600, h: 200 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = size.w;
    const H = size.h;
    const padL = 52;
    const padR = 10;
    const padT = 8;
    const padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    ctx.fillStyle = SURFACE;
    ctx.fillRect(0, 0, W, H);
    if (plotW <= 10 || plotH <= 10) return;

    const samples = simController.samples;
    const tNow = samples.length ? samples[samples.length - 1].t : 0;
    const t0 = tNow - timespan;
    const visible = samples.filter((s) => s.t >= t0);

    // scala Y: include tracce reali e fantasma
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const s of visible) {
      for (const v of s.v) {
        if (Number.isFinite(v)) {
          vmin = Math.min(vmin, v);
          vmax = Math.max(vmax, v);
        }
      }
      if (s.g) {
        for (const v of s.g) {
          if (Number.isFinite(v)) {
            vmin = Math.min(vmin, v);
            vmax = Math.max(vmax, v);
          }
        }
      }
    }
    if (!Number.isFinite(vmin)) {
      vmin = -1;
      vmax = 1;
    }
    if (vmax - vmin < 0.5) {
      const mid = (vmax + vmin) / 2;
      vmin = mid - 0.5;
      vmax = mid + 0.5;
    }
    const pad = (vmax - vmin) * 0.12;
    vmin -= pad;
    vmax += pad;

    const xOf = (t: number) => padL + ((t - t0) / timespan) * plotW;
    const yOf = (v: number) => padT + (1 - (v - vmin) / (vmax - vmin)) * plotH;

    // griglia recessiva + etichette
    ctx.font = '10px ui-monospace, monospace';
    ctx.strokeStyle = GRID_COLOR;
    ctx.fillStyle = AXIS_INK;
    ctx.lineWidth = 1;
    const vStep = niceStep((vmax - vmin) / 4);
    for (let v = Math.ceil(vmin / vStep) * vStep; v <= vmax; v += vStep) {
      const y = yOf(v);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(formatSI(Math.abs(v) < vStep / 1e6 ? 0 : v, 'V', 2), padL - 6, y + 3);
    }
    const tStep = niceStep(timespan / 5);
    for (let t = Math.ceil(t0 / tStep) * tStep; t <= tNow; t += tStep) {
      const x = xOf(t);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, H - padB);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText(formatSI(t, 's', 4), x, H - 8);
    }
    // linea dello zero
    if (vmin < 0 && vmax > 0) {
      ctx.strokeStyle = 'rgba(148,160,184,0.35)';
      ctx.beginPath();
      ctx.moveTo(padL, yOf(0));
      ctx.lineTo(W - padR, yOf(0));
      ctx.stroke();
    }

    const drawTrace = (pick: (s: (typeof visible)[number]) => number | undefined, color: string, ghost: boolean) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = ghost ? 0.6 : 1;
      ctx.setLineDash(ghost ? [6, 5] : []);
      ctx.beginPath();
      let started = false;
      for (const s of visible) {
        const v = pick(s);
        if (v === undefined || !Number.isFinite(v)) continue;
        const x = xOf(s.t);
        const y = yOf(v);
        if (started) ctx.lineTo(x, y);
        else {
          ctx.moveTo(x, y);
          started = true;
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    };

    const state = useStudio.getState();
    probes.forEach((p, i) => {
      if (abGhost) drawTrace((s) => s.g?.[i], p.color, true);
      drawTrace((s) => s.v[i], p.color, false);
    });

    // marcatore τ = RC al 63,2%
    for (const m of markers) {
      const r = state.circuit.components.find((c) => c.id === m.rComponent);
      const c = state.circuit.components.find((x) => x.id === m.cComponent);
      const src = state.circuit.components.find((x) => x.id === m.sourceComponent);
      if (!r || !c || !src) continue;
      const tau = (r.params.R as number) * (c.params.C as number);
      const vTarget = 0.632 * (src.params.V as number);
      const tEvent = state.eventTimes[m.switchComponent] ?? 0;
      const tMark = tEvent + tau;
      ctx.strokeStyle = MARKER;
      ctx.fillStyle = MARKER;
      ctx.setLineDash([4, 4]);
      const yT = yOf(vTarget);
      ctx.beginPath();
      ctx.moveTo(padL, yT);
      ctx.lineTo(W - padR, yT);
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillText(`63,2% = ${formatSI(vTarget, 'V', 3)}`, padL + 6, yT - 4);
      if (tMark >= t0 && tMark <= tNow) {
        const xM = xOf(tMark);
        ctx.beginPath();
        ctx.moveTo(xM, padT);
        ctx.lineTo(xM, H - padB);
        ctx.stroke();
        ctx.fillText(`t₀+τ (τ=${formatSI(tau, 's', 3)})`, xM + 5, padT + 12);
      }
      ctx.setLineDash([]);
    }

    // crosshair su hover: legge il campione più vicino
    const mp = mouse.current;
    if (mp && mp.x >= padL && mp.x <= W - padR && visible.length > 1) {
      const tAt = t0 + ((mp.x - padL) / plotW) * timespan;
      let best = visible[0];
      for (const s of visible) if (Math.abs(s.t - tAt) < Math.abs(best.t - tAt)) best = s;
      const x = xOf(best.t);
      ctx.strokeStyle = 'rgba(220,226,240,0.4)';
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, H - padB);
      ctx.stroke();
      ctx.font = '11px ui-monospace, monospace';
      const lines = [
        `t = ${formatSI(best.t, 's', 3)}`,
        ...probes.map((p, i) => `${p.label}: ${formatSI(best.v[i], 'V', 3)}`),
      ];
      const bw = 130;
      const bx = Math.min(x + 8, W - padR - bw);
      ctx.fillStyle = 'rgba(10,12,18,0.92)';
      ctx.fillRect(bx, padT + 4, bw, 14 * lines.length + 8);
      lines.forEach((l, i) => {
        ctx.fillStyle = i === 0 ? AXIS_INK : probes[i - 1].color;
        ctx.textAlign = 'left';
        ctx.fillText(l, bx + 6, padT + 18 + i * 14);
      });
    }
  }, [tick, size, probes, timespan, abGhost, markers]);

  const last = simController.samples[simController.samples.length - 1];

  return (
    <div className="scope">
      <div className="scope-bar">
        <span className="scope-title">Oscilloscopio</span>
        <div className="scope-legend">
          {probes.length === 0 && <span className="muted">nessuna sonda — usa lo strumento Sonda su un nodo</span>}
          {probes.map((p, i) => (
            <span key={p.id} className="legend-item">
              <i className="legend-chip" style={{ background: p.color }} />
              {p.label}
              <b>{last && Number.isFinite(last.v[i]) ? formatSI(last.v[i], 'V', 3) : '—'}</b>
            </span>
          ))}
          {abGhost && (
            <span className="legend-item">
              <i className="legend-chip ghost-chip" />
              fantasma A/B
            </span>
          )}
        </div>
        <div className="scope-controls">
          <select value={timespan} onChange={(e) => setTimespan(Number(e.target.value))}>
            {[0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10].map((s) => (
              <option key={s} value={s}>
                {formatSI(s, 's', 2)}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => setRunning(!running)}>
            {running ? '‖ Pausa' : '▶ Esegui'}
          </button>
        </div>
      </div>
      <div ref={wrapRef} className="scope-canvas-wrap">
        <canvas
          ref={canvasRef}
          style={{ width: size.w, height: size.h }}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            mouse.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          }}
          onMouseLeave={() => (mouse.current = null)}
        />
      </div>
    </div>
  );
}
