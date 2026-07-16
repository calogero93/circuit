// Pannello proprietà: valori editabili con aggiornamento live della
// simulazione, metadati didattici, rotazione/cancellazione, controlli A/B.

import { useEffect, useState } from 'react';
import { getDef, type ParamDef } from '../model/registry.ts';
import { formatSI } from '../model/units.ts';
import { pinKey } from '../model/types.ts';
import { removeItems, rotateComponent, setParam } from '../store/commands.ts';
import { useStudio } from '../store/studio.ts';
import { simController, useSimTick } from '../viz/controller.ts';
import type { ComponentInstance } from '../model/types.ts';
import { bridgedComponent } from './instruments.ts';

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

function EnvironmentalPanel() {
  const env = useStudio((s) => s.environment);
  const setEnv = useStudio((s) => s.setEnvironment);

  return (
    <div className="env-panel" style={{ marginTop: '16px', padding: '12px', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--panel-2)' }}>
      <h4 style={{ margin: '0 0 10px 0', fontSize: '13.5px', color: 'var(--accent)' }}>🌎 Variabili Ambientali Fisiche</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <label style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span>☀️ Luce Ambiente: <b>{env.light.toFixed(0)}%</b></span>
          <input type="range" min="0" max="100" value={env.light} onChange={(e) => setEnv({ light: Number(e.target.value) })} />
        </label>
        <label style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span>🌡️ Temperatura: <b>{env.temperature.toFixed(1)}°C</b></span>
          <input type="range" min="-40" max="150" value={env.temperature} onChange={(e) => setEnv({ temperature: Number(e.target.value) })} />
        </label>
        <label style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span>🌪️ Pressione: <b>{env.pressure.toFixed(1)} kPa</b></span>
          <input type="range" min="50" max="150" value={env.pressure} onChange={(e) => setEnv({ pressure: Number(e.target.value) })} />
        </label>
        <label style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span>🧲 Campo Magnetico: <b>{env.magneticField.toFixed(1)} mT</b></span>
          <input type="range" min="-100" max="100" value={env.magneticField} onChange={(e) => setEnv({ magneticField: Number(e.target.value) })} />
        </label>
        <label style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span>💧 Umidità Relativa: <b>{env.humidity.toFixed(0)}%</b></span>
          <input type="range" min="0" max="100" value={env.humidity} onChange={(e) => setEnv({ humidity: Number(e.target.value) })} />
        </label>
      </div>
    </div>
  );
}

type DmmMode = 'V' | 'R' | 'C' | 'L' | 'diode' | 'A';

function DigitalMultimeter({ inst, wire, mode }: { inst?: ComponentInstance; wire?: any; mode?: DmmMode }) {
  const circuit = useStudio((s) => s.circuit);
  const env = useStudio((s) => s.environment);
  const frame = simController.frame;
  const [dmmMode, setDmmMode] = useState<DmmMode>('V');

  // Verifica la presenza di un terminale di terra (GND)
  const hasGround = circuit.components.some((c) => getDef(c.type).isGround);

  // Determina la modalità consigliata in base alla selezione
  useEffect(() => {
    if (mode) {
      setDmmMode(mode);
      return;
    }
    if (inst) {
      if (inst.type === 'ammeter') return setDmmMode('A');
      if (inst.type === 'resistor' || inst.type === 'ldr' || inst.type === 'ntc' || inst.type === 'ptc' || inst.type === 'barometer') setDmmMode('R');
      else if (inst.type === 'capacitor' || inst.type === 'humidity_sensor') setDmmMode('C');
      else if (inst.type === 'inductor') setDmmMode('L');
      else if (inst.type === 'diode' || inst.type === 'led' || inst.type === 'schottky' || inst.type === 'zener') setDmmMode('diode');
      else if (inst.type === 'idc') setDmmMode('A');
      else setDmmMode('V');
    } else if (wire) {
      setDmmMode('V');
    }
  }, [inst, wire, mode]);

  let valueDisplay = 'O.L';
  let unitDisplay = '';
  let subText = '';
  let detailTitle = '';
  let details: string[] = [];

  const out = inst ? frame?.result.outputs.get(inst.id) : null;

  // Calcoli e letture del DMM
  if (dmmMode === 'V') {
    detailTitle = 'Misurazione di Tensione';
    if (inst) {
      const v = Number(out?.data.v ?? 0);
      valueDisplay = formatSI(v, 'V', 3).replace(' V', '');
      unitDisplay = formatSI(v, 'V', 3).split(' ').pop() || 'V';
      details.push(`Tensione ai capi di ${inst.id}: ${formatSI(v, 'V', 5)}`);
      if (out?.data.i !== undefined) {
        const outI = Number(out.data.i);
        details.push(`Corrente passante: ${formatSI(outI, 'A', 5)}`);
        details.push(`Potenza istantanea: ${formatSI(Math.abs(v * outI), 'W', 5)}`);
      }
      if (inst.type === 'opamp') {
        details.push(`Saturazione impostata: ±${inst.params.Vsat} V`);
        details.push(`Differenziale d'ingresso (V+ - V-): ${formatSI(Number(out?.data.diff ?? 0), 'V', 4)}`);
      }
    } else if (wire) {
      const net = frame?.compiled.netOfPin.get(pinKey(wire.from));
      const v = net === undefined || !frame ? NaN : frame.result.voltageOfNet(net);
      if (Number.isFinite(v)) {
        valueDisplay = formatSI(v, 'V', 3).replace(' V', '');
        unitDisplay = formatSI(v, 'V', 3).split(' ').pop() || 'V';
        details.push(`Tensione assoluta sul nodo (rispetto a massa GND): ${formatSI(v, 'V', 5)}`);
      } else {
        valueDisplay = '0.000';
        unitDisplay = 'V';
      }
    }
    if (!hasGround) {
      subText = '⚠️ Circuito flottante (No GND)';
    } else {
      subText = 'Lettura DC stabile';
    }
  } else if (dmmMode === 'R') {
    detailTitle = 'Misuratore di Resistenza (Ohmetro)';
    if (inst && (inst.type === 'resistor' || inst.type === 'ldr' || inst.type === 'ntc' || inst.type === 'ptc' || inst.type === 'barometer')) {
      const r = Number(out?.data.r ?? inst.params.R ?? inst.params.R25 ?? inst.params.R0 ?? 1000);
      valueDisplay = formatSI(r, 'Ω', 3).replace(' Ω', '');
      unitDisplay = formatSI(r, 'Ω', 3).split(' ').pop() || 'Ω';
      subText = 'Autorange Ω attivo';
      details.push(`Resistenza calcolata di ${inst.id}: ${formatSI(r, 'Ω', 5)}`);
      
      if (inst.type === 'ldr') {
        details.push(`Sensore LDR — Luce: ${env.light.toFixed(0)}%`);
        details.push(`Resistenza al buio nominale: ${formatSI(inst.params.R_dark as number, 'Ω')}`);
      } else if (inst.type === 'ntc' || inst.type === 'ptc') {
        details.push(`Sensore Termistore — Temperatura: ${env.temperature.toFixed(1)}°C`);
        details.push(`Valore nominale a 25°C: ${formatSI(inst.params.R25 as number, 'Ω')}`);
      } else if (inst.type === 'barometer') {
        details.push(`Sensore Barometro — Pressione: ${env.pressure.toFixed(1)} kPa`);
      }
      
      if (out?.data.v !== undefined && out?.data.i !== undefined) {
        details.push(`Caduta di tensione misurata: ${formatSI(Number(out.data.v), 'V', 5)}`);
        details.push(`Corrente calcolata: ${formatSI(Number(out.data.i), 'A', 5)}`);
      }
    } else {
      valueDisplay = 'O.L';
      unitDisplay = 'MΩ';
      subText = 'Resistenza infinita (aperto)';
      details.push('Il multimetro rileva un circuito aperto o una resistenza superiore a 40 MΩ.');
    }
  } else if (dmmMode === 'C') {
    detailTitle = 'Misuratore di Capacità (Capacimetro)';
    if (inst && (inst.type === 'capacitor' || inst.type === 'humidity_sensor')) {
      const c = Number(out?.data.capacitance ?? inst.params.C ?? inst.params.C0 ?? 100e-6);
      valueDisplay = formatSI(c, 'F', 3).replace(' F', '');
      unitDisplay = formatSI(c, 'F', 3).split(' ').pop() || 'F';
      subText = 'Misura elettrostatica';
      details.push(`Capacità calcolata di ${inst.id}: ${formatSI(c, 'F', 5)}`);
      if (inst.type === 'humidity_sensor') {
        details.push(`Umidità ambiente misurata: ${env.humidity.toFixed(0)}% RH`);
      }
      if (out?.data.v !== undefined) {
        const outV = Number(out.data.v);
        const energy = 0.5 * c * outV * outV;
        details.push(`Tensione attuale ai capi: ${formatSI(outV, 'V', 5)}`);
        details.push(`Energia accumulata (E = ½ C V²): ${formatSI(energy, 'J', 5)}`);
      }
    } else {
      valueDisplay = '0.00';
      unitDisplay = 'nF';
      subText = 'Nessun condensatore';
      details.push('La capacità rilevata è trascurabile o inferiore alla sensibilità dello strumento (pf).');
    }
  } else if (dmmMode === 'L') {
    detailTitle = 'Misuratore di Induttanza (Induttimetro)';
    if (inst && inst.type === 'inductor') {
      const l = inst.params.L as number;
      valueDisplay = formatSI(l, 'H', 3).replace(' H', '');
      unitDisplay = formatSI(l, 'H', 3).split(' ').pop() || 'H';
      subText = 'Misura elettromagnetica';
      details.push(`Induttanza nominale di ${inst.id}: ${formatSI(l, 'H', 5)}`);
      if (out?.data.i !== undefined) {
        const outI = Number(out.data.i);
        const energy = 0.5 * l * outI * outI;
        details.push(`Corrente attuale che lo attraversa: ${formatSI(outI, 'A', 5)}`);
        details.push(`Energia nel campo magnetico (E = ½ L I²): ${formatSI(energy, 'J', 5)}`);
      }
    } else {
      valueDisplay = '0.00';
      unitDisplay = 'µH';
      subText = 'Nessun induttore';
      details.push('L\'induttanza rilevata è trascurabile (inferiore a 1 µH).');
    }
  } else if (dmmMode === 'diode') {
    detailTitle = 'Prova Diodi';
    if (inst && (inst.type === 'diode' || inst.type === 'led' || inst.type === 'schottky' || inst.type === 'zener')) {
      const v = Number(out?.data.v ?? 0);
      const i = Number(out?.data.i ?? out?.data.id ?? 0);
      const th = inst.type === 'schottky' ? 0.15 : 0.45;
      
      if (v > th && Math.abs(i) > 1e-6) {
        valueDisplay = v.toFixed(3);
        unitDisplay = 'V';
        subText = 'Conduzione diretta (ON)';
        details.push(`Caduta di tensione diretta VF: ${formatSI(v, 'V', 4)}`);
        details.push(`Corrente di giunzione IF: ${formatSI(Math.abs(i), 'A', 4)}`);
      } else if (inst.type === 'zener' && v < -(inst.params.Vz as number) + 0.1) {
        valueDisplay = Math.abs(v).toFixed(3);
        unitDisplay = 'V';
        subText = `Regolazione Zener attva (${inst.params.Vz}V)`;
        details.push(`Tensione di Zener misurata: ${formatSI(Math.abs(v), 'V', 4)}`);
        details.push(`Corrente di regolazione Iz: ${formatSI(Math.abs(i), 'A', 4)}`);
      } else {
        valueDisplay = 'O.L';
        unitDisplay = 'V';
        subText = 'Inversione / Blocco (OFF)';
        details.push(`Tensione inversa ai capi: ${formatSI(v, 'V', 4)}`);
        details.push('Giunzione polarizzata inversamente o spenta.');
      }
    } else {
      valueDisplay = 'O.L';
      unitDisplay = 'V';
      subText = 'Circuito aperto';
      details.push('Nessuna giunzione a semiconduttore rilevata tra i puntali.');
    }
  } else if (dmmMode === 'A') {
    detailTitle = 'Amperometro (Misura di Corrente)';
    if (inst) {
      const i = Number(out?.data.i ?? out?.data.id ?? out?.data.ids ?? 0);
      valueDisplay = formatSI(i, 'A', 3).replace(' A', '');
      unitDisplay = formatSI(i, 'A', 3).split(' ').pop() || 'A';
      subText = 'Amperometro in serie';
      details.push(`Corrente che fluisce in ${inst.id}: ${formatSI(i, 'A', 5)}`);
      
      if (inst.type === 'nmos' || inst.type === 'pmos') {
        details.push(`Transistor MOSFET — Stato canale: ${out?.data.mode}`);
        details.push(`Vgs (Gate-Source): ${formatSI(Number(out?.data.vgs ?? 0), 'V', 3)}`);
        details.push(`Vds (Drain-Source): ${formatSI(Number(out?.data.vds ?? 0), 'V', 3)}`);
      } else if (inst.type === 'npn' || inst.type === 'pnp') {
        details.push(`Transistor BJT — Guadagno β reale: ${(out?.data.beta as number || 0).toFixed(1)}`);
      } else if (inst.type === 'fuse') {
        details.push(`Fusibile — Stato: ${out?.data.blown ? '💥 BRUCIATO' : '✅ INTEGRO'}`);
        details.push(`Corrente massima di soglia Imax: ${inst.params.Imax} A`);
      } else if (inst.type === 'relay') {
        details.push(`Relè SPDT — Stato: ${out?.data.active ? '💥 ATTIVO (NO)' : '💤 RIPOSO (NC)'}`);
      }
    } else if (wire) {
      valueDisplay = 'O.L';
      unitDisplay = 'A';
      subText = '⚠️ Richiede taglio filo';
      details.push('Per misurare la corrente nel filo con un vero multimetro, devi interrompere il circuito e inserire l\'amperometro in serie!');
      details.push('Suggerimento: Clicca su un componente connesso al filo per misurarne direttamente la corrente passante.');
    }
  }

  return (
    <div className="dmm-wrapper">
      <div className="dmm-chassis">
        {/* Schermo LCD */}
        <div className="dmm-lcd">
          <div className="dmm-lcd-header">
            <span className="dmm-auto">AUTO</span>
            <span className="dmm-hold">DMM v1.0</span>
          </div>
          <div className="dmm-lcd-value">
            <span className="dmm-digits">{valueDisplay}</span>
            <span className="dmm-unit">{unitDisplay}</span>
          </div>
          <div className="dmm-lcd-footer">
            <span>{subText}</span>
          </div>
        </div>

        {/* Manopola / Bottoni di Selezione Funzione */}
        <div className="dmm-selector">
          {(['V', 'R', 'C', 'L', 'diode', 'A'] as const).map((mode) => (
            <button
              key={mode}
              className={`dmm-btn${dmmMode === mode ? ' active' : ''}`}
              onClick={() => setDmmMode(mode)}
              title={`Modalità ${mode}`}
            >
              {mode === 'diode' ? '▶|' : mode}
            </button>
          ))}
        </div>
      </div>

      {/* Info dettagliate sulla misurazione */}
      <div className="dmm-details">
        <h4>{detailTitle}</h4>
        <ul className="dmm-details-list">
          {details.map((detail, idx) => (
            <li key={idx}>{detail}</li>
          ))}
        </ul>

        {!hasGround && (
          <div className="dmm-alert">
            <h5>⚠️ Perché leggo valori strani (es. 3V)?</h5>
            <p>
              Nel circuito <strong>manca un riferimento di massa (GND)</strong>. Senza il simbolo di terra, le tensioni non hanno un punto di riferimento "0 Volt" stabile. Il simulatore deve indovinare i potenziali basandosi su correnti microscopiche di dispersione (gmin), producendo valori inattesi.
            </p>
            <p>
              <strong>Soluzione:</strong> Trascina un componente <strong>Terra (GND)</strong> dalla palette a sinistra e collegalo al polo negativo del generatore (terminale "−").
            </p>
          </div>
        )}
      </div>
    </div>
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
  useSimTick((s) => s.tick); // re-render automatico per i valori vivi del DMM

  const inst = circuit.components.find((c) => selection.includes(c.id));
  const wire = circuit.wires.find((w) => selection.includes(w.id));

  if (!inst && !wire) {
    return (
      <div className="props-empty">
        <p>Seleziona un componente o un filo per vederne proprietà, descrizione e formule.</p>
        <p>Doppio click su un interruttore per aprirlo/chiuderlo.</p>
        
        <EnvironmentalPanel />

        <div style={{ marginTop: '20px' }}>
          <DigitalMultimeter />
        </div>
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
        
        <DigitalMultimeter wire={wire} />

        <EnvironmentalPanel />

        <button className="btn danger" style={{ marginTop: '16px' }} onClick={() => execute(removeItems(circuit, [wire.id]))}>
          Cancella filo
        </button>
      </div>
    );
  }

  const def = getDef(inst!.type);
  const isSelfAB = ab?.componentId === inst!.id;

  // Multimetro piazzato: il DMM ricco misura il componente "a ponte" fra i puntali
  const isMultimeter = inst!.type === 'multimeter';
  const bridged = isMultimeter && simController.frame
    ? bridgedComponent(circuit, simController.frame.compiled.netOfPin, inst!.id)
    : null;
  const dmmTarget = isMultimeter ? bridged ?? inst! : inst!;
  const dmmMode = isMultimeter ? (String(inst!.params.mode ?? 'V') as DmmMode) : undefined;

  return (
    <div className="props">
      <h3>
        {def.name} <span className="muted">({inst!.id})</span>
      </h3>
      <p className="description">{def.description}</p>

      {isMultimeter && !bridged && (
        <p className="muted">Collega i due puntali ai capi di un componente per misurarne tutte le grandezze.</p>
      )}
      <DigitalMultimeter inst={dmmTarget} mode={dmmMode} />

      <EnvironmentalPanel />

      <h4 style={{ marginTop: '20px', borderTop: '1px solid var(--border)', paddingTop: '16px' }}>Parametri</h4>
      {def.params.map((p) =>
        p.kind === 'number' ? (
          <NumberParam key={p.key} inst={inst!} p={p} />
        ) : p.kind === 'select' ? (
          <label key={p.key} className="param">
            <span className="param-label">{p.label}</span>
            <select
              className="param-select"
              value={String(inst!.params[p.key])}
              onChange={(e) => execute(setParam(inst!.id, p.key, inst!.params[p.key], e.target.value))}
            >
              {p.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
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
              className={`btn${isSelfAB && abGhost && ab?.mode === 'remove' ? ' on' : ''}`}
              onClick={() => {
                if (isSelfAB && abGhost && ab?.mode === 'remove') {
                  setAB(null);
                  setABGhost(false);
                } else {
                  setAB({ componentId: inst!.id, mode: 'remove' });
                  setABGhost(true);
                }
              }}
            >
              Togli
            </button>
            <button
              className={`btn${isSelfAB && abGhost && ab?.mode === 'bypass' ? ' on' : ''}`}
              onClick={() => {
                if (isSelfAB && abGhost && ab?.mode === 'bypass') {
                  setAB(null);
                  setABGhost(false);
                } else {
                  setAB({ componentId: inst!.id, mode: 'bypass' });
                  setABGhost(true);
                }
              }}
            >
              Bypassa
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
