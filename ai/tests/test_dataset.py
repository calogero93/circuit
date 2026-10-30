from copy import deepcopy
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest

from pydantic import ValidationError

from circuit_ai.core.config import Settings
from circuit_ai.evaluation.dataset import DATA_DIR, load_dataset, select_cases, validate_cases
from circuit_ai.evaluation.runner import evaluate
from circuit_ai.evaluation.fixtures import FixtureRuntime, build_fixture, transient
from circuit_ai.evaluation.experiments import create_manifest, new_report, validate_run_identity
from circuit_ai.contracts.shared import (DatasetCase, DCOutput, EvaluationDataset, FixtureScenario, SnapshotOutput, TransientOutput)
from test_tutor import FakeModel, answer, call, last_tool


class DatasetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.bundle = load_dataset()

    def test_coverage_provenance_and_split_are_explicit(self):
        bundle = self.bundle
        self.assertEqual(len(bundle.dataset.cases), 51)
        self.assertEqual({c.split for c in bundle.dataset.cases}, {"development", "validation"})
        self.assertGreaterEqual(len({c.category for c in bundle.dataset.cases}), 10)
        self.assertTrue(all(c.provenance.review_status == "proposed" for c in bundle.dataset.cases))
        self.assertTrue(all(c.provenance.reviewed_by is None for c in bundle.dataset.cases))
        self.assertTrue(any(c.followups for c in bundle.dataset.cases))
        self.assertTrue(any(c.retrieved_source_ids for c in bundle.dataset.cases))
        self.assertTrue(all(c.provenance.origin == "curated" for c in bundle.dataset.cases))

    def test_all_fixture_outputs_follow_production_contracts(self):
        for scenario in self.bundle.fixtures.values():
            snapshot = SnapshotOutput.model_validate(build_fixture(scenario))
            dc = DCOutput.model_validate(build_fixture(scenario, dc=True))
            output = TransientOutput.model_validate(transient(scenario))
            self.assertEqual(snapshot.revision, dc.revision)
            self.assertEqual(len(output.time_s), len(next(iter(output.nodeVoltages.values()))))
        dc = self.bundle.fixtures["dc"]
        self.assertEqual(build_fixture(dc)["components"]["R1"]["data"]["p"], 1)
        self.assertLess(build_fixture(dc)["components"]["R1"]["data"]["temperature"], 30)
        self.assertEqual(build_fixture(dc, dc=True)["components"]["R1"]["data"]["temperature"], 365)

    def test_wrong_numeric_labels_are_rejected(self):
        case = deepcopy(next(c for c in self.bundle.dataset.cases if c.name == "power"))
        case.reference.numbers[0].value = 999
        with self.assertRaisesRegex(ValueError, "numerica incoerente"):
            validate_cases([case], self.bundle.fixtures, self.bundle.corpus)

    def test_fixture_and_label_mismatch_is_rejected(self):
        case = deepcopy(next(c for c in self.bundle.dataset.cases if c.name == "power"))
        case.reference.numbers[0].inputs = {"V": 20, "R": 100}
        case.reference.numbers[0].value = 4
        with self.assertRaisesRegex(ValueError, "discordano"):
            validate_cases([case], self.bundle.fixtures, self.bundle.corpus)

    def test_no_duplicate_ids_questions_or_groups_across_splits(self):
        one = deepcopy(self.bundle.dataset.cases[0])
        two = deepcopy(one)
        with self.assertRaisesRegex(ValueError, "ID duplicato"):
            validate_cases([one, two], self.bundle.fixtures, self.bundle.corpus)
        two.name = "variant"
        with self.assertRaisesRegex(ValueError, "Domanda duplicata"):
            validate_cases([one, two], self.bundle.fixtures, self.bundle.corpus)
        two.question = "Una domanda diversa sullo stesso argomento?"
        two.split = "validation"
        with self.assertRaisesRegex(ValueError, "split diversi"):
            validate_cases([one, two], self.bundle.fixtures, self.bundle.corpus)

    def test_unknown_fixtures_sources_tools_and_fabricated_review_are_rejected(self):
        original = self.bundle.dataset.cases[0]
        for field, value in [("fixture_id", "unknown")]:
            case = original.model_copy(deep=True, update={field: value})
            with self.assertRaises(ValueError): validate_cases([case], self.bundle.fixtures, self.bundle.corpus)
        case = deepcopy(original)
        case.provenance.source_ids = ["unknown"]
        with self.assertRaises(ValueError): validate_cases([case], self.bundle.fixtures, self.bundle.corpus)
        case = deepcopy(original)
        case.reference.forbidden_tools = ["deleteCircuit"]
        with self.assertRaises(ValueError): validate_cases([case], self.bundle.fixtures, self.bundle.corpus)
        raw = original.model_dump()
        raw["provenance"]["review_status"] = "accepted"
        with self.assertRaises(ValidationError): DatasetCase.model_validate(raw)
        raw["provenance"]["review_status"] = "proposed"
        raw["provenance"]["origin"] = "production"
        with self.assertRaises(ValidationError): DatasetCase.model_validate(raw)

    def test_selection_defaults_to_development_and_rag_is_opt_in(self):
        selected = select_cases(self.bundle)
        self.assertTrue(all(c.split == "development" and not c.retrieved_source_ids for c in selected))
        self.assertEqual(len(select_cases(self.bundle, split="all", include_rag=True)), 51)
        with self.assertRaises(ValueError): select_cases(self.bundle, case_name="missing")

    def test_dataset_identity_is_separate_and_edits_invalidate_a_run(self):
        manifest = create_manifest(Settings(), self.bundle.dataset.cases[:1], dataset_identity=self.bundle.identity())
        report = new_report(manifest)
        self.assertIsNone(validate_run_identity(report))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ai/evals").mkdir(parents=True)
            for name in ("dataset.v1.json", "fixtures.v1.json", "corpus.v1.json"):
                (root / "ai/evals" / name).write_bytes((DATA_DIR / name).read_bytes())
            report.manifest.configuration.source_sha256 = {}
            self.assertIsNone(validate_run_identity(report, root))
            (root / "ai/evals/fixtures.v1.json").write_text('{}')
            self.assertIn("Dataset", validate_run_identity(report, root))


