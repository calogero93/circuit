# ⚡ Circuit Studio

Piattaforma didattica per imparare **davvero** l'elettronica — analogica, digitale
e mixed-signal — costruendo e simulando circuiti: modifichi il circuito e vedi la
conseguenza in tempo reale. Il *perché* di un componente non si spiega a parole —
emerge dal **confronto A/B**: lo togli, e la traccia sull'oscilloscopio te lo racconta.

Visione, decisioni bloccate e invarianti architetturali: [`docs/CHARTER.md`](docs/CHARTER.md).
Mappa dei seam: [`docs/SEAMS.md`](docs/SEAMS.md).

## Avvio

```sh
npm install
npm run dev        # app su http://localhost:5173
```

Per il **tutor AI** (opzionale), avvia il modello locale configurato e il
servizio LangGraph. Il default non usa API cloud:

```sh
cp .env.example .env     # configura LLM_BASE_URL e LLM_MODEL
docker compose up -d --wait postgres
cd ai
uv sync --extra dev
uv run python main.py   # FastAPI su http://127.0.0.1:8080
```

In un altro terminale, dalla radice: `npm run tool-bridge`. Il browser si
collega automaticamente al relay tramite il proxy WebSocket di Vite. Il tutor
usa un solo percorso LangGraph e decide quando leggere o simulare il circuito;
può rispondere alle domande teoriche anche senza browser collegato.
Schemi Pydantic per tool e risposte, memoria PostgreSQL e riassunti automatici
al superamento della soglia configurata. Provider esterni disponibili solo con
configurazione esplicita server-side.
Configurazione e avvio: [`ai/README.md`](ai/README.md).

## Architettura

La **simulazione vive nel browser**: editor, strumenti, formule e viste leggono
lo stesso circuito e i risultati dei motori TypeScript. Il tutor usa un unico
grafo LangGraph sul servizio Python; il modello sceglie quando rispondere alla
teoria e quando interrogare il circuito live tramite tool.

```mermaid
flowchart TB
    subgraph Browser["Browser — React e TypeScript"]
        Editor["Editor, lezioni e scenari"]
        Store["Zustand: circuito e configurazione"]
        Controller["SimController: sessioni e confronto A/B"]
        Engines["Motori analogico, digitale e mixed-signal"]
        Views["Canvas, oscilloscopio, formule e 3D"]
        Tutor["TutorPanel: chat"]
        Host["Host WebSocket ed executeTool"]
        Editor --> Store --> Controller
        Controller -->|"netlist e avanzamento"| Engines
        Engines -->|"SimResult e diagnostica"| Controller
        Controller --> Views
        Host <-->|"snapshot e simulazioni richieste"| Controller
        Host -->|"letture"| Store
    end

    subgraph Services["Servizi del tutor"]
        API["FastAPI — porta 8080"]
        Graph["LangGraph: prepare, agent, tools"]
        Tools["Tool Python e validazione Pydantic"]
        Bridge["ToolBridge Python: client RPC"]
        Relay["Relay WebSocket Node — porta 8787"]
        Memory[("PostgreSQL: checkpoint, sintesi e note")]
        RAG["RAG opzionale: embedding e Qdrant locale"]
        API <--> Graph
        Graph <--> Tools
        Tools <--> Bridge <--> Relay
        Graph <-->|"checkpoint"| Memory
        API <-->|"sintesi e note per utente"| Memory
        Tools -.->|"search_info"| RAG
    end

    Model["LLM locale: endpoint configurato"]
    Tutor <-->|"HTTP e stream NDJSON"| API
    Graph <--> Model
    Host <-->|"WebSocket e session_id"| Relay
```

Il diagramma mostra i collegamenti logici. In sviluppo **Vite** inoltra `/api`
a FastAPI e `/tool-bridge` al relay; in produzione questi inoltri spettano al
reverse proxy. Il relay Node instrada richieste e risposte verso la scheda
browser indicata da `session_id`. I calcoli elettrici sono eseguiti dai motori
nel browser; l'LLM interpreta i risultati e costruisce la spiegazione.

Il provider predefinito è locale, con protocollo compatibile OpenAI su
`LLM_BASE_URL`. I provider cloud richiedono configurazione esplicita sul server.
Il RAG, quando abilitato, cerca documenti; PostgreSQL conserva il contesto delle
conversazioni e le note didattiche. Memoria e ricerca documentale hanno quindi
compiti distinti.

