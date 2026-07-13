# Circuit Studio — Project Charter

> Titolo di lavoro: **Circuit Studio** (modificabile).
> Questo documento è la fonte di verità della visione, delle decisioni bloccate e
> degli invarianti architetturali. Ogni prompt di milestone lo referenzia.
> Va committato nel repo (es. `docs/CHARTER.md`) e tenuto aggiornato: cambiare una
> "decisione bloccata" significa aggiornare qui prima di procedere.

---

## 1. Missione

Una piattaforma per imparare **davvero** l'elettronica analogica e digitale
costruendo e simulando circuiti. Il principio: il *perché si usa un componente*
non si spiega a parole, **emerge dalla relazione causa-effetto** — modifichi il
circuito e vedi la conseguenza in tempo reale.

## 2. Principi pedagogici (guidano ogni scelta di prodotto)

- **Causa-effetto immediato**: ogni modifica (valore, componente, topologia)
  aggiorna la simulazione senza latenza percepibile.
- **Confronto A/B**: poter *bypassare/togliere* un componente e vedere la
  differenza è la feature didattica centrale, non un extra.
- **Grounding**: spiegazioni (AI e lezioni) sempre ancorate ai dati reali di
  simulazione del circuito corrente, mai generiche o inventate.
- **Fondamenti matematici/fisici espliciti**: ogni concetto è accompagnato dalla
  sua matematica formale — leggi di Ohm e Kirchhoff, l'equazione differenziale
  della carica RC e la sua soluzione, l'equazione di Shockley — con i termini
  **mappati sui valori vivi** della simulazione: dal simbolo al numero e
  viceversa. Derivazioni complete, sempre ancorate al circuito corrente.
- **Imparare per insegnare**: chi usa la piattaforma prima impara, poi la usa per
  **spiegare ad altri**. Ogni vista deve funzionare anche come strumento di
  presentazione: scenari salvabili e condivisibili, lezioni riproducibili passo
  per passo davanti a un pubblico.
- **Progressione**: dai fondamentali (Ohm, RC) fino a circuiti complessi
  analogici + digitali, con applicazioni reali.

## 3. Decisioni bloccate

Non rinegoziabili senza aggiornare questo Charter.

| Tema | Decisione |
| --- | --- |
| Licenza | **MIT** |
| Motore di simulazione | **Proprietario**, scritto da noi. Nessun motore GPL (no Falstad). Validazione offline contro **ngspice (BSD)** come oracolo di riferimento, **mai spedito** nell'app. |
| Esecuzione simulazione | **Real-time client-side** (TypeScript; WASM in seguito solo se serve performance). |
| Backend Python | Rimandato a **M4**, come servizio opzionale "laboratorio calcolo & AI" (simbolico, SPICE di riferimento, FEM). Non in M1–M3. |
| AI | **API Claude**, ancorata alla simulazione via **tool-use**. La chiave API **non sta mai nel client**: un proxy minimale server-side (TypeScript) instrada le chiamate. |
| Frontend | **React + TypeScript + Vite** |
| Editor circuiti | **2D**, SVG/Canvas custom |
| Visore 3D + campi | **React Three Fiber**, da **M2** |
| Repo | **Nuovo**, riusa il pattern del guscio UI dal progetto celle |
| Stato | Store dedicato (**Zustand**) + **command pattern** per undo/redo |

## 4. Invarianti architetturali — i "seam" che rendono possibili M2–M4

Questi vincoli valgono **già da M1**, anche se le feature che li useranno arrivano
dopo. **M1 DEVE costruirli.** Sono ciò che rende il sistema "consapevole di dove
stiamo andando".

1. **Modello di circuito (netlist) come unica fonte di verità, indipendente dal
   motore.**
   - Componenti con pin e nodi; **interfaccia di "stamping" per dispositivo**
     (ogni componente sa contribuire alla matrice MNA da sé).
   - Raggruppamento in **sotto-circuiti** (predispone la partizione mixed-signal
     di M3).
   - **Serializzazione JSON** (salva/carica; è anche l'input che l'AI legge).

