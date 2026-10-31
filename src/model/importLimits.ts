// Limits for local teaching circuits, checked before hydration or dense allocation.
export const IMPORT_LIMITS = {
  fileBytes: 2 * 1024 * 1024,
  components: 256,
  wires: 1024,
  pointsPerWire: 128,
  routePoints: 8192,
  textLength: 512,
  idLength: 128,
  groups: 128,
  probes: 32,
  solverDimension: 128,
  bodeDimension: 32,
  bodeProbes: 8,
} as const;

export class CircuitImportError extends Error {}

export function importError(detail: string): never {
  throw new CircuitImportError(`Importazione rifiutata: ${detail}. Riduci il circuito o correggi il file JSON.`);
}

/** Bound even ignored/unknown fields before traversing or copying collections. */
export function assertImportBudget(raw: unknown, strictNumbers = false): void {
  const stack = [{ value: raw, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++visited > 60_000 || depth > 12) importError('struttura troppo complessa');
    if (strictNumbers && typeof value === 'number' && !Number.isFinite(value)) importError('numero non finito');
    if (typeof value === 'string' && value.length > IMPORT_LIMITS.textLength) importError(`testo oltre ${IMPORT_LIMITS.textLength} caratteri`);
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      if (value.length > Math.max(IMPORT_LIMITS.wires, IMPORT_LIMITS.routePoints)) importError('collezione troppo grande');
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else {
      const entries = Object.entries(value);
      if (entries.length > 128) importError('oggetto con troppi campi');
      for (const [key, item] of entries) {
        if (key.length > IMPORT_LIMITS.idLength) importError('nome di campo troppo lungo');
        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }
}

export function assertSolverDimension(nNodes: number, nBranches: number, max: number = IMPORT_LIMITS.solverDimension): void {
  if (![nNodes, nBranches].every(n => Number.isSafeInteger(n) && n >= 0) || nNodes + nBranches > max) {
    importError(`il solver consente al massimo ${max} incognite (nodi + correnti di ramo)`);
  }
}

export function parseImportText(text: string): unknown {
  if (text.length > IMPORT_LIMITS.fileBytes || new TextEncoder().encode(text).byteLength > IMPORT_LIMITS.fileBytes) {
    importError('file oltre 2 MiB');
  }
  try { return JSON.parse(text); }
  catch { return importError('JSON non valido'); }
}

export async function readImportFile(file: Pick<File, 'size' | 'text'>): Promise<unknown> {
  if (file.size > IMPORT_LIMITS.fileBytes) importError('file oltre 2 MiB');
  return parseImportText(await file.text());
}

/** Collection bounds shared by external parsing and editor transitions. */
export function assertCircuitCollections(r: Record<string, unknown>): void {
  if (Array.isArray(r.components) && r.components.length > IMPORT_LIMITS.components) importError(`oltre ${IMPORT_LIMITS.components} componenti`);
  if (Array.isArray(r.wires) && r.wires.length > IMPORT_LIMITS.wires) importError(`oltre ${IMPORT_LIMITS.wires} fili`);
  if (Array.isArray(r.groups) && r.groups.length > IMPORT_LIMITS.groups) importError(`oltre ${IMPORT_LIMITS.groups} gruppi`);
  if (Array.isArray(r.boundaries) && r.boundaries.length > IMPORT_LIMITS.wires) importError('troppi confini');
  let pointCount = 0;
  for (const wire of Array.isArray(r.wires) ? r.wires : []) {
    for (const points of [wire?.route, wire?.waypoints]) {
      if (!Array.isArray(points)) continue;
      if (points.length > IMPORT_LIMITS.pointsPerWire) importError(`oltre ${IMPORT_LIMITS.pointsPerWire} punti per percorso`);
      pointCount += points.length;
      if (pointCount > IMPORT_LIMITS.routePoints) importError(`oltre ${IMPORT_LIMITS.routePoints} punti di percorso totali`);
    }
  }

}
