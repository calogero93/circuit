"""Valuta il modello locale reale su tool deterministici, senza richiedere un browser."""
import argparse
import asyncio
import json
import os
from pathlib import Path
from dataclasses import replace

import httpx
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver

from circuit_ai.core.config import Settings
from circuit_ai.agent.graph import create_graph
from circuit_ai.contracts.shared import DatasetTurnResult, EvaluationResult, EvaluationTrial, JudgeEvaluation, ModelQuestion, TurnMetrics
from circuit_ai.evaluation.experiments import ROOT, create_manifest, new_report, save_report, summarize, utc_now, validate_run_identity
from circuit_ai.tools.catalog import make_tools
from circuit_ai.evaluation.dataset import DATA_DIR, load_dataset, select_cases
from circuit_ai.evaluation.fixtures import FixtureRuntime
from circuit_ai.evaluation.checks import deterministic_checks, deterministic_passed, semantic_passed
from circuit_ai.evaluation.judge import evaluation_protocol, judge_answer, judge_input, local_judge_settings

DEFAULT_DATASET = load_dataset()
CASES = DEFAULT_DATASET.dataset.cases


async def evaluate(case, settings, *, bundle=DEFAULT_DATASET, model=None, judge_settings=None, judge_model=None,
                   judge_policy="advisory"):
    if judge_policy not in {"advisory", "blocking"}:
        raise ValueError("judge_policy deve essere advisory o blocking")
    if judge_policy == "blocking" and judge_settings is None:
        raise ValueError("La policy blocking richiede un judge configurato")
    runtime = FixtureRuntime(bundle.fixtures)
    results, trace, history = [], [], []
    if case.summary_threshold_tokens:
        settings = replace(settings, summary_threshold_tokens=case.summary_threshold_tokens, keep_recent_turns=1)
    async def search(query):
        hits = [{"text": bundle.corpus[id].excerpt, "source": bundle.corpus[id].path} for id in case.retrieved_source_ids]
        if case.adversarial_document:
            hits.append({"text": case.adversarial_document, "source": "synthetic-adversarial-document"})
        return {"hits": hits}
    try:
        if case.retrieved_source_ids and not settings.rag_enabled:
            raise ValueError("Il caso documentale richiede --include-rag")
        tools = make_tools(settings, runtime.bridge_factory, search_provider=search)
        graph = create_graph(settings, model=model, tools=tools).compile(checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": case.name}, "recursion_limit": settings.max_tool_rounds * 3 + 20}
        for index, turn in enumerate([case, *case.followups], 1):
            runtime.activate(turn.fixture_id)
            async with asyncio.timeout(settings.request_timeout):
                state = await graph.ainvoke({"messages": [HumanMessage(content=ModelQuestion(question=turn.question).model_dump_json())],
                "trace": [], "evidence": [], "tool_rounds": 0, "schema_errors": 0, "snapshot_revision": None,
                "revision_consistent": True, "answer": None, "metrics": {}, "memories": []}, config=config)
            start = max(i for i, message in enumerate(state["messages"]) if isinstance(message, HumanMessage))
            call_ids = {t["call_id"] for t in state.get("trace", [])}
            outputs = [{"call_id": m.tool_call_id, "tool": m.name, "result": json.loads(m.content)}
                for m in state["messages"][start:] if isinstance(m, ToolMessage) and m.tool_call_id in call_ids]
            result = DatasetTurnResult(turn=index, ok=False, answer=state["answer"],
                metrics=state["metrics"], tools=state.get("trace", []), tool_outputs=outputs,
                evidence=state.get("evidence", []), revision_consistent=state.get("revision_consistent", True), context_summary=state.get("summary"))
            result.checks = deterministic_checks(turn.reference, result, bundle.corpus)
            result.evaluation_input = judge_input(turn, result, history,
                reference_sources=[bundle.corpus[id] for id in case.provenance.source_ids if bundle.corpus[id].publication])
            failed = any(check.status == "fail" for check in result.checks)
            if judge_settings:
                result.judge_policy = judge_policy
                result.judge = JudgeEvaluation(status="skipped", error="Controlli deterministici falliti; judge non chiamato.") if failed else await judge_answer(
                    result.evaluation_input, judge_settings, model=judge_model)
                result.ok = (not failed and semantic_passed(result.judge)) if judge_policy == "blocking" else deterministic_passed(result.checks)
            else:
                result.ok = deterministic_passed(result.checks)
            history.append({"question": turn.question, "answer": result.answer.model_dump(mode="json"),
                "tool_outputs": [o.model_dump(mode="json") for o in result.tool_outputs]})
            results.append(result)
            trace.extend(state.get("trace", []))
        metrics = combined_metrics(results)
        return EvaluationResult(name=case.name, ok=all(turn.ok for turn in results),
            answer=results[-1].answer, metrics=metrics, tools=trace, turns=results)
    except Exception as exc:
        return EvaluationResult(name=case.name, ok=False, error=str(exc) or type(exc).__name__,
            metrics=combined_metrics(results), tools=trace, turns=results)


def combined_metrics(turns):
    metrics = TurnMetrics()
    for turn in turns:
        for field in ("model_calls", "input_tokens", "output_tokens", "model_duration_ms", "summaries"):
            setattr(metrics, field, getattr(metrics, field) + getattr(turn.metrics, field))
        metrics.prompt_tokens_estimate = max(metrics.prompt_tokens_estimate, turn.metrics.prompt_tokens_estimate)
        for observation in turn.metrics.model_observations:
            if observation not in metrics.model_observations:
                metrics.model_observations.append(observation)
    return metrics


async def check_endpoint(settings):
    async with httpx.AsyncClient(timeout=5, headers={"Authorization": f"Bearer {settings.api_key}"}) as client:
        response = await client.get(settings.base_url.rstrip("/") + "/models")
        response.raise_for_status()


async def run_experiment(settings, cases, *, repetitions=1, output=None, manifest_only=False,
                         model_file=None, evaluator=None, preflight=check_endpoint, root=ROOT, bundle=DEFAULT_DATASET,
                         judge_settings=None, judge_policy="advisory"):
    if settings.provider != "local":
        raise ValueError("Questa valutazione richiede LLM_PROVIDER=local")
    if judge_policy not in {"advisory", "blocking"}:
        raise ValueError("judge_policy deve essere advisory o blocking")
    if judge_policy == "blocking" and judge_settings is None:
        raise ValueError("La policy blocking richiede --judge-model")
    manifest = create_manifest(settings, cases, repetitions, root=root, model_file=model_file,
                               dataset_identity=bundle.identity() if bundle else None)
    manifest.evaluation_protocol = evaluation_protocol(judge_settings, candidate=settings, judge_policy=judge_policy)
    manifest.limitations = [text for text in manifest.limitations if "controlli attuali" not in text]
    manifest.limitations.extend(manifest.evaluation_protocol["limitations"])
    output = Path(output) if output else root / ".local-notes/llmops" / manifest.experiment_id / "report.json"
    if output.exists():
        raise ValueError("Il report esiste già: scegliere un nuovo percorso per non perdere l'esperimento precedente")
    report = new_report(manifest)
    save_report(report, output)
    if manifest_only:
        return report, output
    try:
        try:
            await preflight(settings)
        except (httpx.HTTPError, OSError) as exc:
            report.status = "unavailable"
            report.error = f"Endpoint locale non disponibile ({type(exc).__name__}). Avvia il modello configurato in LLM_BASE_URL."
            return report, output
        report.status = "running"
        save_report(report, output)
        for repetition in range(1, repetitions + 1):
            for case in cases:
                result = await evaluate(case, settings, bundle=bundle, judge_settings=judge_settings, judge_policy=judge_policy) if evaluator is None else await evaluator(case, settings)
                report.results.append(EvaluationTrial(repetition=repetition, case=case, result=result))
                report.summary = summarize(report.results)
                save_report(report, output)
                print(f"{case.name} [{repetition}/{repetitions}]: {'OK' if result.ok else 'DA RIVEDERE'}", flush=True)
        error = validate_run_identity(report, root)
        report.status = "invalidated" if error else "completed"
        report.error = error
    except asyncio.CancelledError:
        report.status = "interrupted"
        report.error = "Valutazione interrotta; i risultati già ottenuti sono stati conservati."
        raise
    except Exception:
        report.status = "interrupted"
        report.error = "Valutazione interrotta da un errore operativo; il report parziale è conservato."
        raise
    finally:
        report.completed_at = utc_now()
        save_report(report, output)
    return report, output


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", help="ID del caso; se specificato cerca in entrambi gli split")
    parser.add_argument("--dataset-directory", type=Path, default=DATA_DIR)
    parser.add_argument("--split", choices=["development", "validation", "all"], default=None)
    parser.add_argument("--category", help="Famiglia da eseguire, per esempio power, memory o adversarial")
    parser.add_argument("--mode", choices=["closed_book", "live_tools"], help="Seleziona i casi dei libri senza tool oppure quelli con misure live su fixture")
    parser.add_argument("--include-rag", action="store_true", help="Abilita i casi RAG con estratti controllati, senza aprire Qdrant")
    parser.add_argument("--output", type=Path, help="Nuovo file report; per default ogni esperimento ha una propria directory locale ignorata da Git")
    parser.add_argument("--repetitions", type=int, default=1, help="Ripetizioni per caso, da 1 a 100")
    parser.add_argument("--manifest-only", action="store_true", help="Prepara identità e configurazione senza contattare il modello o il database")
    parser.add_argument("--model-file", type=Path, help="File locale dei pesi di cui verificare SHA-256; non carica né scarica il modello")
    parser.add_argument("--judge-model", help="Abilita il judge locale con questo modello; per default nessun voto semantico")
    parser.add_argument("--judge-policy", choices=["advisory", "blocking"], default="advisory",
                        help="Advisory: i voti del judge sono informativi. Blocking: incidono sull'esito; scelta esplicita che non certifica la calibrazione")
    parser.add_argument("--judge-base-url", default="http://127.0.0.1:1234/v1", help="Endpoint loopback locale del judge, anche distinto da quello del tutor")
    parser.add_argument("--judge-context-tokens", type=int, default=24000, help="Budget totale stimato del judge, output incluso; non tronca le evidenze")
    args = parser.parse_args()
    if not 1 <= args.repetitions <= 100:
        parser.error("--repetitions deve essere fra 1 e 100")
    try:
        bundle = load_dataset(args.dataset_directory)
        cases = select_cases(bundle, split=args.split or ("all" if args.case else "development"),
            category=args.category, case_name=args.case, include_rag=args.include_rag, mode=args.mode)
        settings = Settings.from_env()
        if args.include_rag:
            settings = replace(settings, rag_enabled=True, rag_corpus_revision="evaluation-corpus:" + bundle.identity()["bundle_sha256"])
        judge_config = local_judge_settings(settings, model=args.judge_model, base_url=args.judge_base_url,
            api_key=os.getenv("JUDGE_LLM_API_KEY", "local"), context_tokens=args.judge_context_tokens) if args.judge_model else None
        report, output = await run_experiment(settings, cases,
            repetitions=args.repetitions, output=args.output,
            manifest_only=args.manifest_only, model_file=args.model_file, bundle=bundle, judge_settings=judge_config,
            judge_policy=args.judge_policy)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    print(f"Esperimento: {report.manifest.experiment_id}")
    print(f"Configurazione: {report.manifest.configuration_id}")
    print(f"Report: {output}")
    print(f"Stato: {report.status}")
    if report.error:
        print(report.error)
    if report.status == "completed":
        print(f"Esiti della policy ({report.summary.criterion}): {report.summary.passed}/{report.summary.attempted}.")
        if report.summary.judge_policy:
            print(f"Policy judge: {report.summary.judge_policy}; advisory lascia l'esito ai controlli deterministici.")
        print(f"Judge completato: {report.summary.semantic_evaluated_turns}/{report.summary.evaluated_turns} turni; calibrazione umana separata, non ancora attestata.")
        print(f"Tutti i criteri semantici soddisfatti: {report.summary.semantic_passed_turns}/{report.summary.semantic_evaluated_turns} turni valutati dal judge.")
    if report.status not in {"prepared", "completed"} or (report.summary.attempted and report.summary.passed != report.summary.attempted):
        raise SystemExit(1)


if __name__ == "__main__": asyncio.run(main())
