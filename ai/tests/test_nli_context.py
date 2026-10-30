"""Prepara le coppie senza riscriverne i fatti; gli stub non valutano NLI reale."""
import unittest

from circuit_ai.nli.context import PROTOCOL, anchors, contextual_checks, formula_only, normalize, units
from circuit_ai.nli.classifier import LocalNLI, semantic_status
from circuit_ai.contracts.verification import ExplanationReference, NliCheck, NliScores


def reference(text):
    return ExplanationReference(statement=text, source_ids=['source'], evidence_ids=[], required=True)


class Classifier:
    max_tokens = 60

    def __init__(self):
        self.calls = []

    def count_tokens(self, premise, hypothesis):
        # Solo contatore di test, con finestra piccola per esercitare i confini.
        return len(premise.split()) + len(hypothesis.split()) + 4

    def check(self, p, h, d):
        self.calls.append((p, h, d))
        return NliCheck(premise=p, hypothesis=h, direction=d,
            scores=NliScores(entailment=.95, contradiction=.025, neutral=.025), status='pass', detail='stub')


class SegmentationTests(unittest.TestCase):
    def assert_spans(self, text, parsed):
        for unit in parsed:
            for s in [unit.span, *unit.context]:
                self.assertEqual(text[s.start:s.end], s.quote)

    def test_no_is_joined_to_its_explanation(self):
        parsed = units('No. Il rating non è determinato dagli ohm. La potenza conta.')
        claims = [u for u in parsed if u.kind == 'claim']
        self.assertEqual(claims[0].span.quote, 'No. Il rating non è determinato dagli ohm.')
        self.assertEqual(len(claims), 2)
        split = units('No.\n\nIl rating non è determinato dagli ohm.')
        self.assertEqual(split[-1].context[0].quote, 'No.')

    def test_numbered_bold_titles_are_not_bare_numeric_claims(self):
        text = '**1. Calcolo della corrente (I):**\nSi applica Ohm.\n\n**2. Potenza:**\nSi usa P=VI.'
        parsed = units(text)
        self.assert_spans(text, parsed)
        self.assertEqual(sum(u.kind == 'claim' for u in parsed), 2)
        self.assertTrue(all(u.context for u in parsed if u.kind == 'claim'))
        self.assertFalse(any(u.span.quote in {'1.', '**1.', '2.'} for u in parsed))

    def test_scope_and_negation_are_preserved_for_each_assumption(self):
        text = 'Il modello assume che:\n- La resistenza sia costante.\n- Non vi siano perdite.\n\nLa sorgente eroga energia.'
        parsed = units(text)
        claims = [u for u in parsed if u.kind == 'claim']
        self.assertEqual(claims[0].context[0].quote, 'Il modello assume che:')
        self.assertEqual(claims[1].context[0].quote, 'Il modello assume che:')
        self.assertIn('Non', claims[1].span.quote)
        self.assertEqual(claims[2].context, [])
        self.assert_spans(text, parsed)

    def test_an_assertion_disguised_as_heading_is_still_checked(self):
        parsed = units('# La resistenza genera energia magnetica.\n\n## Corrente\nLa corrente è continua.')
        self.assertTrue(any(u.kind == 'claim' and 'genera energia' in u.span.quote for u in parsed))
        for text in ('Potenza di R1 è 200 W.', '**Potenza di R1: 200 W**', 'Potenza di R1 = 200 W.',
                     'Potenza di R1 brucia il componente.'):
            self.assertTrue(any(u.kind == 'claim' for u in units(text)), text)

    def test_real_world_introduction_qualifies_the_following_list(self):
        text = 'Nel modello la resistenza è costante.\n\nNella realtà le lampade sono non lineari:\n- La resistenza varia con la temperatura.'
        parsed = units(text)
        self.assertTrue(any('Nella realtà' in c.quote for c in parsed[-1].context))
        self.assertTrue(any(u.kind == 'claim' and u.span.quote.startswith('Nella realtà') for u in parsed))

    def test_isolated_formulas_are_not_certified_as_language(self):
        for formula in ('P = I^2 * R', 'P = I^2 / R', 'P = I²·R', '1+1=2', r'$$P = \frac{V^2}{R}$$'):
            self.assertTrue(formula_only(formula))
        self.assertFalse(formula_only('La potenza è data da P = I^2 * R.'))
        self.assertFalse(formula_only('Le forme resistive derivano dalla relazione V=IR.'))
        self.assertFalse(formula_only('Potenza R1 = 108 W.'))
        checks = contextual_checks('P = I^2 / R', Classifier(), [reference('La potenza è P=I²·R.')])
        self.assertEqual(semantic_status(checks, 'faithfulness'), 'review')
        self.assertTrue(any(c.preparation.reason == 'non_linguistic' for c in checks))

    def test_decimal_math_code_and_abbreviations_are_not_cut_internally(self):
        text = 'In D.C. il valore è 1.5 W.\n\n$$P = 1.5 \\cdot 2.0$$\n\n```text\na=1.5; b=2.0\n```'
        parsed = units(text)
        self.assertEqual(parsed[0].span.quote, 'In D.C. il valore è 1.5 W.')
        self.assertTrue(any('1.5 \\cdot 2.0' in u.span.quote for u in parsed))
        self.assertTrue(any('a=1.5; b=2.0' in u.span.quote for u in parsed))
        self.assert_spans(text, parsed)

    def test_pronoun_keeps_the_previous_original_sentence(self):
        parsed = units('La corrente è negativa. Questo non prova che il componente generi energia.')
        self.assertEqual(parsed[1].context[0].quote, parsed[0].span.quote)

    def test_a_numeric_declaration_is_not_copied_into_a_following_generic_claim(self):
        parsed = units('Fase uscita = -45 deg. Questi risultati sono fasi della risposta AC.')
        self.assertEqual(parsed[1].context, [])

    def test_semicolon_separates_explicit_subjects_but_preserves_conditional_scope(self):
        parsed = units('I rami condividono la tensione; le correnti possono differire.')
        self.assertEqual(len(parsed), 2)
        self.assertEqual(parsed[1].span.quote, 'le correnti possono differire.')
        conditional = units('Se R è costante, la corrente raddoppia; la potenza quadruplica.')
        self.assertEqual(len(conditional), 1)

    def test_normalization_does_not_repair_values_or_remove_negation(self):
        text = r'**Potenza:** Non è $18 \\mathrm{W}$; non $108 \\text{W}$. $V_{R1}$ resta diverso.'
        cleaned = normalize(text)
        self.assertIn('18', cleaned)
        self.assertIn('108', cleaned)
        self.assertEqual(cleaned.count('non') + cleaned.count('Non'), 2)
        self.assertIn('V_{R1}', cleaned)
        self.assertIn(r'\neg', normalize(r'$\neg A$'))
        self.assertIn('I**2', normalize('P = I**2 * R'))
        self.assertIn('I__2', normalize('P = I__2 * R'))
        self.assertEqual(normalize('**1. Corrente:**'), 'Corrente:')


