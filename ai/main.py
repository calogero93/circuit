from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel
import uvicorn
from contextlib import asynccontextmanager

from langgraph.store.sqlite.aio import AsyncSqliteStore
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver 
import aiosqlite
import graph as graph_module


@asynccontextmanager
async def lifespan(app: FastAPI):
    checkpoint_conn = await aiosqlite.connect("checkpoints.db")
    store_conn = await aiosqlite.connect("long_term_memory.db")
 
    checkpointer = AsyncSqliteSaver(checkpoint_conn)
    store = AsyncSqliteStore(store_conn)
 
    app.state.graph = graph_module.graph.compile(checkpointer=checkpointer, store=store)
 
    yield 
 
    await checkpoint_conn.close()
    await store_conn.close()

app = FastAPI(lifespan=lifespan)

class Query(BaseModel):
    query: str
    thread_id: str


@app.post("/query")
async def post_query(query: Query):
    config = {"configurable": {"thread_id": query.thread_id}}
    try:
        result = await app.state.graph.ainvoke({"query": query.query}, config=config)
        return result
    except Exception as e:
        print(e)
        raise HTTPException(status_code=500, detail="Internal Server Error")



if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8080, reload=False)






        


