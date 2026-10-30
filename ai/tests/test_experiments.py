"""Passo 1: identità delle configurazioni, osservazioni e report senza un LLM reale."""
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
from langchain_core.messages import AIMessage

from circuit_ai.core.config import Settings, create_model
from circuit_ai.agent.context import record_call
from circuit_ai.evaluation.runner import CASES, run_experiment
from circuit_ai.evaluation.experiments import create_manifest, new_report, source_snapshot, validate_run_identity
from circuit_ai.contracts.shared import EvaluationReport, EvaluationResult, ModelObservation, TurnMetrics


class ManifestTests(unittest.TestCase):
    def test_identity_is_stable_but_experiments_have_distinct_ids(self):
        one = create_manifest(Settings(), CASES[:1])
        two = create_manifest(Settings(), CASES[:1], repetitions=3)
        self.assertEqual(one.configuration_id, two.configuration_id)
        self.assertEqual(one.cases_sha256, two.cases_sha256)
        self.assertNotEqual(one.experiment_id, two.experiment_id)
        self.assertEqual(one.configuration.model.weights_identity, "unknown")
        self.assertTrue(any("alias" in text for text in one.limitations))

    def test_model_generation_prompt_contracts_and_code_change_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ai/circuit_ai/agent").mkdir(parents=True)
            path = root / "ai/circuit_ai/agent/graph.py"
            path.write_text("originale")
            base = create_manifest(Settings(), CASES[:1], root=root)
            for settings in [replace(Settings(), model="altro-modello"), replace(Settings(), temperature=.5),
                             replace(Settings(), seed=42), replace(Settings(), context_max_tokens=15000),
                             replace(Settings(), reasoning_effort="none"),
                             replace(Settings(), model_quantization="Q8_0")]:
                self.assertNotEqual(base.configuration_id, create_manifest(settings, CASES[:1], root=root).configuration_id)
            with patch('circuit_ai.evaluation.experiments.SYSTEM_PROMPT', "prompt diverso"):
                self.assertNotEqual(base.configuration_id, create_manifest(Settings(), CASES[:1], root=root).configuration_id)
            with patch('circuit_ai.evaluation.experiments.tool_schemas', return_value={"nuovo": {}}):
                self.assertNotEqual(base.configuration_id, create_manifest(Settings(), CASES[:1], root=root).configuration_id)
            path.write_text("modificato ma non committato")
            self.assertNotEqual(base.configuration_id, create_manifest(Settings(), CASES[:1], root=root).configuration_id)
            self.assertIsNone(base.git_commit)

    def test_cases_have_a_separate_identity_from_configuration(self):
        one = create_manifest(Settings(), CASES[:1])
        two = create_manifest(Settings(), CASES[:2])
        self.assertEqual(one.configuration_id, two.configuration_id)
        self.assertNotEqual(one.cases_sha256, two.cases_sha256)

    def test_reports_exclude_credentials_and_private_endpoint_paths(self):
        settings = replace(Settings(), api_key="secret-api-key", database_url="postgresql://u:secret-db@localhost/db",
            base_url="http://user:secret-http@127.0.0.1:1234/private/v1?api_key=secret-query")
        manifest = create_manifest(settings, CASES[:1])
        text = manifest.model_dump_json()
        for value in ["secret-api-key", "secret-db", "secret-http", "secret-query", "/private/v1"]:
            self.assertNotIn(value, text)
        self.assertEqual(manifest.configuration.model.endpoint_origin, "http://127.0.0.1:1234")

    def test_weights_are_hashed_and_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            weight_file = Path(directory) / "model.gguf"
            weight_file.write_bytes(b"fake-weights-for-hash-test")
            expected = hashlib.sha256(weight_file.read_bytes()).hexdigest()
            measured = create_manifest(Settings(), CASES[:1], model_file=weight_file)
            self.assertEqual(measured.configuration.model.weights_sha256, expected)
            self.assertEqual(measured.configuration.model.weights_identity, "file_hash")
            declared = create_manifest(replace(Settings(), model_sha256=expected), CASES[:1])
            self.assertEqual(declared.configuration.model.weights_identity, "declared")
            with self.assertRaisesRegex(ValueError, "non corrisponde"):
                create_manifest(replace(Settings(), model_sha256="0" * 64), CASES[:1], model_file=weight_file)
            weight_file.write_bytes(b"different-weights")
            different = create_manifest(Settings(), CASES[:1], model_file=weight_file)
            self.assertNotEqual(measured.configuration_id, different.configuration_id)

    def test_configured_generation_parameters_reach_adapter(self):
        model = create_model(replace(Settings(), temperature=.4, seed=42, max_output_tokens=512))
        self.assertEqual(model.temperature, .4)
        self.assertEqual(model.seed, 42)
        self.assertEqual(model.max_tokens, 512)
        with self.assertRaises(ValueError): replace(Settings(), temperature=float("nan"))
        with self.assertRaises(ValueError): replace(Settings(), model_sha256="not-a-hash")

    def test_reasoning_option_is_explicit_validated_and_recorded(self):
        self.assertIsNone(create_model(Settings()).reasoning_effort)
        with patch.dict("os.environ", {"LLM_PROVIDER": "local", "LLM_REASONING_EFFORT": "none"}, clear=True):
            settings = Settings.from_env()
        self.assertEqual(create_model(settings).reasoning_effort, "none")
        self.assertEqual(create_manifest(settings, CASES[:1]).configuration.generation.reasoning_effort, "none")
        with self.assertRaises(ValueError): replace(Settings(), reasoning_effort="invalid")
        with self.assertRaises(ValueError): replace(Settings(), provider="anthropic", reasoning_effort="none")

    def test_server_identity_is_recorded_and_deduplicated(self):
        message = AIMessage(content="", response_metadata={"model_name": "gemma-build-1", "system_fingerprint": "build-a"})
        metrics = record_call({}, message, [], .1)
        metrics = record_call(metrics, message, [], .2)
        self.assertEqual(len(metrics["model_observations"]), 1)
        changed = AIMessage(content="", response_metadata={"model_name": "gemma-build-2", "system_fingerprint": "build-b"})
        metrics = record_call(metrics, changed, [], .1)
        self.assertEqual(len(metrics["model_observations"]), 2)
        self.assertEqual(metrics["model_calls"], 3)


