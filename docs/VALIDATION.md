# Validazione del motore

## 1. Test analitici automatici (`npm test`)

`node --test` esegue `tests/engine/*.test.ts` contro riferimenti analitici noti:

| Caso | Riferimento | Test |
| --- | --- | --- |
| Partitore di tensione | `Vout = Vin·R2/(R1+R2)` esatto | `divider.test.ts` |
| Carica RC | 63,2% di Vin a `t = τ` (±1%) | `rc.test.ts` |
| Diodo | I-V monotona, coerente con Shockley, KCL | `diode.test.ts` |
| BJT Ebers-Moll | zona attiva: `IC/IB ≈ βF` (±5%), KVL collettore | `bjt.test.ts` |
| Induttore DC | cortocircuito: `I = V/R` | `transient-integration.test.ts` |
| Raddrizzatore | il condensatore riduce il ripple > 3× | `transient-integration.test.ts` |
| Serializzazione | roundtrip fedele, input malformato tollerato | `serialize.test.ts` |

## 2. Cross-check offline con ngspice (oracolo di riferimento)

Il Charter (§3) impone un motore proprietario, validato offline contro
**ngspice (BSD)** come oracolo. ngspice **non è incluso né spedito** nel bundle:
è uno strumento di sviluppo opzionale.

### Setup

```sh
sudo apt install ngspice   # o brew install ngspice
```

### Uso

Le netlist di riferimento sono in `validation/ngspice/*.cir`, una per ciascun
circuito delle lezioni. Per confrontare:

```sh
cd validation/ngspice
ngspice -b divider.cir     # stampa il punto di lavoro DC
ngspice -b rc.cir          # transitoria: v(out) a t = τ
ngspice -b rectifier.cir   # transitoria: min/max di v(out) a regime
```

Confronta i valori stampati con quelli dei test (`npm test`) o con l'app
(probe/oscilloscopio, o il tool AI `runDC`/`runTransient`). Tolleranze attese:

- circuiti lineari: concordanza a meno del gmin (≈1e-12 S) — differenze < 1 µV;
- diodi/BJT: i parametri dei modelli (`Is`, `n`, `βF`) sono dichiarati nei `.cir`
  identici a quelli di `src/library/` — differenze < 1% sul punto di lavoro;
- transitoria: backward Euler nostro vs trapezoidale ngspice — differenze
  dell'ordine di `O(dt)`; riduci `dt` per convergere.

Nota: il nostro motore usa backward Euler (stabile, dissipativo); ngspice di
default usa il trapezio. Sul RC a `t=τ` con `dt = τ/1000` la differenza attesa
è < 0,1%.

## 3. Solver adattivo e confronto automatico (16 ottobre 2026)

La transitoria usa ora sottopassi backward Euler con stima dell'errore per
step doubling, rifiuto e rollback. `dt` è l'intervallo di uscita, mantenuto
costante; `adaptive: false` consente il confronto con il precedente passo fisso.
Newton distingue tensioni e correnti e verifica i residui dopo aver ricostruito
le equazioni alla soluzione candidata. `diagnostics` riporta residui e avvisi.

`tests/engine/accuracy.test.ts` aggiunge sweep analitici RC/RL e partitori,
rollback dopo un passo rifiutato e diagnostica di isole senza riferimento.

Il confronto ngspice è ora automatizzato:

```sh
npm run validate:spice
# oppure con un eseguibile estratto/localizzato separatamente:
NGSPICE_BIN=/percorso/ngspice npm run validate:spice
```

Lo script `scripts/validate-spice.ts` genera le netlist in una directory
temporanea, esegue ngspice, confronta 12 casi e termina con errore se manca
l'eseguibile o un confronto non rispetta la soglia. Non include ngspice nell'app.
Le temperature operative e nominali sono allineate a 300 K per i diodi.

Con ngspice 45.2 sono passati tutti i casi: partitori <0.0001%, diodi
<0.00004%, RC circa 0.0835%, RL circa 0.1435%. Questi risultati non garantiscono
un errore globale per circuiti arbitrari. Il RAG e il modello locale effettivo
non fanno parte della verifica numerica.

Verifica complessiva delle modifiche: suite motore passata (15 file), build
TypeScript/Vite passata, 10 test Python passati e 4 prove Playwright passate
(simulazione, A/B, tutor e RPC verso il browser). I test del tutor usano un
modello controllato; il collegamento al modello locale effettivo richiede
l'endpoint configurato dall'utente e non è stato verificato con un LLM avviato.
