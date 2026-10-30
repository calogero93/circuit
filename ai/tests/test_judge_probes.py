import asyncio
from contextlib import redirect_stdout
from copy import deepcopy
from dataclasses import replace
import json
import io
from pathlib import Path
import tempfile
import unittest

import httpx
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from circuit_ai.core.config import Settings
from circuit_ai.evaluation.dataset import TEXTBOOK_DIR, load_dataset
from circuit_ai.evaluation.experiments import ROOT
from circuit_ai.contracts.probes import JudgeProbeReport
from circuit_ai.evaluation.probes import (altered_response, identity_error, load_probes, probe_input,
    run_verification, validate_mutation)
from test_tutor import FakeModel

SUITE = TEXTBOOK_DIR / "judge-probes.v1.json"
CRITERIA = ("relevance", "completeness", "groundedness", "compliance")


async def no_network(_):
    return None


class AnswerAwareJudge(FakeModel):
    def __init__(self, errors, *, always_accept=False, reject_concise=None):
        super().__init__([])
        self.errors, self.always_accept, self.reject_concise = set(errors), always_accept, reject_concise
        self.verdict_calls = 0

    async def ainvoke(self, messages):
        self.calls.append(messages.copy())
        payload = json.loads(next(m.content for m in reversed(messages) if isinstance(m, HumanMessage)))
        text = payload["response"]["response"]
        if payload["reference"]["numbers"] and not any(isinstance(m, ToolMessage) and m.name == "calculator" for m in messages):
            return AIMessage(content="", tool_calls=[{"name": "calculator", "id": f"calc-{len(self.calls)}", "args": {
                "expression": "1+1", "variables": [], "response_quote": text}}])
        self.verdict_calls += 1
        low = (text in self.errors and not self.always_accept) or text == self.reject_concise
        return AIMessage(content="", tool_calls=[{"id": "judgment", "name": "JudgeVerdict", "args": {
            "ratings": [{"criterion": c, "score": 1 if c == "groundedness" and low else 2,
                "rationale": "Riscontro di test nel testo e nella fonte."} for c in CRITERIA]}}])


class ProbeDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = load_dataset(TEXTBOOK_DIR)
        cls.suite = load_probes(cls.bundle, SUITE)

    def test_probes_cover_all_exercises_and_changed_claims_are_local(self):
        self.assertEqual(len(self.suite.cases), 11)
        for probe in self.suite.cases:
            self.assertNotEqual(altered_response(probe), probe.correct_explained)
            self.assertEqual(probe.correct_explained.count(probe.mutation.before), 1)
        self.assertTrue({"numeric_value", "unit", "component_swap", "truth_table", "rms_confusion",
            "unsupported_claim", "component_mapping"} <= {p.mutation.kind for p in self.suite.cases})

    def test_broken_numeric_and_logical_mutations_are_rejected(self):
        cases = {c.name: c for c in self.bundle.dataset.cases}
        probe = deepcopy(self.suite.cases[0])
        probe.mutation.wrong_quantity.value = 108
        with self.assertRaisesRegex(ValueError, "quantità dichiarata"):
            validate_mutation(cases[probe.case_id], probe)
        probe = deepcopy(next(p for p in self.suite.cases if p.mutation.kind == "truth_table"))
        probe.mutation.wrong_output = 1
        with self.assertRaisesRegex(ValueError, "Mutazione logica non errata"):
            validate_mutation(cases[probe.case_id], probe)

    def test_positive_truth_tables_are_checked_independently(self):
        probe = deepcopy(next(p for p in self.suite.cases if p.case_id == "book-digital-and-closed"))
        probe.correct_concise = probe.correct_concise.replace("00 → 0", "00 → 1")
        case = next(c for c in self.bundle.dataset.cases if c.name == probe.case_id)
        with self.assertRaisesRegex(ValueError, "Tabella positiva"):
            validate_mutation(case, probe)

    def test_judge_inputs_differ_only_in_answer_not_in_variant_or_expectations(self):
        probe = self.suite.cases[0]
        case = next(c for c in self.bundle.dataset.cases if c.name == probe.case_id)
        inputs = [probe_input(self.bundle, case, text)[0] for text in
            (probe.correct_concise, probe.correct_explained, altered_response(probe))]
        self.assertEqual(inputs[0].model_dump(exclude={"response"}), inputs[1].model_dump(exclude={"response"}))
        self.assertEqual(inputs[1].model_dump(exclude={"response"}), inputs[2].model_dump(exclude={"response"}))
        for payload in inputs:
            self.assertTrue(payload.reference_sources)
            self.assertFalse({"variant", "expectations", "mutation", "maximum_score", "case_id"} & payload.model_dump().keys())
            self.assertEqual(payload.tools, [])
        live = next(c for c in self.bundle.dataset.cases if c.name == "book-dc-power-live")
        payload, result = probe_input(self.bundle, live, "Risposta costruita per il test")
        self.assertEqual(payload.tools[0].tool, "getCircuitSnapshot")
        self.assertTrue(result.evidence[0].measurement_valid)
        self.assertEqual(payload.tool_outputs[0].result.data["components"]["R1"]["data"]["p"], 108)


class ProbeRunnerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.enterContext(redirect_stdout(io.StringIO()))
        self.bundle = load_dataset(TEXTBOOK_DIR)
        self.suite = load_probes(self.bundle, SUITE)
        self.errors = [altered_response(p) for p in self.suite.cases]
        directory = ROOT / ".local-notes"
        directory.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=directory)
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name) / "report.json"
        self.case = self.bundle.dataset.cases[0]
        self.settings = replace(Settings(), model="judge-test", max_output_tokens=1024)

    async def run_probe(self, **kwargs):
        return await run_verification(self.bundle, SUITE, self.settings, output=self.output,
            preflight=no_network, **kwargs)

    async def test_prepare_only_never_calls_model_and_does_not_claim_results(self):
        model = AnswerAwareJudge(self.errors)
        async def forbidden(_): raise AssertionError("Non contattare il server")
        report, _ = await run_verification(self.bundle, SUITE, self.settings, output=self.output,
            prepare_only=True, judge_model=model, preflight=forbidden, cases=self.bundle.dataset.cases)
        self.assertEqual(report.status, "prepared")
        self.assertEqual(report.summary.planned, 45)
        self.assertEqual(report.summary.attempted, 0)
        self.assertIsNone(report.summary.false_acceptance_rate)
        self.assertEqual(report.summary.outcome, "not_evaluated")
        self.assertFalse(report.human_calibrated)
        self.assertFalse(report.baseline_approved)
        self.assertEqual(model.calls, [])
        self.assertEqual(JudgeProbeReport.model_validate_json(self.output.read_text()), report)
        self.assertIsNone(identity_error(report))

    async def test_full_coverage_repeats_critical_cases_and_preserves_hidden_expectations(self):
        model = AnswerAwareJudge(self.errors)
        report, _ = await self.run_probe(judge_model=model, cases=self.bundle.dataset.cases)
        self.assertEqual(report.status, "completed")
        s = report.summary
        self.assertEqual((s.planned, s.completed, s.expectations_met), (45, 45, 45))
        self.assertEqual((s.distinct_cases, s.distinct_groups), (11, 8))
        self.assertEqual((s.positive_completed, s.negative_completed, s.style_pairs), (30, 15, 15))
        self.assertEqual(s.outcome, "checks_passed")
        self.assertEqual((s.false_acceptances, s.false_rejections), (0, 0))
        for request in model.calls:
            payload = next(m.content for m in request if isinstance(m, HumanMessage))
            self.assertNotIn('"expectations"', payload)
            self.assertNotIn('"mutation"', payload)

    async def test_judge_accepting_everything_fails_controlled_errors(self):
        model = AnswerAwareJudge(self.errors, always_accept=True)
        report, _ = await self.run_probe(judge_model=model, cases=[self.case])
        self.assertEqual(report.status, "completed")
        self.assertEqual(report.summary.false_acceptance_rate, 1)
        self.assertEqual(report.summary.targeted_misses, 2)
        self.assertEqual(report.summary.outcome, "needs_revision")

    async def test_short_correct_response_penalty_is_reported(self):
        model = AnswerAwareJudge(self.errors, reject_concise=self.suite.cases[0].correct_concise)
        report, _ = await self.run_probe(judge_model=model, cases=[self.case])
        self.assertEqual(report.summary.false_rejections, 2)
        self.assertEqual(report.summary.false_rejection_rate, .5)
        self.assertEqual(report.summary.concise_penalized, 2)
        self.assertEqual(report.summary.explained_penalized, 0)
        self.assertEqual(report.summary.outcome, "needs_revision")

    async def test_unavailable_results_are_not_quality_scores_or_passes(self):
        model = FakeModel([TimeoutError(), TimeoutError(), TimeoutError()])
        report, _ = await self.run_probe(judge_model=model, cases=[self.case])
        self.assertEqual(report.status, "interrupted")
        self.assertEqual((report.summary.planned, report.summary.attempted, report.summary.completed), (6, 3, 0))
        self.assertEqual(report.summary.operational_errors, 3)
        self.assertIsNone(report.summary.false_acceptance_rate)
        self.assertIsNone(report.summary.false_rejection_rate)
        self.assertTrue(all(t.expectations_met is None for t in report.results))
        self.assertEqual(report.summary.outcome, "needs_revision")

    async def test_missing_endpoint_is_recorded_without_inference(self):
        async def unavailable(_): raise httpx.ConnectError("test endpoint unavailable")
        model = AnswerAwareJudge(self.errors)
        report, _ = await run_verification(self.bundle, SUITE, self.settings, output=self.output,
            cases=[self.case], preflight=unavailable, judge_model=model)
        self.assertEqual(report.status, "unavailable")
        self.assertEqual(report.summary.attempted, 0)
        self.assertEqual(model.calls, [])
        self.assertIsNotNone(report.completed_at)

    async def test_suite_edits_and_existing_outputs_are_rejected(self):
        report, _ = await self.run_probe(prepare_only=True, cases=[self.case])
        report.suite_sha256 = "0" * 64
        self.assertIn("suite", identity_error(report))
        with self.assertRaisesRegex(ValueError, "report esiste"):
            await self.run_probe(prepare_only=True, cases=[self.case])

    async def test_model_identity_changes_invalidate_and_stop_the_report(self):
        class DriftingJudge(AnswerAwareJudge):
            async def ainvoke(self, messages):
                index = self.verdict_calls + 1
                response = await super().ainvoke(messages)
                response.response_metadata = {"model_name": f"model-{index}"}
                return response
        report, _ = await self.run_probe(judge_model=DriftingJudge(self.errors), cases=[self.case])
        self.assertEqual(report.status, "invalidated")
        self.assertEqual(report.summary.attempted, 2)
        self.assertEqual(report.summary.outcome, "needs_revision")
        self.assertIn("identità diverse", report.error)

    async def test_cancellation_preserves_completed_trials(self):
        class CancelledJudge(AnswerAwareJudge):
            async def ainvoke(self, messages):
                if self.verdict_calls:
                    raise asyncio.CancelledError()
                return await super().ainvoke(messages)
        with self.assertRaises(asyncio.CancelledError):
            await self.run_probe(judge_model=CancelledJudge(self.errors), cases=[self.case])
        report = JudgeProbeReport.model_validate_json(self.output.read_text())
        self.assertEqual(report.status, "interrupted")
        self.assertEqual(report.summary.completed, 1)
        self.assertEqual(report.summary.planned, 6)

    async def test_cloud_and_rag_cannot_be_used_accidentally(self):
        for settings in (replace(self.settings, provider="openai"), replace(self.settings, rag_enabled=True),
                replace(self.settings, base_url="https://example.com/v1")):
            with self.assertRaises(ValueError):
                await run_verification(self.bundle, SUITE, settings, output=self.output, prepare_only=True)


if __name__ == "__main__":
    unittest.main()
