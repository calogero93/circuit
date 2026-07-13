# Circuit Studio — Prompt eseguibile M1

> Questo è il prompt da consegnare a un agente di sviluppo per costruire **M1**.
> Presuppone e referenzia `CHARTER.md`. Obiettivo: fondamenta analogiche
> interattive + tutor AI ancorato, con **tutti i seam architetturali** del §4 del
> Charter già in piedi per accogliere M2–M4.

---

## Ruolo e contesto

Stai costruendo la **M1** di *Circuit Studio*, una piattaforma didattica per
imparare l'elettronica costruendo e simulando circuiti. Leggi `CHARTER.md`: le
decisioni bloccate (§3) e gli invarianti architetturali (§4) sono **vincolanti**.
In particolare: licenza **MIT**, **motore di simulazione proprietario** (niente
codice GPL), simulazione **client-side in tempo reale**, e devi realizzare gli otto
**seam** del §4 anche dove la feature che li userà arriva solo in M2–M4.

## Deliverable

Un'app web (React + TypeScript + Vite, MIT) in cui l'utente **costruisce circuiti
analogici in un editor 2D**, li **simula in tempo reale**, **vede corrente e
tensione**, **vede la matematica formale accanto alla simulazione** (derivazioni
con termini mappati sui valori simulati), segue **lezioni guidate**, può
**salvare e condividere scenari** e usare tutto in **modalità presentazione** per
insegnare ad altri, e ha un **tutor AI ancorato alla simulazione**. Il progetto è un **repo nuovo** che riusa il *pattern* del guscio
UI del progetto celle (layout a pannelli, sidebar-palette, pannello dettagli,
stili) — non la sua scena 3D.

## Requisiti per area

### 1. Scaffold
- Vite + React + TypeScript. Licenza MIT (`LICENSE`, `package.json`).
- Struttura a moduli chiara: `model/` (netlist), `engine/` (simulazione),
  `editor/` (canvas 2D), `viz/` (visualizzazione), `math/` (formule + mapping
  simbolo↔circuito), `scenarios/` (salva/condividi + presentazione), `ai/`
  (tutor + tool), `components/` (UI), `lessons/` (contenuti didattici).
- Committa `docs/CHARTER.md`.

### 2. Modello di circuito (netlist) — seam §4.1
- Tipi per **componente**, **pin**, **nodo**, **filo**. Ogni componente espone una
  **interfaccia di stamping** (`stamp(matrix, rhs, ctx)`) — il motore non deve
  conoscere i tipi concreti.
- Supporto a **sotto-circuiti/gruppi** (anche solo strutturale ora: serve a M3).
- **Serializzazione JSON** completa (salva/carica) e deserializzazione robusta.
- Nodo di **massa** = riferimento 0.

### 3. Libreria componenti M1 — seam §4.4
Registro estensibile `dati + comportamento` (metadati didattici + simbolo 2D +
stamp elettrico). Componenti di M1:
- **Massa (ground)**.
- **Sorgente di tensione DC**, **sorgente di corrente DC**.
- **Sorgente di tensione sinusoidale** (ampiezza, frequenza, offset) — per il
  transitorio e le lezioni sul raddrizzatore.
- **Resistore** (stamp lineare, conduttanza G).
- **Condensatore** (companion model: equivalente di Norton con conduttanza
  `C/dt` + generatore di corrente dallo stato precedente).
- **Induttore** (companion model duale).
- **Diodo** (equazione di Shockley, risolto in Newton-Raphson, con *limiting* di
  tensione per la convergenza).
- **LED** (diodo + indicatore luminoso la cui intensità è legata alla corrente reale).
- **Interruttore SPST** (ideale: commuta la connettività / R molto bassa↔alta).
- **Almeno un transistor**: **BJT NPN con modello Ebers-Moll** (default). In
  alternativa NMOS square-law; scegline uno e implementalo completo.

### 4. Motore di simulazione (proprietario) — seam §4.2
- **Modified Nodal Analysis**: assembla la matrice per stamping dei componenti.
- **Punto di lavoro DC**: solve diretto per circuiti lineari; **Newton-Raphson**
  per i non lineari, con aiuti di convergenza minimi ma reali (**gmin stepping**
  e **limiting** delle tensioni di giunzione).
