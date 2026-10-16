// Tutor unificato: una richiesta a LangGraph; il server gestisce modello, memoria e tool.

import { useEffect, useRef, useState } from 'react';
import { simController } from '../viz/controller.ts';

import { browserSessionId, readTutorStream, storedId } from './contracts.ts';
import type { ChatEntry } from './contracts.ts';

export function TutorPanel() {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const threadId = useRef(storedId(sessionStorage, 'circuit-tutor-thread'));
  const userId = useRef(storedId(localStorage, 'circuit-tutor-user'));
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const logRef = useRef<HTMLDivElement>(null);

  const append = (entry: ChatEntry) => {
    setEntries((prev) => [...prev, entry]);
    requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
  };

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    append({ kind: 'user', text });

    try {
      abort.current = new AbortController();
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: text, thread_id: threadId.current,
          user_id: userId.current, session_id: browserSessionId() }),
        signal: AbortSignal.any([abort.current.signal, AbortSignal.timeout(125_000)]),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail ?? 'Errore del servizio tutor');
      }
      let finished = false;
      await readTutorStream(res, (event) => {
        switch (event.event) {
          case 'tool_start':
            if (event.data.tool !== 'SubmitAnswer') append({ kind: 'tool', text: `🔧 ${event.data.tool} in corso…` });
            break;
          case 'tool_end':
            append({ kind: 'tool', text: `🔧 ${event.data.tool} ${event.data.ok ? 'completato' : `: ${event.data.error}`}` });
            break;
          case 'summary':
            append({ kind: 'tool', text: event.data.message });
            break;
          case 'error': throw new Error(event.data.message);
          case 'final': {
            finished = true;
            append({ kind: 'assistant', text: event.data.response });
            if (!event.data.revision_consistent || (event.data.snapshot_revision != null &&
                event.data.snapshot_revision !== simController.revision)) {
              append({ kind: 'tool', text: 'Il circuito è cambiato durante l’analisi: i dati si riferiscono alla configurazione precedente. Ripeti la domanda per aggiornarli.' });
            }
            break;
          }
        }
      });
      if (!finished) throw new Error('La connessione si è chiusa prima della risposta finale');
    } catch (error) {
      append({ kind: 'error', text: error instanceof Error ? error.message : 'Tutor non raggiungibile. Avvia il servizio Python e il modello locale.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tutor">
      <button className="btn" disabled={busy} onClick={() => {
        threadId.current = crypto.randomUUID();
        sessionStorage.setItem('circuit-tutor-thread', threadId.current);
        setEntries([]);
      }}>Nuova conversazione</button>
      <div className="tutor-log" ref={logRef}>
        {entries.length === 0 && (
          <div className="props-empty">
            Chiedi teoria o informazioni sul circuito: il tutor sceglie quando usare le misure live.
            <br />
            <br />
            Esempi: «perché il mio LED non si accende?», «quanto vale Vout e perché?», «cosa succede
            se tolgo il condensatore?»
          </div>
        )}
        {entries.map((e, i) => (
          <div key={i} className={`msg ${e.kind}`}>
            {e.text}
          </div>
        ))}
        {busy && <div className="msg tool">… il tutor sta elaborando la domanda …</div>}
      </div>
      <div className="tutor-input">
        <textarea
          rows={2}
          value={input}
          placeholder="Fai una domanda sul circuito…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn primary" disabled={busy || !input.trim()} onClick={() => void send()}>
          Invia
        </button>
      </div>
    </div>
  );
}
