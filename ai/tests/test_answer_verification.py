"""Regressioni di contratto/coerenza; i mock NLI non certificano il modello reale."""
import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from langchain_core.messages import AIMessage
from pydantic import ValidationError

from answer_contracts import NumericAnswer
from answer_verifier import extract_inventory, verify_answer
from config import Settings
from dataset import TEXTBOOK_DIR, load_dataset
from graph import validate_answer
from nli_verifier import LocalNLI, explanation_checks, semantic_status, sentences
from numeric_verification import aggregate, mentions, validate_numeric_results, verify_numbers
from prepare_nli import FILES, MODEL, REVISION, prepare
from schemas import SubmitAnswer, submit_answer_tool
from verification_schemas import ExplanationReference, NliCheck, NliScores, ResponseInventory
from verification_references import load_references
from verify_judge import probe_input


BUNDLE = load_dataset(TEXTBOOK_DIR)


class TokenCounter:
    # Contatore finto: questi test verificano l'orchestrazione, non il tokenizer.
    max_tokens = 512

    def count_tokens(self, premise, hypothesis):
        return len(premise.split()) + len(hypothesis.split()) + 4


def payload(text, name='book-dc-power-closed'):
    case = next(c for c in BUNDLE.dataset.cases if c.name == name)
    return probe_input(BUNDLE, case, text)[0]


def inventory(*items):
    return ResponseInventory(bindings=[dict(mention_id=i, role=role, reference_index=ref) for i, role, ref in items])


def references(p):
    return [ExplanationReference(statement=c, source_ids=[p.reference_sources[0].id], evidence_ids=[], required=True) for c in p.reference.concepts]


class NumericTests(unittest.TestCase):
    def test_original_bad_result_is_not_repaired_by_correct_result_elsewhere(self):
        p = payload('I = 6 A. P = 18 W. Il risultato corretto sarebbe 108 W.')
        observed = mentions(p.response.response)
        checks = verify_numbers(p, observed, inventory((0,'result',0),(1,'result',1),(2,'result',1)))
        self.assertEqual(aggregate(c.status for c in checks), 'fail')
        self.assertEqual(checks[1].actual_value, 18)
        self.assertEqual(checks[1].expected_value, 108)

    def test_correct_json_cannot_hide_bad_number_in_free_text(self):
        text = 'La potenza è 18 W. Il valore atteso è 108 W.'
        answer = SubmitAnswer(response=text, kind='theory', evidence_ids=[], uses_measurements=False,
            learning_notes=[], numeric_results=[NumericAnswer(subject='lampada', quantity='potenza', context='DC',
                value=108, unit='W')])
        self.assertEqual(len(mentions(answer.response)), 2)
        with self.assertRaises(ValueError):
            verify_numbers(payload(text), mentions(text), inventory((1,'result',1)))

    def test_missing_duplicate_and_unknown_occurrences_rejected(self):
        p = payload('I = 6 A. P = 108 W.')
        for inv in [inventory((0,'result',0)), inventory((0,'result',0),(9,'result',1))]:
            with self.assertRaises(ValueError): verify_numbers(p, mentions(p.response.response), inv)
        with self.assertRaises(ValidationError): inventory((0,'result',0),(0,'result',1))

    def test_units_latex_and_offsets_are_preserved(self):
        text = r'I = 500 \mathrm{µA}; R = 18 kohm; P = 1,5 mW.'
        found = mentions(text)
        self.assertEqual([(m.value,m.unit) for m in found],[(0.0005,'A'),(18000,'ohm'),(0.0015,'W')])
        for m in found: self.assertEqual(text[m.start:m.end],m.quote)

    def test_swapped_component_numbers_cannot_pass_by_remapping_reference(self):
        p = payload('V_R1 = 2.5 V; V_R3 = 1.5 V.', 'book-dc-series-closed')
        with self.assertRaises(ValueError):verify_numbers(p, mentions(p.response.response), inventory((0,'result',4),(1,'result',2)))
        checks = verify_numbers(p, mentions(p.response.response), inventory((0,'result',2),(1,'result',4)))
        self.assertEqual([c.status for c in checks[:2]], ['fail','fail'])

    def test_units_and_coverage_checked_independently(self):
        p=payload('I = 6 mA.')
        checks=verify_numbers(p,mentions(p.response.response),inventory((0,'result',0)))
        self.assertEqual([c.status for c in checks],['fail','review'])

    def test_given_and_refuted_are_not_escapes_to_pass(self):
        p=payload('P = 18 W; I = 6 A.')
        checks=verify_numbers(p,mentions(p.response.response),inventory((0,'given',None),(1,'refuted',None)))
        self.assertEqual(aggregate(c.status for c in checks),'review')

    def test_structured_result_must_be_in_original_quote(self):
        claim=NumericAnswer(subject='R1',quantity='potenza',context='DC',value=108,unit='W')
        with self.assertRaises(ValueError): validate_numeric_results('P = 18 W.',[claim])
        with self.assertRaises(ValueError): validate_numeric_results('Testo diverso.',[claim])

    def test_dimensionless_value_cannot_match_number_with_unit(self):
        claim=NumericAnswer(subject='R1',quantity='rapporto',context='DC',value=18,unit='1')
        with self.assertRaises(ValueError): validate_numeric_results('18 V',[claim])

    def test_legacy_report_remains_readable_but_live_contract_requires_field(self):
        raw=dict(response='Teoria.',kind='theory',evidence_ids=[],uses_measurements=False,learning_notes=[])
        self.assertNotIn('numeric_results',SubmitAnswer(**raw).model_dump(mode='json'))
        self.assertIn('numeric_results',submit_answer_tool()['function']['parameters']['required'])
        with self.assertRaises(ValueError): validate_answer(raw,{})
        self.assertEqual(validate_answer(dict(raw,numeric_results=[]),{}).response,'Teoria.')

    def test_new_explicit_empty_numeric_results_remain_in_api_output(self):
        answer=SubmitAnswer(response='Teoria.',kind='theory',evidence_ids=[],uses_measurements=False,learning_notes=[],numeric_results=[])
        self.assertEqual(answer.model_dump(mode='json')['numeric_results'],[])

    def test_measured_answer_requires_numeric_results(self):
        raw=dict(response='I = 6 A.',kind='circuit',evidence_ids=['m'],uses_measurements=True,learning_notes=[],numeric_results=[])
        with self.assertRaisesRegex(ValueError,'risultati numerici'): validate_answer(raw,{})


