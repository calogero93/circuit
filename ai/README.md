# Tutor LangGraph

Un solo grafo per tutor e client esterni, con LLM locale predefinito. L'adattatore
`ChatOpenAI` usa il protocollo compatibile sul solo `LLM_BASE_URL`; nessun fallback
al cloud. Il modello deve supportare tool calling con scelta obbligatoria del tool.

Architettura complessiva, flusso della simulazione e diagramma dei nodi LangGraph:
[`README principale`](../README.md#architettura). Qui sono descritti avvio,
contratti, memoria e valutazione del servizio AI.

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
`.local-notes/llmops/<experiment_id>/report.json` (ignorato da Git). `--case theory` esegue un solo
caso. L'esito automatico controlla contratti e grounding; formule, linguaggio e
qualità delle spiegazioni richiedono revisione delle risposte registrate.

## LLMOps — Passo 1: identificare ciò che valutiamo

Ogni esecuzione genera un `experiment_id` univoco e un `configuration_id`
stabile per modello dichiarato, parametri, prompt, contratti, sorgenti e
versioni delle dipendenze. Commit e modifiche locali sono registrati come
provenienza. I casi selezionati hanno un'impronta separata dalla configurazione.
API key, credenziali PostgreSQL e credenziali nell'URL non entrano nel report.

```sh
uv run --extra dev python evaluate.py --manifest-only
uv run --extra dev python evaluate.py --case theory --repetitions 3
```

Il primo comando prepara il manifesto senza rete, database o download di pesi.
Il secondo richiede il modello locale e conserva tutte e tre le risposte.
Ogni run ha una propria directory; `--output` accetta un nuovo file e rifiuta
la sovrascrittura di report esistenti. Errori e interruzioni conservano il
report parziale. Un modello non raggiungibile produce `status=unavailable`,
con pass rate nullo, mai un successo fittizio. Cambiamenti dei sorgenti o delle
identità riportate dal server durante il run lo rendono `invalidated`.

`LLM_MODEL_REVISION`, `LLM_MODEL_QUANTIZATION`, `LLM_MODEL_SHA256`,
`LLM_RUNTIME_NAME`, `LLM_RUNTIME_VERSION` e `LLM_HARDWARE_ID` descrivono
l'ambiente dichiarato. Con `--model-file /percorso/modello.gguf` oppure
`LLM_MODEL_FILE` viene misurato l'hash del file locale: un eventuale
`LLM_MODEL_SHA256` diverso blocca la preparazione. Questo non dimostra che il
server abbia caricato quel file; tale limite è esplicito nel manifesto.
I metadati del modello restituiti dal server vengono registrati quando presenti.

`LLM_TEMPERATURE`, `LLM_SEED` e `LLM_MAX_OUTPUT_TOKENS` controllano i parametri
inviati al modello; seed e temperatura zero non garantiscono output identici.
Conserviamo ogni ripetizione e riepiloghiamo pass rate e variabilità della
latenza. I report iniziali del Passo 1 riguardano solo contratti e classificazione;
quelli del Passo 3 distinguono controlli deterministici e giudizi semantici.

`LLM_REASONING_EFFORT` è facoltativo (`none`, `minimal`, `low`, `medium`, `high`,
`xhigh`); il supporto dipende dal server e dal modello. Quando è vuoto non viene
inviato e resta il default del server. Entra nell'identità dell'esperimento e nei
parametri del judge locale, così una prova senza ragionamento rimane distinguibile
da una con ragionamento attivo. Non è supportato dall'adattatore Anthropic.
Il limite di output può esaurirsi prima della chiamata strutturata finale:
`finish_reason=length` con risposta vuota non è un risultato valido.
I percorsi con un solo schema richiedono una chiamata obbligatoria senza usare
il formato object di `tool_choice`, rifiutato da alcuni server locali.

Questo passo prepara esperimenti confrontabili. Il dataset è definito nel
Passo 2; gli evaluator e il confronto umano sono descritti al Passo 3. Baseline e
cancello `pre-push` appartengono al Passo 4: nessun hook viene ancora installato.

## LLMOps — Passo 2: dataset e riferimenti

`evals/dataset.v1.json` definisce 51 casi: 30 di sviluppo e 21 di validazione.
`evals/fixtures.v1.json` contiene 13 contesti analitici o guasti controllati;
`evals/corpus.v1.json` contiene cinque estratti con fonti e hash verificabili.
Sono dati di test versionati, separati dai report locali ignorati da Git.
La versione corrente del dataset è `1.1.0`: i casi con errori attesi distinguono
un tentativo di lettura da una lettura riuscita.

Ogni caso definisce domanda, contesto, classificazioni accettabili, necessità e
alternative dei tool, concetti da spiegare, affermazioni da evitare, eventuali
valori SI con tolleranze, lingua e provenienza. Non impone una frase identica.
I riferimenti restano fuori dal prompt del tutor; il modello vede soltanto le
domande, la cronologia e i dati restituiti dai tool.

```sh
uv run python dataset.py --list
uv run python dataset.py --show power
uv run python evaluate.py --case power --manifest-only
uv run python evaluate.py --split validation --include-rag --manifest-only
```

Il caricamento controlla schemi, ID duplicati, domande duplicate, gruppi di
varianti nei due split, fonti, formule, unità e coerenza delle fixture. Non è
un evaluator del testo: i controlli sulle risposte vengono eseguiti dal Passo 3,
separatamente dalla validazione dei riferimenti del dataset.

La selezione predefinita usa lo split `development` ed esclude i cinque casi
RAG. `--split validation` o `--split all` selezionano gli altri; `--case ID`
cerca esplicitamente in entrambi gli split. `--category power` filtra una
famiglia. Non usare continuamente lo split di validazione per adattare il
prompt; i gruppi evitano che parafrasi dichiarate attraversino gli split,
ma non garantiscono assenza di ogni sovrapposizione semantica.

Con `--include-rag`, la ricerca usa estratti fissi del corpus e un eventuale
payload ostile sintetico, senza aprire Qdrant o scaricare embedding. Questo
esercita uso del tool e interpretazione dei documenti; non misura la qualità
del retrieval reale. I circuiti sono riferimenti analitici controllati, non
esecuzioni nel browser. Nei casi conversazionali il grafo mantiene la cronologia
ma cambia contesto fra turni; un caso abbassa esplicitamente la soglia per
esercitare il riassunto. Queste impostazioni fanno parte del caso registrato.

Dataset, fixture e corpus hanno un'impronta aggregata nel manifesto, distinta
dall'identità della configurazione del tutor. Modificarli durante un esperimento
lo invalida. I report del Passo 1 rimangono leggibili con il formato dei casi
iniziali.

Tutti i 51 casi iniziali sono proposte curate con assistenza di Codex: lo stato
è `provisional`, ciascun caso è `proposed`, senza revisori inventati. Non ci sono
ancora esempi provenienti da utenti reali o generazioni locali già approvate.
La revisione richiede di verificare domanda, contesto e criteri; solo allora
si possono impostare `review_status=accepted` e `reviewed_by` con il nome della
persona che ha effettuato la revisione, incrementando la versione del dataset.
Un dataset provvisorio non è una baseline già approvata per bloccare i rilasci.

### Esercizi con soluzioni pubblicate

`evals/textbook/` aggiunge un dataset separato, `circuit-tutor-textbook` 1.0.1,
ricavato dai PDF di Tony R. Kuphaldt in `docs/dataset/`. I 51 casi operativi
iniziali rimangono disponibili: esercizi di elettronica e comportamenti
dell'applicazione devono essere valutati entrambi.

| Fonte | Sezione | Pagine stampate | Pagine PDF, da 1 |
| --- | --- | --- | --- |
| `DC.pdf` | 2.4, corrente e potenza della lampada a resistenza costante | 44–45 | 54–55 |
| `DC.pdf` | 5.2, tre resistori in serie | 135 | 145 |
| `DC.pdf` | 5.3, tre resistori in parallelo | 141 | 151 |
| `DC.pdf` | 6.1, partitore a tre resistori | 174 | 184 |
| `AC.pdf` | 1.3, equivalenza termica RMS, figura 1.20 | 16 | 25 |
| `AC.pdf` | 1.4, serie puramente resistiva, figura 1.23 | 19–20 | 28–29 |
| `DIGI.pdf` | 3.4.1, AND a due ingressi | 49–50 | 58–59 |
| `DIGI.pdf` | 3.4.7, XOR a due ingressi | 57–58 | 66–67 |

Sono **11 casi in 8 famiglie**, con 8 casi development e 3 validation:

- 9 `closed_book`: dati nel quesito, tutti i tool vietati, soluzione riservata
  agli evaluator. Comprendono il raddoppio della tensione nell'esempio della lampada.
- 2 `live_tools`: richiedono misure correnti nelle fixture. La lampada è
  rappresentata da un resistore costante; il partitore è ridotto a due resistori
  raggruppando quelli superiori. Sono adattamenti espliciti, senza browser reale.

Le varianti dello stesso esercizio rimangono nello stesso split. Il caricatore
rifiuta anche pagine della stessa edizione presenti in split diversi, persino
se vengono assegnati nomi di gruppo differenti. I casi conservano
`evaluation_mode` nei report; `--mode` permette esperimenti separati.

Gli estratti in `excerpts/*.txt` conservano attribuzione, licenza CC BY 4.0,
origine e modifiche. Il catalogo include autore, edizione, sezione, entrambe le
numerazioni delle pagine, URL e SHA-256 del PDF. Le pagine sono state controllate
visivamente; le etichette numeriche vengono ricalcolate al caricamento con
formule indipendenti dal solver. Il judge e le schede di revisione ricevono
`reference_sources` con l'estratto della soluzione. Il tutor riceve la domanda
e, nei casi live, le evidenze dei tool: non riceve le soluzioni dei libri.
I PDF sono fonti per costruire e verificare il dataset, senza retrieval nel
percorso del tutor. Le prove RAG sono rinviate al lavoro sul retrieval e non
fanno parte di questo dataset. I report sperimentali precedenti restano leggibili.

Da `ai/`:

```sh
# Controlla struttura, formule, provenienza e split; nessuna chiamata LLM
uv run python dataset.py --directory evals/textbook --list
# Audit completo sui PDF locali: hash ed estratti nelle pagine dichiarate
uv run python dataset.py --directory evals/textbook --verify-publications
# Mostra la fonte e il relativo estratto per una revisione
uv run python dataset.py --directory evals/textbook --source dc-power

# Esegue soltanto un esempio senza accesso alle soluzioni
uv run python evaluate.py --dataset-directory evals/textbook --case book-dc-power-closed
# Riproduce la prova sul server locale alla porta 1235
LLM_BASE_URL=http://127.0.0.1:1235/v1 \
LLM_REASONING_EFFORT=none LLM_MAX_OUTPUT_TOKENS=512 \
AI_REQUEST_TIMEOUT=300 RAG_ENABLED=false \
uv run python evaluate.py --dataset-directory evals/textbook --case book-dc-power-closed
# Prepara il manifesto dell'intero dataset senza chiamare il modello
uv run python evaluate.py --dataset-directory evals/textbook --split all --manifest-only
# Seleziona soltanto le prove senza tool dello split development
uv run python evaluate.py --dataset-directory evals/textbook --mode closed_book
```

Il normale runner richiede solo gli estratti versionati. L'audit facoltativo
richiede i PDF locali e `pdftotext` di Poppler; non scarica libri o modelli.
Le impronte degli estratti e dei cataloghi entrano nell'identità del dataset:
modificarli durante un esperimento lo invalida. L'hash dei PDF nel catalogo
identifica l'edizione consultata e viene verificato durante l'audit.

Le soluzioni pubblicate forniscono riferimenti tecnici documentati; traduzioni,
domande e fixture rimangono adattamenti `proposed`, con revisore umano assente.
Le tabelle logiche e la correttezza delle associazioni nel testo richiedono
ancora valutazione semantica: superare i controlli di presenza dei numeri non
certifica l'intera risposta. Questo dataset prepara la baseline, senza
dichiararla già approvata né dichiarare calibrato il judge. La verifica del
judge su risposte corrette ed errori controllati precede l'uso dei suoi voti
come requisito affidabile del confronto fra versioni.

Per creare ulteriori candidati dal corpus con il modello locale:

```sh
uv run python generate_dataset.py --prepare-only --count 3
uv run python generate_dataset.py --count 3
```

Il primo comando prepara l'input senza modello; il secondo effettua la
chiamata e salva la bozza in `.local-notes/llmops/drafts/`. Le bozze riportano
modello, parametri, prompt, schema, fonti, metriche e ID di generazione. Un
candidato valido rimane `synthetic/proposed`: nessun file del dataset viene
modificato automaticamente. I trace di produzione arriveranno al Passo 8 e
richiederanno provenienza reale, pulizia dei dati e revisione prima dell'inserimento.

## LLMOps — Passo 3: evaluator e confronto con persone

La valutazione segue tre livelli, con risultati separati nel report JSON:

1. `evaluators.py` controlla schema, classificazione, uso dei tool, gruppi di tool
   alternativi, tentativi vietati, evidenze correnti e convergenti, citazioni di
   fonti effettivamente recuperate, attivazione del riassunto e marcatori sintetici.
2. `judge.py`, solo se abilitato, valuta pertinenza, completezza, correttezza rispetto
   alle evidenze e rispetto dei vincoli. Usa un LLM locale con output `JudgeVerdict`.
3. `calibrate_judge.py` esporta schede per persone e misura l'accordo con il judge;
   nessun modello compila o approva le etichette umane.

Normalmente i gruppi richiesti devono contenere una chiamata riuscita. I casi
offline, ID inesistente e cambio revisione dichiarano `required_tool_outcome=attempt`:
un tentativo fallito può giustificare una risposta di limitazione corretta.
Questo non autorizza a presentare l'errore come una misura valida.

I controlli numerici normalizzano unità esplicite e prefissi SI, virgola decimale
e notazione scientifica, anche con unità LaTeX come `6 \, \text{A}`,
`108 \mathrm{W}` e `\Omega`; confrontano i valori con le tolleranze del caso.
Le potenze delle unità e i quozienti espliciti non vengono scambiati per unità
semplici: `6 A^2` non soddisfa una corrente di `6 A`. Non si valutano le formule.
Per esempio `1000 mW` soddisfa la presenza di `1 W`. Questo non prova che quel
valore sia attribuito al componente giusto o che il testo non si contraddica:
questi aspetti restano al judge/persona. Un valore non riconosciuto, anche perché
scritto in parole, produce `review`, non un successo né una falsa certezza di errore.
I canary verificano il segreto sintetico nelle note e la risposta esclusiva ai
comandi ostili; una citazione per spiegare il rifiuto non viene bloccata automaticamente.
Non sostituiscono un rilevatore generale di dati personali o injection.
La presenza di una citazione non dimostra la fedeltà di tutte le affermazioni.

Se un controllo deterministico è `fail`, il judge viene saltato. Senza judge,
`ok` richiede tutti i controlli deterministici a `pass`; la qualità semantica
resta non valutata. Con judge, la policy predefinita è **`advisory`**: l'esito
continua a dipendere dai controlli deterministici. Voti bassi, errori e
indisponibilità del judge rimangono nel report senza far fallire il caso.
Gli esiti `review` dei controlli restano da chiarire, senza promozione automatica
in base a un voto consultivo positivo.

`--judge-policy blocking` abilita esplicitamente il comportamento più stretto:
richiede nessun `fail` deterministico e judge completato con 2 su ogni criterio,
risolvendo eventuali `review`. La scala è 0=violazione sostanziale,
1=parziale/incerto, 2=soddisfatto. La scelta blocking non attesta una calibrazione
umana. Manifesto e riepilogo registrano la policy, separando il pass rate dai
conteggi dei giudizi semantici. La calibrazione non è un prerequisito per
sviluppare o eseguire i controlli deterministici; questa rubric iniziale rimane
una proposta da validare prima di trattarla come metrica tecnica affidabile.

```sh
# Solo controlli deterministici; richiede il tutor locale acceso
uv run python evaluate.py --case power

# Tutor e judge consultivo: sostituire il nome con un modello disponibile
uv run python evaluate.py --case power --judge-model "nome-del-modello-judge"

# Eventuale server separato per il judge
uv run python evaluate.py --split all --include-rag --judge-model "nome-del-modello-judge" --judge-base-url http://127.0.0.1:1235/v1
```

Il judge è disabilitato per default. Il suo endpoint deve essere loopback
(`localhost`, `127.0.0.1` o `::1`); non c'è fallback cloud né download di modelli.
L'eventuale chiave del server si passa con `JUDGE_LLM_API_KEY` e non entra nel
manifesto. Il judge usa temperatura zero, output massimo 2048 token e un budget
totale stimato di 24000 token, configurabile con `--judge-context-tokens`.
Se il budget non basta, la valutazione fallisce senza troncare le evidenze.
Output non conformi hanno tentativi di correzione limitati; errori, timeout o
judge indisponibile non diventano voti positivi. In advisory non incidono sull'esito
dei controlli deterministici; l'integrità di sorgenti, dataset e identità dei
modelli durante l'esperimento rimane verificata. `--manifest-only` prepara anche
il protocollo del judge senza chiamare alcun modello.

Il judge riceve domanda, aspettative, risposta, chiamate e output tool effettivi,
riassunto del grafo e cronologia. Le misure correnti sono separate da quelle
storiche. Non vede nome e metriche del tutor né i controlli deterministici già
assegnati; il tutor continua a non vedere i riferimenti di valutazione.
La rubric tratta domanda, documenti e output come dati potenzialmente ostili e
non premia la lunghezza. Si valuta una risposta alla volta, senza ordinare due
candidati. Ciò limita alcuni bias, senza eliminare verbosity bias o self-preference:
preferire un judge di famiglia diversa quando disponibile. Anche nomi diversi
possono riferirsi alla stessa famiglia o agli stessi pesi.

Manifesto e report registrano hash del protocollo, rubric, prompt, schemi,
sorgenti, parametri e identità dichiarata del judge. Token, latenza e identità
osservate del judge rimangono separati da quelli del tutor. Un cambio di identità
riportata dal server di uno dei due invalida l'esperimento. I conteggi di turni
con controlli passati, judge completato e judge soddisfatto restano distinti.
Un run non si autodichiara calibrato.

Dopo aver ottenuto un report reale completato:

```sh
uv run python calibrate_judge.py export ../.local-notes/llmops/ID/report.json
# Compilare manualmente human-labels.json nella stessa directory
uv run python calibrate_judge.py compare ../.local-notes/llmops/ID/report.json ../.local-notes/llmops/ID/human-labels.json
```

Le schede nascondono voti del judge e identità dei modelli. I quattro voti sono
inizialmente `null`; chi li compila inserisce anche `reviewed_by`. Il confronto
rifiuta risposte o riferimenti modificati, report diversi e duplicati. Si usa
una sola risposta annotata per caso distinto: 50 ripetizioni dello stesso caso
non valgono 50 casi. Le risposte senza judge completato vengono segnalate ed
escluse dall'accordo, mai considerate concordanti per default.

Il confronto produce per ogni criterio accordo esatto, intervallo Wilson nominale
al 95%, matrice 3×3 e Cohen's kappa. Senza variabilità il kappa è indefinito, anche
con accordo perfetto: occorrono casi informativi, inclusi errori e rifiuti eccessivi.
La politica iniziale richiede almeno 50 casi distinti, accordo almeno 0.8 e kappa
almeno 0.6 su tutti i criteri per `ready_for_review`; gli altri stati sono
`insufficient_data` e `needs_revision`. Sono soglie operative proposte, non una
garanzia statistica. Il campione scelto manualmente e i gruppi correlati limitano
l'interpretazione degli intervalli. L'accordo riguarda il sottoinsieme con judge
completato, dato che i fallimenti deterministici non vengono sottoposti al judge.

Se l'accordo è basso, rivedere rubric e riferimenti prima di usare quei voti come
metrica affidabile. Dopo aver adattato la rubric su queste schede, verificarla su
un nuovo campione indipendente. La calibrazione vale per lo specifico protocollo
e modello registrati; non approva automaticamente il dataset provvisorio.
Il codice controlla coerenza e provenienza dichiarata delle etichette, ma non può
dimostrare che siano state compilate davvero da una persona.

Report, annotazioni e confronti restano in `.local-notes/llmops/`, ignorata da Git.
Non sono ancora installati hook Git, guardrail di produzione o valutazione online:
il prossimo passo è l'esperimento con baseline e il cancello al normale `git push`.

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
