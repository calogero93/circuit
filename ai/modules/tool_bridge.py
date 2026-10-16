"""RPC serializzato e limitato nel tempo verso il browser live."""
import asyncio
import itertools
import json

import websockets


class ToolBridge:
    def __init__(self, url="ws://127.0.0.1:8787", timeout=20.0):
        self.url = url
        self.timeout = timeout
        self.ws = None
        self._ids = itertools.count(1)
        self._lock = asyncio.Lock()

    async def connect(self):
        self.ws = await websockets.connect(self.url, open_timeout=5, max_size=8_000_000)
        return self

    async def close(self):
        if self.ws is not None:
            ws, self.ws = self.ws, None
            await ws.close()

    async def __aenter__(self):
        return await self.connect()

    async def __aexit__(self, *_):
        await self.close()

    async def _rpc(self, payload):
        async with self._lock:
            if self.ws is None:
                raise RuntimeError("Tool bridge non connesso")
            async with asyncio.timeout(self.timeout):
                rid = next(self._ids)
                await self.ws.send(json.dumps({**payload, "id": rid}))
                while True:
                    msg = json.loads(await self.ws.recv())
                    if msg.get("id") == rid:
                        if msg.get("error"):
                            raise RuntimeError(msg["error"])
                        return msg

    async def list_tools(self):
        return (await self._rpc({"type": "list_tools"}))["tools"]

    async def call(self, tool, **input):
        return (await self._rpc({"type": "call", "tool": tool, "input": input}))["result"]