class NliTests(unittest.TestCase):
    def model(self, scores):
        nli=object.__new__(LocalNLI)
        nli.confidence,nli.margin=0.8,0.15
        nli.predict=lambda p,h:NliScores(**scores)
        return nli

    def test_neutral_and_uncertain_are_review_not_fail_or_pass(self):
        for scores in [dict(entailment=.05,neutral=.9,contradiction=.05),dict(entailment=.6,neutral=.2,contradiction=.2)]:
            self.assertEqual(self.model(scores).check('p','h','faithfulness').status,'review')

    def test_entailment_and_contradiction_remain_distinct(self):
        self.assertEqual(self.model(dict(entailment=.9,neutral=.05,contradiction=.05)).check('p','h','faithfulness').status,'pass')
        self.assertEqual(self.model(dict(entailment=.05,neutral=.05,contradiction=.9)).check('p','h','faithfulness').status,'fail')

    def test_too_long_or_unavailable_pair_is_not_support(self):
        nli=self.model(dict(entailment=.9,neutral=.05,contradiction=.05))
        def too_long(*_): raise ValueError('Input oltre il limite')
        nli.predict=too_long
        result=nli.check('p','h','faithfulness')
        self.assertEqual(result.status,'review');self.assertIsNone(result.scores)

    def test_sentence_segmentation_preserves_decimal_and_bad_sentence(self):
        self.assertEqual(sentences('P = 1.5 W. È media; non è RMS.'),['P = 1.5 W.','È media; non è RMS.'])

    def test_both_directions_and_every_sentence_are_compared(self):
        calls=[]
        class NLI(TokenCounter):
            def check(self,p,h,d):
                calls.append((p,h,d))
                return NliCheck(premise=p,hypothesis=h,direction=d,scores=None,status='review',detail='fake')
        p=payload('Prima affermazione. Seconda affermazione.')
        result=explanation_checks(p,NLI(),references(p))
        self.assertEqual(len({c.preparation.target_id for c in result if c.direction=='faithfulness'}),2)
        self.assertEqual({s.reference_index for c in result if c.direction=='completeness'
            for s in c.preparation.hypothesis_spans},set(range(len(p.reference.concepts))))
        self.assertEqual(calls[0][1],'Prima affermazione.')
        self.assertTrue(all(c[0] in p.response.response for c in calls if c[2]=='completeness'))

    def test_disagreement_is_review_instead_of_compensation(self):
        def check(status): return NliCheck(premise='p',hypothesis='h',direction='faithfulness',scores=NliScores(entailment=.9,neutral=.05,contradiction=.05),status=status,detail='fake')
        self.assertEqual(semantic_status([check('pass'),check('fail')],'faithfulness'),'review')
        self.assertEqual(semantic_status([check('pass'),check('review')],'faithfulness'),'pass')

    def test_references_are_bound_to_dataset_and_available_sources(self):
        suite=load_references(BUNDLE,TEXTBOOK_DIR/'explanation-references.v1.json')
        self.assertEqual(set(suite.cases),{c.name for c in BUNDLE.dataset.cases})
        p=payload('I = 6 A.')
        bad=ExplanationReference(statement='Un fatto.',source_ids=['invented'],evidence_ids=[],required=True)
        with self.assertRaises(ValueError):explanation_checks(p,None,[bad])
        with self.assertRaises(ValueError):explanation_checks(p,None,[])

    def test_missing_model_never_downloads(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError): LocalNLI(Path(d)/'absent')

    def test_unknown_label_order_not_guessed(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d,'config.json').write_text(json.dumps({'id2label':{'0':'LABEL_0','1':'LABEL_1','2':'LABEL_2'}}))
            with self.assertRaisesRegex(ValueError,'etichette'): LocalNLI(d)

    def test_prepare_reuses_hash_verified_files_without_network(self):
        from experiments import file_digest
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            for f in FILES: (root/f).write_text('test')
            (root/'source.json').write_text(json.dumps({'model':MODEL,'revision':REVISION,'files_sha256':{f:file_digest(root/f) for f in FILES}}))
            with patch('prepare_nli.urlopen',side_effect=AssertionError('network')): self.assertEqual(prepare(root),root)
            (root/'model.onnx').write_text('modified')
            with self.assertRaises(ValueError): prepare(root)
        with self.assertRaises(ValueError): prepare('/tmp/unused-nli',revision='main')


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_incompatible_binding_is_retried_and_preserved_not_called_answer_error(self):
        p=payload('La corrente è 6 A. La potenza è 18 W.')
        class Model:
            count=0
            def bind_tools(self,*_,**__):return self
            async def ainvoke(self,messages):
                self.count+=1
                inv=inventory((0,'result',1),(1,'result',1)) if self.count==1 else inventory((0,'result',0),(1,'result',1))
                return AIMessage(content='',tool_calls=[{'id':str(self.count),'name':'ResponseInventory','args':inv.model_dump()}])
        inv,metrics,attempts=await extract_inventory(p,mentions(p.response.response),Settings(),model=Model())
        self.assertEqual(metrics.model_calls,2)
        self.assertEqual([a.accepted for a in attempts],[False,True])
        self.assertIn('unità',attempts[0].error)
        self.assertEqual(aggregate(c.status for c in verify_numbers(p,mentions(p.response.response),inv)),'fail')

    async def test_structured_extractor_never_gets_expected_numeric_values(self):
        p=payload('I = 6 A. P = 18 W.')
        class Model:
            def bind_tools(self,*_,**__):return self
            async def ainvoke(self,messages):
                data=json.loads(messages[1].content)
                self.data=data
                return AIMessage(content='',tool_calls=[{'id':'i','name':'ResponseInventory','args':inventory((0,'result',0),(1,'result',1)).model_dump()}])
        model=Model()
        inv,_,attempts=await extract_inventory(p,mentions(p.response.response),Settings(),model=model)
        self.assertEqual(inv.bindings[1].mention_id,1)
        self.assertTrue(attempts[0].accepted)
        self.assertTrue(all(set(r)=={'reference_index','label','unit'} for r in model.data['references']))

    async def test_semantic_success_cannot_override_numeric_failure(self):
        class NLI(TokenCounter):
            def check(self,p,h,d): return NliCheck(premise=p,hypothesis=h,direction=d,
                scores=NliScores(entailment=.99,neutral=.005,contradiction=.005),status='pass',detail='fake')
        p=payload('La corrente è 6 A. La potenza è 18 W.')
        result,_=await verify_answer(p,Settings(),NLI(),references=references(p),inventory=inventory((0,'result',0),(1,'result',1)))
        self.assertEqual(result.numeric_status,'fail');self.assertEqual(result.explanation_status,'pass');self.assertEqual(result.status,'fail')

    async def test_numeric_success_cannot_override_semantic_contradiction(self):
        class NLI(TokenCounter):
            def check(self,p,h,d): return NliCheck(premise=p,hypothesis=h,direction=d,
                scores=NliScores(entailment=.005,neutral=.005,contradiction=.99),status='fail',detail='fake')
        p=payload('La corrente è 6 A. La potenza è 108 W.')
        result,_=await verify_answer(p,Settings(),NLI(),references=references(p),inventory=inventory((0,'result',0),(1,'result',1)))
        self.assertEqual(result.numeric_status,'pass');self.assertEqual(result.explanation_status,'fail');self.assertEqual(result.status,'fail')

    async def test_missing_extraction_coverage_is_review(self):
        class NLI(TokenCounter):
            def check(self,p,h,d): return NliCheck(premise=p,hypothesis=h,direction=d,
                scores=NliScores(entailment=.99,neutral=.005,contradiction=.005),status='pass',detail='fake')
        p=payload('I = 6 A. P = 18 W.')
        result,_=await verify_answer(p,Settings(),NLI(),references=references(p),inventory=inventory((0,'result',0)))
        self.assertEqual(result.numeric_status,'review');self.assertEqual(result.status,'review');self.assertTrue(result.errors)


if __name__=='__main__': unittest.main()