| Area | Codice | Responsabilità |
| --- | --- | --- |
| Stato e modifiche | [`src/store/`](src/store/) | Zustand, comandi, undo/redo, ambiente e configurazione della UI. |
| Modello e componenti | [`src/model/`](src/model/), [`src/library/`](src/library/) | Circuito, compilazione dei fili in nodi elettrici, modelli dei dispositivi e formule. |
| Simulazione | [`src/engine/`](src/engine/), [`controller.ts`](src/viz/controller.ts) | Soluzioni numeriche, stato delle sessioni, campioni e confronto A/B. |
| Interfaccia e didattica | [`src/editor/`](src/editor/), [`src/viz/`](src/viz/), [`src/math/`](src/math/), [`src/viz3d/`](src/viz3d/), [`src/lessons/`](src/lessons/), [`src/scenarios/`](src/scenarios/) | Editor, strumenti, visualizzazioni, lezioni e scenari salvabili. |
| Tutor e contratti | [`ai/main.py`](ai/main.py), [`ai/graph.py`](ai/graph.py), [`ai/schemas.py`](ai/schemas.py), [`ai/config.py`](ai/config.py) | HTTP, orchestrazione, schemi di input/output e configurazione del modello. |
| Collegamento ai tool live | [`src/ai/`](src/ai/), [`tool-bridge.mjs`](server/tool-bridge.mjs), [`tool_bridge.py`](ai/modules/tool_bridge.py), [`ai/tools.py`](ai/tools.py) | Registrazione delle schede, RPC WebSocket, esecuzione browser e validazione dei risultati. |
| Memoria e contesto | [`ai/memory.py`](ai/memory.py), [`ai/context.py`](ai/context.py) | Checkpoint PostgreSQL, note fra conversazioni, budget e riassunti del contesto. |
| Valutazione offline | [`ai/evals/`](ai/evals/), [`ai/evaluate.py`](ai/evaluate.py), [`ai/evaluators.py`](ai/evaluators.py), [`ai/judge.py`](ai/judge.py), [`ai/calibrate_judge.py`](ai/calibrate_judge.py) | Dataset, esperimenti ripetibili, controlli deterministici, judge locale e confronto con etichette umane. |

### Flusso della simulazione live

```mermaid
flowchart TD
    Edit["Avvio o modifica del circuito in Zustand"]
    Compile["Compila la netlist e sceglie il motore"]
    Session["Crea o aggiorna la sessione; eventuale sessione A/B"]
    Frame["Callback requestAnimationFrame"]
    Running{"Simulazione in esecuzione?"}
    Step["Avanza le sessioni nel budget del frame"]
    Paused["Mantiene il risultato; DC iniziale se necessario"]
    Result["Pubblica SimResult, campioni e diagnostica"]
    Render["Aggiorna strumenti e visualizzazioni"]
    Edit --> Compile --> Session --> Frame --> Running
    Running -->|"Sì"| Step --> Result
    Running -->|"No"| Paused --> Result
    Result --> Render --> Frame
```

Una **sessione di simulazione** conserva il tempo e gli stati fisici necessari
al passo successivo, come tensioni dei condensatori e correnti degli induttori.
Le modifiche ordinarie trasferiscono gli stati disponibili; il caricamento
integrale di uno scenario riavvia la simulazione. Il confronto A/B usa una
seconda sessione con il circuito modificato.

Il passo numerico e il frame grafico hanno ritmi diversi: il controller può
eseguire più passi per callback e il solver analogico usa sottopassi adattivi.
Gli strumenti leggono risultati e diagnostica pubblicati dal controller.
`runDC` e `runTransient`, richiesti dal tutor, effettuano analisi dedicate;
la transitoria richiesta via tool usa una sessione separata da quella live.

### Cosa fa il grafo LangGraph

Il grafo coordina **contesto → decisione del modello → tool → risposta
validata**. La stessa implementazione serve la chat del browser e i client
HTTP esterni.

```mermaid
flowchart TD
    Request["Domanda, user_id, thread_id e session_id"]
    Restore["FastAPI: ripristina checkpoint e recupera memoria didattica"]
    Start(["START"])
    Prepare["prepare: controlla il budget e riassume se necessario"]
    Agent["agent: LLM con domanda, contesto e schemi dei tool"]
    Tools["tools: esegue strumenti oppure valida SubmitAnswer"]
    End(["END"])
    Final["FastAPI: salva sintesi e note; invia la risposta finale"]
    Request --> Restore --> Start --> Prepare --> Agent
    Agent -->|"Chiamate strutturate"| Tools
    Agent -->|"Budget superato: risposta limitation"| End
    Tools -->|"Risultati o risposta da correggere"| Prepare
    Tools -->|"SubmitAnswer accettato"| End
    End --> Final
```

