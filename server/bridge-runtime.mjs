// Shared convention with circuit_ai.integrations.bridge_runtime. Never web-served.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const projectId = createHash('sha256').update(PROJECT_ROOT).digest('hex').slice(0, 16);
const uid = process.getuid?.();
const userId = uid ?? createHash('sha256').update(homedir()).digest('hex').slice(0, 16);
const outsideProject = path => { const rel = relative(PROJECT_ROOT, path); return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel); };

function privateDirectory(path) {
  try {
    const s = lstatSync(path);
    return s.isDirectory() && !s.isSymbolicLink() && (uid === undefined || s.uid === uid && (s.mode & 0o7777) === 0o700);
  } catch { return false; }
}

export function runtimeDirectory() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  const base = realpathSync(xdg && privateDirectory(xdg) && outsideProject(realpathSync(xdg)) ? xdg : tmpdir());
  const path = resolve(base, `circuit-studio-${userId}`, projectId);
  if (!outsideProject(path)) throw new Error('La directory runtime privata deve essere esterna al progetto');
  return path;
}

export function ensurePrivateDirectory(path) {
  mkdirSync(path, { mode: 0o700, recursive: true });
  if (!privateDirectory(path)) throw new Error('Directory capability non privata: sono richiesti proprietario corrente, permessi 0700 e nessun link simbolico');
}

export function capabilityPath(port) {
  return resolve(runtimeDirectory(), `tool-bridge-${port}.token`);
}

export function prepareRuntimeDirectory() {
  const path = runtimeDirectory();
  ensurePrivateDirectory(dirname(path));
  ensurePrivateDirectory(path);
  return path;
}

export async function readTutorCapability(port, path = capabilityPath(port)) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || uid !== undefined && (s.uid !== uid || (s.mode & 0o7777) !== 0o600)) throw new Error('File capability non privato');
  let record;
  try { record = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Capability non valida o scaduta'); }
  if (record.version !== 1 || record.port !== port || !Number.isSafeInteger(record.pid) || record.pid < 1 || !/^[a-f0-9]{64}$/.test(record.token)) throw new Error('Capability non valida');
  process.kill(record.pid, 0); // Refuse stale files left behind by an exited relay.
  return record.token;
}