class PlanningTests(unittest.TestCase):
    def test_different_named_gates_or_components_cannot_supply_support(self):
        for premise, hypothesis in [
            ('La OR è alta con entrambi gli ingressi alti.', 'La XOR è alta con entrambi gli ingressi alti.'),
            ('U1 contiene una porta OR.', 'U1 contiene una porta XOR.'),
            ('R1 dissipa energia.', 'R2 dissipa energia.'),
        ]:
            self.assertFalse(anchors(premise, hypothesis).comparable)
            checks = contextual_checks(hypothesis, Classifier(), [reference(premise)])
            forward = [c for c in checks if c.direction == 'faithfulness']
            self.assertEqual(semantic_status(checks, 'faithfulness'), 'review')
            self.assertEqual(forward[0].preparation.reason, 'anchor_mismatch')
            self.assertEqual(forward[0].scores.entailment, .95)  # Il punteggio non viene riscritto.

    def test_different_quantities_cannot_supply_support_or_contradiction(self):
        self.assertFalse(anchors('Le correnti sono diverse.', 'Le tensioni sono diverse.').comparable)
        self.assertTrue(anchors('La tensione è proporzionale alla corrente.', 'La corrente varia.').comparable)
        self.assertTrue(anchors('I rami condividono la differenza di potenziale.', 'I rami hanno la stessa tensione.').comparable)
        self.assertTrue(anchors('Modello a resistenza costante: I=V/R=6 A; P=VI=108 W.', 'La potenza è 108 W.').comparable)
        model = Classifier()
        def contradict(p,h,d):
            return NliCheck(premise=p,hypothesis=h,direction=d,status='fail',detail='stub',
                scores=NliScores(entailment=.01,contradiction=.98,neutral=.01))
        model.check = contradict
        checks = contextual_checks('La corrente è negativa.', model, [reference('La potenza è negativa.')])
        self.assertEqual(semantic_status(checks,'faithfulness'),'review')
        self.assertEqual(checks[0].scores.contradiction,.98)

    def test_long_response_is_covered_and_late_evidence_is_not_dropped(self):
        response = ' '.join(f'La frase numero {i} parla del circuito.' for i in range(40)) + ' La potenza è dissipata.'
        model = Classifier()
        # Una parafrasi forza il percorso neurale, senza il nuovo shortcut di identità.
        checks = contextual_checks(response, model, [reference('Il componente dissipa potenza.')])
        backward = [c for c in checks if c.direction == 'completeness']
        self.assertGreater(len(backward), 1)
        self.assertTrue(any('La potenza è dissipata.' in c.premise for c in backward))
        self.assertTrue(all(c.preparation.token_count <= model.max_tokens for c in backward))
        covered = set()
        for check in backward:
            for span in check.preparation.premise_spans:
                self.assertEqual(response[span.start:span.end], span.quote)
                covered.update(range(span.start, span.end))
        self.assertTrue(all(i in covered for i, ch in enumerate(response) if not ch.isspace()))

    def test_compound_required_reference_checks_every_sentence(self):
        checks = contextual_checks('La corrente è costante. La potenza è dissipata.', Classifier(),
            [reference('La corrente è costante. La potenza è dissipata.')])
        backward = [c for c in checks if c.direction == 'completeness']
        self.assertEqual(len({c.preparation.target_id for c in backward}), 2)

    def test_an_oversized_unit_is_review_without_silent_truncation(self):
        text = ' '.join(['circuito'] * 100)
        checks = contextual_checks(text, Classifier(), [reference('La corrente è costante.')])
        self.assertEqual(semantic_status(checks, 'faithfulness'), 'review')
        self.assertTrue(any(c.preparation.reason == 'oversized_unit' for c in checks))
        self.assertTrue(any(c.preparation.raw_hypothesis == text for c in checks))

    def test_model_failure_and_incomplete_coverage_cannot_become_support(self):
        model = Classifier()
        def fail(*args):
            return NliCheck(premise=args[0], hypothesis=args[1], direction=args[2],
                scores=None, status='review', detail='offline')
        model.check = fail
        checks = contextual_checks('Il resistore dissipa energia.', model, [reference('La resistenza dissipa energia.')])
        self.assertEqual(semantic_status(checks, 'faithfulness'), 'review')
        self.assertTrue(all(not c.preparation.coverage_complete for c in checks))

    def test_no_tokenizer_is_review_not_an_estimated_pass(self):
        model = Classifier()
        def fail(*args):raise ValueError('tokenizer non disponibile')
        model.count_tokens = fail
        checks = contextual_checks('Il resistore dissipa energia.', model, [reference('La resistenza dissipa energia.')])
        self.assertEqual(semantic_status(checks, 'completeness'), 'review')
        self.assertTrue(all(c.preparation.reason == 'tokenizer_error' for c in checks))
        self.assertEqual(model.calls, [])

    def test_passing_some_chunks_does_not_hide_a_contradiction(self):
        model = Classifier()
        checks = contextual_checks(' '.join('La frase descrive il circuito.' for _ in range(40)),
            model, [reference('La corrente è continua.')])
        backward = [c for c in checks if c.direction == 'completeness']
        backward[-1].scores = NliScores(entailment=.01, contradiction=.98, neutral=.01)
        backward[-1].status = 'fail'
        self.assertEqual(semantic_status(backward, 'completeness'), 'review')

    def test_pair_budget_is_explicit_and_unchecked_targets_remain_review(self):
        from unittest.mock import patch
        model = Classifier()
        with patch.dict(PROTOCOL, max_pairs_per_answer=1):
            checks = contextual_checks("Una frase. Un'altra frase.", model, [reference('Un fatto.')])
        self.assertEqual(len(model.calls), 1)
        self.assertTrue(any(c.preparation.reason == 'budget_exhausted' for c in checks))
        self.assertEqual(semantic_status(checks, 'completeness'), 'review')

    def test_historical_checks_keep_their_original_serialization(self):
        old = dict(direction='faithfulness', premise='p', hypothesis='h', scores=None, status='review', detail='old')
        self.assertEqual(NliCheck.model_validate(old).model_dump(mode='json'), old)

    def test_a_required_title_is_not_implicitly_covered(self):
        checks = contextual_checks('La corrente è costante.', Classifier(),
            [reference('La corrente è costante.'), reference('# Potenza')])
        self.assertEqual(semantic_status(checks, 'completeness'), 'review')

    def test_identical_contextual_fact_has_a_deterministic_proof_without_neural_scores(self):
        model = Classifier()
        checks = contextual_checks('La corrente è costante.', model, [reference('La corrente è costante.')])
        self.assertEqual(model.calls, [])
        self.assertTrue(all(c.preparation.reason == 'exact_reference' and c.scores is None for c in checks))
        self.assertEqual(semantic_status(checks, 'faithfulness'), 'pass')

    def test_literal_proof_is_not_a_substring_match_and_preserves_conditions(self):
        for source, response in [('Se R è costante, la corrente raddoppia.', 'La corrente raddoppia.'),
                                 ('Non è vero che la corrente è costante.', 'La corrente è costante.'),
                                 ('P = I__2 * R', 'P = I2 * R')]:
            checks = contextual_checks(response, Classifier(), [reference(source)])
            self.assertTrue(all(c.preparation.reason != 'exact_reference' for c in checks))

    def test_a_correct_fact_does_not_hide_an_additional_wrong_claim(self):
        class Model(Classifier):
            def check(self,p,h,d):
                return NliCheck(premise=p,hypothesis=h,direction=d,status='fail',detail='stub',
                    scores=NliScores(entailment=.01,contradiction=.98,neutral=.01))
        checks = contextual_checks('Il resistore dissipa energia. Il resistore genera energia.', Model(),
            [reference('Il resistore dissipa energia.')])
        self.assertEqual(semantic_status(checks,'completeness'),'pass')
        self.assertEqual(semantic_status(checks,'faithfulness'),'fail')
