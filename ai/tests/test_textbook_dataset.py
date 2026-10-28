from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from config import Settings
from dataset import TEXTBOOK_DIR, load_dataset, select_cases, validate_cases
from evaluate import evaluate
from evaluation_sources import verify_publications
from experiments import ROOT, create_manifest, new_report, validate_run_identity
from judge import local_judge_settings
from schemas import JudgeInput
from test_evaluators import CalculatorJudgeFake, judge_reply
from test_tutor import FakeModel, answer, call


class TextbookDatasetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = load_dataset(TEXTBOOK_DIR)

    def case(self, name):
        return next(c for c in self.bundle.dataset.cases if c.name == name)

    def test_published_references_have_traceable_authorship_without_invented_human_review(self):
        bundle = self.bundle
        self.assertEqual(len(bundle.dataset.cases), 11)
        self.assertEqual(len(bundle.corpus), 8)
        self.assertEqual(len(select_cases(bundle, split="all", mode="closed_book")), 9)
        self.assertEqual(len(select_cases(bundle, split="all", mode="live_tools")), 2)
        self.assertTrue(all(not c.retrieved_source_ids and not c.reference.citation_source_ids
            for c in bundle.dataset.cases))
        self.assertTrue(all(c.provenance.source_ids and c.provenance.reviewed_by is None and
            c.provenance.review_status == "proposed" for c in bundle.dataset.cases))
        for source in bundle.corpus.values():
            self.assertEqual(source.publication.author, "Tony R. Kuphaldt")
            self.assertTrue(source.publication.pdf_pages)
            self.assertTrue(source.publication.license_url)
            self.assertIn(source.path, bundle.identity()["files_sha256"])

    def test_reference_numbers_match_published_solutions(self):
        # Valori delle tabelle pubblicate, non ottenuti dalle fixture o dal solver.
        expected = {
            "book-dc-power-closed": [6, 108],
            "book-dc-series-closed": [18000, .0005, 1.5, 5, 2.5],
            "book-dc-parallel-closed": [.0009, .0045, .009, .0144, 625],
            "book-dc-divider-closed": [10, 20, 15],
            "book-ac-rms-closed": [5, 50],
            "book-ac-series-closed": [1000, .01, 1, 5, 4],
            "book-dc-power-doubled": [6, 108, 12, 432],
        }
        for name, values in expected.items():
            self.assertEqual([n.value for n in self.case(name).reference.numbers], values)
        broken = deepcopy(self.case("book-dc-series-closed"))
        broken.reference.numbers[2].inputs["Rtarget"] = 5000
        with self.assertRaisesRegex(ValueError, "numerica incoerente"):
            validate_cases([broken], self.bundle.fixtures, self.bundle.corpus)

    def test_solution_leakage_and_cross_split_variants_are_rejected(self):
        one = deepcopy(self.case("book-dc-power-closed"))
        one.retrieved_source_ids = ["dc-power"]
        with self.assertRaisesRegex(ValueError, "closed_book"):
            validate_cases([one], self.bundle.fixtures, self.bundle.corpus)
        one = deepcopy(self.case("book-dc-power-closed"))
        two = deepcopy(self.case("book-dc-power-doubled"))
        two.group_id, two.split = "different-name-same-original", "validation"
        with self.assertRaisesRegex(ValueError, "pagina pubblicata in split diversi"):
            validate_cases([one, two], self.bundle.fixtures, self.bundle.corpus)
        two = deepcopy(self.case("book-dc-parallel-closed"))
        sourced = deepcopy(self.case("book-dc-power-closed"))
        sourced.provenance.source_ids.append("dc-parallel")
        with self.assertRaisesRegex(ValueError, "pagina pubblicata in split diversi"):
            validate_cases([sourced, two], self.bundle.fixtures, self.bundle.corpus)

    def test_live_mode_requires_browser_evidence(self):
        case = deepcopy(self.case("book-dc-power-live"))
        case.reference.required_tool_groups = []
        with self.assertRaisesRegex(ValueError, "live_tools"):
            validate_cases([case], self.bundle.fixtures, self.bundle.corpus)
        case = deepcopy(self.case("book-dc-power-live"))
        case.reference.required_tool_groups = [["search_info", "getCircuitSnapshot"]]
        case.reference.forbidden_tools = []
        with self.assertRaisesRegex(ValueError, "live_tools"):
            validate_cases([case], self.bundle.fixtures, self.bundle.corpus)

    def test_bundle_can_be_loaded_without_original_pdfs_and_excerpt_edits_invalidate_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dest = root / "ai/evals/textbook"
            dest.parent.mkdir(parents=True)
            shutil.copytree(TEXTBOOK_DIR, dest)
            self.assertFalse((root / "docs").exists())
            bundle = load_dataset(dest, root=root)
            self.assertEqual(len(bundle.dataset.cases), 11)
            manifest = create_manifest(Settings(), self.bundle.dataset.cases[:1], dataset_identity=self.bundle.identity())
            report = new_report(manifest)
            report.manifest.configuration.source_sha256 = {}
            self.assertIsNone(validate_run_identity(report, root))
            (dest / "excerpts/dc-power.txt").write_text("Fonte alterata")
            self.assertIn("Dataset", validate_run_identity(report, root))
            with self.assertRaisesRegex(ValueError, "Estratto non più presente"):
                load_dataset(dest, root=root)

    def test_pdf_audit_rejects_changed_edition_wrong_pages_and_missing_poppler(self):
        source = deepcopy(self.bundle.corpus["dc-power"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / source.publication.pdf_path
            pdf.parent.mkdir(parents=True)
            pdf.write_bytes(b"A controlled document")
            with patch("evaluation_sources.shutil.which", return_value="pdftotext"), \
                    patch("evaluation_sources.subprocess.run") as extract:
                with self.assertRaisesRegex(ValueError, "PDF modificato"):
                    verify_publications({source.id: source}, root)
                extract.assert_not_called()
                source.publication.pdf_sha256 = hashlib.sha256(pdf.read_bytes()).hexdigest()
                extract.return_value = subprocess.CompletedProcess([], 0, stdout="A different exercise")
                with self.assertRaisesRegex(ValueError, "Estratto assente"):
                    verify_publications({source.id: source}, root)
            with patch("evaluation_sources.shutil.which", return_value=None):
                with self.assertRaisesRegex(ValueError, "Poppler"):
                    verify_publications({source.id: source}, root)

    def test_absent_new_metadata_preserves_legacy_serialization(self):
        legacy = load_dataset()
        self.assertNotIn("evaluation_mode", legacy.dataset.cases[0].model_dump(mode="json"))
        self.assertNotIn("publication", next(iter(legacy.corpus.values())).model_dump(mode="json"))


class TextbookRunnerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bundle = load_dataset(TEXTBOOK_DIR)

    def case(self, name):
        return next(c for c in self.bundle.dataset.cases if c.name == name)

    async def test_closed_book_hides_solution_from_tutor_but_preserves_it_for_judge(self):
        model = FakeModel([answer("Si applica Ohm, poi P = V·I, nel modello a resistenza costante.")])
        judge = CalculatorJudgeFake([judge_reply()])
        result = await evaluate(self.case("book-dc-power-closed"), Settings(), bundle=self.bundle, model=model,
            judge_settings=local_judge_settings(Settings(), model="judge"), judge_model=judge)
        self.assertIsNone(result.error)
        # Il protocollo storico vieta tutti i tool: senza calcoli non certifica
        # più una risposta numerica. Rimane valido come test di isolamento.
        self.assertFalse(result.ok)
        source = self.bundle.corpus["dc-power"]
        self.assertNotIn(source.excerpt, str(model.calls))
        self.assertNotIn("Tony R. Kuphaldt", str(model.calls))
        self.assertEqual(result.tools, [])
        payload = json.loads(judge.calls[0][-1].content)
        self.assertEqual(payload["reference_sources"][0]["excerpt"], source.excerpt)
        self.assertEqual(payload["reference_sources"][0]["publication"]["pdf_pages"], [54, 55])
        self.assertEqual(JudgeInput.model_validate(payload).reference_sources[0], source)

    async def test_closed_book_rejects_browser_use_even_with_correct_numbers(self):
        model = FakeModel([call(), answer("6 A, 108 W", "circuit", ["call-1"], True, numbers=[(6,"A"),(108,"W")])])
        result = await evaluate(self.case("book-dc-power-closed"), Settings(), bundle=self.bundle, model=model)
        self.assertFalse(result.ok)
        self.assertTrue(any(c.id == "tool_policy" and c.status == "fail" for c in result.turns[0].checks))

    async def test_book_baseline_does_not_enable_retrieval(self):
        model = FakeModel([answer("Si applicano la legge di Ohm e la potenza resistiva.")])
        result = await evaluate(self.case("book-dc-power-closed"), Settings(), bundle=self.bundle, model=model)
        self.assertIsNone(result.error)
        self.assertFalse(result.ok)  # Nessun risultato: non promuovere il vecchio caso numerico.
        offered = [tool['function']['name'] if isinstance(tool, dict) else tool.name if hasattr(tool, "name") else tool.__name__ for tool in model.bindings[0][0]]
        self.assertNotIn("search_info", offered)

    async def test_live_adaptations_require_current_valid_measurements(self):
        for name, response in [("book-dc-power-live", "R1: corrente 6 A e potenza 108 W, modello ideale."),
                ("book-dc-divider-live", "R2 della fixture: 15 V e 2 mA; corrisponde a R3 nel libro.")]:
            numbers = [(6,"A"),(108,"W")] if name == "book-dc-power-live" else [(15,"V"),(2,"mA")]
            model = FakeModel([call(), answer(response, "circuit", ["call-1"], True, numbers=numbers)])
            result = await evaluate(self.case(name), Settings(), bundle=self.bundle, model=model)
            self.assertTrue(result.ok, result.error)
            self.assertTrue(result.turns[0].evidence[0].measurement_valid)
            self.assertEqual(result.turns[0].evaluation_input.reference_sources[0].id,
                self.case(name).provenance.source_ids[0])


if __name__ == "__main__":
    unittest.main()
