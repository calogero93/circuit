"""HTTP e stream condividono lo stesso turno LangGraph e la memoria PostgreSQL."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import logging

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
import uvicorn

from circuit_ai.core.config import Settings
from circuit_ai.agent.graph import create_graph
from circuit_ai.memory.postgres import PostgresMemory, recall, remember
from circuit_ai.contracts.shared import (ChatResponse, ConversationSummary, ModelQuestion, Query,
                     StreamEvent, ToolResult, TurnMetrics)
from circuit_ai.tools.catalog import tool_schemas
from circuit_ai.contracts.answer import AnswerDraft
from circuit_ai.api.errors import tutor_error

logger = logging.getLogger(__name__)


def thread_key(body):
    return hashlib.sha256(json.dumps([body.user_id, body.thread_id]).encode()).hexdigest()


def repair_tools(history):
    completed = {m.tool_call_id for m in history if isinstance(m, ToolMessage)}
    return [ToolMessage(content=ToolResult[dict](ok=False, error="Turno precedente interrotto").model_dump_json(),
                        tool_call_id=call["id"], name=call["name"], status="error")
            for m in history if isinstance(m, AIMessage) for call in m.tool_calls if call["id"] not in completed]


def create_app(settings=None, graph_factory=create_graph, memory_factory=PostgresMemory):
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        async with memory_factory(settings) as memory:
            app.state.memory = memory
            app.state.graph = graph_factory(settings).compile(checkpointer=memory.checkpointer, store=memory.store)
            yield

    app = FastAPI(lifespan=lifespan)

    @app.get("/healthz")
    async def health():
        return {"status": "ok", "provider": settings.provider, "model": settings.model, "memory": "postgres"}

    @app.get("/api/schemas")
    async def schemas():
        return {"request": Query.model_json_schema(), "response": ChatResponse.model_json_schema(),
                "event": StreamEvent.model_json_schema(), "tools": tool_schemas(),
                "llm_answer_input": AnswerDraft.model_json_schema()}

    async def run_turn(body):
        async with asyncio.timeout(settings.request_timeout):
            memory = app.state.memory
            key = thread_key(body)
            async with memory.lock(key):
                config = {"configurable": {"thread_id": key, "user_id": body.user_id,
                          "session_id": body.session_id}, "recursion_limit": settings.max_tool_rounds * 3 + 20}
                saved = await app.state.graph.aget_state(config)
                history = saved.values.get("messages", [])
                state = {"messages": [*repair_tools(history), HumanMessage(content=ModelQuestion(question=body.query).model_dump_json())],
                         "tool_rounds": 0, "schema_errors": 0, "trace": [], "evidence": [],
                         "snapshot_revision": None, "revision_consistent": True, "answer": None,
                         "metrics": TurnMetrics().model_dump(),
                         "memories": await recall(memory.store, body.user_id, body.thread_id,
                                                  max_chars=settings.context_max_tokens // 2)}
                yield StreamEvent(event="status", data={"message": "Analisi della domanda"})
                final_state = None
                async for mode, event in app.state.graph.astream(state, config=config, stream_mode=["custom", "values"]):
                    if mode == "custom":
                        yield StreamEvent.model_validate(event)
                    else:
                        final_state = event
                if not final_state or not final_state.get("answer"):
                    raise ValueError("Il grafo non ha prodotto una risposta strutturata")
                result = ChatResponse(response=final_state["answer"]["response"], answer=final_state["answer"],
                    thread_id=body.thread_id, tools=final_state.get("trace", []),
                    snapshot_revision=final_state.get("snapshot_revision"),
                    revision_consistent=final_state.get("revision_consistent", True),
                    evidence=final_state.get("evidence", []), metrics=final_state.get("metrics", {}))
                prior = await memory.store.aget(("tutor", body.user_id), body.thread_id)
                previous = ConversationSummary.model_validate(prior.value) if prior else ConversationSummary(summary="", learning_notes=[])
                summary = ConversationSummary.model_validate(final_state.get("summary") or previous.model_dump())
                summary.learning_notes = list(dict.fromkeys([*summary.learning_notes, *previous.learning_notes,
                                                             *result.answer.learning_notes]))[-8:]
                if summary.summary or summary.learning_notes:
                    await remember(memory.store, body.user_id, body.thread_id, summary)
                yield StreamEvent(event="final", data=result.model_dump(mode="json"))

    @app.post("/api/chat", response_model=ChatResponse)
    @app.post("/query", response_model=ChatResponse)
    async def query(body: Query):
        try:
            async for event in run_turn(body):
                if event.event == "final":
                    return event.data
        except Exception as exc:
            logger.exception("Errore tutor")
            status, _, message = tutor_error(exc)
            raise HTTPException(status_code=status, detail=message) from exc

    @app.post("/api/chat/stream")
    async def stream(body: Query):
        async def events():
            try:
                async for event in run_turn(body):
                    yield event.model_dump_json() + "\n"
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("Errore stream tutor")
                _, code, message = tutor_error(exc)
                error = StreamEvent(event="error", data={"message": message, "code": code})
                yield error.model_dump_json() + "\n"
        return StreamingResponse(events(), media_type="application/x-ndjson",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                     "X-Tutor-Timeout-Ms": str(int(settings.request_timeout * 1000))})

    return app


app = create_app()

def main():
    logging.basicConfig(level=logging.WARNING)
    logging.getLogger("circuit_ai").setLevel(logging.INFO)
    uvicorn.run(app, host="127.0.0.1", port=8080, reload=False)


if __name__ == "__main__":
    main()
