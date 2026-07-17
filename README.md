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

Per il **tutor AI** (opzionale) serve il proxy server-side (la chiave API non
sta mai nel client):

```sh
cp .env.example .env    # inserisci ANTHROPIC_API_KEY
ANTHROPIC_API_KEY=sk-ant-... npm run proxy   # oppure: export e npm run proxy
```

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
  delle giunzioni, transitoria backward Euler con companion model. Validato contro
  riferimenti analitici (`npm test`) e, offline, contro ngspice
  ([`docs/VALIDATION.md`](docs/VALIDATION.md)).
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
| `npm run proxy` | proxy tutor AI (serve `ANTHROPIC_API_KEY`) |
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
