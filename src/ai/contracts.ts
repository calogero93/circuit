import definitions from './tool-schemas.json' with { type: 'json' };

export const TOOL_DEFINITIONS = definitions;

export interface ChatEntry {
  kind: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
}
export interface ToolTrace {
  call_id: string;
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  error?: string | null;
}
export interface ChatResponse {
  response: string;
  snapshot_revision: number | null;
  revision_consistent: boolean;
  tools: ToolTrace[];
}
export type TutorEvent =
  | { event: 'tool_start'; data: { call_id: string; tool: string } }
  | { event: 'tool_end'; data: ToolTrace }
  | { event: 'status' | 'summary'; data: { message: string } }
  | { event: 'error'; data: { message: string } }
  | { event: 'final'; data: ChatResponse };

export function browserSessionId(): string {
  // Ogni scheda ha una destinazione distinta, anche se sessionStorage viene
  // copiato dal browser quando si duplica una scheda.
  return sessionId;
}
const sessionId = crypto.randomUUID();

export function storedId(storage: Storage, key: string): string {
  const value = storage.getItem(key) ?? crypto.randomUUID();
  storage.setItem(key, value);
  return value;
}

/** NDJSON può essere suddiviso in qualunque punto dal trasporto HTTP. */
export async function readTutorStream(response: Response, receive: (event: TutorEvent) => void): Promise<void> {
  if (!response.body) throw new Error('Il browser non supporta lo stream della risposta');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) receive(JSON.parse(line) as TutorEvent);
      if (done) break;
    }
    if (buffer.trim()) receive(JSON.parse(buffer) as TutorEvent);
  } finally { await reader.cancel(); reader.releaseLock(); }
}
