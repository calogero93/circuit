"""Controlla il judge su risposte basate sui libri, senza tutor, RAG o voti umani."""
import argparse
import asyncio
from dataclasses import replace
import math
import os
from pathlib import Path
import random
import re

import httpx

from circuit_ai.core.config import Settings
from circuit_ai.evaluation.dataset import TEXTBOOK_DIR, load_dataset, select_cases
from circuit_ai.evaluation.fixtures import build_fixture
from circuit_ai.evaluation.checks import deterministic_checks, deterministic_passed, quantities, semantic_passed
from circuit_ai.evaluation.experiments import ROOT, create_manifest, digest, file_digest, save_report, source_snapshot, utc_now
from circuit_ai.evaluation.judge import CRITERIA, evaluation_protocol, judge_answer, judge_input, local_judge_settings
from circuit_ai.contracts.probes import (JudgeProbeReport, JudgeProbeSuite, JudgeProbeSummary,
    JudgeProbeTrial, ScheduledProbe, ScoreRange)
from circuit_ai.contracts.shared import DatasetTurnResult, JudgeEvaluation, SnapshotOutput, SubmitAnswer, TurnMetrics

VARIANTS = ("correct_concise", "correct_explained", "controlled_error")
LIMITATIONS = [
    "Le risposte e le aspettative sono proposte assistite costruite da fonti pubblicate, non etichette umane né una calibrazione umana.",
    "Numeri e mutazioni logiche hanno controlli indipendenti; ipotesi, completezza e alterazioni concettuali restano costruzioni da revisionare alla luce delle fonti.",
    "Varianti, ripetizioni ed esercizi della stessa famiglia sono correlati: i tassi descrivono queste prove, non una stima generale di affidabilità.",
    "Le differenze fra risposte brevi e spiegate sono segnali diagnostici, non una dimostrazione causale di verbosity bias.",
    "Le evidenze live sono fixture ideali controllate, non chiamate a un browser o risposte generate dal tutor. Nessun retrieval viene eseguito.",
    "Gli errori operativi non entrano nei denominatori qualitativi, ma impediscono checks_passed; anche le prove non tentate restano nel totale pianificato.",
    "Il passaggio di queste prove non approva automaticamente una baseline o un hook Git. Dopo modifiche guidate dal development, usare un nuovo campione indipendente per verificare il judge.",
]


def probe_input(bundle, case, text):
    live = case.evaluation_mode == "live_tools"
    tools, outputs, evidence = [], [], []
    if live:
        snapshot = SnapshotOutput.model_validate(build_fixture(bundle.fixtures[case.fixture_id])).model_dump(mode="json", exclude_unset=True)
        tools = [{"call_id": "snapshot-1", "tool": "getCircuitSnapshot", "input": {},
            "ok": True, "revision": snapshot["revision"], "error": None, "duration_ms": 0}]
        outputs = [{"call_id": "snapshot-1", "tool": "getCircuitSnapshot", "result": {"ok": True, "data": snapshot}}]
        evidence = [{"call_id": "snapshot-1", "tool": "getCircuitSnapshot", "revision": snapshot["revision"],
            "measurement_valid": snapshot["converged"] and snapshot["measurementsAvailable"]}]
    result = DatasetTurnResult(turn=1, ok=False, answer=SubmitAnswer(response=text,
        kind="circuit" if live else "theory", evidence_ids=["snapshot-1"] if live else [],
        uses_measurements=live, learning_notes=[]), metrics=TurnMetrics(), tools=tools,
        tool_outputs=outputs, evidence=evidence)
    payload = judge_input(case, result, [], reference_sources=[bundle.corpus[id] for id in case.provenance.source_ids])
    return payload, result


def altered_response(probe):
    return probe.correct_explained.replace(probe.mutation.before, probe.mutation.after, 1)


def same_quantity(actual, expected):
    return actual[1] == expected[1] and math.isclose(actual[0], expected[0], rel_tol=1e-9, abs_tol=1e-12)


