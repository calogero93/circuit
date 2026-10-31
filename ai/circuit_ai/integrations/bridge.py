"""RPC serializzato e limitato nel tempo verso il browser live."""
import asyncio
import itertools
import json
import inspect
from urllib.parse import urlsplit
from circuit_ai.integrations.bridge_runtime import read_tutor_capability

import websockets


class ToolBridge:
    def __init__(self, url="ws://127.0.0.1:8787", timeout=20.0, *, token=None):
        self.url = url
        self.timeout = timeout
        self.token = token
        self.ws = None
        self._ids = itertools.count(1)
        self._lock = asyncio.Lock()

    async def connect(self):
        endpoint = urlsplit(self.url)
        if endpoint.scheme != "ws" or endpoint.hostname not in {"127.0.0.1", "localhost"}:
            raise ValueError("Il tool bridge deve usare un endpoint ws localhost")
        token = self.token
        if token is None:
            token = read_tutor_capability(endpoint.port or 80)
        if not token:
            raise RuntimeError("Capability del bridge vuota")
        options = {"open_timeout": 5, "max_size": 8_000_000,
                   "additional_headers": {"Authorization": f"Bearer {token}"}}
        # websockets 14 has no proxy discovery/argument; 15+ enables it by default.
        if "proxy" in inspect.signature(websockets.connect).parameters:
            options["proxy"] = None
        self.ws = await websockets.connect(self.url, **options)
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

    async def list_tools(self, session_id=None):
        return (await self._rpc({"type": "list_tools", "session_id": session_id}))["tools"]

    async def call(self, tool, *, session_id=None, **input):
        return (await self._rpc({"type": "call", "tool": tool, "input": input,
                                 "session_id": session_id}))["result"]