- **`prepare`** compatta la cronologia oltre la soglia configurata, conservando
  il turno corrente e le coppie chiamata/risposta dei tool.
- **`agent`** sceglie gli strumenti oppure conclude con `SubmitAnswer`. Anche
  una spiegazione teorica usa questo schema finale, senza richiedere tool del
  browser.
- **`tools`** esegue le chiamate: letture e calcoli passano dal bridge al browser;
  `search_info`, se abilitato, consulta i documenti. Per `SubmitAnswer` controlla
  schema, evidenze citate e coerenza delle revisioni prima di terminare il grafo.

Gli output del browser sono validati con Pydantic prima di diventare evidenze.
Le misure dichiarate nella risposta richiedono un'evidenza convergente acquisita
nel turno corrente. Se le revisioni cambiano fra letture, il modello deve
concludere con una limitazione. Gli errori dei tool ritornano al modello come
risultati strutturati; round, tentativi di correzione e tempi sono limitati.
Questi controlli verificano contratti e metadati: la correttezza di ogni frase
richiede anche valutazione semantica.

La chat mostra progressivamente gli eventi dei tool e pubblica il testo finale
dopo la validazione. Per domande sul circuito live serve il browser collegato;
teoria e saluti possono essere gestiti anche senza una scheda connessa.

### Identità e memoria

| Identità | Cosa rappresenta |
| --- | --- |
| Sessione numerica (`TransientSession`) | Il calcolo in corso nel browser, con tempo e stati fisici; una seconda sessione sostiene il confronto A/B. |
| `session_id` | La scheda browser cui indirizzare i tool via WebSocket. |
| `thread_id` | La conversazione da riprendere dai checkpoint del grafo. |
| `user_id` | Il contesto utente cui appartengono conversazioni e note didattiche condivise fra thread. |

PostgreSQL usa `AsyncPostgresSaver` per i checkpoint e `AsyncPostgresStore` per
sintesi e note. Le richieste dello stesso utente/thread sono serializzate con
lock PostgreSQL. Quando il contesto cresce, `ConversationSummary` riduce la
cronologia attiva conservandone una sintesi persistente; i vecchi checkpoint
rimangono nel database. Misure e riassunti storici vanno distinti dallo stato
live appena letto.

La valutazione **LLMOps offline** riusa il grafo con fixture controllate e
checkpoint in memoria: verifica prima i contratti, poi usa facoltativamente un
judge locale consultivo e prepara il confronto umano. I voti del judge restano
informativi per default; la calibrazione umana non blocca lo sviluppo.
Questo percorso valuta il tutor
senza richiedere il browser; i report e le annotazioni sono salvati in
`.local-notes/llmops/`, ignorata da Git. Dataset e codice degli evaluator sono
versionati. Configurazione, comandi e criteri: [`ai/README.md`](ai/README.md).
Il dataset [`ai/evals/textbook/`](ai/evals/textbook/) aggiunge 11 casi derivati
da soluzioni pubblicate di elettronica, con fonti e pagine tracciate, separando
prove senza tool e misure su fixture. I libri forniscono le soluzioni attese
agli evaluator, senza retrieval nel percorso del tutor. Serve a costruire la
baseline di confronto; non è ancora una baseline approvata.

## Cosa c'è dentro

### Editor 2D
Griglia SVG: piazza, trascina, **ruota**, **duplica** e **multi-selezione a
rettangolo** con spostamento di gruppo, copia/incolla, undo/redo (command pattern),
salva/carica JSON. **Ricerca nella palette** e **evidenziazione del net** al
passaggio del mouse.
Cablaggio con **gomito invertibile**, **waypoint multipli** (instradamento a più
segmenti) e **giunzioni a T**; i fili seguono i componenti spostati.

### Motori di simulazione (proprietari, MIT, niente GPL)
- **Analogico**: MNA per stamping, Newton-Raphson con gmin stepping e limiting
  delle giunzioni, transitoria backward Euler con sottopassi adattivi, stima dell’errore e rollback dei passi rifiutati. Convergenza verificata con residui e tolleranze separate per tensioni e correnti; diagnostica delle isole flottanti. Validato contro
  riferimenti analitici (`npm test`) e, offline, contro ngspice
  (`npm run validate:spice`).