class ReportTests(unittest.IsolatedAsyncioTestCase):
    async def test_manifest_only_does_not_contact_model_and_does_not_claim_success(self):
        async def forbidden(*_): raise AssertionError("Il modello non deve essere chiamato")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            report, _ = await run_experiment(Settings(), CASES[:1], output=output, manifest_only=True,
                evaluator=forbidden, preflight=forbidden)
            saved = EvaluationReport.model_validate_json(output.read_text())
            self.assertEqual(saved.status, "prepared")
            self.assertEqual(saved.summary.attempted, 0)
            self.assertIsNone(saved.summary.pass_rate)
            self.assertEqual(saved.manifest.experiment_id, report.manifest.experiment_id)
            with self.assertRaisesRegex(ValueError, "esiste già"):
                await run_experiment(Settings(), CASES[:1], output=output, manifest_only=True)
            self.assertEqual(saved.manifest.experiment_id, EvaluationReport.model_validate_json(output.read_text()).manifest.experiment_id)

    async def test_repetitions_preserve_every_result_and_report_variability(self):
        calls = []
        async def ready(_): pass
        async def evaluate(case, settings):
            calls.append(case.name)
            return EvaluationResult(name=case.name, ok=len(calls) != 2,
                answer={"response": "Spiegazione", "kind": "theory", "evidence_ids": [], "uses_measurements": False, "learning_notes": []},
                metrics=TurnMetrics(model_duration_ms=100 * len(calls)))
        with tempfile.TemporaryDirectory() as directory:
            report, output = await run_experiment(Settings(), CASES[:1], repetitions=3,
                output=Path(directory) / "report.json", evaluator=evaluate, preflight=ready)
            self.assertEqual(report.status, "completed")
            self.assertEqual([r.repetition for r in report.results], [1, 2, 3])
            self.assertEqual(report.summary.passed, 2)
            self.assertAlmostEqual(report.summary.pass_rate, 2 / 3)
            self.assertAlmostEqual(report.summary.mean_model_duration_ms, 200)
            self.assertAlmostEqual(report.summary.stdev_model_duration_ms, 100)
            self.assertEqual(len(json.loads(output.read_text())["results"]), 3)

    async def test_offline_model_leaves_an_unavailable_report(self):
        async def unavailable(_): raise httpx.ConnectError("secret backend details")
        with tempfile.TemporaryDirectory() as directory:
            report, output = await run_experiment(Settings(), CASES[:1],
                output=Path(directory) / "report.json", preflight=unavailable)
            saved = EvaluationReport.model_validate_json(output.read_text())
            self.assertEqual(saved.status, "unavailable")
            self.assertIsNone(saved.summary.pass_rate)
            self.assertEqual(report.summary.attempted, 0)
            self.assertNotIn("secret backend details", saved.error)
            self.assertIsNotNone(saved.completed_at)

    async def test_source_change_invalidates_experiment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ai/circuit_ai/agent").mkdir(parents=True)
            path = root / "ai/circuit_ai/agent/graph.py"
            path.write_text("prima")
            report = new_report(create_manifest(Settings(), CASES[:1], root=root))
            self.assertIsNone(validate_run_identity(report, root))
            path.write_text("dopo")
            self.assertIn("Sorgenti cambiati", validate_run_identity(report, root))

    async def test_server_switch_during_run_invalidates_report(self):
        calls = []
        async def ready(_): pass
        async def evaluate(case, settings):
            calls.append(1)
            return EvaluationResult(name=case.name, ok=True, metrics=TurnMetrics(model_observations=[
                ModelObservation(model_name="same-alias", system_fingerprint=f"build-{len(calls)}")]))
        with tempfile.TemporaryDirectory() as directory:
            report, _ = await run_experiment(Settings(), CASES[:1], repetitions=2,
                output=Path(directory) / "report.json", evaluator=evaluate, preflight=ready)
            self.assertEqual(report.status, "invalidated")
            self.assertIn("identità diverse", report.error)

    async def test_interrupted_experiment_keeps_partial_results(self):
        async def ready(_): pass
        calls = []
        async def evaluate(case, settings):
            calls.append(1)
            if len(calls) == 2: raise RuntimeError("Errore valutatore")
            return EvaluationResult(name=case.name, ok=True)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            with self.assertRaises(RuntimeError):
                await run_experiment(Settings(), CASES[:1], repetitions=3, output=output, evaluator=evaluate, preflight=ready)
            saved = EvaluationReport.model_validate_json(output.read_text())
            self.assertEqual(saved.status, "interrupted")
            self.assertEqual(len(saved.results), 1)
            self.assertIsNotNone(saved.completed_at)


if __name__ == "__main__": unittest.main()
