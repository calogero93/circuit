// Pannello matematico (seam §4.8): derivazioni KaTeX con i termini mappati
// sui valori vivi della simulazione. Hover su un termine → evidenzia il
// componente/nodo nell'editor; hover su un componente → evidenzia i termini.
// Mai formula senza numero, mai numero senza formula.

import { useEffect, useMemo, useRef } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { getDef } from '../model/registry.ts';
import { formatSI } from '../model/units.ts';
import { useStudio } from '../store/studio.ts';
import { simController, useSimTick } from '../viz/controller.ts';
import { bindFormulaToInstance, type FormulaDef, type FormulaTerm } from './formula.ts';
import { resolveTarget } from './resolve.ts';
import { shockleyCurrent } from '../library/junction.ts';
import { VT } from '../library/junction.ts';
import { getLesson } from '../lessons/data.ts';

function renderLatex(latex: string): string {
  return katex.renderToString(latex, {
    trust: true,
    strict: false,
    throwOnError: false,
    displayMode: true,
  });
}

function termFromEvent(e: React.MouseEvent): string | null {
  let el = e.target as HTMLElement | null;
  while (el && el !== e.currentTarget) {
    for (const cls of el.classList ?? []) {
      if (cls.startsWith('fx-')) return cls.slice(3);
    }
    el = el.parentElement;
  }
  return null;
}

function FormulaView({ formula }: { formula: FormulaDef }) {
  const setHover = useStudio((s) => s.setHover);
  const hoveredComponent = useStudio((s) => s.hoveredComponent);
  useSimTick((s) => s.tick);
  const rootRef = useRef<HTMLDivElement>(null);

  const html = useMemo(
    () => formula.steps.map((s) => renderLatex(s.latex)),
    [formula],
  );

  const onOver = (e: React.MouseEvent) => {
    const termName = termFromEvent(e);
    const term = formula.terms.find((t) => t.term === termName);
    if (!term?.highlight) {
      setHover(null);
      return;
    }
    setHover(
      term.highlight.kind === 'component'
        ? { components: [term.highlight.id], pins: [] }
        : { components: [], pins: [term.highlight.pin] },
    );
  };

  // direzione inversa: componente sotto il mouse → termini evidenziati
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const term of formula.terms) {
      const active =
        hoveredComponent !== null &&
        term.highlight?.kind === 'component' &&
        term.highlight.id === hoveredComponent;
      root.querySelectorAll(`.fx-${term.term}`).forEach((el) => {
        el.classList.toggle('term-active', active);
      });
    }
  }, [hoveredComponent, formula]);

  return (
    <div className="formula" ref={rootRef}>
      <h4>{formula.title}</h4>
      {formula.description && <p className="muted">{formula.description}</p>}
      {formula.steps.map((step, i) => (
        <div key={i} className="formula-step">
          <div
            className="formula-latex"
            onMouseOver={onOver}
            onMouseLeave={() => setHover(null)}
            dangerouslySetInnerHTML={{ __html: html[i] }}
          />
          {step.note && <div className="formula-note">{step.note}</div>}
        </div>
      ))}
      <div className="term-values">
        {formula.terms.map((t) => (
          <TermChip key={t.term} term={t} />
        ))}
      </div>
    </div>
  );
}

function TermChip({ term }: { term: FormulaTerm }) {
  const circuit = useStudio((s) => s.circuit);
  const setHover = useStudio((s) => s.setHover);
  const hoveredComponent = useStudio((s) => s.hoveredComponent);
  const value = resolveTarget(term.target, { circuit, frame: simController.frame });
  const active =
    hoveredComponent !== null && term.highlight?.kind === 'component' && term.highlight.id === hoveredComponent;
  return (
    <span
      className={`term-chip${active ? ' term-active' : ''}`}
      onMouseEnter={() =>
        term.highlight &&
        setHover(
          term.highlight.kind === 'component'
            ? { components: [term.highlight.id], pins: [] }
            : { components: [], pins: [term.highlight.pin] },
        )
      }
      onMouseLeave={() => setHover(null)}
    >
      {term.label} = <b>{value === null ? '—' : formatSI(value, term.unit)}</b>
    </span>
  );
}

