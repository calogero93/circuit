# Gli otto seam architetturali (Charter §4) — dove vivono nel codice

M1 costruisce tutti i seam che rendono possibili M2–M4. Questa è la mappa.

## 1. Modello netlist come unica fonte di verità (§4.1)

- `src/model/types.ts` — componente, pin, nodo (net), filo; **sotto-circuiti/gruppi**
  (`Group`, strutturale per la partizione mixed-signal di M3) e **confini di dominio
  espliciti** (`Circuit.boundaries`).
- `src/model/device.ts` — **interfaccia di stamping** (`DeviceModel.stamp(ctx, ...)`):
  ogni componente contribuisce da sé alla matrice MNA; il motore non conosce i tipi concreti.
- `src/model/serialize.ts` — serializzazione JSON completa, deserializzazione difensiva.
  È anche il formato che l'AI legge (`getNetlist`).
- `src/model/netlist.ts` — compilazione fili→nodi (union-find), consumata da motore e UI.

## 2. Interfaccia `Simulator` astratta (§4.2)

- `src/engine/simulator.ts` — `Simulator` (con `domain: 'analog' | 'digital' | 'mixed'`),
  `TransientSession`, `SimResult`. La UI e l'AI parlano SOLO con questa interfaccia.
- `src/engine/analog.ts` — l'implementazione analogica (MNA + Newton-Raphson + gmin
  stepping + backward Euler). Il motore digitale e il coordinatore mixed-signal di M3
  si innestano qui senza toccare la UI; i confini tra domini sono nodi espliciti nel modello.

## 3. Rendering disaccoppiato dal modello (§4.3)

- `src/editor/CanvasEditor.tsx` disegna a partire dalla netlist (`Circuit`), mai dallo
  stato interno del motore.
- `src/viz/controller.ts` — il layer di probe/visualizzazione: compila, avanza la
  transitoria e pubblica gli **output** (`SimResult`); colori dei fili, puntini di
  corrente, oscilloscopio e pannello matematico leggono da qui.
- Il visore 3D di M2 si aggancerà alle definizioni dei componenti (`symbol3d` nel
  registro) senza toccare il motore.

## 4. Libreria componenti = dati + comportamento (§4.4)

- `src/model/registry.ts` — voce di registro: metadati didattici + simbolo 2D (dati,
  non JSX) + riferimento 3D (`symbol3d`, per M2) + modello elettrico + formule.
- `src/library/*` — le voci M1. Aggiungere un componente = registrare una voce
  (`registerComponent`), **senza modificare il nucleo**.

## 5. Interfaccia a strumenti per l'AI (§4.5)

- `src/ai/tools.ts` — `getNetlist`, `runDC`, `runTransient`, `measureNode`,
  `measureComponent`, `listComponents`, `getLessonState`. Ogni feature AI futura
  (M4: generazione circuiti, curriculum adattivo) riusa questi tool.
- `server/proxy.mjs` — la chiave API sta solo qui.

## 6. Hook per i campi a livello componente (M2, §4.6)

- Ogni dispositivo espone già in `DeviceOutputs` le correnti ai pin e le grandezze
  interne (`data`): sono esattamente i valori che piloteranno i campi E/M analitici
  di M2 (niente PDE su tutta la scheda).

## 7. Scenari condivisibili + modalità presentazione (§4.7)

- `src/scenarios/scenario.ts` — lo stato completo della sessione (circuito, sonde,
  configurazione oscilloscopio, A/B, lezione, viste, presentazione) è un JSON
  salvabile, caricabile e condivisibile via link (hash URL).
- Modalità presentazione: `StudioState.presentation` + CSS (`.app.presentation`) —
  UI ridotta, tipografia grande, passi lezione con ← →. Chi insegna riusa gli stessi
  seam di chi impara.

## 8. Contenuto matematico come dato (§4.8)

- `src/math/formula.ts` — le formule sono **dati** (`FormulaDef`): passi LaTeX con
  termini (`\htmlClass{fx-...}`) mappati su componenti/nodi (`TermTarget`) e
  espressioni derivate (τ = R·C) serializzabili.
- Vivono nella libreria componenti (`ComponentDef.formulas`, con segnaposto `self`)
  e nelle lezioni (`src/lessons/data.ts`).
- `src/math/resolve.ts` porta il simbolo al numero vivo; `src/math/MathPanel.tsx`
  rende con KaTeX e realizza l'hover bidirezionale simbolo ↔ circuito.
