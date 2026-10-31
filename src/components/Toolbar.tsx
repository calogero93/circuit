// Barra strumenti: strumenti dell'editor, esegui/pausa, undo/redo,
// salva/carica circuito e scenari, modalità presentazione.

import { useRef } from 'react';
import { importCircuit, circuitToJSON } from '../model/serialize.ts';
import { readImportFile } from '../model/importLimits.ts';
import { timeCSV, bodeCSV } from '../scenarios/csv.ts';
import { formatSI } from '../model/units.ts';
import { replaceCircuit } from '../store/commands.ts';
import { useStudio } from '../store/studio.ts';
import { simController, useSimTick } from '../viz/controller.ts';
import { PLAYBACK_SPEEDS, isPlaybackSpeed } from '../viz/playback.ts';
import {
  applyScenario,
  captureScenario,
  downloadJSON,
  scenarioLink,
} from '../scenarios/scenario.ts';

export function Toolbar() {
  const tool = useStudio((s) => s.tool);
  const setTool = useStudio((s) => s.setTool);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const canUndo = useStudio((s) => s.undoStack.length > 0);
  const canRedo = useStudio((s) => s.redoStack.length > 0);
  const running = useStudio((s) => s.running);
  const operationError = useStudio((s) => s.operationError);
  const setRunning = useStudio((s) => s.setRunning);
  const presentation = useStudio((s) => s.presentation);
  const setPresentation = useStudio((s) => s.setPresentation);
  const execute = useStudio((s) => s.execute);
  const timestep = useStudio((s) => s.timestep);
  const setTimestep = useStudio((s) => s.setTimestep);
  const playbackSpeed = useStudio((s) => s.playbackSpeed);
  const setPlaybackSpeed = useStudio((s) => s.setPlaybackSpeed);
  const { time, converged, playbackLag } = useSimTick();
  const diagnostics = simController.frame?.result.diagnostics;

  const circuitFile = useRef<HTMLInputElement>(null);
  const scenarioFile = useRef<HTMLInputElement>(null);

  const openFile = (input: HTMLInputElement | null, apply: (json: unknown) => void) => {
    if (!input?.files?.[0]) return;
    readImportFile(input.files[0]).then(apply).catch((error: unknown) => {
      alert(error instanceof Error ? error.message : 'File non valido: correggi il JSON e riprova.');
    });
    input.value = '';
  };

  const exportSVG = () => {
    if (typeof window !== 'undefined' && (window as any).__circuitStudio?.exportSVG) {
      (window as any).__circuitStudio.exportSVG();
    } else {
      alert('Editor non pronto per l\'esportazione.');
    }
  };

  const exportCSV = () => {
    const s = useStudio.getState();
    const probes = s.probes;
    if (probes.length === 0) {
      alert('Nessuna sonda attiva sul circuito per l\'esportazione dei dati.');
      return;
    }

    if (s.scopeMode === 'bode') {
      const points = simController.bodePoints;
      if (points.length === 0) {
        alert('Nessun dato di risposta in frequenza AC disponibile.');
        return;
      }

      const content = bodeCSV(probes, points);
      const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'risposta_frequenza_bode.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    } else {
      const samples = simController.samples;
      if (samples.length === 0) {
        alert('Nessun dato dell\'oscilloscopio registrato per l\'esportazione.');
        return;
      }

      const content = timeCSV(probes, samples);
      const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'tracce_oscilloscopio.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    }
  };

  return (
    <div className="toolbar">
      <span className="brand">⚡ KirchForge</span>
      {operationError && <span className="sim-status error" role="alert">{operationError}</span>}

      <div className="tool-group">
        <button className={`btn${tool.kind === 'select' ? ' on' : ''}`} title="Seleziona/sposta (Esc)" onClick={() => setTool({ kind: 'select' })}>
          ⬚ Seleziona
        </button>
        <button
          className={`btn${tool.kind === 'wire' ? ' on' : ''}`}
          title="Filo: click sul pin di partenza, poi sul pin di arrivo. Click nel vuoto per invertire il gomito (w)"
          onClick={() => setTool({ kind: 'wire', from: null })}
        >
          ─ Filo
        </button>
        <button className={`btn${tool.kind === 'probe' ? ' on' : ''}`} title="Sonda oscilloscopio su un nodo (p)" onClick={() => setTool({ kind: 'probe' })}>
          ◎ Sonda
        </button>
      </div>

      <div className="tool-group">
        <button className="btn" disabled={!canUndo} onClick={undo} title="Annulla (Ctrl+Z)">
          ↩
        </button>
        <button className="btn" disabled={!canRedo} onClick={redo} title="Ripristina (Ctrl+Y)">
          ↪
        </button>
      </div>

      <div className="tool-group">
        <button className={`btn${running ? ' on' : ''}`} onClick={() => setRunning(!running)}>
          {running ? '‖ Pausa' : '▶ Esegui'}
        </button>
        <select aria-label="Velocità simulazione" value={playbackSpeed}
          title="Velocità rispetto al tempo reale: 1× = un secondo simulato per secondo reale. In background la simulazione è sospesa."
          onChange={(e) => {
            const speed = Number(e.target.value);
            if (isPlaybackSpeed(speed)) setPlaybackSpeed(speed);
          }}>
          {PLAYBACK_SPEEDS.map((speed) => (
            <option key={speed} value={speed}>{String(speed).replace('.', ',')}×{speed === 1 ? ' (tempo reale)' : ''}</option>
          ))}
        </select>
        <select value={timestep} onChange={(e) => setTimestep(Number(e.target.value))} title="Intervallo dei campioni; il solver analogico usa sottopassi adattivi">
          {[1e-5, 5e-5, 1e-4, 5e-4, 1e-3, 5e-3].map((dt) => (
            <option key={dt} value={dt}>
              Δt uscita {formatSI(dt, 's', 1)}
            </option>
          ))}
        </select>
        <span className={`sim-status${converged ? '' : ' error'}`}
          title={diagnostics?.warnings.join('\n') || 'Simulazione con controllo di convergenza e sottopassi adattivi'}>
          {converged ? `t = ${formatSI(time, 's', 3)}` : '⚠ non converge'}
        </span>
        {running && converged && playbackLag > 0.1 * playbackSpeed && (
          <span className="playback-lag" role="status"
            title="Il calcolo è più lento della velocità richiesta. I passi rimasti vengono recuperati senza saltare stati fisici.">
            In ritardo: {formatSI(playbackLag, 's', 2)} simulati
          </span>
        )}
      </div>

      <div className="tool-group">
        <button
          className="btn"
          title="Salva il circuito come JSON"
          onClick={() => downloadJSON(circuitToJSON(useStudio.getState().circuit), 'circuito.json')}
        >
          ↓ Circuito
        </button>
        <button className="btn" title="Carica un circuito JSON" onClick={() => circuitFile.current?.click()}>
          ↑ Circuito
        </button>
        <input
          ref={circuitFile}
          type="file"
          accept=".json"
          hidden
          onChange={() =>
            openFile(circuitFile.current, (json) => {
              const next = importCircuit(json);
              execute(replaceCircuit('carica circuito', useStudio.getState().circuit, next));
            })
          }
        />
      </div>

      <div className="tool-group">
        <button
          className="btn"
          title="Salva lo scenario completo (circuito + sonde + scope + viste)"
          onClick={() => downloadJSON(captureScenario('scenario'), 'scenario.json')}
        >
          ↓ Scenario
        </button>
        <button className="btn" title="Carica uno scenario" onClick={() => scenarioFile.current?.click()}>
          ↑ Scenario
        </button>
        <button
          className="btn"
          title="Copia un link che riapre esattamente questa sessione"
          onClick={() => {
            navigator.clipboard.writeText(scenarioLink(captureScenario('condiviso'))).then(
              () => alert('Link dello scenario copiato negli appunti'),
              () => alert('Impossibile copiare il link'),
            );
          }}
        >
          ∞ Condividi
        </button>
        <input
          ref={scenarioFile}
          type="file"
          accept=".json"
          hidden
          onChange={() => openFile(scenarioFile.current, (json) => applyScenario(json, alert))}
        />
      </div>

      <div className="tool-group">
        <button className="btn" title="Esporta lo schema corrente in formato SVG vettoriale" onClick={exportSVG}>
          🖼 Esporta SVG
        </button>
        <button className="btn" title="Esporta i dati delle tracce (oscilloscopio o Bode) in formato CSV" onClick={exportCSV}>
          📊 Esporta CSV
        </button>
      </div>

      <div className="tool-group right">
        <button
          className={`btn${presentation ? ' on' : ''}`}
          title="Modalità presentazione: UI ridotta, tipografia grande, passi con ← →"
          onClick={() => setPresentation(!presentation)}
        >
          ▣ Presentazione
        </button>
      </div>
    </div>
  );
}