class RunnerDatasetTests(unittest.IsolatedAsyncioTestCase):
    async def test_references_are_not_leaked_to_agent_input(self):
        bundle = load_dataset()
        case = deepcopy(bundle.dataset.cases[0])
        case.reference.concepts = ["PRIVATE_REFERENCE_MARKER_452"]
        model = FakeModel([answer("Una resistenza limita la corrente.")])
        result = await evaluate(case, Settings(), model=model)
        self.assertTrue(result.ok)
        self.assertNotIn("PRIVATE_REFERENCE_MARKER_452", str(model.calls))

    async def test_followup_changes_fixture_and_requires_fresh_evidence(self):
        case = next(c for c in load_dataset().dataset.cases if c.name == "memory-voltage")
        model = FakeModel([call(call_id="a"), answer("0.1 A e 1 W", "circuit", ["a"], True, numbers=[(.1,"A"),(1,"W")]),
                           call(call_id="b"), answer("0.05 A e 0.25 W", "circuit", ["b"], True, numbers=[(.05,"A"),(.25,"W")])])
        # Qui si verifica la freschezza delle evidenze, non la compattazione
        # dovuta al catalogo tool più grande (coperta nei test del grafo).
        result = await evaluate(case, Settings(context_max_tokens=24000), model=model)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(len(result.turns), 2)
        self.assertEqual(result.metrics.model_calls, 4)
        first = json.loads(last_tool(model.calls[1]).content)["data"]["components"]["R1"]["data"]["p"]
        second = json.loads(last_tool(model.calls[3]).content)["data"]["components"]["R1"]["data"]["p"]
        self.assertEqual((first, second), (1., .25))

    async def test_controlled_rag_does_not_open_real_vectorstore(self):
        case = next(c for c in load_dataset().dataset.cases if c.name == "rag-divider")
        model = FakeModel([call("search_info", {"query": "formula partitore"}), answer("Vout segue R2/(R1+R2), fonte src/lessons/data.ts")])
        result = await evaluate(case, replace(Settings(), rag_enabled=True), model=model)
        self.assertTrue(result.ok, result.error)
        self.assertIn("src/lessons/data.ts", last_tool(model.calls[1]).content)
        self.assertIn("R2/(R1+R2)", last_tool(model.calls[1]).content)

    async def test_fixture_id_and_net_arguments_are_not_silently_ignored(self):
        bundle = load_dataset()
        runtime = FixtureRuntime(bundle.fixtures)
        runtime.activate("dc")
        self.assertIn("error", runtime.call("measureComponent", {"componentId": "R99"}))
        self.assertIn("error", runtime.call("measureNode", {"nodeId": "missing"}))


