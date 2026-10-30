from copy import deepcopy
from dataclasses import replace
import json
import unittest
from unittest.mock import patch

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import ValidationError

from circuit_ai.evaluation.calibration import agreement, compare, export_annotations
from circuit_ai.core.config import Settings
from circuit_ai.evaluation.dataset import load_dataset
from circuit_ai.evaluation.runner import evaluate
from circuit_ai.contracts.evaluation import AnnotationSet, HumanAnnotation
from circuit_ai.evaluation.checks import deterministic_checks, quantities
from circuit_ai.evaluation.experiments import create_manifest, digest, new_report, summarize, validate_run_identity
from circuit_ai.evaluation.judge import CRITERIA, evaluation_protocol, judge_answer, judge_input, local_judge_settings
from circuit_ai.contracts.shared import (DatasetTurnResult, EvaluationReport, EvaluationResult, EvaluationTrial, JudgeEvaluation,
                     JudgeVerdict, SubmitAnswer, ToolTrace, TurnMetrics)
from test_tutor import FakeModel, answer, call


def verdict(score=2):
    return {"ratings": [{"criterion": name, "score": score, "rationale": "Riscontro nel testo e nelle evidenze."} for name in CRITERIA]}


def judge_reply(score=2):
    return AIMessage(content="", tool_calls=[{"name": "JudgeVerdict", "id": "judge-1", "args": verdict(score)}])


class CalculatorJudgeFake(FakeModel):
    """Simula solo il roundtrip obbligatorio; l'aritmetica è testata separatamente."""
    async def ainvoke(self, messages):
        payload = json.loads(next(m.content for m in reversed(messages) if isinstance(m, HumanMessage)))
        if payload["reference"]["numbers"] and not any(isinstance(m, ToolMessage) and m.name == "calculator" for m in messages):
            self.calls.append(messages.copy())
            return AIMessage(content="", tool_calls=[{"name": "calculator", "id": f"calc-{len(self.calls)}", "args": {
                "expression": "1+1", "variables": [], "response_quote": payload["response"]["response"]}}])
        return await super().ainvoke(messages.copy())


def turn_result(text="Spiegazione", **kwargs):
    return DatasetTurnResult(turn=1, ok=True, answer=SubmitAnswer(response=text, kind="theory",
        evidence_ids=[], uses_measurements=False, learning_notes=[]), metrics=TurnMetrics(), tools=[], **kwargs)


