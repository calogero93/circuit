import asyncio
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import replace
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore
from pydantic import ValidationError
import websockets

from config import Settings, create_model
from graph import create_graph
from main import create_app
from modules.tool_bridge import ToolBridge
from memory import recall
from schemas import (ComponentInput, ConversationSummary, Evidence, ModelQuestion,
                     NodeInput, SubmitAnswer, TransientInput)
from tools import BROWSER_TOOLS, make_tools


def answer(text, kind="theory", evidence=None, measured=False, notes=None):
    return AIMessage(content="", tool_calls=[{"name": "SubmitAnswer", "id": "final-" + str(id(text)),
        "args": {"response": text, "kind": kind, "evidence_ids": evidence or [],
                 "uses_measurements": measured, "learning_notes": notes or []}}])


def call(name="getCircuitSnapshot", args=None, call_id="call-1"):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args or {}, "id": call_id}])


class FakeModel:
    def __init__(self, responses):
        self.responses = deque(responses)
        self.calls = []
        self.bindings = []

    def bind_tools(self, tools, **kwargs):
        self.bindings.append((tools, kwargs))
        return self

    async def ainvoke(self, messages):
        self.calls.append(messages)
        response = self.responses.popleft()
        if isinstance(response, Exception):
            raise response
        return response


class TestMemory:
    def __init__(self, settings=None):
        self.checkpointer = InMemorySaver()
        self.store = InMemoryStore()
        self.locks = {}

    async def __aenter__(self): return self
    async def __aexit__(self, *_): pass

    @asynccontextmanager
    async def lock(self, key):
        async with self.locks.setdefault(key, asyncio.Lock()):
            yield


def input_state(text):
    return {"messages": [HumanMessage(content=ModelQuestion(question=text).model_dump_json())],
            "trace": [], "evidence": [], "tool_rounds": 0, "schema_errors": 0,
            "snapshot_revision": None, "revision_consistent": True, "answer": None, "metrics": {}}


def custom_tool(function, name="getCircuitSnapshot"):
    return StructuredTool.from_function(coroutine=function, name=name, description="Test tool")