def validate_mutation(case, probe):
    mutation = probe.mutation
    if probe.correct_explained.count(mutation.before) != 1 or mutation.before == mutation.after:
        raise ValueError(f"Mutazione assente, ambigua o senza effetto: {case.name}")
    if len(probe.correct_concise) >= len(probe.correct_explained):
        raise ValueError(f"La variante spiegata deve essere più lunga della breve: {case.name}")
    if mutation.kind in {"numeric_value", "unit", "component_swap"}:
        try:
            references = [case.reference.numbers[i] for i in mutation.reference_indices if i >= 0]
        except IndexError as exc:
            raise ValueError(f"Indice numerico sconosciuto: {case.name}") from exc
        before, after = quantities(mutation.before), quantities(mutation.after)
        count = 2 if mutation.kind == "component_swap" else 1
        if len(references) != count or len(mutation.reference_indices) != count or not before or not after:
            raise ValueError(f"Mutazione numerica incompleta: {case.name}")
        expected = [(n.value, n.unit) for n in references]
        if mutation.kind == "component_swap":
            if len(before) != 2 or len(after) != 2 or same_quantity(expected[0], expected[1]) or not all(
                same_quantity(a, b) for a, b in zip(before + after, expected + expected[::-1])):
                raise ValueError(f"Scambio non coerente con i riferimenti: {case.name}")
        else:
            wrong = mutation.wrong_quantity
            if wrong is None or not same_quantity(before[-1], expected[0]) or not same_quantity(after[-1], (wrong.value, wrong.unit)) or before[:-1] != after[:-1]:
                raise ValueError(f"Alterazione non coerente con la quantità dichiarata: {case.name}")
            original = references[0]
            if wrong.unit == original.unit and math.isclose(wrong.value, original.value,
                rel_tol=original.relative_tolerance, abs_tol=original.absolute_tolerance):
                raise ValueError(f"L'errore numerico rientra nella tolleranza: {case.name}")
    elif mutation.kind == "truth_table":
        if mutation.logic_gate is None or mutation.logic_inputs is None or mutation.wrong_output is None:
            raise ValueError(f"Mutazione logica incompleta: {case.name}")
        a, b = mutation.logic_inputs
        correct = int(bool(a and b) if mutation.logic_gate == "and" else a != b)
        if mutation.wrong_output == correct or mutation.before != f"{a}{b} → {correct}" or mutation.after != f"{a}{b} → {mutation.wrong_output}":
            raise ValueError(f"Mutazione logica non errata: {case.name}")
        for text in (probe.correct_concise, probe.correct_explained):
            rows = re.findall(r"(?<!\d)([01])([01])\s*→\s*([01])(?!\d)", text)
            observed = {(int(a), int(b)): int(out) for a, b, out in rows}
            expected = {(a, b): int(bool(a and b) if mutation.logic_gate == "and" else a != b) for a in (0, 1) for b in (0, 1)}
            if len(rows) != 4 or observed != expected:
                raise ValueError(f"Tabella positiva non coerente con l'operatore: {case.name}")


def load_probes(bundle, path):
    path = Path(path).resolve()
    suite = JudgeProbeSuite.model_validate_json(path.read_text())
    if suite.dataset_bundle_sha256 != bundle.identity()["bundle_sha256"]:
        raise ValueError("La suite si riferisce a un dataset diverso: revisionare risposte e mutazioni")
    cases = {case.name: case for case in bundle.dataset.cases}
    ids = [probe.case_id for probe in suite.cases]
    if len(set(ids)) != len(ids) or set(ids) != set(cases):
        raise ValueError("La suite deve coprire ogni caso del dataset una sola volta")
    for probe in suite.cases:
        case = cases[probe.case_id]
        if case.evaluation_mode not in {"closed_book", "live_tools"} or case.followups or case.retrieved_source_ids or not case.provenance.source_ids:
            raise ValueError("Le prove richiedono casi dei libri a un turno, senza retrieval")
        if any(not bundle.corpus[id].publication for id in case.provenance.source_ids):
            raise ValueError("Una prova deve riferirsi a una soluzione pubblicata")
        validate_mutation(case, probe)
        for text in (probe.correct_concise, probe.correct_explained):
            _, result = probe_input(bundle, case, text)
            if not deterministic_passed(deterministic_checks(case.reference, result, bundle.corpus)):
                raise ValueError(f"La risposta proposta come corretta non supera i controlli rigidi: {case.name}")
    return suite


def expectations(probe, variant):
    if variant != "controlled_error":
        return {criterion: ScoreRange(minimum=2, maximum=2) for criterion in CRITERIA}
    mutation = probe.mutation
    return {mutation.target_criterion: ScoreRange(minimum=0, maximum=mutation.maximum_score)}


