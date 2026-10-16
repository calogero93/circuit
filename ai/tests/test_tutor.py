import asyncio
from collections import deque
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.memory import InMemorySaver
import websockets

from config import Settings, create_model
from graph import create_graph, make_tools
from main import create_app
from modules.tool_bridge import ToolBridge


class FakeModel:
    def __init__(self, responses):
        self.responses = deque(responses)
        self.calls = []

    def bind_tools(self, tools):
        self.tools = tools
        return self

    async def ainvoke(self, messages):
        self.calls.append(messages)
        response = self.responses.popleft()
        if isinstance(response, Exception):
            raise response
        return response


def input_state(text):
    return {"messages": [HumanMessage(content=text)], "trace": [], "tool_rounds": 0, "snapshot_revision": None}


class GraphTests(unittest.IsolatedAsyncioTestCase):
    async def test_theory_does_not_connect_browser(self):
        model = FakeModel([AIMessage(content="Una resistenza limita la corrente.")])
        with patch("modules.tool_bridge.websockets.connect", side_effect=AssertionError("browser inatteso")):
            graph = create_graph(Settings(), model=model).compile()
            result = await graph.ainvoke(input_state("Cos'è una resistenza?"))
        self.assertEqual(result["trace"], [])
        self.assertEqual(len(model.calls), 1)

    async def test_live_tool_result_and_history_persist(self):
        async def snapshot():
            return {"revision": 7, "nodeVoltages": {"n1": 3.2}, "converged": True}
        tool = StructuredTool.from_function(coroutine=snapshot, name="getCircuitSnapshot", description="Snapshot")
        model = FakeModel([
            AIMessage(content="", tool_calls=[{"name": tool.name, "args": {}, "id": "call-1"}]),
            AIMessage(content="Il nodo è a 3.2 V."), AIMessage(content="Sì, quel valore."),
        ])
        graph = create_graph(Settings(), model=model, tools=[tool]).compile(checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "test"}}
        first = await graph.ainvoke(input_state("Misura il circuito"), config)
        self.assertEqual(first["snapshot_revision"], 7)
        self.assertTrue(first["trace"][0]["ok"])
        self.assertIsInstance(model.calls[1][-1], ToolMessage)
        await graph.ainvoke(input_state("Confermi?"), config)
        humans = [m.content for m in model.calls[2] if isinstance(m, HumanMessage)]
        self.assertEqual(humans, ["Misura il circuito", "Confermi?"])
        self.assertEqual(len([m for m in model.calls[1] if isinstance(m, HumanMessage)]), 1)

    async def test_disconnected_browser_is_returned_to_model(self):
        async def unavailable():
            raise ConnectionError("nessun circuito connesso")
        tool = StructuredTool.from_function(coroutine=unavailable, name="getCircuitSnapshot", description="Snapshot")
        model = FakeModel([
            AIMessage(content="", tool_calls=[{"name": tool.name, "args": {}, "id": "call-1"}]),
            AIMessage(content="Apri il circuito nel browser."),
        ])
        result = await create_graph(Settings(), model=model, tools=[tool]).compile().ainvoke(input_state("Misura"))
        self.assertFalse(result["trace"][0]["ok"])
        self.assertEqual(model.calls[1][-1].status, "error")

    async def test_round_limit_requires_final_answer(self):
        async def value():
            return {"revision": 1}
        tool = StructuredTool.from_function(coroutine=value, name="getCircuitSnapshot", description="Snapshot")
        model = FakeModel([AIMessage(content="", tool_calls=[{"name": tool.name, "args": {}, "id": "one"}]), AIMessage(content="Fine")])
        result = await create_graph(replace(Settings(), max_tool_rounds=1), model=model, tools=[tool]).compile().ainvoke(input_state("Misura"))
        self.assertEqual(result["tool_rounds"], 1)
        self.assertIn("limite", model.calls[-1][0].content)

    async def test_bridge_rpc_and_close(self):
        async def handler(ws):
            async for raw in ws:
                msg = json.loads(raw)
                await ws.send(json.dumps({"id": msg["id"], "result": {"voltage": 4.2}}))
        async with websockets.serve(handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            bridge = ToolBridge(f"ws://127.0.0.1:{port}")
            async with bridge:
                results = await asyncio.gather(bridge.call("measureNode", nodeId="n1"), bridge.call("runDC"))
                self.assertEqual(results, [{"voltage": 4.2}] * 2)
            self.assertIsNone(bridge.ws)
            await bridge.close()

    async def test_bridge_timeout(self):
        async def handler(ws):
            await ws.recv()
            await ws.wait_closed()
        async with websockets.serve(handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            async with ToolBridge(f"ws://127.0.0.1:{port}", timeout=0.01) as bridge:
                with self.assertRaises(TimeoutError):
                    await bridge.call("runDC")


class ApiTests(unittest.TestCase):
    def test_interrupted_tools_are_repaired_on_next_turn(self):
        async def slow():
            await asyncio.sleep(10)
        tool = StructuredTool.from_function(coroutine=slow, name="slow", description="Slow")
        model = FakeModel([
            AIMessage(content="", tool_calls=[{"name": "slow", "args": {}, "id": "pending"}]),
            AIMessage(content="Riprendiamo la conversazione."),
        ])
        with tempfile.TemporaryDirectory() as directory:
            settings = replace(Settings(), data_dir=Path(directory), request_timeout=0.1)
            with TestClient(create_app(settings, lambda s: create_graph(s, model=model, tools=[tool]))) as client:
                body = {"query": "Misura", "thread_id": "interrupted"}
                self.assertEqual(client.post("/api/chat", json=body).status_code, 504)
                self.assertEqual(client.post("/api/chat", json=body).status_code, 200)
        self.assertIsInstance(model.calls[-1][-2], ToolMessage)
        self.assertEqual(model.calls[-1][-2].tool_call_id, "pending")

    def test_shared_endpoints_and_sqlite_history(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = replace(Settings(), data_dir=Path(directory))
            model = FakeModel([AIMessage(content="Prima risposta"), AIMessage(content="Seconda risposta")])
            def factory(settings):
                return create_graph(settings, model=model)
            with TestClient(create_app(settings, factory)) as client:
                self.assertEqual(client.get("/healthz").json()["provider"], "local")
                for endpoint in ["/api/chat", "/query"]:
                    response = client.post(endpoint, json={"query": "Ciao", "thread_id": "thread"})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["tools"], [])
                self.assertEqual(client.post("/api/chat", json={"query": "", "thread_id": "thread"}).status_code, 422)
            self.assertEqual(len([m for m in model.calls[-1] if isinstance(m, HumanMessage)]), 2)
            self.assertTrue((Path(directory) / "checkpoints.db").is_file())

    def test_default_is_local_even_with_cloud_key(self):
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "unused", "OPENAI_API_KEY": "unused"}, clear=True):
            settings = Settings.from_env()
            self.assertEqual(settings.provider, "local")
            self.assertEqual(settings.base_url, "http://127.0.0.1:1234/v1")
            self.assertNotIn("search_info", [tool.name for tool in make_tools(settings)])

    def test_local_adapter_uses_configured_endpoint(self):
        model = create_model(Settings(base_url="http://127.0.0.1:9999/v1", model="local-test"))
        self.assertEqual(model.openai_api_base, "http://127.0.0.1:9999/v1")
        self.assertEqual(model.model_name, "local-test")
        with patch.dict("os.environ", {"LLM_PROVIDER": "anthropic"}, clear=True):
            with self.assertRaises(ValueError):
                Settings.from_env()


if __name__ == "__main__":
    unittest.main()