class GraphTests(unittest.IsolatedAsyncioTestCase):
    async def test_theory_does_not_connect_browser_and_is_structured(self):
        model = FakeModel([answer("Una resistenza limita la corrente.")])
        with patch("modules.tool_bridge.websockets.connect", side_effect=AssertionError("browser inatteso")):
            result = await create_graph(Settings(), model=model).compile().ainvoke(input_state("Cos'è una resistenza?"))
        self.assertEqual(result["trace"], [])
        self.assertEqual(result["answer"]["kind"], "theory")
        self.assertEqual(result["metrics"]["model_calls"], 1)
        self.assertEqual(json.loads(model.calls[0][-1].content)["question"], "Cos'è una resistenza?")

    async def test_live_tool_result_and_history_persist(self):
        async def snapshot():
            return {"revision": 7, "nodeVoltages": {"n1": 3.2}, "converged": True, "measurementsAvailable": True}
        model = FakeModel([call(), answer("Il nodo è a 3.2 V.", "circuit", ["call-1"], True), answer("Sì, quel valore era storico.")])
        graph = create_graph(Settings(), model=model, tools=[custom_tool(snapshot)]).compile(checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "test"}}
        first = await graph.ainvoke(input_state("Misura il circuito"), config)
        self.assertEqual(first["snapshot_revision"], 7)
        self.assertTrue(first["trace"][0]["ok"])
        self.assertTrue(first["evidence"][0]["measurement_valid"])
        self.assertIsInstance(model.calls[1][-1], ToolMessage)
        self.assertTrue(json.loads(model.calls[1][-1].content)["ok"])
        await graph.ainvoke(input_state("Confermi?"), config)
        humans = [json.loads(m.content)["question"] for m in model.calls[2] if isinstance(m, HumanMessage)]
        self.assertEqual(humans, ["Misura il circuito", "Confermi?"])

    async def test_disconnected_browser_is_returned_to_model(self):
        async def unavailable(): raise ConnectionError("nessun circuito connesso")
        model = FakeModel([call(), answer("Apri il circuito nel browser.", "limitation")])
        result = await create_graph(Settings(), model=model, tools=[custom_tool(unavailable)]).compile().ainvoke(input_state("Misura"))
        self.assertFalse(result["trace"][0]["ok"])
        self.assertEqual(result["evidence"], [])
        self.assertEqual(model.calls[1][-1].status, "error")

    async def test_revision_change_cannot_produce_a_circuit_conclusion(self):
        revisions = iter([4, 5])
        async def snapshot():
            return {"revision": next(revisions), "converged": True, "measurementsAvailable": True}
        model = FakeModel([call(call_id="a"), call(call_id="b"),
                           answer("Tensione confermata", "circuit", ["a"], True),
                           answer("Il circuito è cambiato; ripeti la domanda.", "limitation")])
        result = await create_graph(Settings(), model=model, tools=[custom_tool(snapshot)]).compile().ainvoke(input_state("Misura"))
        self.assertEqual(result["snapshot_revision"], 4)
        self.assertFalse(result["revision_consistent"])
        self.assertEqual(result["answer"]["kind"], "limitation")
        self.assertFalse(result["trace"][1]["ok"])
        self.assertEqual(len(result["evidence"]), 1)

    async def test_invalid_evidence_and_nonconvergent_measurement_are_rejected(self):
        async def snapshot(): return {"revision": 2, "converged": False}
        model = FakeModel([call(), answer("2 V", "circuit", ["missing"], True),
                           answer("2 V", "circuit", ["call-1"], True),
                           answer("Non ci sono misure convergenti", "limitation")])
        result = await create_graph(Settings(), model=model, tools=[custom_tool(snapshot)]).compile().ainvoke(input_state("Misura"))
        self.assertEqual(result["answer"]["kind"], "limitation")
        self.assertEqual(result["schema_errors"], 2)

    async def test_round_limit_requires_structured_final_answer(self):
        async def snapshot(): return {"revision": 1}
        model = FakeModel([call(), answer("Fine", "circuit", ["call-1"])])
        result = await create_graph(replace(Settings(), max_tool_rounds=1), model=model,
            tools=[custom_tool(snapshot)]).compile().ainvoke(input_state("Misura"))
        self.assertEqual(result["tool_rounds"], 1)
        self.assertIn("limite", model.calls[-1][0].content)

    async def test_free_text_is_retried_not_accepted_as_structured_output(self):
        model = FakeModel([AIMessage(content="testo libero"), answer("Testo validato")])
        result = await create_graph(Settings(), model=model).compile().ainvoke(input_state("Ciao"))
        self.assertEqual(result["answer"]["response"], "Testo validato")
        self.assertEqual(result["metrics"]["model_calls"], 2)

    async def test_large_tool_payload_is_not_sent_to_model(self):
        async def snapshot(): return {"revision": 1, "waveforms": "x" * 40000}
        model = FakeModel([call(), answer("Serve una misura mirata", "limitation")])
        result = await create_graph(Settings(), model=model, tools=[custom_tool(snapshot)]).compile().ainvoke(input_state("Misura"))
        self.assertFalse(result["trace"][0]["ok"])
        self.assertNotIn("x" * 100, model.calls[1][-1].content)

    async def test_summary_preserves_recent_turn_and_complete_tool_protocol(self):
        model = FakeModel([call(), answer("Risposta " + "a" * 500, "circuit", ["call-1"]),
            AIMessage(content="riassunto fuori schema"),
            AIMessage(content="", tool_calls=[{"name": "ConversationSummary", "id": "s", "args": {
                "summary": "Ha studiato un partitore; i numeri precedenti sono storici.", "learning_notes": ["Studia i partitori"]}}]),
            answer("Nuova risposta")])
        async def snapshot(): return {"revision": 1}
        settings = replace(Settings(), summary_threshold_tokens=200, keep_recent_turns=1)
        graph = create_graph(settings, model=model, tools=[custom_tool(snapshot)]).compile(checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "summary"}}
        await graph.ainvoke(input_state("Partitore"), config)
        result = await graph.ainvoke(input_state("Spiega ancora"), config)
        self.assertEqual(result["metrics"]["summaries"], 1)
        self.assertIn("storici", result["summary"]["summary"])
        history = (await graph.aget_state(config)).values["messages"]
        self.assertEqual(len([m for m in history if isinstance(m, HumanMessage)]), 1)
        self.assertNotIn("Risposta aaa", str([m.content for m in model.calls[-1]]))
        self.assertIsInstance(history[0], HumanMessage)

    async def test_long_term_recall_is_recent_and_bounded_after_many_threads(self):
        store = InMemoryStore()
        for index in range(105):
            await store.aput(("tutor", "u"), str(index), {"summary": "s" * 4000, "learning_notes": [f"Nota {index}"]})
        memories = await recall(store, "u", "104", max_chars=300)
        self.assertEqual(memories[0]["learning_notes"], ["Nota 103"])
        self.assertLessEqual(sum(len(ConversationSummary.model_validate(m).model_dump_json()) for m in memories), 300)
        self.assertEqual(await recall(store, "other", "x"), [])

    async def test_browser_contract_and_session_are_validated(self):
        seen = []
        class Bridge:
            def __init__(self, url): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *_): pass
            async def call(self, name, **kwargs):
                seen.append(kwargs)
                return {"id": "R1", "type": "resistor", "params": {}, "revision": 1,
                        "time_s": 0.1, "converged": True, "live": {"data": {"p": 1}, "pinCurrents": [.1, -.1]}}
        tool = next(t for t in make_tools(Settings(), Bridge) if t.name == "measureComponent")
        value = await tool.ainvoke({"componentId": "R1"}, config={"configurable": {"session_id": "tab-a"}})
        self.assertEqual(value["live"]["data"]["p"], 1)
        self.assertEqual(seen[0], {"session_id": "tab-a", "componentId": "R1"})
        with self.assertRaises(ValidationError): await tool.ainvoke({"componentId": ""})
        class BadBridge(Bridge):
            async def call(self, name, **kwargs): return {"invalid": True}
        tool = make_tools(Settings(), BadBridge)[0]
        with self.assertRaises(ValidationError): await tool.ainvoke({})

    async def test_bridge_rpc_and_close(self):
        seen = []
        async def handler(ws):
            async for raw in ws:
                msg = json.loads(raw)
                seen.append(msg)
                await ws.send(json.dumps({"id": msg["id"], "result": {"voltage": 4.2}}))
        async with websockets.serve(handler, "127.0.0.1", 0) as server:
            bridge = ToolBridge(f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}")
            async with bridge:
                results = await asyncio.gather(bridge.call("measureNode", nodeId="n1", session_id="tab"), bridge.call("runDC"))
                self.assertEqual(results, [{"voltage": 4.2}] * 2)
            self.assertEqual(seen[0]["session_id"], "tab")
            self.assertIsNone(bridge.ws)
            await bridge.close()

    async def test_bridge_timeout(self):
        async def handler(ws):
            await ws.recv()
            await ws.wait_closed()
        async with websockets.serve(handler, "127.0.0.1", 0) as server:
            async with ToolBridge(f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}", timeout=.01) as bridge:
                with self.assertRaises(TimeoutError): await bridge.call("runDC")