def summarize_probes(schedule, trials):
    completed = [trial for trial in trials if trial.judge.status == "completed" and trial.judge.verdict is not None]
    positive = [trial for trial in completed if trial.scheduled.variant != "controlled_error"]
    negative = [trial for trial in completed if trial.scheduled.variant == "controlled_error"]
    rejected = sum(not semantic_passed(t.judge) for t in positive)
    accepted = sum(semantic_passed(t.judge) for t in negative)
    lookup = {(t.scheduled.case_id, t.scheduled.repetition, t.scheduled.variant):
        {rating.criterion: rating.score for rating in t.judge.verdict.ratings} for t in positive}
    style_pairs = short_penalized = explained_penalized = 0
    for (case_id, repetition, variant), concise in lookup.items():
        explained = lookup.get((case_id, repetition, "correct_explained"))
        if variant == "correct_concise" and explained is not None:
            style_pairs += 1
            short_penalized += any(concise[c] < explained[c] for c in CRITERIA)
            explained_penalized += any(explained[c] < concise[c] for c in CRITERIA)
    met = sum(t.expectations_met is True for t in completed)
    outcome = "not_evaluated" if not trials else "checks_passed" if len(completed) == len(schedule) and met == len(schedule) else "needs_revision"
    return JudgeProbeSummary(planned=len(schedule), attempted=len(trials), completed=len(completed),
        operational_errors=len(trials) - len(completed), expectations_met=met,
        positive_completed=len(positive), false_rejections=rejected,
        false_rejection_rate=rejected / len(positive) if positive else None,
        negative_completed=len(negative), false_acceptances=accepted,
        false_acceptance_rate=accepted / len(negative) if negative else None,
        targeted_misses=sum(t.expectations_met is False for t in negative), style_pairs=style_pairs,
        concise_penalized=short_penalized, explained_penalized=explained_penalized,
        distinct_cases=len({t.scheduled.case_id for t in trials}), distinct_groups=len({t.group_id for t in trials}), outcome=outcome)


def identity_error(report, root=ROOT):
    if source_snapshot(root) != report.manifest.configuration.source_sha256:
        return "Sorgenti cambiati durante la verifica del judge."
    for relative, expected in {**report.manifest.dataset.files_sha256, report.suite_path: report.suite_sha256}.items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file() or file_digest(path) != expected:
            return "Dataset, estratti o suite cambiati durante la verifica del judge."
    observations = [o for t in report.results for o in t.judge.metrics.model_observations]
    if len({o.model_name for o in observations if o.model_name}) > 1 or len({o.system_fingerprint for o in observations if o.system_fingerprint}) > 1:
        return "Il server ha riportato identità diverse del judge durante la verifica."
    return None


async def check_endpoint(settings):
    async with httpx.AsyncClient(timeout=5, headers={"Authorization": f"Bearer {settings.api_key}"}) as client:
        response = await client.get(settings.base_url.rstrip("/") + "/models")
        response.raise_for_status()


