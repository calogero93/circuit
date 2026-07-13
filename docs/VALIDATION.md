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