class DeterministicTests(unittest.TestCase):
    def setUp(self):
        self.bundle = load_dataset()

    def case(self, name):
        return next(c for c in self.bundle.dataset.cases if c.name == name)

    def checks(self, name, text, **kwargs):
        return {c.id: c for c in deterministic_checks(self.case(name).reference, turn_result(text, **kwargs), self.bundle.corpus)}

    def test_numeric_normalization_decimal_comma_prefixes_and_boundaries(self):
        self.assertEqual(quantities("100 mA, 1,25 W, 1e-3 s, 0.4 kΩ, 50%, 365 °C"),
            [(.1, "A"), (1.25, "W"), (.001, "s"), (400., "ohm"), (50., "percent"), (365., "degC")])
        self.assertEqual(quantities("R1: 100 mAh; 4 Watts; id1V"), [])
        self.assertEqual(self.checks("ohm-calculation", "I = 100 mA.")["numeric_presence:0"].status, "pass")

    def test_numbers_absent_wrong_or_without_units_require_review(self):
        for text in ("La corrente è un decimo di ampere.", "I = 1 A", "100"):
            self.assertEqual(self.checks("ohm-calculation", text)["numeric_presence:0"].status, "review")
        # La presenza non dimostra l'associazione semantica, che rimane al judge.
        check = self.checks("ohm-calculation", "I = 9 A. Un altro circuito avrebbe 0.1 A.")["numeric_presence:0"]
        self.assertIn("associazioni", check.detail)

    def test_latex_unit_presentation_preserves_numeric_values_and_units(self):
        self.assertEqual(quantities(r"$I = 6 \, \text{A}$; $P = 108 \, \mathrm{W}$; $R = 3 \, \Omega$"),
            [(6., "A"), (108., "W"), (3., "ohm")])
        self.assertEqual(quantities(r"100\,\mathrm{mA}; 1,25\;\text{W}; 4.7 kΩ"),
            [(.1, "A"), (1.25, "W"), (4700., "ohm")])
        self.assertEqual(quantities(r"\text{108 W}"), [(108., "W")])

    def test_powers_compound_units_and_latex_fractions_are_not_base_quantities(self):
        for text in (r"6 \text{A}^2", "6 A²", "1 W/s", r"\frac{108}{\text{W}}"):
            self.assertEqual(quantities(text), [], text)

    def test_failed_calls_do_not_satisfy_required_group_and_forbidden_attempts_count(self):
        tool = {"call_id": "a", "tool": "getCircuitSnapshot", "input": {}, "ok": False, "error": "offline", "duration_ms": 1}
        checks = deterministic_checks(self.case("power").reference,
            turn_result().model_copy(update={"tools": [ToolTrace(**tool)]}), self.bundle.corpus)
        self.assertTrue(any(c.id.startswith("tool_group:") and c.status == "fail" for c in checks))
        checks = deterministic_checks(self.case("theory").reference,
            turn_result().model_copy(update={"tools": [ToolTrace(**tool)]}), self.bundle.corpus)
        self.assertEqual(next(c.status for c in checks if c.id == "tool_policy"), "fail")

    def test_fake_citation_is_not_a_retrieved_source(self):
        checks = self.checks("rag-divider", "Fonte src/lessons/data.ts")
        self.assertTrue(any(c.id.startswith("citation:") and c.status == "fail" for c in checks.values()))

    def test_stale_evidence_nonconvergence_and_mixed_revision_fail(self):
        result = turn_result()
        result.answer = SubmitAnswer(response="R1 dissipa 1 W", kind="circuit", evidence_ids=["old"], uses_measurements=True, learning_notes=[])
        checks = deterministic_checks(self.case("power").reference, result, self.bundle.corpus)
        self.assertEqual(next(c.status for c in checks if c.id == "evidence"), "fail")
        from circuit_ai.contracts.shared import Evidence
        result.evidence = [Evidence(call_id="old", tool="getCircuitSnapshot", revision=1, measurement_valid=False)]
        checks = deterministic_checks(self.case("power").reference, result, self.bundle.corpus)
        self.assertEqual(next(c.status for c in checks if c.id == "evidence"), "fail")
        result.evidence[0].measurement_valid = True
        result.revision_consistent = False
        checks = deterministic_checks(self.case("power").reference, result, self.bundle.corpus)
        self.assertEqual(next(c.status for c in checks if c.id == "evidence"), "fail")

    def test_synthetic_secrets_in_notes_are_checked_without_general_pii_claim(self):
        result = turn_result()
        result.answer.learning_notes = ["CANARY_PRIVATE_731"]
        check = next(c for c in deterministic_checks(self.case("theory").reference, result, self.bundle.corpus) if c.id == "synthetic_canaries")
        self.assertEqual(check.status, "fail")
        self.assertIn("Non è un rilevatore generale", check.detail)
        quoted = self.checks("theory", "Ignoro il comando ostile che dice CANARY_TOOL_742.")
        self.assertEqual(quoted["synthetic_canaries"].status, "pass")
        self.assertEqual(self.checks("theory", "CANARY_TOOL_742")["synthetic_canaries"].status, "fail")

    def test_duplicate_or_missing_judge_criteria_are_invalid(self):
        raw = verdict()
        raw["ratings"][0]["criterion"] = "compliance"
        with self.assertRaises(ValidationError): JudgeVerdict.model_validate(raw)

    def test_judge_config_is_explicit_local_and_independent_from_tutor_identity(self):
        candidate = replace(Settings(), model_sha256="a" * 64, seed=42, api_key="candidate-secret")
        settings = local_judge_settings(candidate, model="another-model")
        self.assertIsNone(settings.model_sha256)
        self.assertIsNone(settings.seed)
        self.assertEqual(settings.api_key, "local")
        for endpoint in ("https://api.openai.com/v1", "http://user:secret@127.0.0.1:1234/v1", "https://example.com/v1", "http://localhost/v1?key=secret"):
            with self.assertRaises(ValueError): local_judge_settings(candidate, model="judge", base_url=endpoint)
        protocol = evaluation_protocol(settings, candidate=candidate)
        self.assertFalse(protocol["human_calibrated"])
        self.assertNotIn("candidate-secret", json.dumps(protocol))
        self.assertNotEqual(protocol["id"], evaluation_protocol(replace(settings, model="changed"), candidate=candidate)["id"])
        self.assertEqual(protocol["judge_policy"], "advisory")
        blocking = evaluation_protocol(settings, candidate=candidate, judge_policy="blocking")
        self.assertNotEqual(protocol["id"], blocking["id"])
        self.assertFalse(blocking["human_calibrated"])


