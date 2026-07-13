# ⚡ Circuit Studio

Piattaforma didattica per imparare **davvero** l'elettronica analogica costruendo e
simulando circuiti: modifichi il circuito e vedi la conseguenza in tempo reale.
Il *perché* di un componente non si spiega a parole — emerge dal **confronto A/B**:
lo togli, e la traccia sull'oscilloscopio te lo racconta.

M1: fondamenta analogiche interattive. Visione, decisioni bloccate e invarianti
architetturali: [`docs/CHARTER.md`](docs/CHARTER.md). Mappa dei seam:
[`docs/SEAMS.md`](docs/SEAMS.md).

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

## Cosa c'è dentro (M1)

- **Editor 2D** su griglia SVG: piazza, trascina, ruota, cablaggio pin→pin con
  merge dei nodi, undo/redo (command pattern), salva/carica JSON.
- **Motore di simulazione proprietario** (MIT, niente GPL): MNA per stamping,
  Newton-Raphson con gmin stepping e limiting delle giunzioni, transitoria
  backward Euler con companion model. Validato contro riferimenti analitici
  (`npm test`) e, offline, contro ngspice ([`docs/VALIDATION.md`](docs/VALIDATION.md)).
- **Libreria M1**: massa, sorgenti DC/sinusoidale/corrente, R, C, L, diodo, LED
  (con luminosità legata alla corrente reale), interruttore SPST, BJT NPN Ebers-Moll.
- **Visualizzazione**: fili colorati per tensione, puntini di corrente animati,
  probe al passaggio del mouse, oscilloscopio multi-traccia, **toggle A/B** con
  traccia fantasma.
- **Pannello matematico** (KaTeX): derivazioni complete con i termini **mappati sui
  valori vivi** della simulazione — hover sul simbolo → si illumina il componente.
  Marcatore τ = RC al 63,2% sull'oscilloscopio.
- **5 lezioni guidate**: partitore, carica RC, raddrizzatore (di punta), clipping
  a diodo, LED con resistenza di limitazione.
- **Scenari e presentazione**: stato completo salvabile/condivisibile (file o
  link), modalità presentazione con passi controllati (← →).
- **Tutor AI ancorato**: chiama i tool (`getNetlist`, `runDC`, ...) prima di
  affermare qualsiasi cosa sul circuito; le chiamate sono visibili nel transcript.

## Comandi

| Comando | Cosa fa |
| --- | --- |
| `npm run dev` | dev server Vite |
| `npm run proxy` | proxy tutor AI (serve `ANTHROPIC_API_KEY`) |
| `npm test` | test del motore (`node --test`, validazione analitica) |
| `npm run test:e2e` | smoke Playwright (metrica a pixel sull'oscilloscopio) |
| `npm run build` | typecheck + build di produzione |

## Scorciatoie

`w` filo · `p` sonda · `r` ruota · `Canc` cancella · `Ctrl+Z`/`Ctrl+Y` undo/redo ·
`Esc` seleziona · doppio click su interruttore = apri/chiudi · `←`/`→` passi lezione.

## Licenza

MIT — vedi [`LICENSE`](LICENSE).