- **Digitale nativo**: combinatoria a punto fisso + sequenziale sul fronte di
  clock, dietro l'interfaccia `Simulator`.
- **Coordinatore mixed-signal**: co-simula analogico↔digitale nello **stesso
  circuito** accoppiando i due motori ai **nodi di confine** (soglia in ingresso,
  tensione pilotata in uscita). Il controller instrada per dominio.

### Libreria componenti
- **Sorgenti**: DC, sinusoidale (con fase), corrente, pulse.
- **Passivi**: R, C, L, potenziometro.
- **Semiconduttori**: diodo, **LED** (si accende col colore scelto), Schottky,
  Zener, BJT NPN/PNP (Ebers-Moll), MOSFET N/P, op-amp, ponte raddrizzatore,
  trasformatore, relè, fusibile.
- **Sensori** (variabili d'ambiente regolabili): LDR, NTC/PTC, barometro, Hall,
  umidità.
- **Digitale**: ingresso/clock/uscita logica, porte NOT/BUFFER/AND/OR/NAND/NOR/
  XOR/XNOR, flip-flop **D** e **T**, **display esadecimale a 7 segmenti**.
- **Strumenti** piazzabili: **multimetro** (in parallelo, alta impedenza,
  manopola V/R/C/L/diodo) e **amperometro** (in serie, ideale) — quanti ne vuoi,
  con letture live sul canvas.

### Visualizzazione 3D + campi
Pannello **3D** (React Three Fiber, caricato in lazy): il componente selezionato
come modello ruotabile ancorato ai dati vivi (il resistore mostra le sue **bande di
colore reali**, il LED si illumina), con i **campi** animati dalla simulazione:
**flusso di corrente**, **campo E** fra le armature del condensatore, **campo B**
attorno alla bobina.

### Dimensionamento di potenza
Resistenze con potenza nominale configurabile, derating con la temperatura
ambiente e avvisi live sul canvas. Il pannello distingue potenza istantanea,
media e temperatura stimata; il modello termico ha parametri regolabili.
Dati e limiti sono disponibili anche al tutor. Il profilo termico predefinito
è didattico e non simula automaticamente la rottura del componente.

### Analisi e didattica
- **Visualizzazione 2D**: fili colorati per tensione, puntini di corrente animati,
  sonde, oscilloscopio multi-traccia (tempo e **Bode**), **confronto A/B** con
  traccia fantasma (tasto `a`).
- **Pannello matematico** (KaTeX): derivazioni complete con i termini **mappati sui
  valori vivi** — hover sul simbolo → si illumina il componente.
- **Tavola di verità dal vivo** per i circuiti digitali (clic su una riga per
  impostare gli ingressi).
- **Lezioni guidate**, **libreria scenari** (nel browser) e stato completo
  salvabile/condivisibile (file o link), modalità presentazione (← →).
- **Tutor AI ancorato**: chiama i tool (`getNetlist`, `runDC`, …) prima di
  affermare qualsiasi cosa sul circuito; le chiamate sono visibili nel transcript.

## Comandi

| Comando | Cosa fa |
| --- | --- |
| `npm run dev` | dev server Vite |
| `docker compose up -d --wait postgres` | database persistente per il tutor |
| `npm run ai` | servizio tutor FastAPI/LangGraph (default LLM locale) |
| `npm run tool-bridge` | relay WebSocket per i tool live |
| `npm run validate:spice` | confronto automatico con ngspice installato, oppure `NGSPICE_BIN` |
| `npm test` | test del motore (`node --test`, validazione analitica) |
| `npm run test:e2e` | e2e Playwright |
| `npm run build` | typecheck + build di produzione |

## Scorciatoie

`w` filo · `p` sonda · `r` ruota · `a` confronto A/B · `Canc` cancella ·
`Ctrl+Z`/`Ctrl+Y` undo/redo · `Ctrl+C`/`Ctrl+V`/`Ctrl+D` copia/incolla/duplica ·
`Esc` seleziona · trascinamento su area vuota = selezione a rettangolo,
`Spazio`+trascinamento (o tasto centrale) = pan · doppio click su interruttore/
ingresso logico = commuta · doppio click su un filo = inverte il gomito ·
`←`/`→` passi lezione.

Filo: clic sul pin di partenza, clic nel vuoto per aggiungere waypoint, clic sul
pin d'arrivo per chiudere; clic su un filo esistente per creare una giunzione.

## Licenza

MIT — vedi [`LICENSE`](LICENSE).