/** Curva I-V del diodo con il punto di lavoro corrente evidenziato. */
function DiodeCurve({ instId }: { instId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useSimTick((s) => s.tick);

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = simController.frame;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 280;
    const H = 170;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#14171f';
    ctx.fillRect(0, 0, W, H);

    const data = frame?.result.outputs.get(instId)?.data;
    if (!data || data.is === undefined) return;
    const Is = data.is;
    const nVt = data.n * VT;
    const vd = data.vd ?? 0;
    const id = data.id ?? 0;

    const vMax = Math.max(1.0, vd + 0.3);
    const vMin = -0.5;
    const iMax = Math.max(shockleyCurrent(vMax, Is, nVt), Math.abs(id) * 1.2, 1e-3);
    const padL = 44;
    const padB = 18;
    const xOf = (v: number) => padL + ((v - vMin) / (vMax - vMin)) * (W - padL - 8);
    const yOf = (i: number) => 8 + (1 - i / iMax) * (H - padB - 16);

    ctx.strokeStyle = 'rgba(148,160,184,0.35)';
    ctx.beginPath();
    ctx.moveTo(xOf(0), 8);
    ctx.lineTo(xOf(0), H - padB);
    ctx.moveTo(padL, yOf(0));
    ctx.lineTo(W - 8, yOf(0));
    ctx.stroke();
    ctx.fillStyle = 'rgba(148,160,184,0.75)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`${formatSI(iMax, 'A', 2)}`, 4, 16);
    ctx.fillText(`${formatSI(vMax, 'V', 2)}`, W - 40, H - 4);

    ctx.strokeStyle = '#2f93d0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let px = 0; px <= W - padL - 8; px += 2) {
      const v = vMin + (px / (W - padL - 8)) * (vMax - vMin);
      const i = Math.min(iMax, Math.max(0, shockleyCurrent(v, Is, nVt)));
      const x = padL + px;
      const y = yOf(i);
      if (px === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // punto di lavoro corrente
    ctx.fillStyle = '#d55e00';
    ctx.beginPath();
    ctx.arc(xOf(vd), yOf(Math.max(0, Math.min(id, iMax))), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(220,226,240,0.9)';
    ctx.fillText(`(${formatSI(vd, 'V', 2)}, ${formatSI(id, 'A', 2)})`, Math.min(xOf(vd) + 8, W - 100), yOf(id) - 8);
  });

  return <canvas ref={canvasRef} style={{ width: 280, height: 170 }} className="diode-curve" />;
}

export function MathPanel() {
  const circuit = useStudio((s) => s.circuit);
  const selection = useStudio((s) => s.selection);
  const lessonId = useStudio((s) => s.lessonId);

  const lesson = lessonId ? getLesson(lessonId) : null;
  const selected = circuit.components.find((c) => selection.includes(c.id)) ?? null;
  const selDef = selected ? getDef(selected.type) : null;
  const componentFormulas =
    selected && selDef?.formulas ? selDef.formulas.map((f) => bindFormulaToInstance(f, selected.id)) : [];

  if (!lesson && componentFormulas.length === 0) {
    return (
      <div className="props-empty">
        Seleziona un componente con una formula (resistore, condensatore, diodo, transistor...) o
        apri una lezione: qui compaiono le derivazioni con i valori vivi della simulazione.
      </div>
    );
  }

  return (
    <div className="math-panel">
      {selected && componentFormulas.length > 0 && (
        <section>
          <h3>
            {selDef!.name} <span className="muted">({selected.id})</span>
          </h3>
          {componentFormulas.map((f) => (
            <FormulaView key={f.id} formula={f} />
          ))}
          {(selected.type === 'diode' || selected.type === 'led') && <DiodeCurve instId={selected.id} />}
        </section>
      )}
      {lesson && (
        <section>
          <h3>Matematica della lezione: {lesson.title}</h3>
          {lesson.formulas.map((f) => (
            <FormulaView key={f.id} formula={f} />
          ))}
        </section>
      )}
    </div>
  );
}
