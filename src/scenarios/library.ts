// Libreria di scenari persistente nel browser (localStorage): salva lo stato
// completo della sessione con un nome e riaprilo/condividilo con un click.
// Riusa gli stessi seam di cattura/applicazione degli scenari da file.

import { captureScenario, type Scenario } from './scenario.ts';

const KEY = 'circuit-studio:scenarios';

export interface SavedScenario {
  id: string;
  scenario: Scenario;
}

export function listSavedScenarios(): SavedScenario[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (s): s is SavedScenario => s && typeof s.id === 'string' && s.scenario && typeof s.scenario === 'object',
    );
  } catch {
    return [];
  }
}

function persist(list: SavedScenario[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* quota superata o storage non disponibile: fallimento silenzioso */
  }
}

/** Cattura lo stato corrente e lo aggiunge in testa alla libreria. */
export function saveCurrentScenario(name: string): SavedScenario[] {
  const entry: SavedScenario = {
    id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scenario: captureScenario(name.trim() || 'senza nome'),
  };
  const list = [entry, ...listSavedScenarios()];
  persist(list);
  return list;
}

export function deleteSavedScenario(id: string): SavedScenario[] {
  const list = listSavedScenarios().filter((s) => s.id !== id);
  persist(list);
  return list;
}
