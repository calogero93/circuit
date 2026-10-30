"""Il runner preserva fatti, aspettative proposte e risultati originali."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from circuit_ai.evaluation.experiments import digest
from circuit_ai.nli.runner import build_jobs, load_controls, run
from test_nli_context import Classifier


class NliRunnerTests(unittest.TestCase):
    def test_controls_are_sourced_but_not_invented_human_calibration(self):
        suite, dataset, identity = load_controls()
        self.assertEqual(len(suite.cases), 19)
        self.assertEqual(suite.review_status, 'proposed')
        self.assertEqual(suite.dataset_bundle_sha256, identity['bundle_sha256'])
        jobs, skipped, _ = build_jobs(suite, dataset, identity, [])
        self.assertEqual(skipped, [])
        self.assertTrue(all(j['references'][0].source_ids for j in jobs))
        altered = suite.model_copy(deep=True)
        altered.cases[0].reference_statements = ['Fatto inventato assente dal libro.']
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'controls.json'
            p.write_text(altered.model_dump_json())
            with self.assertRaisesRegex(ValueError, 'fatti assenti'):
                load_controls(p)

    def test_missing_answers_are_not_counted_as_quality_scores(self):
        suite, dataset, identity = load_controls()
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'report.json'
            p.write_text(json.dumps({'status': 'completed', 'mode': 'tutor', 'dataset': identity,
                'results': [{'id': 'worked-power-18', 'answer': None}]}))
            jobs, skipped, _ = build_jobs(suite, dataset, identity, [p])
            self.assertEqual(len(jobs), len(suite.cases))
            self.assertEqual(len(skipped), 1)
            raw = json.loads(p.read_text());raw['status'] = 'interrupted'
            p.write_text(json.dumps(raw))
            with self.assertRaisesRegex(ValueError, 'completati'):
                build_jobs(suite, dataset, identity, [p])

    def test_changed_facts_are_rejected_even_if_the_input_hash_was_updated(self):
        suite, dataset, identity = load_controls()
        jobs, _, _ = build_jobs(suite, dataset, identity, [])
        payload = jobs[0]['payload'].model_copy(deep=True)
        payload.reference.concepts = ['Un fatto diverso.']
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'report.json'
            p.write_text(json.dumps({'status': 'completed', 'mode': 'references', 'dataset': identity,
                'results': [{'id': jobs[0]['case_id'], 'input': payload.model_dump(mode='json'),
                    'input_sha256': digest(payload), 'answer': payload.response.model_dump(mode='json')}]}))
            with self.assertRaisesRegex(ValueError, 'fatti del report'):
                build_jobs(suite, dataset, identity, [p])

    def test_report_preserves_expectations_and_never_approves_a_baseline(self):
        class Model(Classifier):
            identity = {'backend': 'stub'}
            confidence = .8
            margin = .15
            def assert_unchanged(self):pass
        suite, dataset, identity = load_controls()
        suite.cases = [suite.cases[0]]
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'report.json'
            with patch('circuit_ai.nli.runner.load_controls', return_value=(suite, dataset, identity)):
                result = run(Model(), output=p)
            self.assertEqual(result['status'], 'completed')
            self.assertFalse(result['human_calibrated'])
            self.assertFalse(result['baseline_approved'])
            self.assertEqual(result['manifest']['llm_calls'], 0)
            self.assertEqual(result['results'][0]['input_sha256'], digest(result['results'][0]['input']))
            with self.assertRaisesRegex(ValueError, 'sovrascrivere'):
                run(Model(), output=p)

    def test_changed_numeric_references_are_rejected(self):
        from circuit_ai.nli.runner import _baseline_payload
        from circuit_ai.contracts.shared import SubmitAnswer
        suite, dataset, identity = load_controls()
        case = next(c for c in dataset.cases if c.numbers)
        payload = _baseline_payload(case, SubmitAnswer(response='Risposta', kind='theory',
            evidence_ids=[], uses_measurements=False, learning_notes=[]), dataset)
        payload.reference.numbers[0].relative_tolerance = .049
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'report.json'
            p.write_text(json.dumps({'status': 'completed', 'mode': 'references', 'dataset': identity,
                'results': [{'id': case.id, 'input': payload.model_dump(mode='json'),
                    'input_sha256': digest(payload), 'answer': payload.response.model_dump(mode='json')}]}))
            with self.assertRaisesRegex(ValueError, 'riferimenti numerici'):
                build_jobs(suite, dataset, identity, [p])

    def test_new_schema_fields_are_described(self):
        from pydantic import BaseModel
        import circuit_ai.contracts.verification as verification_schemas
        for cls in vars(verification_schemas).values():
            if isinstance(cls, type) and issubclass(cls, BaseModel) and cls.__module__ == 'circuit_ai.contracts.verification':
                for name, field in cls.model_fields.items():
                    self.assertTrue(field.description, f'{cls.__name__}.{name}')
