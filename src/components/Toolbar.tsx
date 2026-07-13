// Barra strumenti: strumenti dell'editor, esegui/pausa, undo/redo,
// salva/carica circuito e scenari, modalità presentazione.

import { useRef } from 'react';
import { circuitFromJSON, circuitToJSON } from '../model/serialize.ts';
import { formatSI } from '../model/units.ts';
import { replaceCircuit } from '../store/commands.ts';
import { useStudio } from '../store/studio.ts';
import { useSimTick } from '../viz/controller.ts';
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
  const setRunning = useStudio((s) => s.setRunning);
  const presentation = useStudio((s) => s.presentation);
  const setPresentation = useStudio((s) => s.setPresentation);
  const execute = useStudio((s) => s.execute);
  const timestep = useStudio((s) => s.timestep);
  const setTimestep = useStudio((s) => s.setTimestep);
  const { time, converged } = useSimTick();

  const circuitFile = useRef<HTMLInputElement>(null);
  const scenarioFile = useRef<HTMLInputElement>(null);

  const openFile = (input: HTMLInputElement | null, apply: (json: unknown) => void) => {
    if (!input?.files?.[0]) return;
    input.files[0].text().then((text) => {
      try {
        apply(JSON.parse(text));
      } catch {
        alert('File non valido');
      }
    });
    input.value = '';
  };

  return (
    <div className="toolbar">
      <span className="brand">⚡ Circuit Studio</span>

      <div className="tool-group">
        <button className={`btn${tool.kind === 'select' ? ' on' : ''}`} title="Seleziona/sposta (Esc)" onClick={() => setTool({ kind: 'select' })}>
          ⬚ Seleziona
        </button>
        <button className={`btn${tool.kind === 'wire' ? ' on' : ''}`} title="Filo: pin → pin (w)" onClick={() => setTool({ kind: 'wire', from: null })}>
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
        <select value={timestep} onChange={(e) => setTimestep(Number(e.target.value))} title="Passo temporale">
          {[1e-5, 5e-5, 1e-4, 5e-4, 1e-3, 5e-3].map((dt) => (
            <option key={dt} value={dt}>
              dt {formatSI(dt, 's', 1)}
            </option>
          ))}
        </select>
        <span className={`sim-status${converged ? '' : ' error'}`}>
          {converged ? `t = ${formatSI(time, 's', 3)}` : '⚠ non converge'}
        </span>
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
              const next = circuitFromJSON(json);
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
          onChange={() => openFile(scenarioFile.current, (json) => applyScenario(json))}
        />
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