2. **Interfaccia `Simulator` astratta.**
   - Anche con il solo motore analogico, la simulazione sta dietro un'interfaccia,
     così il motore digitale e il coordinatore mixed-signal (M3) si innestano
     **senza toccare la UI**.
   - I confini tra domini (analogico/digitale) sono **nodi espliciti** nel modello.

3. **Rendering disaccoppiato dal modello.**
   - L'editor 2D disegna a partire dalla netlist; un layer separato di
     *probe/visualizzazione* legge gli output della simulazione.
   - Il visore 3D (M2) si aggancia alle **definizioni dei componenti** senza
     toccare il motore.

4. **Libreria componenti come dati + comportamento.**
   - Ogni componente = **metadati** (didattici, simbolo 2D, riferimento 3D) +
     **modello elettrico** (stamp). Registro estensibile: aggiungere un componente
     = aggiungere una voce, **senza modificare il nucleo**.

5. **Interfaccia a strumenti per l'AI.**
   - Il modello e il motore espongono tool (`getNetlist`, `runTransient`,
     `measureNode`, `listComponents`, `explainComponent`, ...). M1 li implementa;
     **ogni feature AI futura li riusa**.

6. **Visualizzazione dei campi (M2) pilotata da valori reali di simulazione**
   (campi analitici a livello di componente), **non** da PDE su tutta la scheda.

7. **Scenari condivisibili / modalità spiegazione.**
   - Lo stato completo di una sessione (circuito, parametri, sonde,
     configurazione oscilloscopio, viste aperte) è serializzabile in uno
     **scenario** salvabile e condivisibile (estende la serializzazione JSON del
     §4.1). Ogni lezione e vista è utilizzabile in **modalità presentazione**:
     chi insegna riusa gli stessi seam di chi impara.

8. **Contenuto matematico come dato, collegato alla simulazione.**
   - Le formule (Ohm/Kirchhoff, equazioni differenziali, Shockley) sono **dati
     della libreria componenti e delle lezioni**, con i termini simbolici
     **mappati su nodi/componenti** e sui loro valori simulati correnti — non
     testo statico.

## 5. Roadmap

| Milestone | Obiettivo | Seam che sfrutta |
| --- | --- | --- |
| **M1** | Fondamenta analogiche interattive: editor 2D + motore analogico (lineare + non lineare di base) + visualizzazione corrente/tensione/oscilloscopio + **pannello matematico** (derivazioni mappate sui valori simulati) + **scenari + modalità presentazione** + lezioni guidate + **tutor AI ancorato**. **Costruisce tutti i seam del §4.** | — (li crea) |
| **M2** | Visore **3D** interni componente + **campi E/M** a livello componente (pilotati dalla sim). Amplia la libreria componenti. | §4.3, §4.4, §4.6 |
| **M3** | Motore **digitale** (a eventi) + **coordinatore mixed-signal**. Componenti logici, comparatori/ADC ai confini analog↔digitale. | §4.1 (sotto-circuiti), §4.2 |
| **M4** | Servizio **Python** (FastAPI): analisi **simbolica** (sympy/lcapy), **SPICE di riferimento** per validazione, eventuale FEM per i campi; **AI avanzata** (generazione circuiti, curriculum adattivo, RAG). | §4.5 |

I prompt dettagliati di M2/M3/M4 si scrivono **quando ci si arriva**, alla stessa
precisione di M1, **contro il codice reale** — è l'unico modo per averli precisi.
Questo Charter garantisce che il codice li sappia già accogliere.

## 6. Fuori scope (per evitare deriva)

- Accuratezza industriale SPICE su circuiti patologici; modelli **BSIM**.
- Simulazione di campo su **intera PCB** (solo campi analitici a livello componente).
- Layout PCB / routing fisico.

## 7. Stack di riferimento

- **Frontend**: React 19, TypeScript, Vite.
- **Editor**: SVG/Canvas custom (2D).
- **3D (M2)**: React Three Fiber + Three.js.
- **Stato**: Zustand + command pattern (undo/redo).
- **Matematica**: rendering formule con **KaTeX** (MIT), termini collegati ai
  valori simulati correnti.
- **AI**: Claude API via proxy TypeScript (chiave server-side).
- **Test**: `node --test` per il motore (validazione analitica), Playwright per la UI.
- **Backend (M4)**: Python FastAPI.
