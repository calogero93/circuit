// Pannello "Scenari": galleria degli scenari salvati nel browser, con salva /
// apri / condividi / elimina. Realizza il principio "imparare per insegnare":
// stati riproducibili e condivisibili a portata di click.

import { useState } from 'react';
import { applyScenario, scenarioLink } from './scenario.ts';
import { deleteSavedScenario, listSavedScenarios, saveCurrentScenario, type SavedScenario } from './library.ts';

export function ScenarioPanel() {
  const [list, setList] = useState<SavedScenario[]>(() => listSavedScenarios());
  const [name, setName] = useState('');

  const save = () => {
    setList(saveCurrentScenario(name));
    setName('');
  };

  const share = (s: SavedScenario) => {
    navigator.clipboard.writeText(scenarioLink(s.scenario)).then(
      () => alert('Link dello scenario copiato negli appunti'),
      () => alert('Impossibile copiare il link'),
    );
  };

  return (
    <div className="scenario-panel">
      <h3>Scenari salvati</h3>
      <p className="muted">
        Salva lo stato completo (circuito, sonde, oscilloscopio, confronto A/B, lezione) nel browser e
        riaprilo o condividilo con un click.
      </p>
      <div className="scenario-save">
        <input
          value={name}
          placeholder="Nome scenario…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <button className="btn primary" onClick={save}>
          Salva stato attuale
        </button>
      </div>
      {list.length === 0 ? (
        <p className="muted">Nessuno scenario salvato.</p>
      ) : (
        <ul className="scenario-list">
          {list.map((s) => (
            <li key={s.id} className="scenario-card">
              <div className="scenario-meta">
                <b>{s.scenario.name}</b>
                <span className="muted">{new Date(s.scenario.savedAt).toLocaleString()}</span>
              </div>
              <div className="scenario-actions">
                <button className="btn" onClick={() => applyScenario(s.scenario)}>
                  Apri
                </button>
                <button className="btn" onClick={() => share(s)}>
                  Condividi
                </button>
                <button className="btn danger" onClick={() => setList(deleteSavedScenario(s.id))}>
                  Elimina
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
