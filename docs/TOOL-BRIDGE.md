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

Il browser si connette al relay se è definito `VITE_TOOL_BRIDGE_URL` (mettilo in
`.env.local`, es. `VITE_TOOL_BRIDGE_URL=ws://localhost:8787`), oppure a mano dalla
console: `window.__circuitStudio.connectToolBridge('ws://localhost:8787')`.

## Protocollo (JSON su WebSocket)

Client → relay:

```jsonc
{ "type": "list_tools", "id": 1 }
{ "type": "call", "id": 2, "tool": "runDC", "input": {} }
```

relay → Client:

```jsonc
{ "type": "tools",  "id": 1, "tools": [ /* schemi in formato Anthropic tool */ ] }
{ "type": "result", "id": 2, "result": { /* ... */ } }      // oppure: "error": "..."
```

`id` è scelto dal client e restituito così com'è (correlazione richiesta/risposta).

## Tool disponibili

| tool | input | cosa restituisce |
| --- | --- | --- |
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
import asyncio, json, itertools, websockets

class ToolBridge:
    def __init__(self, url="ws://localhost:8787"):
        self.url, self.ws, self._ids = url, None, itertools.count(1)

    async def connect(self):
        self.ws = await websockets.connect(self.url)

    async def _rpc(self, payload):
        rid = next(self._ids)
        await self.ws.send(json.dumps({**payload, "id": rid}))
        while True:                      # scarta eventuali messaggi con altro id
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == rid:
                return msg

    async def list_tools(self):
        return (await self._rpc({"type": "list_tools"}))["tools"]

    async def call(self, tool, **input):
        msg = await self._rpc({"type": "call", "tool": tool, "input": input})
        if "error" in msg and msg["error"]:
            raise RuntimeError(msg["error"])
        return msg["result"]

async def main():
    bridge = ToolBridge()
    await bridge.connect()
    print([t["name"] for t in await bridge.list_tools()])
    print(await bridge.call("getNetlist"))
    print(await bridge.call("measureComponent", componentId="R1"))

asyncio.run(main())
```

Da qui i tool sono normali coroutine: incapsulale come nodi/strumenti del tuo
grafo LangGraph. Se nessun browser è connesso, una `call` torna
`error: "nessun circuito connesso…"`.