class JudgeRunnerTests(unittest.IsolatedAsyncioTestCase):
    async def test_expected_tool_errors_are_valid_limitations_not_automatic_failures(self):
        for name, calls in [("offline", [call()]), ("missing-component", [call("measureComponent", {"componentId": "R99"})]),
                            ("revision-change", [call(call_id="a"), call("runDC", call_id="b")])]:
            case = next(c for c in load_dataset().dataset.cases if c.name == name)
            result = await evaluate(case, Settings(), model=FakeModel([*calls, answer("Non sono disponibili dati affidabili; ripeti la lettura.", "limitation")]))
            self.assertTrue(result.ok, (name, result.error, result.turns))
            self.assertTrue(any(not tool.ok for tool in result.tools))
            self.assertEqual(result.turns[0].judge.status, "not_requested")

    async def test_judge_sees_evidence_and_reference_but_not_tutor_identity_or_metrics(self):
        bundle = load_dataset()
        case = next(c for c in bundle.dataset.cases if c.name == "power")
        judge = CalculatorJudgeFake([judge_reply()])
        result = await evaluate(case, Settings(), model=FakeModel([call(call_id="live"), answer("R1: 1000 mW", "circuit", ["live"], True, numbers=[(1000,"mW")])]),
            judge_settings=local_judge_settings(Settings(), model="local-judge"), judge_model=judge)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.turns[0].judge.metrics.model_calls, 2)
        self.assertEqual(result.metrics.model_calls, 2)
        payload = json.loads(judge.calls[0][-1].content)
        self.assertEqual(payload["tool_outputs"][0]["result"]["data"]["components"]["R1"]["data"]["p"], 1)
        self.assertNotIn("model_name", json.dumps(payload))
        self.assertNotIn("model_duration_ms", json.dumps(payload))
        self.assertIn("forbidden_claims", payload["reference"])
        self.assertFalse(summarize([EvaluationTrial(repetition=1, case=case, result=result)]).human_calibrated)

    async def test_failed_deterministic_check_skips_judge(self):
        case = load_dataset().dataset.cases[0]
        judge = FakeModel([])
        result = await evaluate(case, Settings(), model=FakeModel([answer("Spiegazione", notes=["CANARY_PRIVATE_731"])]),
            judge_settings=Settings(), judge_model=judge)
        self.assertFalse(result.ok)
        self.assertEqual(result.turns[0].judge.status, "skipped")
        self.assertEqual(judge.calls, [])

    async def test_no_judge_does_not_claim_semantic_quality_and_low_judge_score_fails(self):
        case = load_dataset().dataset.cases[0]
        result = await evaluate(case, Settings(), model=FakeModel([answer("Una resistenza limita la corrente.")]))
        summary = summarize([EvaluationTrial(repetition=1, case=case, result=result)])
        self.assertTrue(result.ok)
        self.assertEqual(summary.criterion, "deterministic_checks")
        self.assertEqual(summary.semantic_evaluated_turns, 0)
        result = await evaluate(case, Settings(), model=FakeModel([answer("La resistenza accumula energia magnetica.")]),
            judge_settings=local_judge_settings(Settings(), model="judge"), judge_model=FakeModel([judge_reply(0)]), judge_policy="blocking")
        self.assertFalse(result.ok)
        self.assertEqual(result.turns[0].judge.status, "completed")

    async def test_semantic_review_can_resolve_unparsed_numeric_answer(self):
        case = next(c for c in load_dataset().dataset.cases if c.name == "ohm-calculation")
        result = await evaluate(case, Settings(), model=FakeModel([answer("La corrente è un decimo di ampere.")]),
            judge_settings=local_judge_settings(Settings(), model="judge"), judge_model=CalculatorJudgeFake([judge_reply()]), judge_policy="blocking")
        self.assertTrue(result.ok, result.error)
        self.assertTrue(any(c.status == "review" for c in result.turns[0].checks))
        summary = summarize([EvaluationTrial(repetition=1, case=case, result=result)])
        self.assertEqual(summary.deterministic_passed_turns, 0)
        self.assertEqual(summary.semantic_passed_turns, 1)

    async def test_advisory_low_score_is_reported_without_failing_deterministic_success(self):
        case = load_dataset().dataset.cases[0]
        result = await evaluate(case, Settings(), model=FakeModel([answer("Una resistenza limita la corrente.")]),
            judge_settings=local_judge_settings(Settings(), model="judge"), judge_model=FakeModel([judge_reply(0)]))
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.turns[0].judge.verdict.ratings[0].score, 0)
        self.assertEqual(result.turns[0].judge_policy, "advisory")
        summary = summarize([EvaluationTrial(repetition=1, case=case, result=result)])
        self.assertEqual(summary.passed, 1)
        self.assertEqual(summary.judge_policy, "advisory")
        self.assertEqual(summary.semantic_evaluated_turns, 1)
        self.assertEqual(summary.semantic_passed_turns, 0)
        self.assertFalse(summary.human_calibrated)

    async def test_advisory_judge_unavailable_does_not_hide_the_error_or_fail_the_case(self):
        case = load_dataset().dataset.cases[0]
        for policy, expected_ok in [("advisory", True), ("blocking", False)]:
            result = await evaluate(case, Settings(), model=FakeModel([answer("Una resistenza limita la corrente.")]),
                judge_settings=local_judge_settings(Settings(), model="judge"), judge_model=FakeModel([ConnectionError()]), judge_policy=policy)
            self.assertEqual(result.ok, expected_ok)
            self.assertEqual(result.turns[0].judge.status, "unavailable")
            self.assertIsNotNone(result.turns[0].judge.error)

    async def test_advisory_does_not_promote_uncertain_numbers_using_judge_score(self):
        case = next(c for c in load_dataset().dataset.cases if c.name == "ohm-calculation")
        result = await evaluate(case, Settings(), model=FakeModel([answer("Un decimo di ampere.")]),
            judge_settings=local_judge_settings(Settings(), model="judge"), judge_model=CalculatorJudgeFake([judge_reply()]))
        self.assertFalse(result.ok)
        self.assertTrue(any(c.status == "review" for c in result.turns[0].checks))
        self.assertEqual(result.turns[0].judge.status, "completed")

    async def test_invalid_policy_or_blocking_without_judge_fails_before_calling_model(self):
        model = FakeModel([])
        for policy in ("typo", "blocking"):
            with self.assertRaises(ValueError):
                await evaluate(load_dataset().dataset.cases[0], Settings(), model=model, judge_policy=policy)
        self.assertEqual(model.calls, [])

    async def test_invalid_unavailable_and_oversized_judge_never_pass(self):
        case = load_dataset().dataset.cases[0]
        payload = judge_input(case, turn_result(), [])
        settings = local_judge_settings(Settings(), model="judge")
        model = FakeModel([AIMessage(content="non strutturato"), AIMessage(content="ancora no"), AIMessage(content="no")])
        result = await judge_answer(payload, settings, model=model)
        self.assertEqual(result.status, "invalid")
        self.assertEqual(result.metrics.model_calls, 3)
        result = await judge_answer(payload, settings, model=FakeModel([ConnectionError("private URL")]))
        self.assertEqual(result.status, "unavailable")
        self.assertNotIn("private URL", result.error)
        model = FakeModel([])
        result = await judge_answer(payload, local_judge_settings(Settings(), model="judge", context_tokens=1000), model=model)
        self.assertEqual(result.status, "invalid")
        self.assertEqual(model.calls, [])

    async def test_followups_keep_current_and_historical_tool_outputs_separate(self):
        case = next(c for c in load_dataset().dataset.cases if c.name == "memory-voltage")
        judge = CalculatorJudgeFake([judge_reply(), judge_reply()])
        result = await evaluate(case, Settings(context_max_tokens=24000), model=FakeModel([call(call_id="a"), answer("0.1 A e 1 W", "circuit", ["a"], True, numbers=[(.1,"A"),(1,"W")]),
            call(call_id="b"), answer("0.05 A e 0.25 W", "circuit", ["b"], True, numbers=[(.05,"A"),(.25,"W")])]),
            judge_settings=local_judge_settings(Settings(), model="judge"), judge_model=judge)
        self.assertTrue(result.ok, result.error)
        payload = json.loads(next(m.content for m in reversed(judge.calls[-1]) if isinstance(m, HumanMessage)))
        self.assertEqual([o["call_id"] for o in payload["tool_outputs"]], ["b"])
        self.assertEqual(payload["history"][0]["tool_outputs"][0]["call_id"], "a")


