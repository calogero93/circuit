# Tutor LangGraph

Un solo grafo per tutor e client esterni, con LLM locale predefinito. L'adattatore
`ChatOpenAI` usa il protocollo compatibile sul solo `LLM_BASE_URL`; nessun fallback
al cloud. Il modello deve supportare tool calling con scelta obbligatoria del tool.

## Avvio

Dalla radice:

```sh
cp .env.example .env
docker compose up -d --wait postgres
cd ai
uv sync --extra dev
uv run python main.py
```

In altri terminali: `npm run tool-bridge` e `npm run dev`. Avvia anche il modello
locale indicato da `LLM_BASE_URL` e `LLM_MODEL`. Vite inoltra `/api` a FastAPI e
`/tool-bridge` al relay. In produzione configura gli stessi inoltri nel proxy.

Compose espone PostgreSQL 17 su `127.0.0.1:5433`, con volume persistente.
`POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT` configurano il
container; mantieni `DATABASE_URL` coerente. Tabelle e migrazioni LangGraph sono
inizializzate all'avvio. PostgreSQL è richiesto: non c'è fallback silenzioso a SQLite.
I precedenti file SQLite restano intatti e non vengono importati automaticamente.

## Contratti e flusso

`schemas.py` contiene richieste HTTP, argomenti e risultati dei tool, risposta
finale, contesto, riassunti, evidenze e metriche. I campi usano `Field(description=...)`,
con unità, vincoli e significato dei valori. `tools.py` valida gli output del browser
prima che diventino evidenze. Gli errori sono restituiti al modello come
`ToolResult(ok=false, error=...)`.

Il modello riceve domanda e contesto serializzati da Pydantic; decide fra i tool
operativi e `SubmitAnswer`. Quest'ultimo è il contratto della risposta finale,
anche per la teoria: testo libero fuori schema non è accettato. Le risposte sul
circuito devono citare chiamate riuscite del turno. Le affermazioni numeriche
richiedono almeno un'evidenza di misura convergente. Questa verifica controlla
metadati ed evidenze, non dimostra semanticamente ogni frase del modello.

La prima revisione osservata viene mantenuta. Un cambiamento fra letture rende
il turno incoerente: si deve concludere dichiarando il limite e ripetere l'analisi.
Il circuito rimane live; il routing `session_id` lega i tool alla scheda corretta.
Le risposte teoriche non richiedono un browser connesso.

`GET /api/schemas` espone i JSON Schema completi. Dopo una modifica agli argomenti,
rigenera il catalogo browser dalla stessa fonte Pydantic:

```sh
uv run python export_schemas.py
```

## Memoria e budget

PostgreSQL ospita sia `AsyncPostgresSaver` per i checkpoint del thread sia
`AsyncPostgresStore` per sintesi e note didattiche fra thread dello stesso utente.
È la distinzione fra memoria del thread e memoria condivisa descritta nella
[documentazione LangGraph](https://docs.langchain.com/oss/python/langgraph/add-memory).
Le richieste dello stesso utente/thread sono serializzate con lock PostgreSQL,
anche fra processi del servizio.

Oltre `AI_SUMMARY_THRESHOLD_TOKENS` (default 6000 stimati), i turni più vecchi
vengono riassunti dal modello in `ConversationSummary`. Si conservano fino a
`AI_KEEP_RECENT_TURNS` turni recenti (default 3), riducendoli se necessario;
il turno corrente e le coppie tool-call/risposta rimangono interi. I messaggi
riassunti sono rimossi dal contesto attivo e il riassunto è persistito. I vecchi
checkpoint continuano a essere conservati nel database.

`AI_CONTEXT_MAX_TOKENS` (default 12000) limita il prompt stimato, compresi gli
schemi dei tool. Anche le richieste di riassunto rispettano il budget. I risultati
troppo grandi vengono rifiutati con invito a usare misure mirate. La stima è
conservativa e indipendente dal tokenizer locale: imposta i limiti lasciando
spazio alla risposta nel contesto reale del modello. Sono registrati anche i
token effettivi, quando il provider li comunica, e la latenza delle chiamate.

Le note persistenti riguardano preferenze esplicite, obiettivi e concetti studiati;
le misure dei circuiti sono storiche e non diventano lo stato corrente. Il browser
conserva `user_id` in localStorage e `thread_id` in sessionStorage. “Nuova
conversazione” cambia thread mantenendo la memoria didattica. Questi ID separano
i dati nell'app locale; non costituiscono autenticazione di un servizio pubblico.

## HTTP e aggiornamenti progressivi

`POST /api/chat` e `POST /query` accettano:

```json
{"query":"Quanto dissipa R1?","thread_id":"conversazione","user_id":"utente","session_id":"scheda"}
```

`user_id` ha default `local`. Senza `session_id` i tool funzionano solo se il relay
ha un unico browser. La risposta `ChatResponse` contiene testo, `answer`
strutturato, traccia, evidenze, prima revisione osservata, coerenza e metriche.

`POST /api/chat/stream` usa lo stesso grafo e restituisce NDJSON: `status`,
`tool_start`, `tool_end`, `summary`, `final` o `error`. La UI mostra i tool mentre
lavorano e il testo solo dopo la validazione finale; non mostra frammenti JSON
del modello. Il client rileva anche una chiusura senza evento finale.
`GET /healthz` riporta provider, modello e tipo di memoria.

## Verifica

```sh
uv run --extra dev python -m unittest discover -s tests -v
AI_TEST_DATABASE_URL=postgresql://circuit:circuit@127.0.0.1:5433/circuit uv run --extra dev python -m unittest discover -s tests -v
uv run --extra dev python evaluate.py
```

I test ordinari usano modelli controllati e server HTTP/WS locali. La variabile
`AI_TEST_DATABASE_URL` abilita prove reali di riavvio, isolamento e riassunti su
PostgreSQL; usa un database di sviluppo/test. `evaluate.py` usa il modello locale
reale con circuiti deterministici, registra scelte, risposte e metriche in
`.local-notes/ai-evaluation.json` (ignorato da Git). `--case theory` esegue un solo
caso. L'esito automatico controlla contratti e grounding; formule, linguaggio e
qualità delle spiegazioni richiedono revisione delle risposte registrate.

## Provider e documenti facoltativi

`LLM_PROVIDER=openai` richiede `OPENAI_API_KEY` e `LLM_MODEL`.
`LLM_PROVIDER=anthropic` richiede l'extra `anthropic`, `ANTHROPIC_API_KEY` e
`LLM_MODEL`. Rimuovi `LLM_BASE_URL` per usare l'endpoint predefinito del provider.

Il RAG resta facoltativo e separato dalla memoria PostgreSQL. Per prepararlo,
con il servizio AI fermo (Qdrant locale richiede accesso esclusivo):

```sh
uv run --extra rag python index_documents.py /percorso/documenti
```

Il comando legge PDF, MD e TXT e aggiorna i documenti passati senza duplicare i
chunk o cancellare gli altri documenti. File rimossi dalla directory non vengono
eliminati automaticamente dall'indice. Il primo avvio può scaricare il modello
embedding. Imposta `RAG_ENABLED=true` e avvia con `uv run --extra rag python main.py`:
`search_info` restituisce estratti con la fonte. L'indice risiede in
`AI_DATA_DIR/qdrant` e viene aperto solo al primo utilizzo.