- **Analisi transitoria**: **backward Euler** (o trapezoidale) con i companion
  model per C/L; passo temporale configurabile.
- Tutto dietro un'**interfaccia `Simulator`** astratta (seam §4.2): la UI parla
  con l'interfaccia, non con l'implementazione analogica. I confini di dominio
  sono nodi espliciti (predispone M3).
- *(Opzionale in M1, altrimenti inizio M2)*: **sweep in frequenza / Bode** per la
  risposta dei filtri.
- **Validazione**: il motore va confrontato con risultati analitici noti (vedi
  §Testing). Predisponi un harness offline di cross-check con **ngspice** (BSD),
  documentato ma **non incluso** nel bundle.

### 5. Editor 2D — seam §4.3
- Canvas a **griglia** (SVG), con snap.
- **Palette** dei componenti nella sidebar (riusa il guscio UI delle celle).
- Piazza, trascina, **ruota (90°)**, seleziona, cancella componenti.
- **Strumento filo**: click su pin → click su pin, instradamento ortogonale,
  **merge dei nodi**.
- **Pannello proprietà** per editare i valori (R, C, L, ampiezza/frequenza
  sorgente) con aggiornamento live della simulazione.
- **Undo/redo** via command pattern; store **Zustand**.
- **Salva/carica** circuito come JSON.
- Il rendering legge dal modello; **non** deve accedere direttamente allo stato
  interno del motore.

### 6. Visualizzazione — seam §4.3
- **Colorazione dei fili per tensione di nodo** (scala divergente).
- **Puntini di corrente animati** sui fili: densità/velocità ∝ modulo della
  corrente, direzione ∝ segno.
- **Probe**: hover su nodo → V; hover su componente → I e V ai capi.
- **Oscilloscopio**: seleziona uno o più nodi e plotta V(t); per il raddrizzatore,
  ingresso vs uscita.
- **Toggle A/B** (feature didattica centrale): *bypassa/togli* il componente
  selezionato e mostra la differenza sull'oscilloscopio (traccia "fantasma" di
  confronto sovrapposta).

### 7. Lezioni guidate
Almeno queste, ciascuna imperniata sul ruolo di **un** componente:
1. **Partitore di tensione** (Ohm, DC).
2. **Carica/scarica RC** (costante di tempo, transitorio).
3. **Raddrizzatore con/senza condensatore di livellamento** — **lezione di punta**:
   togliendo il condensatore l'ondulazione ricompare sull'oscilloscopio.
4. **Clipping con diodo**.
5. **LED con resistenza di limitazione** (perché la resistenza: senza, la corrente
   diverge / il LED "si brucia").
Ogni lezione include: obiettivo, circuito iniziale, il "perché", un punto di
confronto A/B, e il suo **pannello matematico** (vedi §8).

### 8. Fondamenti matematici — seam §4.8
- Ogni lezione e componente espone un **pannello matematico**: la formula formale
  (rendering **KaTeX**, MIT) con i **termini mappati sui valori vivi** della
  simulazione — hover su un termine evidenzia il nodo/componente corrispondente e
  mostra il valore simulato corrente, e viceversa. Le formule sono **dati della
  libreria componenti e delle lezioni** (seam §4.4), non testo statico.
- Casi obbligatori in M1:
  - **Partitore di tensione**: derivazione da KCL + legge di Ohm fino a
    `Vout = Vin·R₂/(R₁+R₂)`, con i valori correnti sostituibili nei simboli.
  - **Carica RC**: l'equazione differenziale `RC·dV/dt + V = Vin`, la sua
    soluzione esponenziale `V(t) = Vin·(1 − e^(−t/τ))` e `τ = RC` evidenziato
    graficamente sull'oscilloscopio (marcatore al 63,2%).
  - **Diodo**: equazione di **Shockley** accanto alla curva I-V, con il punto di
    lavoro corrente evidenziato sulla curva.
- Profondità: derivazioni complete da corso introduttivo di elettrotecnica,
  sempre ancorate al circuito corrente — mai formula senza numero, mai numero
  senza formula.