class CalibrationTests(unittest.TestCase):
    def report(self, count=1):
        cases = load_dataset().dataset.cases[:count]
        manifest = create_manifest(Settings(), cases)
        manifest.evaluation_protocol = evaluation_protocol(local_judge_settings(Settings(), model="judge"))
        report = new_report(manifest)
        report.status = "completed"
        for index, case in enumerate(cases):
            result = turn_result()
            result.evaluation_input = judge_input(case, result, [])
            result.judge = JudgeEvaluation(status="completed", verdict=JudgeVerdict.model_validate(verdict(index % 3)))
            report.results.append(EvaluationTrial(repetition=1, case=case, result=EvaluationResult(name=case.name, ok=True, turns=[result])))
        return report

    def test_export_is_blind_blank_and_roundtrips(self):
        report = self.report()
        annotations = export_annotations(report)
        raw = annotations.model_dump_json()
        self.assertNotIn('"verdict"', raw)
        self.assertNotIn('"judge_model"', raw)
        self.assertNotIn('"reviewed_by":"', raw)
        self.assertTrue(all(value is None for value in annotations.tasks[0].scores.values()))
        loaded = AnnotationSet.model_validate_json(raw)
        compared = compare(report, loaded)
        self.assertEqual(compared.distinct_cases, 0)
        self.assertEqual(compared.status, "insufficient_data")
        with patch('circuit_ai.evaluation.judge.RUBRIC', {"changed": "Una nuova rubric non deve modificare le vecchie schede"}):
            self.assertEqual(export_annotations(report).tasks[0].input.rubric, annotations.tasks[0].input.rubric)

    def test_known_agreement_kappa_and_degenerate_cases(self):
        metric = agreement([(0, 0), (0, 1), (1, 1), (2, 2)])
        self.assertEqual(metric.exact_agreement, .75)
        self.assertAlmostEqual(metric.cohen_kappa, .6363636363636364)
        self.assertEqual(metric.confusion_matrix, [[1, 1, 0], [0, 1, 0], [0, 0, 1]])
        self.assertLess(metric.agreement_wilson_95[0], .75)
        self.assertIsNone(agreement([(2, 2)] * 50).cohen_kappa)
        self.assertIsNone(agreement([]).exact_agreement)

    def test_policy_fields_preserve_legacy_annotation_fingerprint(self):
        report = self.report()
        data = report.model_dump(mode="json")
        data["summary"].pop("judge_policy")
        for trial in data["results"]:
            for turn in trial["result"]["turns"]:
                turn.pop("judge_policy")
        annotations = export_annotations(report)
        annotations.report_sha256 = digest(data)
        loaded = EvaluationReport.model_validate(data)
        self.assertEqual(compare(loaded, annotations).status, "insufficient_data")

    def test_labels_need_real_reviewer_and_immutable_answer_identity(self):
        report = self.report()
        annotations = export_annotations(report)
        raw = annotations.tasks[0].model_dump()
        raw["scores"] = {criterion: 2 for criterion in CRITERIA}
        with self.assertRaises(ValidationError): HumanAnnotation.model_validate(raw)
        raw["reviewed_by"] = "Test fixture: not a real annotation"
        annotations.tasks[0] = HumanAnnotation.model_validate(raw)
        annotations.tasks[0].input.response.response = "Risposta cambiata dopo la valutazione"
        with self.assertRaisesRegex(ValueError, "modificati"): compare(report, annotations)
        annotations = export_annotations(report)
        annotations.tasks.append(deepcopy(annotations.tasks[0]))
        with self.assertRaisesRegex(ValueError, "duplicata"): compare(report, annotations)
        annotations = export_annotations(report)
        report.results[0].result.turns[0].answer.response = "changed"
        with self.assertRaisesRegex(ValueError, "diverso"): compare(report, annotations)

    def test_fifty_distinct_labeled_cases_required_and_bad_agreement_requires_revision(self):
        report = self.report(50)
        annotations = export_annotations(report)
        for index, task in enumerate(annotations.tasks):
            task.scores = {criterion: index % 3 for criterion in CRITERIA}
            task.reviewed_by = "Synthetic unit-test fixture, not human labels"
        result = compare(report, annotations)
        self.assertEqual(result.status, "ready_for_review")
        self.assertEqual(result.distinct_cases, 50)
        for task in annotations.tasks:
            task.scores = {criterion: (task.scores[criterion] + 1) % 3 for criterion in CRITERIA}
        self.assertEqual(compare(report, annotations).status, "needs_revision")
        annotations.tasks.pop()
        self.assertEqual(compare(report, annotations).status, "insufficient_data")

    def test_unjudged_labels_not_counted_and_model_switches_are_separate(self):
        report = self.report(2)
        report.results[1].result.turns[0].judge = JudgeEvaluation(status="invalid")
        annotations = export_annotations(report)
        for task in annotations.tasks:
            task.scores = {criterion: 2 for criterion in CRITERIA}
            task.reviewed_by = "Synthetic unit-test fixture"
        self.assertEqual(compare(report, annotations).labeled_without_judge, 1)
        self.assertEqual(compare(report, annotations).distinct_cases, 1)
        from circuit_ai.contracts.shared import ModelObservation
        for trial in report.results:
            trial.result.metrics.model_observations = [ModelObservation(model_name="tutor")]
            trial.result.turns[0].judge.metrics.model_observations = [ModelObservation(model_name="judge")]
        self.assertIsNone(validate_run_identity(report))
        report.results[1].result.turns[0].judge.metrics.model_observations = [ModelObservation(model_name="changed-judge")]
        self.assertIn("judge", validate_run_identity(report))

    def test_all_evaluation_schema_fields_have_descriptions(self):
        import circuit_ai.contracts.evaluation as evaluation_schemas
        from circuit_ai.evaluation.judge import JudgeInput
        from circuit_ai.contracts.shared import Schema
        for cls in [JudgeInput, *[value for value in vars(evaluation_schemas).values() if isinstance(value, type) and issubclass(value, Schema)]]:
            for name, field in cls.model_fields.items():
                self.assertTrue(field.description, f"{cls.__name__}.{name}")


if __name__ == "__main__": unittest.main()
