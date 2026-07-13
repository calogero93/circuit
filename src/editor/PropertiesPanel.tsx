// Pannello proprietà: valori editabili con aggiornamento live della
// simulazione, metadati didattici, rotazione/cancellazione, controlli A/B.

import { useEffect, useState } from 'react';
import { getDef, type ParamDef } from '../model/registry.ts';
import { formatSI } from '../model/units.ts';
import { removeItems, rotateComponent, setParam } from '../store/commands.ts';
import { useStudio } from '../store/studio.ts';
import { simController } from '../viz/controller.ts';
import type { ComponentInstance } from '../model/types.ts';

function LogSlider({
  def,
  value,
  onChange,
}: {
  def: ParamDef;
  value: number;
  onChange: (v: number) => void;
}) {
  const min = def.min ?? 0;
  const max = def.max ?? 100;
  const toSlider = (v: number) =>
    def.log ? (Math.log10(Math.max(v, min) / min) / Math.log10(max / min)) * 1000 : ((v - min) / (max - min)) * 1000;
  const fromSlider = (t: number) =>
    def.log ? min * Math.pow(max / min, t / 1000) : min + ((max - min) * t) / 1000;
  return (
    <input
      type="range"
      min={0}
      max={1000}
      value={toSlider(value)}
      onChange={(e) => onChange(fromSlider(Number(e.target.value)))}
    />
  );
}

function NumberParam({ inst, p }: { inst: ComponentInstance; p: ParamDef }) {
  const execute = useStudio((s) => s.execute);
  const markEvent = useStudio((s) => s.markEvent);
  const value = inst.params[p.key] as number;
  const [text, setText] = useState<string | null>(null);

  useEffect(() => setText(null), [value]);

  const commit = (v: number) => {
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v));
    if (clamped === value) return;
    execute(setParam(inst.id, p.key, value, clamped));
    markEvent(inst.id, simController.time);
  };

  return (
    <label className="param">
      <span className="param-label">
        {p.label} <b>{formatSI(value, p.unit)}</b>
      </span>
      <LogSlider def={p} value={value} onChange={commit} />
      <input
        className="param-input"
        value={text ?? String(value)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== null && commit(Number(text))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text !== null) commit(Number(text));
        }}
      />
    </label>
  );
}

export function PropertiesPanel() {
  const circuit = useStudio((s) => s.circuit);
  const selection = useStudio((s) => s.selection);
  const execute = useStudio((s) => s.execute);
  const markEvent = useStudio((s) => s.markEvent);
  const ab = useStudio((s) => s.ab);
  const abGhost = useStudio((s) => s.abGhost);
  const setAB = useStudio((s) => s.setAB);
  const setABGhost = useStudio((s) => s.setABGhost);

  const inst = circuit.components.find((c) => selection.includes(c.id));
  const wire = circuit.wires.find((w) => selection.includes(w.id));

  if (!inst && !wire) {
    return (
      <div className="props-empty">
        Seleziona un componente per vederne proprietà, descrizione e formule. Doppio click su un
        interruttore per aprirlo/chiuderlo.
      </div>
    );
  }

  if (wire && !inst) {
    return (
      <div className="props">
        <h3>Filo</h3>
        <p className="muted">
          Connette {wire.from.component}:{wire.from.pin} → {wire.to.component}:{wire.to.pin}
        </p>
        <button className="btn danger" onClick={() => execute(removeItems(circuit, [wire.id]))}>
          Cancella filo
        </button>
      </div>
    );
  }

  const def = getDef(inst!.type);
  const isSelfAB = ab?.componentId === inst!.id;

  return (
    <div className="props">
      <h3>
        {def.name} <span className="muted">({inst!.id})</span>
      </h3>
      <p className="description">{def.description}</p>

      {def.params.map((p) =>
        p.kind === 'number' ? (
          <NumberParam key={p.key} inst={inst!} p={p} />
        ) : (
          <label key={p.key} className="param">
            <span className="param-label">{p.label}</span>
            <button
              className={`btn toggle${inst!.params[p.key] ? ' on' : ''}`}
              onClick={() => {
                execute(setParam(inst!.id, p.key, inst!.params[p.key], !inst!.params[p.key]));
                markEvent(inst!.id, simController.time);
              }}
            >
              {inst!.params[p.key] ? 'Chiuso' : 'Aperto'}
            </button>
          </label>
        ),
      )}

      <div className="props-actions">
        <button
          className="btn"
          onClick={() => execute(rotateComponent(inst!.id, inst!.rot, ((inst!.rot + 1) % 4) as 0 | 1 | 2 | 3))}
        >
          Ruota 90° (r)
        </button>
        <button className="btn danger" onClick={() => execute(removeItems(circuit, [inst!.id]))}>
          Cancella (Canc)
        </button>
      </div>

      {def.pins.length >= 2 && !def.isGround && (
        <div className="ab-box">
          <h4>Confronto A/B</h4>
          <p className="muted">
            Sovrappone sull'oscilloscopio la traccia "fantasma" del circuito senza questo componente
            (tolto) o con un corto al suo posto (bypassato).
          </p>
          <div className="props-actions">
            <button
              className={`btn${isSelfAB && ab?.mode === 'remove' ? ' on' : ''}`}
              onClick={() => setAB(isSelfAB && ab?.mode === 'remove' ? null : { componentId: inst!.id, mode: 'remove' })}
            >
              Togli
            </button>
            <button
              className={`btn${isSelfAB && ab?.mode === 'bypass' ? ' on' : ''}`}
              onClick={() => setAB(isSelfAB && ab?.mode === 'bypass' ? null : { componentId: inst!.id, mode: 'bypass' })}
            >
              Bypassa
            </button>
            {isSelfAB && (
              <button className={`btn${abGhost ? ' on' : ''}`} onClick={() => setABGhost(!abGhost)}>
                {abGhost ? 'Confronto attivo' : 'Attiva confronto'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
