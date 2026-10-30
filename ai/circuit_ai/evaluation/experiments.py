"""Passo 1 LLMOps: identità degli esperimenti e risultati locali senza sovrascritture."""
from datetime import datetime, timezone
import hashlib
from importlib.metadata import PackageNotFoundError, version
import json
from pathlib import Path
import platform
import statistics
import subprocess
from urllib.parse import urlsplit
from uuid import uuid4

from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import BaseModel

from circuit_ai.core.config import Settings
from circuit_ai.agent.graph import SYSTEM_PROMPT
from circuit_ai.contracts.shared import (ConversationSummary, EvaluationReport, EvaluationSummary,
    ExperimentConfiguration, ExperimentGeneration, ExperimentManifest,
    ExperimentModel, ExperimentPolicy, ModelContext, ModelQuestion, SubmitAnswer, submit_answer_tool)
from circuit_ai.tools.catalog import make_tools, tool_schemas
from circuit_ai.core.paths import REPO_ROOT as ROOT



def utc_now():
    return datetime.now(timezone.utc).isoformat()


def canonical(value):
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def file_digest(path):
    fingerprint = hashlib.sha256()
    before = path.stat()
    with path.open("rb") as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            fingerprint.update(chunk)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("Un file è cambiato durante il calcolo della sua impronta")
    return fingerprint.hexdigest()


def source_snapshot(root=ROOT):
    patterns = ["ai/circuit_ai/**/*.py", "src/ai/*.ts", "src/ai/*.tsx", "src/ai/*.json",
        "src/engine/*.ts", "src/model/*.ts", "src/library/*.ts", "src/store/*.ts",
        "src/viz/controller.ts", "ai/uv.lock", "ai/pyproject.toml", "package-lock.json"]
    files = {p for pattern in patterns for p in root.glob(pattern) if p.is_file()}
    return {p.relative_to(root).as_posix(): file_digest(p) for p in sorted(files)}


def git_provenance(root):
    def git(*args):
        result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, timeout=5)
        return result.stdout.strip() if result.returncode == 0 else None
    try:
        commit = git("rev-parse", "HEAD")
        status = git("status", "--porcelain", "--untracked-files=normal")
        return commit, status != "" if status is not None else None
    except (OSError, subprocess.TimeoutExpired):
        return None, None


def endpoint_origin(url):
    parsed = urlsplit(url)
    if not parsed.hostname:
        return "provider-default"
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    return f"{parsed.scheme}://{host}" + (f":{parsed.port}" if parsed.port else "")


def installed_versions(rag_enabled):
    names = ["langgraph", "langchain-core", "langchain-openai", "langgraph-checkpoint-postgres",
             "psycopg", "pydantic"]
    if rag_enabled:
        names += ["qdrant-client", "sentence-transformers"]
    values = {"python": platform.python_version()}
    for name in names:
        try:
            values[name] = version(name)
        except PackageNotFoundError:
            values[name] = "not-installed"
    return values


