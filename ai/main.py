"""HTTP condiviso dal tutor e dai client esterni. Stato conversazioni su SQLite."""
import asyncio
from contextlib import asynccontextmanager
import logging
from weakref import WeakValueDictionary

import aiosqlite
from fastapi import FastAPI, HTTPException
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from pydantic import BaseModel, Field
import uvicorn

from config import Settings
from graph import create_graph, response_text

logger = logging.getLogger(__name__)


def create_app(settings=None, graph_factory=create_graph):
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(settings.data_dir / "checkpoints.db") as connection:
            checkpointer = AsyncSqliteSaver(connection)
            await checkpointer.setup()
            app.state.graph = graph_factory(settings).compile(checkpointer=checkpointer)
            app.state.thread_locks = WeakValueDictionary()
            yield

    app = FastAPI(lifespan=lifespan)

    @app.get("/healthz")
    async def health():
        return {"status": "ok", "provider": settings.provider, "model": settings.model}

    @app.post("/api/chat")
    @app.post("/query")
    async def query(body: Query):
        locks = app.state.thread_locks
        lock = locks.get(body.thread_id)
        if lock is None:
            lock = asyncio.Lock()
            locks[body.thread_id] = lock
        async with lock:
            try:
                async with asyncio.timeout(settings.request_timeout):
                    config = {"configurable": {"thread_id": body.thread_id}, "recursion_limit": 24}
                    saved = await app.state.graph.aget_state(config)
                    history = saved.values.get("messages", [])
                    # Un timeout può aver lasciato chiamate tool senza risposta nel checkpoint.
                    recovery = []
                    if history and isinstance(history[-1], AIMessage):
                        recovery = [ToolMessage(content='{"error": "Turno precedente interrotto"}',
                                                tool_call_id=call["id"], status="error")
                                    for call in history[-1].tool_calls]
                    result = await app.state.graph.ainvoke(
                        {"messages": [*recovery, HumanMessage(content=body.query)], "tool_rounds": 0,
                         "trace": [], "snapshot_revision": None},
                        config=config)
                return {"response": response_text(result["messages"][-1]),
                        "thread_id": body.thread_id, "tools": result.get("trace", []),
                        "snapshot_revision": result.get("snapshot_revision")}
            except TimeoutError as exc:
                raise HTTPException(status_code=504, detail="Il tutor ha superato il tempo di risposta") from exc
            except Exception as exc:
                logger.exception("Errore tutor")
                raise HTTPException(status_code=502, detail="LLM non raggiungibile o risposta non valida. Verifica modello, endpoint e supporto tool calling.") from exc

    return app


class Query(BaseModel):
    query: str = Field(min_length=1, max_length=20000)
    thread_id: str = Field(min_length=1, max_length=200)


app = create_app()

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8080, reload=False)
