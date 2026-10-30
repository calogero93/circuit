"""Memoria PostgreSQL: checkpoint dei thread e sintesi didattiche fra conversazioni."""
import hashlib
from contextlib import asynccontextmanager

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.store.postgres import AsyncPostgresStore
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from circuit_ai.contracts.shared import ConversationSummary


class PostgresMemory:
    def __init__(self, settings):
        self.settings = settings

    async def __aenter__(self):
        self.pool = AsyncConnectionPool(self.settings.database_url, min_size=1, max_size=10,
            open=False, kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row})
        await self.pool.open(wait=True)
        try:
            self.checkpointer = AsyncPostgresSaver(self.pool)
            self.store = AsyncPostgresStore(self.pool)
            async with self.lock("circuit:memory:schema-setup"):
                await self.checkpointer.setup()
                await self.store.setup()
        except BaseException:
            await self.pool.close()
            raise
        return self

    async def __aexit__(self, *_):
        await self.pool.close()

    @asynccontextmanager
    async def lock(self, thread_key):
        # Connessione separata: attese dei lock non esauriscono il pool del grafo.
        key = int.from_bytes(hashlib.sha256(thread_key.encode()).digest()[:8], "big", signed=True)
        async with await AsyncConnection.connect(self.settings.database_url, connect_timeout=10) as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(%s)", (key,))
            yield


async def recall(store, user_id, thread_id, max_chars=6000):
    # L'ordine di asearch non è garantito: non confondere i primi cento
    # risultati con i più recenti quando le conversazioni aumentano.
    items, offset = [], 0
    while True:
        page = await store.asearch(("tutor", user_id), limit=100, offset=offset)
        items = sorted([*items, *(i for i in page if i.key != thread_id)],
                       key=lambda i: i.updated_at, reverse=True)[:3]
        if len(page) < 100:
            break
        offset += len(page)
    selected = []
    for item in items:
        value = ConversationSummary.model_validate(item.value)
        if len(value.model_dump_json()) > max_chars:
            # Le preferenze didattiche hanno priorità sulle lunghe sintesi di
            # altre conversazioni. Non troncare una frase a metà.
            value = ConversationSummary(summary="", learning_notes=value.learning_notes)
        size = len(value.model_dump_json())
        if size > max_chars or not (value.summary or value.learning_notes):
            continue
        selected.append(value.model_dump(mode="json"))
        max_chars -= size
        if len(selected) == 3:
            break
    return selected


async def remember(store, user_id, thread_id, summary):
    value = ConversationSummary.model_validate(summary)
    await store.aput(("tutor", user_id), thread_id, value.model_dump(mode="json"))
