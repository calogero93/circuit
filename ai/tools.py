"""Catalogo tool: schemi Pydantic indipendenti dal grafo e validazione del browser."""
import asyncio
import threading

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import StructuredTool

from config import Settings
from calculation_tools import calculation_tools, TOOLS
from calculation_schemas import ArithmeticInput, CalculationOutput
from modules.circuit_topology import describe_topology
from modules.tool_bridge import ToolBridge
from schemas import (NoInput, ComponentInput, NodeInput, TransientInput, SearchInput,
                     SnapshotOutput, NetlistOutput, DCOutput, TransientOutput,
                     ComponentOutput, NodeOutput, LibraryOutput, LessonOutput,
                     SearchOutput, SearchHit)

BROWSER_TOOLS = [
    ("getCircuitSnapshot", "Legge netlist, ambiente, misure LIVE, versione, tempo e diagnostica insieme. Prima scelta per domande sul circuito aperto.", NoInput, SnapshotOutput),
    ("getNetlist", "Legge solo componenti, parametri e collegamenti; non fornisce misure.", NoInput, NetlistOutput),
    ("runDC", "Calcola il punto di lavoro DC. Per segnali AC non sostituisce una transitoria; la temperatura è una previsione a regime.", NoInput, DCOutput),
    ("runTransient", "Calcola una transitoria dedicata; non altera la sessione live. Controllare converged, truncated e actualDuration_s.", TransientInput, TransientOutput),
    ("measureComponent", "Legge parametri e misure LIVE di un ID ottenuto dalla netlist, anche potenza e dati termici delle resistenze.", ComponentInput, ComponentOutput),
    ("measureNode", "Legge tensioni LIVE e DC di una net ottenuta dallo snapshot; controllare separatamente converged e dcConverged.", NodeInput, NodeOutput),
    ("listComponents", "Elenca tipologie, parametri e unità della libreria, non i componenti del circuito corrente.", NoInput, LibraryOutput),
    ("getLessonState", "Legge lezione, passo, confronto A/B e sonde; non misura tensioni o correnti.", NoInput, LessonOutput),
]


def output_description(schema):
    return " Output: " + "; ".join(f"{name}: {field.description}" for name, field in schema.model_fields.items())


def tool_schemas():
    catalog = {name: {"input": args.model_json_schema(), "output": output.model_json_schema()}
            for name, _, args, output in BROWSER_TOOLS}
    catalog.update({name: {"input": schema.model_json_schema(), "output": CalculationOutput.model_json_schema()}
                    for name, schema in {**TOOLS, "calculate": ArithmeticInput}.items()})
    return catalog


def make_tools(settings: Settings, bridge_factory=ToolBridge, *, search_provider=None):
    def browser_tool(name, description, schema, output):
        async def call(config: RunnableConfig, **kwargs):
            session_id = config.get("configurable", {}).get("session_id")
            async with bridge_factory(settings.bridge_url) as bridge:
                result = await bridge.call(name, session_id=session_id, **kwargs)
            if not isinstance(result, dict):
                raise ValueError("Il browser ha restituito un risultato non oggetto")
            if result.get("error"):
                raise ValueError(str(result))
            if name == "getCircuitSnapshot" and "netlist" in result:
                result = {**result, "topology": describe_topology(result["netlist"])}
            return output.model_validate(result).model_dump(mode="json", exclude_unset=True)
        return StructuredTool.from_function(coroutine=call, name=name,
                    description=description + output_description(output), args_schema=schema)

    tools = [browser_tool(*definition) for definition in BROWSER_TOOLS] + calculation_tools()
    if settings.rag_enabled:
        store = None
        search_lock = threading.Lock()

        def search_sync(query):
            nonlocal store
            from modules.vectorstore import VectorStore
            if store is None:
                path = settings.data_dir / "qdrant"
                path.mkdir(parents=True, exist_ok=True)
                store = VectorStore(dataset_path=str(path))
            points = store.search_chunks(query=query, collection_name="electronics")
            hits = []
            for point in points.points:
                payload = point.payload or {}
                hits.append(SearchHit(text=str(payload.get("text", payload.get("payload", payload.get("content", "")))),
                                      source=str(payload.get("source", payload.get("file_name", payload.get("url", ""))))))
            return SearchOutput(hits=hits).model_dump(mode="json")

        async def search_info(query: str):
            if search_provider is not None:
                return SearchOutput.model_validate(await search_provider(query)).model_dump(mode="json")
            def serialized_search():
                with search_lock:
                    return search_sync(query)
            return await asyncio.to_thread(serialized_search)

        tools.append(StructuredTool.from_function(coroutine=search_info, name="search_info",
                     description="Cerca teoria con fonti nella collezione electronics già indicizzata. Non misura il circuito.", args_schema=SearchInput))
    return tools