async def run_verification(bundle, suite_path, settings, *, cases=None, repetitions=1, critical_repetitions=2,
        order_seed=42, prepare_only=False, output=None, judge_model=None, preflight=check_endpoint, consecutive_error_limit=3):
    if settings.provider != "local" or settings.rag_enabled:
        raise ValueError("La verifica richiede un judge locale e RAG disattivato")
    local_judge_settings(settings, model=settings.model, base_url=settings.base_url, context_tokens=settings.context_max_tokens)
    if not 1 <= repetitions <= 100 or not 1 <= critical_repetitions <= 100 or consecutive_error_limit < 1:
        raise ValueError("Ripetizioni ammesse fra 1 e 100; limite di errori positivo")
    suite_path = Path(suite_path).resolve()
    if not suite_path.is_relative_to(ROOT):
        raise ValueError("La suite deve essere locale alla repository")
    suite = load_probes(bundle, suite_path)
    cases = list(cases) if cases is not None else select_cases(bundle)
    if not cases or len({c.name for c in cases}) != len(cases) or any(c not in bundle.dataset.cases for c in cases):
        raise ValueError("Selezionare casi distinti del dataset verificato")
    critical_repetitions = max(repetitions, critical_repetitions)
    schedule = [ScheduledProbe(case_id=case.name, variant=variant, repetition=rep)
        for case in cases for variant in VARIANTS
        for rep in range(1, (critical_repetitions if case.critical else repetitions) + 1)]
    random.Random(order_seed).shuffle(schedule)
    manifest = create_manifest(settings, cases, repetitions, dataset_identity=bundle.identity())
    manifest.evaluation_protocol = evaluation_protocol(settings, judge_policy="blocking")
    manifest.limitations = [text for text in manifest.limitations if "controlli attuali" not in text]
    report = JudgeProbeReport(manifest=manifest, suite_id=suite.id, suite_version=suite.version,
        suite_path=suite_path.relative_to(ROOT).as_posix(), suite_sha256=file_digest(suite_path),
        verification_schema_sha256=digest({"suite": JudgeProbeSuite.model_json_schema(), "report": JudgeProbeReport.model_json_schema()}),
        order_seed=order_seed, repetitions=repetitions, critical_repetitions=critical_repetitions,
        consecutive_error_limit=consecutive_error_limit, schedule=schedule, status="prepared",
        summary=summarize_probes(schedule, []), limitations=LIMITATIONS)
    output = Path(output) if output else ROOT / ".local-notes/llmops/judge-verification" / manifest.experiment_id / "report.json"
    if output.exists():
        raise ValueError("Il report esiste già: scegliere un nuovo percorso")
    save_report(report, output)
    if prepare_only:
        return report, output
    by_case = {case.name: case for case in cases}
    by_probe = {probe.case_id: probe for probe in suite.cases}
    errors = 0
    try:
        try:
            await preflight(settings)
        except (httpx.HTTPError, OSError):
            report.status, report.error = "unavailable", "Endpoint locale non disponibile; nessun voto assegnato."
            return report, output
        report.status = "running"
        save_report(report, output)
        for scheduled in schedule:
            error = identity_error(report)
            if error:
                report.status, report.error = "invalidated", error
                break
            case, probe = by_case[scheduled.case_id], by_probe[scheduled.case_id]
            text = altered_response(probe) if scheduled.variant == "controlled_error" else getattr(probe, scheduled.variant)
            payload, _ = probe_input(bundle, case, text)
            try:
                async with asyncio.timeout(settings.request_timeout):
                    evaluation = await judge_answer(payload, settings, model=judge_model)
            except TimeoutError:
                evaluation = JudgeEvaluation(status="unavailable", error="Budget totale della prova esaurito; nessun voto assegnato.")
            expected = expectations(probe, scheduled.variant)
            met = None
            if evaluation.status == "completed" and evaluation.verdict is not None:
                scores = {rating.criterion: rating.score for rating in evaluation.verdict.ratings}
                met = all(bounds.minimum <= scores[name] <= bounds.maximum for name, bounds in expected.items())
            report.results.append(JudgeProbeTrial(scheduled=scheduled, split=case.split, group_id=case.group_id,
                input=payload, input_sha256=digest(payload), expectations=expected, judge=evaluation, expectations_met=met))
            report.summary = summarize_probes(schedule, report.results)
            save_report(report, output)
            print(f"{len(report.results)}/{len(schedule)} {case.name} {scheduled.variant} r{scheduled.repetition}: "
                f"{'OK' if met else 'DA RIVEDERE' if met is False else evaluation.status}", flush=True)
            errors = errors + 1 if met is None else 0
            if errors >= consecutive_error_limit:
                report.status, report.error = "interrupted", "Limite di errori operativi consecutivi raggiunto; risultati parziali conservati."
                break
        else:
            report.status = "completed"
        error = identity_error(report)
        if error:
            report.status, report.error = "invalidated", error
            report.summary.outcome = "needs_revision"
    except asyncio.CancelledError:
        report.status, report.error = "interrupted", "Verifica interrotta; risultati parziali conservati."
        raise
    except Exception:
        report.status, report.error = "interrupted", "Errore operativo durante la verifica; risultati parziali conservati."
        raise
    finally:
        report.completed_at = utc_now()
        save_report(report, output)
    return report, output


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-directory", type=Path, default=TEXTBOOK_DIR)
    parser.add_argument("--suite", type=Path)
    parser.add_argument("--case")
    parser.add_argument("--split", choices=["development", "validation", "all"])
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--critical-repetitions", type=int, default=2)
    parser.add_argument("--order-seed", type=int, default=42)
    parser.add_argument("--consecutive-error-limit", type=int, default=3)
    parser.add_argument("--judge-model")
    parser.add_argument("--judge-base-url")
    parser.add_argument("--max-output-tokens", type=int, default=1024)
    parser.add_argument("--context-tokens", type=int, default=24000)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        bundle = load_dataset(args.dataset_directory)
        cases = select_cases(bundle, split=args.split or ("all" if args.case else "development"), case_name=args.case)
        base = Settings.from_env()
        settings = local_judge_settings(base, model=args.judge_model or base.model,
            base_url=args.judge_base_url or base.base_url, api_key=os.getenv("JUDGE_LLM_API_KEY", "local"), context_tokens=args.context_tokens)
        settings = replace(settings, max_output_tokens=args.max_output_tokens)
        report, output = await run_verification(bundle, args.suite or args.dataset_directory / "judge-probes.v1.json", settings,
            cases=cases, repetitions=args.repetitions, critical_repetitions=args.critical_repetitions,
            order_seed=args.order_seed, prepare_only=args.prepare_only, output=args.output,
            consecutive_error_limit=args.consecutive_error_limit)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    print(f"Report: {output}")
    print(f"Stato: {report.status}; esito: {report.summary.outcome}")
    print(f"Judge completato: {report.summary.completed}/{report.summary.planned}; aspettative soddisfatte: {report.summary.expectations_met}")
    print(f"Accettazioni errate: {report.summary.false_acceptances}/{report.summary.negative_completed}; rifiuti di risposte proposte corrette: {report.summary.false_rejections}/{report.summary.positive_completed}")
    print("Calibrazione umana: no. Baseline approvata: no.")
    if report.error:
        print(report.error)
    if report.status != "prepared" and (report.status != "completed" or report.summary.outcome != "checks_passed"):
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
