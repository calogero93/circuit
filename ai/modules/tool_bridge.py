import asyncio, json, itertools, websockets

class ToolBridge:
    def __init__(self, url="ws://localhost:8787"):
        self.url, self.ws, self._ids = url, None, itertools.count(1)

    async def connect(self):
        self.ws = await websockets.connect(self.url)

    async def close(self):
        self.ws.close()

    def get_id(self):
        return self.ws.id

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

# async def main():
#     bridge = ToolBridge()
#     await bridge.connect()
#     print([t["name"] for t in await bridge.list_tools()])
#     print(await bridge.call("getNetlist"))
#     print(await bridge.call("measureComponent", componentId="R2"))

# asyncio.run(main())