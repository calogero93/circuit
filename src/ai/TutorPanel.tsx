// Tutor unificato: una richiesta a LangGraph; il server gestisce modello, memoria e tool.

import { useRef, useState } from 'react';
import { simController } from '../viz/controller.ts';

interface ChatEntry {
  kind: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
}

export function TutorPanel() {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const threadId = useRef(crypto.randomUUID());
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
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: text, thread_id: threadId.current }),
        signal: AbortSignal.timeout(125_000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? 'Errore del servizio tutor');
      for (const call of data.tools ?? []) {
        append({ kind: 'tool', text: `🔧 ${call.tool}(${JSON.stringify(call.input)})${call.ok ? '' : `: ${call.error}`}` });
      }
      append({ kind: 'assistant', text: data.response });
      if (data.snapshot_revision != null && data.snapshot_revision !== simController.revision) {
        append({ kind: 'tool', text: 'Il circuito è cambiato durante l’analisi: la risposta si riferisce alla configurazione precedente.' });
      }
    } catch (error) {
      append({ kind: 'error', text: error instanceof Error ? error.message : 'Tutor non raggiungibile. Avvia il servizio Python e il modello locale.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tutor">
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
