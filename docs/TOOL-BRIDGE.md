# Tool-bridge (WebSocket)

Espone i **tool del circuito** (`src/ai/tools.ts`) a un client esterno — es. un
sistema multiagente Python. I tool leggono lo **stato vivo** (store + simulazione
in corso), quindi l'esecutore è il **browser**; il relay fa solo da rendez-vous:

```
[ Browser: host, esegue i tool ]  ⇄  relay WS  ⇄  [ Client (Python): chiama i tool ]
```

## Avvio

```sh
npm run tool-bridge     # relay su ws://localhost:8787 (env TOOL_BRIDGE_PORT per cambiarla)
npm run dev             # l'app; il browser si registra come host
```

Il browser si connette automaticamente a `/tool-bridge` sullo stesso host;
Vite inoltra il WebSocket al relay. `VITE_TOOL_BRIDGE_URL` permette un override.
In produzione configura lo stesso inoltro nel reverse proxy. Il relay espone
anche `GET /healthz`, con il campo `connected` per lo stato dell'host.

Il tutor usa FastAPI/LangGraph (vedi [`ai/README.md`](../ai/README.md));
il relay inoltra soltanto le operazioni sul circuito. Lo snapshot restituisce
`revision`, `time_s`, `converged`, `diagnostics`, `measurementsAvailable`,
netlist e misure acquisite nella stessa esecuzione sincrona sul browser.

## Protocollo (JSON su WebSocket)

Client → relay:

```jsonc
{ "type": "list_tools", "id": 1 }
{ "type": "call", "id": 2, "tool": "runDC", "input": {} }
```

relay → Client:

```jsonc
{ "type": "tools",  "id": 1, "tools": [ /* schemi con name, description e input_schema */ ] }
{ "type": "result", "id": 2, "result": { /* ... */ } }      // oppure: "error": "..."
```

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
from modules.tool_bridge import ToolBridge

async def main():
    async with ToolBridge("ws://127.0.0.1:8787") as bridge:
        print(await bridge.call("getCircuitSnapshot"))
        print(await bridge.call("measureComponent", componentId="R1"))

asyncio.run(main())
```

Da qui i tool sono normali coroutine: incapsulale come nodi/strumenti del tuo
grafo LangGraph. Se nessun browser è connesso, una `call` torna
`error: "nessun circuito connesso…"`.