def create_manifest(settings: Settings, cases, repetitions=1, *, root=ROOT, model_file=None, dataset_identity=None):
    weight_file = model_file if model_file is not None else settings.model_file
    weights_sha256 = settings.model_sha256.lower() if settings.model_sha256 else None
    identity = "declared" if weights_sha256 else "unknown"
    if weight_file is not None:
        measured = file_digest(Path(weight_file).expanduser())
        if weights_sha256 and measured != weights_sha256:
            raise ValueError("Il file pesi non corrisponde a LLM_MODEL_SHA256")
        weights_sha256, identity = measured, "file_hash"
    public_model = ExperimentModel(provider=settings.provider, name=settings.model,
        endpoint_origin=endpoint_origin(settings.base_url), revision=settings.model_revision,
        quantization=settings.model_quantization, weights_sha256=weights_sha256,
        weights_identity=identity, runtime_name=settings.runtime_name,
        runtime_version=settings.runtime_version, hardware_id=settings.hardware_id)
    generation = ExperimentGeneration(temperature=settings.temperature, seed=settings.seed, reasoning_effort=settings.reasoning_effort,
        max_output_tokens=settings.max_output_tokens if settings.max_output_tokens is not None else
            (4096 if settings.provider == "anthropic" else None),
        timeout_s=settings.request_timeout, adapter_retries=2)
    policy = ExperimentPolicy(max_tool_rounds=settings.max_tool_rounds, max_schema_retries=settings.max_schema_retries,
        summary_threshold_tokens=settings.summary_threshold_tokens, context_max_tokens=settings.context_max_tokens,
        keep_recent_turns=settings.keep_recent_turns, rag_enabled=settings.rag_enabled,
        rag_corpus_revision=settings.rag_corpus_revision)
    contracts = {"browser": tool_schemas(),
        "agent_tools": [convert_to_openai_tool(tool) for tool in [*make_tools(settings), submit_answer_tool()]],
        "context": ModelContext.model_json_schema(), "question": ModelQuestion.model_json_schema(),
        "summary": ConversationSummary.model_json_schema()}
    configuration = ExperimentConfiguration(model=public_model, generation=generation, policy=policy,
        prompt_sha256=digest(SYSTEM_PROMPT), contracts_sha256=digest(contracts),
        source_sha256=source_snapshot(root), dependency_versions=installed_versions(settings.rag_enabled))
    commit, dirty = git_provenance(root)
    limitations = ["I tool del circuito sono fixture controllate: questa valutazione non esercita il browser live.",
                  "I controlli attuali verificano contratti e classificazione: non misurano ancora qualità, faithfulness o sicurezza del testo.",
                  "Temperatura zero e seed non garantiscono risultati identici fra esecuzioni."]
    if identity == "unknown":
        limitations.append("Pesi non identificati: il nome richiesto al server può essere un alias mutevole.")
    elif identity == "declared":
        limitations.append("Hash dei pesi dichiarato, non verificato leggendo il file locale.")
    else:
        limitations.append("File pesi identificato; il protocollo del server non prova che sia il file effettivamente caricato.")
    if not settings.runtime_name or not settings.runtime_version:
        limitations.append("Runtime di inferenza non completamente identificato: dichiarare nome e versione per confronti ripetibili.")
    if not settings.hardware_id:
        limitations.append("Hardware del server LLM non dichiarato: i confronti di latenza richiedono lo stesso ambiente hardware.")
    if settings.rag_enabled and not settings.rag_corpus_revision:
        limitations.append("Indice RAG attivo ma senza revisione dichiarata del corpus.")
    if dataset_identity and dataset_identity["status"] == "provisional":
        limitations.append("Dataset provvisorio: i riferimenti sono proposte assistite non ancora revisionate da una persona.")
    return ExperimentManifest(experiment_id=uuid4().hex, created_at=utc_now(),
        configuration_id=digest(configuration), configuration=configuration,
        git_commit=commit, worktree_dirty=dirty, python_version=platform.python_version(),
        platform=f"{platform.system()} {platform.machine()}",
        cases_sha256=digest([c.model_dump(mode="json") for c in cases]),
        selected_cases=[c.name for c in cases], repetitions=repetitions, dataset=dataset_identity, limitations=limitations)


def summarize(trials):
    latencies = [trial.result.metrics.model_duration_ms for trial in trials if trial.result.answer is not None]
    passed = sum(trial.result.ok for trial in trials)
    turns = [turn for trial in trials for turn in trial.result.turns if turn.checks]
    judged = [turn for turn in turns if turn.judge.status == "completed"]
    requested = any(turn.judge.status != "not_requested" for turn in turns)
    policies = {turn.judge_policy for turn in turns if turn.judge_policy is not None}
    return EvaluationSummary(criterion="deterministic_and_judge" if requested else "deterministic_checks" if turns else "contracts_and_classification_only",
        attempted=len(trials), passed=passed,
        pass_rate=passed / len(trials) if trials else None,
        mean_model_duration_ms=statistics.mean(latencies) if latencies else None,
        stdev_model_duration_ms=statistics.stdev(latencies) if len(latencies) > 1 else None,
        evaluated_turns=len(turns), deterministic_passed_turns=sum(all(c.status == "pass" for c in t.checks) for t in turns),
        semantic_evaluated_turns=len(judged), semantic_passed_turns=sum(all(r.score == 2 for r in t.judge.verdict.ratings) for t in judged),
        judge_policy=next(iter(policies)) if len(policies) == 1 else "mixed" if policies else None)


def new_report(manifest):
    return EvaluationReport(manifest=manifest, status="prepared", summary=summarize([]))


def save_report(report, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    try:
        temporary.write_text(report.model_dump_json(indent=2) + "\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_run_identity(report, root=ROOT):
    if source_snapshot(root) != report.manifest.configuration.source_sha256:
        return "Sorgenti cambiati durante la valutazione: eseguire nuovamente l'esperimento."
    if report.manifest.dataset:
        for relative, expected in report.manifest.dataset.files_sha256.items():
            path = (root / relative).resolve()
            if not path.is_relative_to(root.resolve()) or not path.is_file() or file_digest(path) != expected:
                return "Dataset, fixture o corpus cambiati durante l'esperimento."
    observations = [o for trial in report.results for o in trial.result.metrics.model_observations]
    names = {o.model_name for o in observations if o.model_name}
    fingerprints = {o.system_fingerprint for o in observations if o.system_fingerprint}
    if len(names) > 1 or len(fingerprints) > 1:
        return "Il server ha riportato identità diverse del modello durante lo stesso esperimento."
    judge_observations = [o for trial in report.results for turn in trial.result.turns for o in turn.judge.metrics.model_observations]
    if len({o.model_name for o in judge_observations if o.model_name}) > 1 or len({o.system_fingerprint for o in judge_observations if o.system_fingerprint}) > 1:
        return "Il server del judge ha riportato identità diverse durante l'esperimento."
    return None
