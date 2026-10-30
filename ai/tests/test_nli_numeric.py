"""Le prove scalari usano etichette, unità e tolleranze indipendenti."""
import unittest

from circuit_ai.contracts.baseline import ExpectedNumber
from circuit_ai.nli.context import contextual_checks, normalize
from circuit_ai.nli.numeric import compare, declaration, valid_proof
from circuit_ai.nli.classifier import semantic_status
from test_nli_context import Classifier, reference


class NumericProofTests(unittest.TestCase):
    def setUp(self):
        self.ref = ExpectedNumber(label='Corrente R1', value=.02272727273, unit='A',
                                  absolute_tolerance=1e-8, relative_tolerance=.001)
        self.fact = 'Corrente R1 = 0.02272727273 A.'

    def checks(self, text):
        return contextual_checks(text, Classifier(), [reference(self.fact)], [self.ref])

    def test_rounding_and_prefix_are_verified_without_neural_scores(self):
        checks = self.checks('Per il modello dichiarato: Corrente R1 = 22.7273 mA.')
        self.assertEqual(len(checks), 2)
        self.assertTrue(all(valid_proof(c) and c.status == 'pass' for c in checks))
        self.assertTrue(all(c.scores is None for c in checks))
        self.assertAlmostEqual(checks[0].preparation.numeric_proof.actual_value, .0227273)
        self.assertEqual(semantic_status(checks, 'faithfulness'), 'pass')
        self.assertEqual(semantic_status(checks, 'completeness'), 'pass')

    def test_wrong_prefix_fails_both_directions_without_changing_text(self):
        text = 'Corrente R1 = 22.7273 A.'
        checks = self.checks(text)
        self.assertEqual(semantic_status(checks, 'faithfulness'), 'fail')
        self.assertEqual(semantic_status(checks, 'completeness'), 'fail')
        self.assertEqual(checks[0].preparation.raw_hypothesis, text)

    def test_conflicting_copies_are_not_selected_by_closest_value(self):
        checks = self.checks(self.fact + ' Corrente R1 = 999 A.')
        self.assertEqual(semantic_status(checks, 'faithfulness'), 'fail')
        self.assertEqual(semantic_status(checks, 'completeness'), 'review')
        self.assertEqual(sum(c.direction == 'completeness' for c in checks), 2)

    def test_different_fields_units_or_conditions_do_not_prove_support(self):
        for text in ('Corrente R2 = 0.02272727273 A.', 'Corrente R1 = 0.02272727273 V.',
                     'In AC: Corrente R1 = 0.02272727273 A.',
                     'Corrente R1 = 0.02272727273 A se R2 è chiuso.',
                     'Corrente R1 = 0.02272727273 A + 1 A.'):
            self.assertIsNone(compare(text, self.fact, [self.ref], normalize), text)
        self.assertIsNone(compare(self.fact, self.fact, [self.ref, self.ref], normalize))
        self.assertIsNone(declaration('Corrente R1 = I * R.', normalize))

    def test_inconsistent_dataset_fact_is_not_silently_repaired(self):
        with self.assertRaisesRegex(ValueError, 'incoerente'):
            compare(self.fact, 'Corrente R1 = 1 A.', [self.ref], normalize)

    def test_proof_tampering_does_not_create_support(self):
        for change in ('value', 'status', 'source', 'normalized', 'coverage'):
            checks = self.checks('Corrente R1 = 22.7273 mA.')
            c = checks[0]
            if change == 'value':c.preparation.numeric_proof.actual_value = 9
            if change == 'status':c.status = 'fail'
            if change == 'source':c.preparation.premise_spans[0].origin = 'response'
            if change == 'normalized':c.hypothesis = 'Inventato'
            if change == 'coverage':c.preparation.coverage_complete = False
            self.assertFalse(valid_proof(c))
            self.assertEqual(semantic_status([c], 'faithfulness'), 'review')

    def test_additional_linguistic_claim_is_still_checked(self):
        model = Classifier()
        checks = contextual_checks(self.fact + ' La resistenza genera energia.', model,
                                    [reference(self.fact)], [self.ref])
        self.assertTrue(model.calls)
        self.assertTrue(any(c.hypothesis == 'La resistenza genera energia.' for c in checks))
