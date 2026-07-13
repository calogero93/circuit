// Tutor AI ancorato alla simulazione: chat con loop di tool-use lato client.
// Il modello DEVE chiamare i tool prima di affermare fatti sul circuito; ogni
// chiamata tool è mostrata nel transcript (verificabile). La chiave API vive
// solo nel proxy server-side.

import { useRef, useState } from 'react';
import { TOOL_DEFINITIONS, executeTool } from './tools.ts';

const SYSTEM_PROMPT = `Sei il tutor socratico di elettronica di Circuit Studio, una piattaforma dove
lo studente costruisce e simula circuiti in tempo reale. Rispondi in italiano.

REGOLA FONDAMENTALE: prima di affermare QUALSIASI fatto sul circuito dello
studente (tensioni, correnti, componenti presenti, perché qualcosa non
funziona) DEVI chiamare i tool (getNetlist, runDC, runTransient, measureNode,
measureComponent, getLessonState) e ancorare la spiegazione ai valori reali
che ottieni. Mai inventare valori, mai rispondere in astratto quando puoi misurare.

Stile socratico: parti da cosa mostra la simulazione, guida con domande brevi,
svela la risposta solo dopo aver dato allo studente la possibilità di arrivarci.
Collega sempre il numero alla formula (Ohm, Kirchhoff, Shockley, τ=RC) e
suggerisci esperimenti concreti da fare nell'editor ("prova a raddoppiare R1 e
guarda l'oscilloscopio"). Se il circuito ha problemi (nessuna massa, componente
non collegato, corrente nulla), la simulazione te lo rivela: spiega il perché
fisico, non solo il sintomo. Risposte concise: poche frasi, un concetto alla volta.`;

interface ChatEntry {
  kind: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
}

type ApiContent = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];

const MAX_TOOL_ROUNDS = 8;

export function TutorPanel() {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const history = useRef<{ role: 'user' | 'assistant'; content: unknown }[]>([]);
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
    history.current.push({ role: 'user', content: text });

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            system: SYSTEM_PROMPT,
            messages: history.current,
            tools: TOOL_DEFINITIONS,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          append({ kind: 'error', text: data.error ?? `errore ${res.status}` });
          break;
        }

        const content = data.content as ApiContent;
        // il contenuto COMPLETO (anche thinking/tool_use) torna nella history
        history.current.push({ role: 'assistant', content });

        for (const block of content) {
          if (block.type === 'text' && block.text) append({ kind: 'assistant', text: block.text });
          if (block.type === 'tool_use') {
            append({ kind: 'tool', text: `🔧 ${block.name}(${JSON.stringify(block.input ?? {})})` });
          }
        }

        if (data.stop_reason === 'tool_use') {
          const results = content
            .filter((b) => b.type === 'tool_use')
            .map((b) => {
              const result = executeTool(b.name!, b.input ?? {});
              console.info('[tutor-ai] tool', b.name, b.input, '→', result);
              return {
                type: 'tool_result',
                tool_use_id: b.id,
                content: JSON.stringify(result),
                ...('error' in result ? { is_error: true } : {}),
              };
            });
          history.current.push({ role: 'user', content: results });
          continue;
        }
        if (data.stop_reason === 'pause_turn') continue;
        if (data.stop_reason === 'refusal') {
          append({ kind: 'error', text: 'Il modello ha rifiutato di rispondere a questa richiesta.' });
        }
        break;
      }
    } catch {
      append({
        kind: 'error',
        text: 'Proxy non raggiungibile. Avvia il server con: ANTHROPIC_API_KEY=... npm run proxy',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tutor">
      <div className="tutor-log" ref={logRef}>
        {entries.length === 0 && (
          <div className="props-empty">
            Chiedi qualcosa sul circuito: il tutor lo misura davvero prima di rispondere.
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
        {busy && <div className="msg tool">… il tutor sta misurando il circuito …</div>}
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