class ApiTests(unittest.TestCase):
    def test_interrupted_tools_are_repaired_on_next_turn(self):
        async def slow(): await asyncio.sleep(10)
        model = FakeModel([call("slow", call_id="pending"), answer("Riprendiamo la conversazione.")])
        settings = replace(Settings(), request_timeout=.15)
        factory = lambda s: create_graph(s, model=model, tools=[custom_tool(slow, "slow")])
        with TestClient(create_app(settings, factory, TestMemory)) as client:
            body = {"query": "Misura", "thread_id": "interrupted"}
            self.assertEqual(client.post("/api/chat", json=body).status_code, 504)
            self.assertEqual(client.post("/api/chat", json=body).status_code, 200)
        self.assertIsInstance(model.calls[-1][-2], ToolMessage)
        self.assertEqual(model.calls[-1][-2].tool_call_id, "pending")

    def test_shared_endpoints_history_and_long_term_notes(self):
        memory = TestMemory()
        model = FakeModel([answer("Prima risposta", notes=["Studia elettronica di base"]),
                           answer("Seconda risposta"), answer("Terza risposta")])
        factory = lambda s: create_graph(s, model=model)
        with TestClient(create_app(Settings(), factory, lambda s: memory)) as client:
            for endpoint in ["/api/chat", "/query"]:
                res = client.post(endpoint, json={"query": "Ciao", "thread_id": "thread", "user_id": "u"})
                self.assertEqual(res.status_code, 200, res.text)
                self.assertEqual(res.json()["tools"], [])
            self.assertEqual(client.post("/api/chat", json={"query": "", "thread_id": "thread"}).status_code, 422)
            res = client.post("/api/chat", json={"query": "Nuovo thread", "thread_id": "new", "user_id": "u"})
            self.assertEqual(res.status_code, 200, res.text)
            self.assertIn("Studia elettronica di base", model.calls[-1][1].content)
            schemas = client.get("/api/schemas").json()
            self.assertIn("description", schemas["tools"]["measureComponent"]["input"]["properties"]["componentId"])
        self.assertEqual(len([m for m in model.calls[1] if isinstance(m, HumanMessage)]), 2)

    def test_same_thread_different_users_are_isolated(self):
        model = FakeModel([answer("Ciao", notes=["Preferisce formule"]), answer("Ciao")])
        with TestClient(create_app(Settings(), lambda s: create_graph(s, model=model), TestMemory)) as client:
            for user in ["u1", "u2"]:
                self.assertEqual(client.post("/api/chat", json={"query": "Ciao", "thread_id": "same", "user_id": user}).status_code, 200)
        self.assertNotIn("Preferisce formule", model.calls[1][1].content)
        self.assertEqual(len([m for m in model.calls[1] if isinstance(m, HumanMessage)]), 1)

    def test_stream_exposes_tool_lifecycle_before_final(self):
        async def snapshot(): return {"revision": 3}
        model = FakeModel([call(), answer("R1 nel circuito", "circuit", ["call-1"])])
        factory = lambda s: create_graph(s, model=model, tools=[custom_tool(snapshot)])
        with TestClient(create_app(Settings(), factory, TestMemory)) as client:
            res = client.post("/api/chat/stream", json={"query": "R1?", "thread_id": "stream"})
            events = [json.loads(line) for line in res.text.splitlines()]
        kinds = [e["event"] for e in events]
        self.assertLess(kinds.index("tool_start"), kinds.index("tool_end"))
        self.assertLess(kinds.index("tool_end"), kinds.index("final"))
        self.assertEqual(events[-1]["data"]["answer"]["kind"], "circuit")

    def test_default_is_local_even_with_cloud_key(self):
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "unused", "OPENAI_API_KEY": "unused"}, clear=True):
            settings = Settings.from_env()
            self.assertEqual(settings.provider, "local")
            self.assertNotIn("search_info", [t.name for t in make_tools(settings)])

    def test_local_adapter_uses_configured_endpoint(self):
        model = create_model(Settings(base_url="http://127.0.0.1:9999/v1", model="local-test"))
        self.assertEqual(model.openai_api_base, "http://127.0.0.1:9999/v1")
        with patch.dict("os.environ", {"LLM_PROVIDER": "anthropic"}, clear=True):
            with self.assertRaises(ValueError): Settings.from_env()

    def test_local_http_adapter_sends_schemas_and_parses_structured_reply(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                message = {"role": "assistant", "content": None, "tool_calls": [{
                    "id": "f", "type": "function", "function": {"name": "SubmitAnswer", "arguments": json.dumps({
                        "response": "Una resistenza limita la corrente.", "kind": "theory", "evidence_ids": [],
                        "uses_measurements": False, "learning_notes": []})}}]}
                data = json.dumps({"id": "reply", "object": "chat.completion", "created": 1, "model": "local-test",
                    "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls"}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 30, "total_tokens": 130}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            settings = replace(Settings(), base_url=f"http://127.0.0.1:{server.server_port}/v1", model="local-test")
            with TestClient(create_app(settings, memory_factory=TestMemory)) as client:
                res = client.post("/api/chat", json={"query": "Cos'è una resistenza?", "thread_id": "http"})
                self.assertEqual(res.status_code, 200, res.text)
                self.assertEqual(res.json()["answer"]["kind"], "theory")
                self.assertEqual(res.json()["metrics"]["input_tokens"], 100)
            request = requests[0]
            tools = {t["function"]["name"]: t["function"] for t in request["tools"]}
            self.assertIn("description", tools["measureComponent"]["parameters"]["properties"]["componentId"])
            self.assertIn("SubmitAnswer", tools)
            self.assertEqual(json.loads(request["messages"][-1]["content"])["question"], "Cos'è una resistenza?")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_schema_fields_are_described_and_constraints_enforced(self):
        import schemas
        from pydantic import BaseModel
        for cls in vars(schemas).values():
            if isinstance(cls, type) and issubclass(cls, BaseModel) and cls.__module__ == "schemas":
                for name, field in cls.model_fields.items():
                    self.assertTrue(field.description, f"{cls.__name__}.{name}")
        for cls, args in [(ComponentInput, {"componentId": ""}), (NodeInput, {"nodeId": ""}),
                          (TransientInput, {"duration_ms": 5001}), (TransientInput, {"duration_ms": 1, "dt_us": .5})]:
            with self.assertRaises(ValidationError): cls.model_validate(args)


if __name__ == "__main__": unittest.main()
