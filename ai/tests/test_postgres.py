"""Integrazione reale: AI_TEST_DATABASE_URL punta al servizio Compose."""
from dataclasses import replace
import os
import unittest
from uuid import uuid4

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage

from config import Settings
from graph import create_graph
from main import create_app
from test_tutor import FakeModel, answer


@unittest.skipUnless(os.getenv("AI_TEST_DATABASE_URL"), "Impostare AI_TEST_DATABASE_URL per la prova PostgreSQL")
class PostgresTests(unittest.TestCase):
    def test_restart_preserves_thread_and_memory_across_threads(self):
        user = "test-" + uuid4().hex
        settings = replace(Settings(), database_url=os.environ["AI_TEST_DATABASE_URL"])
        first = FakeModel([answer("Prima risposta", notes=["Vuole esempi sui partitori"] )])
        with TestClient(create_app(settings, lambda s: create_graph(s, model=first))) as client:
            res = client.post("/api/chat", json={"query": "Partitore", "thread_id": "a", "user_id": user})
            self.assertEqual(res.status_code, 200, res.text)
        second = FakeModel([answer("Risposta dopo riavvio"), answer("Nuovo thread"), answer("Altro utente")])
        with TestClient(create_app(settings, lambda s: create_graph(s, model=second))) as client:
            for thread, identity in [("a", user), ("b", user), ("a", user + "-other")]:
                res = client.post("/api/chat", json={"query": "Confermi?", "thread_id": thread, "user_id": identity})
                self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(len([m for m in second.calls[0] if isinstance(m, HumanMessage)]), 2)
        self.assertIn("Vuole esempi sui partitori", second.calls[1][1].content)
        self.assertNotIn("Vuole esempi sui partitori", second.calls[2][1].content)

    def test_summary_is_checkpointed_and_saved_in_long_term_store(self):
        user = "summary-" + uuid4().hex
        settings = replace(Settings(), database_url=os.environ["AI_TEST_DATABASE_URL"], summary_threshold_tokens=200, keep_recent_turns=1)
        first = FakeModel([answer("Spiegazione " + "R" * 700)])
        with TestClient(create_app(settings, lambda s: create_graph(s, model=first))) as client:
            self.assertEqual(client.post("/query", json={"query": "Partitore", "thread_id": "a", "user_id": user}).status_code, 200)
        second = FakeModel([AIMessage(content="", tool_calls=[{"name": "ConversationSummary", "id": "s", "args": {
            "summary": "Ha studiato i partitori", "learning_notes": ["Preferisce formule"]}}]),
            answer("Riprendiamo"), answer("Nuovo thread")])
        with TestClient(create_app(settings, lambda s: create_graph(s, model=second))) as client:
            res = client.post("/query", json={"query": "Ancora", "thread_id": "a", "user_id": user})
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual(res.json()["metrics"]["summaries"], 1)
            res = client.post("/query", json={"query": "Ricordi?", "thread_id": "b", "user_id": user})
            self.assertEqual(res.status_code, 200, res.text)
        self.assertIn("Ha studiato i partitori", second.calls[-1][1].content)
        self.assertIn("Preferisce formule", second.calls[-1][1].content)


if __name__ == "__main__": unittest.main()