class SyntheticDatasetTests(unittest.IsolatedAsyncioTestCase):
    def proposal(self):
        bundle = load_dataset()
        case = next(c for c in bundle.dataset.cases if c.name == "rag-divider")
        return {"question": "Quale rapporto di resistenze determina la quota di Vin su R2 secondo la fonte?",
            "fixture_id": "divider", "reference": case.reference.model_dump(mode="json"),
            "category": "rag", "source_ids": ["divider-formula"], "rationale": "Verifica comprensione della formula senza confronto testuale."}

    async def test_preparation_never_calls_model_or_claims_generated_cases(self):
        from circuit_ai.evaluation.generate import generate
        model = FakeModel([])
        artifact = await generate(load_dataset(), Settings(), count=1, model=model, prepare_only=True)
        self.assertEqual(artifact.status, "prepared")
        self.assertEqual(artifact.cases, [])
        self.assertEqual(model.calls, [])

    async def test_generator_keeps_real_provenance_and_never_auto_accepts_or_edits_dataset(self):
        from circuit_ai.evaluation.generate import generate
        from langchain_core.messages import AIMessage
        before = (DATA_DIR / "dataset.v1.json").read_bytes()
        model = FakeModel([AIMessage(content="", tool_calls=[{"name": "SyntheticCaseBatch", "id": "generated",
            "args": {"proposals": [self.proposal()]}}])])
        artifact = await generate(load_dataset(), Settings(), count=1, model=model)
        self.assertEqual(artifact.status, "generated", artifact.error)
        self.assertEqual(artifact.cases[0].provenance.origin, "synthetic")
        self.assertEqual(artifact.cases[0].provenance.generator_experiment_id, artifact.generation_id)
        self.assertEqual(artifact.cases[0].provenance.review_status, "proposed")
        self.assertIsNone(artifact.cases[0].provenance.reviewed_by)
        self.assertEqual((DATA_DIR / "dataset.v1.json").read_bytes(), before)
        self.assertNotIn('"reference":', model.calls[0][-1].content)

    async def test_invalid_synthetic_references_do_not_enter_dataset(self):
        from circuit_ai.evaluation.generate import generate
        from langchain_core.messages import AIMessage
        proposal = self.proposal()
        proposal["fixture_id"] = "invented-circuit"
        model = FakeModel([AIMessage(content="", tool_calls=[{"name": "SyntheticCaseBatch", "id": "generated",
            "args": {"proposals": [proposal]}}])])
        artifact = await generate(load_dataset(), Settings(), count=1, model=model)
        self.assertEqual(artifact.status, "invalid")
        self.assertEqual(artifact.cases, [])
        self.assertEqual(len(load_dataset().dataset.cases), 51)


class SummaryDatasetTests(unittest.IsolatedAsyncioTestCase):
    async def test_summary_case_preserves_conversation_but_updates_live_evidence(self):
        from langchain_core.messages import AIMessage
        case = next(c for c in load_dataset().dataset.cases if c.name == "memory-summary")
        model = FakeModel([call(call_id="a"), answer("La potenza è 1 W, con profilo didattico.", "circuit", ["a"], True, numbers=[(1,"W")]),
            AIMessage(content="", tool_calls=[{"name": "ConversationSummary", "id": "summary", "args": {
                "summary": "Si è discusso di 1 W su R1: valore storico, non misura corrente.", "learning_notes": []}}]),
            call(call_id="b"), answer("Ora dissipa 0.25 W.", "circuit", ["b"], True, numbers=[(.25,"W")])])
        result = await evaluate(case, Settings(), model=model)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(len(result.turns), 2)
        self.assertEqual(result.turns[1].metrics.summaries, 1)
        self.assertIn('"p":0.25', last_tool(model.calls[-1]).content)


if __name__ == "__main__": unittest.main()
