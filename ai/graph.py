from modules.chunking import prepare_docs, chunk_data
from modules.vectorstore import VectorStore
from langchain_core.tools import tool
from langgraph.graph import START, END, StateGraph, add_messages
from langgraph.types import RetryPolicy
import asyncio
from typing import TypedDict, Annotated, Any
from modules.tool_bridge import ToolBridge
from modules.circuit_topology import describe_topology
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import ToolMessage, HumanMessage, SystemMessage
import time


list_files = prepare_docs("/home/calogero/circuit/ai/dataset")
chunks = chunk_data(list_files=list_files)

vs = VectorStore(dataset_path="./")

class CircuitState(TypedDict):
    query: str
    messages: Annotated[list, add_messages]
    topology: dict
    measure_components: list
    response: str
    error: str

model = ChatOpenAI(
    base_url="http://192.168.1.9:1234/v1",
    model="google/gemma-4-e4b",
    api_key="lm-studio"
)

def generate_prompt_for_circuit_with_data(topology: dict, measure_components: list, query: str):
    return f"""
        <topology>{topology}</topology>

        <measure_components>{measure_components}</measure_components>

        QUERY: {query}
    """

@tool
def search_info(query:str):
    """
    Function used to search the vector db for information useful to answer
    the user's questions

    Args:
        query: the user's question, used as input to retrieve the list of
        chunks to use for answering the question

    Output:
        chunks: list of chunks to insert into the LLM as additional context
    """
    for retry in range(3):
        try:
            points = vs.search_chunks(query=query, collection_name="electronics")
            chunks = [chunk.payload for chunk in points.points]
            return chunks
        except Exception as e:
            if retry == 2:
                return f"Was not possible reach the vector db neither after 3 retries"
            time.sleep(0.5 * (2 ** retry))

tools = [search_info]

model_with_tools = model.bind_tools(tools)

def translate_query(state: CircuitState):
    query = state["query"]
    prompt = ChatPromptTemplate.from_messages([
        ("system", "Analyze the query provided by the user verify the language and if it is not equal to english, translate it in english and reply only with the translation"),
        ("human", "{query}")
    ]
    )
    chain = prompt | model
    for retry in range(3):
        try:
            response = chain.invoke({"query": query})
            return {"query": response.content}
        except Exception as e:
            if retry == 2:
                return {"query": query}
            time.sleep(0.5 * (2 ** retry))


async def get_circuit_topology(state: CircuitState):
    try: 
        bridge = ToolBridge()
        await bridge.connect()
        measure_components = []
   
        net_list = await bridge.call("getNetlist")
        net_list = dict(net_list)
        components = [c["id"] for c in net_list["components"]]

        for component in components:
            result = await asyncio.wait_for(bridge.call("measureComponent", componentId=component), timeout=5.0)
            measure_components.append(result)

        topology = describe_topology(net_list)

        await bridge.close()

        return {"topology": topology, "measure_components": measure_components}
    except Exception as e:
        await bridge.close()
        return {"topology": {}, "measure_components": [], "error": str(e)}

def analyze_circuit(state: CircuitState):
    try:
        topology = state["topology"]
        measure_components = state["measure_components"]
        query = state["query"]

        system_prompt = """
            You have analyze the topology of the circuit and the values of the components
            and use them to reply at the questions of the user, suggesting alternative, if
            there are errors suggest how to correct them, if requirede guide user or list 
            possible use case of that circuit or project, or in most of the case explain components
            how it works in 3 level of deep, from high level to very low level where explain the physics behind

            IMPORTANT! If you need more info you can use tools available for you
        """

        query_txt = generate_prompt_for_circuit_with_data(topology, measure_components, query)

        messages = [
            SystemMessage(content=system_prompt),
            *state.get("messages", []),
            HumanMessage(content=query_txt),
        ]

        response = model_with_tools.invoke(messages)

        return {"messages": [response]}
    except Exception as e:
        return {"error": str(e)}

def route(state: CircuitState):
    last_msg = state["messages"][-1]

    if last_msg.tool_calls:
        return "tool"
    return END

def tool(state: CircuitState):
    
        last_msg = state["messages"][-1]
        tool_messages = []

        for tool_call in last_msg.tool_calls:
            try:
                tool = next(t for t in tools if tool_call["name"] == t.name)
                result = tool.invoke(tool_call["args"])
            except Exception as e:
                result = str(e)
        
            tool_messages.append(
                ToolMessage(content=str(result), tool_call_id=tool_call["id"])
            )
        return {"messages": tool_messages}
    


builder = StateGraph(CircuitState)

builder.add_node("translate", translate_query)
builder.add_node(
    "get_circuit_topology", 
    get_circuit_topology, 
    retry=RetryPolicy(max_attempts=3, initial_interval=0.5, backoff_factor=2.0, jitter=True)
)
builder.add_node(
    "analyze_circuit",
    analyze_circuit,
    retry=RetryPolicy(max_attempts=3, initial_interval=0.5, backoff_factor=2.0, jitter=True)
)
builder.add_node(
    "tool", 
    tool,
    retry=RetryPolicy(max_attempts=3, initial_interval=0.5, backoff_factor=2.0, jitter=True)
)


builder.add_edge(START, "translate")
builder.add_edge("translate", "get_circuit_topology")
builder.add_edge("get_circuit_topology", "analyze_circuit")
builder.add_conditional_edges("analyze_circuit", route)
builder.add_edge("tool", "analyze_circuit")


graph = builder