# Tool-bridge (WebSocket)

Espone i **tool del circuito** (`src/ai/tools.ts`) a un client esterno — es. un
sistema multiagente Python. I tool leggono lo **stato vivo** (store + simulazione
in corso), quindi l'esecutore è il **browser**; il relay fa solo da rendez-vous:

```
[ Browser: host, esegue i tool ]  ⇄  relay WS  ⇄  [ Client (Python): chiama i tool ]
```

## Avvio

```sh
npm run tool-bridge     # relay solo su ws://127.0.0.1:8787 (TOOL_BRIDGE_PORT cambia la porta)
npm run dev             # l'app; il browser si registra come host
```

Il browser si connette automaticamente a `/tool-bridge` sullo stesso host;
Vite inoltra il WebSocket al relay. `VITE_TOOL_BRIDGE_URL` permette un override.
Questo flusso è previsto per l'esecuzione locale: un reverse proxy da solo non
rende sicura l'esposizione pubblica del tutor o del relay. Il relay espone anche
`GET /healthz`, con `connected` e il numero di `sessions` connesse.

Il relay verifica le origini browser esplicitamente consentite (Vite su
`http://127.0.0.1:5173`, `http://localhost:5173` e preview sulla porta `4173`).
`TOOL_BRIDGE_ALLOWED_ORIGINS` può cambiare l'elenco; non usare wildcard.
Il browser acquisisce una capability temporanea per il ruolo host, mentre il
tutor invia una capability diversa nell'header `Authorization`. Gli ID di
sessione identificano la scheda e non sostituiscono l'autorizzazione.

Il relay ruota le capability a ogni avvio. Quella del tutor è conservata fuori
dal repository: directory private `0700` in `XDG_RUNTIME_DIR`, se idonea, oppure
nella directory temporanea del sistema, e file `0600`. Node e Python ricavano
lo stesso percorso dal checkout e dalla porta; avviali dalla stessa copia del
progetto. Non copiare la capability in URL, variabili frontend o log. I processi
locali dello stesso utente e gli script dell'origine frontend sono fidati.

Il tutor usa FastAPI/LangGraph (vedi [`ai/README.md`](../ai/README.md));
il relay inoltra soltanto le operazioni sul circuito. Lo snapshot restituisce
`revision`, `time_s`, `converged`, `diagnostics`, `measurementsAvailable`,
netlist e misure acquisite nella stessa esecuzione sincrona sul browser.

## Protocollo (JSON su WebSocket)

Client → relay:

```jsonc
{ "type": "list_tools", "id": 1, "session_id": "scheda" }
{ "type": "call", "id": 2, "session_id": "scheda", "tool": "runDC", "input": {} }
```

relay → Client:

```jsonc
{ "type": "tools",  "id": 1, "tools": [ /* schemi con name, description e input_schema */ ] }
{ "type": "result", "id": 2, "result": { /* ... */ } }      // oppure: "error": "..."
```

Il browser registra un `session_id` distinto per scheda. Il client indica la
sessione da interrogare: `session_id` è obbligatorio anche con un unico host
connesso. Le risposte sono accettate soltanto dal browser destinatario.
Il catalogo degli argomenti è generato da `ai/circuit_ai/contracts/shared.py`; gli output vengono
validati in Python prima di essere passati al modello.

`id` è scelto dal client e restituito così com'è (correlazione richiesta/risposta).

## Tool disponibili

| tool | input | cosa restituisce |
| --- | --- | --- |
| `getCircuitSnapshot` | — | netlist e misure coerenti dello stesso frame, versione e diagnostica |
| `getNetlist` | — | componenti (parametri + net per pin), nets, `hasGround` |
| `runDC` | — | punto di lavoro DC: tensioni di nodo, correnti/dati per componente |
| `runTransient` | `duration_ms`, `dt_us?` | forme d'onda campionate delle tensioni di nodo |
| `measureNode` | `nodeId` | tensione live + DC di un nodo (es. `"n1"`) |
| `measureComponent` | `componentId` | parametri + grandezze live di un componente (es. `"R1"`) |
| `listComponents` | — | libreria: tipi disponibili con descrizione e parametri |
| `getLessonState` | — | lezione/passo/A-B/sonde correnti |

Gli schemi completi (con `input_schema`) arrivano da `list_tools`.

## Esempio client Python

```python
import asyncio
from circuit_ai.integrations.bridge import ToolBridge

async def main():
    async with ToolBridge("ws://127.0.0.1:8787") as bridge:
        print(await bridge.call("getCircuitSnapshot", session_id="scheda"))
        print(await bridge.call("measureComponent", session_id="scheda", componentId="R1"))

asyncio.run(main())
```

Esegui il client dall'ambiente Python di `ai/` (`uv run python <script.py>`),
con il relay avviato. L'adapter legge automaticamente la capability privata e
disabilita la scoperta automatica dei proxy per la connessione locale; non
modifica i proxy usati dagli altri servizi.

Da qui i tool sono normali coroutine: incapsulale come nodi/strumenti del tuo
grafo LangGraph. Se nessun browser è connesso, una `call` torna
`error: "nessun circuito connesso…"`.