### 9. Modalità insegnamento — scenari e presentazione (seam §4.7)
La piattaforma serve a chi impara **e poi insegna**: ogni feature deve funzionare
anche davanti a un pubblico.
- **Scenari**: salva/carica/condividi lo stato completo (circuito, parametri,
  sonde, configurazione oscilloscopio, viste aperte) come JSON — estende il
  salva/carica del §5.
- **Modalità presentazione**: UI ridotta (nasconde i pannelli non pertinenti),
  tipografia più grande, avanzamento a passi controllato da chi presenta.
- Ogni lezione è riproducibile come **sequenza di passi predefiniti**, così chi
  ha imparato può ripercorrerla spiegandola ad altri.

### 10. Tutor AI ancorato — seam §4.5
- Pannello chat.
- **Tool esposti dal modello/motore**: `getNetlist()`, `runDC()`,
  `runTransient(params)`, `measureNode(nodeId)`, `measureComponent(id)`,
  `listComponents()`, `getLessonState()`.
- **Claude API via proxy TypeScript** (endpoint minimale server-side, unica parte
  server di M1): la chiave `ANTHROPIC_API_KEY` sta **solo sul server**, mai nel
  bundle client.
- System prompt: tutor socratico di elettronica **che deve chiamare i tool prima
  di affermare fatti sul circuito**. Esempio d'uso: "perché il mio LED non si
  accende?" → il tutor chiama `getNetlist` + `runDC`, vede corrente nulla, e
  spiega ancorandosi ai valori reali.

## Seam da costruire esplicitamente (checklist §4 del Charter)
- [ ] Modello netlist con interfaccia di stamping + sotto-circuiti + JSON.
- [ ] Interfaccia `Simulator` astratta con confini di dominio espliciti.
- [ ] Rendering disaccoppiato dal motore (viz legge output, non stato interno).
- [ ] Registro componenti estensibile (dati + comportamento).
- [ ] Interfaccia a tool per l'AI.
- [ ] Predisposizione hook per campi a livello componente (M2): i componenti
      espongono già i valori (corrente/tensione) che i campi useranno.
- [ ] Scenari serializzabili + modalità presentazione.
- [ ] Formule come dati (libreria componenti + lezioni), mappate su
      nodi/componenti e valori simulati.

## Criteri di accettazione
- Build e avvio ok; app funzionante.
- Si costruisce la lezione **raddrizzatore**; togliere/aggiungere il condensatore
  di livellamento **cambia visibilmente** la traccia sull'oscilloscopio
  (ondulazione ↔ livellato).
- **Test del motore** superati contro riferimenti analitici (vedi Testing).
- **Undo/redo** funziona su piazza/filo/edit/cancella.
- Simulazione **stabile (converge)** su tutte le lezioni di M1.
- **Pannello matematico**: nella lezione RC il marcatore di `τ = RC`
  sull'oscilloscopio **coincide con il 63,2% simulato**; i valori mostrati nei
  simboli coincidono con quelli della simulazione.
- Uno **scenario** salvato e ricaricato ripristina lo stato completo; la
  **modalità presentazione** funziona su almeno una lezione.
- Il **tutor AI** risponde a una domanda ancorata **invocando i tool** (verificabile
  nei log).
- Gli otto **seam** sono presenti e documentati brevemente in `docs/`.

## Testing / verifica
- `node --test` sul motore con **casi di validazione analitica**:
  - partitore: tensione d'uscita esatta;
  - RC: raggiunge il **63,2%** a `t = τ` entro tolleranza;
  - diodo: I-V monotona e coerente con Shockley.
- Harness offline opzionale di cross-check con **ngspice** (documentato, non spedito).
- **Playwright** smoke (riusa l'approccio a metriche-pixel del progetto celle):
  carica, piazza componenti, avvia simulazione, verifica canvas non vuoto.

## Fuori scope M1 (arriva dopo)
Motore **digitale**, **mixed-signal**, visore **3D**, **campi** E/M, servizio
**Python**, modelli **BSIM**, layout **PCB**. Non implementarli; lascia solo i seam.
