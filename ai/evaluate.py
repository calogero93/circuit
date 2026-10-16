"""Valuta il modello locale reale su tool deterministici, senza richiedere un browser."""
import argparse
import asyncio
import json
from pathlib import Path

import httpx
from langchain_core.messages import HumanMessage

from config import Settings
from graph import create_graph
from schemas import EvaluationCase, EvaluationResult, ModelQuestion
from tools import make_tools

CASES = [
    EvaluationCase(name="theory", question="Cos'è una resistenza?", mode="theory", expected_kind="theory", expected_terms=["corrente", "ohm"]),
    EvaluationCase(name="power", question="Quanto dissipa R1 e la taglia scelta è sufficiente?", mode="power", expected_kind="circuit", expected_terms=["1 W", "0.25 W", "sovraccarico"]),
    EvaluationCase(name="rated-2w", question="Ho aumentato la potenza nominale di R1 a 2 W: cambia la corrente e quanto margine ho?", mode="rated-2w", expected_kind="circuit", expected_terms=["0.1 A", "50%", "corrente invariata"]),
    EvaluationCase(name="hot", question="Fa caldo: posso ancora dissipare 1 W su R1?", mode="hot", expected_kind="circuit", expected_terms=["112.5", "0.125 W", "derating"]),
    EvaluationCase(name="dc-temperature", question="La temperatura restituita da runDC è quella fisica di R1 in questo momento?", mode="power", expected_kind="circuit", expected_terms=["stima", "regime"]),
    EvaluationCase(name="offline", question="Misura la potenza di R1 nel circuito aperto.", mode="offline", expected_kind="limitation", expected_terms=["browser", "collegato"]),
    EvaluationCase(name="nonconvergent", question="Che tensione misuri su R1?", mode="nonconvergent", expected_kind="limitation", expected_terms=["convergenza", "non attendibile"]),
    EvaluationCase(name="transient", question="Simula per 100 ms e dimmi se hai raggiunto il regime e se R1 regge i picchi.", mode="transient", expected_kind="circuit", expected_terms=["troncata", "10 ms", "limiti impulsivi"]),
]


def fixture(case):
    rated = 2 if case.mode == "rated-2w" else .25
    hot = case.mode == "hot"
    converged = case.mode != "nonconvergent"
    params = {"R": 100, "ratedPower": rated}
    values = {"data": {"v": 10, "i": .1, "p": 1, "meanPower": 1, "ratedPower": rated,
        "allowedPower": .125 if hot else rated, "powerLoadPercent": 800 if hot else 100 / rated,
        "ambientTemperature": 112.5 if hot else 25, "temperature": 25 + 85 / rated,
        "temperatureMode": "steady-state", "powerStatus": "overload" if rated < 1 else "ok"},
        "pinCurrents": [.1, -.1]}
    diagnostics = {"iterations": 1, "residual": 0 if converged else None, "floatingNets": [], "warnings": []}
    netlist = {"revision": 1, "components": [{"id": "R1", "type": "resistor", "name": "Resistenza", "params": params,
        "pins": [{"name": "a", "net": "n1"}, {"name": "b", "net": "gnd"}]}], "wires": 2, "nets": ["n1", "gnd"], "hasGround": True}
    dc = {"revision": 1, "converged": converged, "diagnostics": diagnostics, "nodeVoltages": {"n1": 10, "gnd": 0}, "components": {"R1": values}}
    return dc, netlist, values


async def evaluate(case, settings):
    dc, netlist, values = fixture(case)
    class Bridge:
        def __init__(self, url): pass
        async def __aenter__(self):
            if case.mode == "offline": raise ConnectionError("Browser non collegato")
            return self
        async def __aexit__(self, *_): pass
        async def call(self, name, **args):
            if name == "getCircuitSnapshot": return {**dc, "netlist": netlist, "environment": {
                "temperature": 112.5 if case.mode == "hot" else 25, "light": 50, "pressure": 101, "magneticField": 0, "humidity": 50},
                "time_s": .1, "measurementsAvailable": True}
            if name == "getNetlist": return netlist
            if name == "runDC": return dc
            if name == "measureComponent":
                if args.get("componentId") != "R1": return {"error": "ID sconosciuto; disponibile R1"}
                return {"id": "R1", "type": "resistor", "params": netlist["components"][0]["params"],
                        "revision": 1, "time_s": .1, "converged": dc["converged"], "live": values}
            if name == "measureNode": return {"nodeId": args["nodeId"], "liveVoltage": 10, "liveTime": .1, "dcVoltage": 10,
                    "converged": dc["converged"], "dcConverged": dc["converged"], "revision": 1, "diagnostics": dc["diagnostics"]}
            if name == "runTransient": return {"revision": 1, "converged": True, "diagnostics": dc["diagnostics"], "components": dc["components"],
                "dt_us": args.get("dt_us", 100), "actualDuration_s": .01, "truncated": True, "time_s": [0, .01], "nodeVoltages": {"n1": [0, 10]}}
            if name == "listComponents": return {"library": []}
            return {"lessonId": None, "title": None, "objective": None, "step": None, "ab": None, "probes": [], "presentazione": False}
    try:
        graph = create_graph(settings, tools=make_tools(settings, Bridge)).compile()
        async with asyncio.timeout(settings.request_timeout):
            state = await graph.ainvoke({"messages": [HumanMessage(content=ModelQuestion(question=case.question).model_dump_json())],
                "trace": [], "evidence": [], "tool_rounds": 0, "snapshot_revision": None,
                "revision_consistent": True, "answer": None, "metrics": {}}, config={"recursion_limit": settings.max_tool_rounds * 3 + 20})
        ok = state["answer"]["kind"] == case.expected_kind
        if case.expected_kind == "theory": ok = ok and not state.get("trace")
        return EvaluationResult(name=case.name, ok=ok, answer=state["answer"], metrics=state["metrics"], tools=state.get("trace", []))
    except Exception as exc:
        return EvaluationResult(name=case.name, ok=False, error=str(exc) or type(exc).__name__)


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=[c.name for c in CASES])
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / ".local-notes/ai-evaluation.json")
    args = parser.parse_args()
    settings = Settings.from_env()
    if settings.provider != "local": raise SystemExit("Questa valutazione richiede LLM_PROVIDER=local")
    async with httpx.AsyncClient(timeout=5) as client:
        try:
            response = await client.get(settings.base_url.rstrip("/") + "/models")
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise SystemExit(f"Endpoint locale non disponibile ({type(exc).__name__}). Avvia il modello configurato in LLM_BASE_URL.") from exc
    results = []
    for case in CASES:
        if args.case and case.name != args.case: continue
        result = await evaluate(case, settings)
        results.append({"case": case.model_dump(mode="json"), "result": result.model_dump(mode="json")})
        print(f"{case.name}: {'OK' if result.ok else 'DA RIVEDERE'}", flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"model": settings.model, "results": results}, ensure_ascii=False, indent=2) + "\n")
    print(f"Risultati: {args.output}")
    if not all(item["result"]["ok"] for item in results): raise SystemExit(1)


if __name__ == "__main__": asyncio.run(main())
