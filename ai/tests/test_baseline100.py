"""Fonti e simulazioni indipendenti; nessun mock NLI certifica la qualità linguistica."""
from collections import Counter
from decimal import Decimal
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from baseline_dataset import DIRECTORY, load_baseline
from baseline_runtime import arithmetic
from experiments import ROOT
from numeric_verification import mentions, validate_numeric_results
from answer_contracts import NumericAnswer
from spice_reference import run_spice
from run_baseline import answer_checks, payload_for, run, summary, validate_model_identity
from schemas import SubmitAnswer, TurnMetrics
from config import Settings
from verification_schemas import AnswerVerification


class BaselineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.dataset,cls.identity=load_baseline()

    def test_exact_composition_and_distinct_purposes(self):
        self.assertEqual(Counter(c.bucket for c in self.dataset.cases),{'worked':30,'ngspice':30,'theory':20,'stress':20})
        self.assertEqual(Counter(c.split for c in self.dataset.cases),{'development':80,'validation':20})
        self.assertEqual(Counter(c.purpose for c in self.dataset.cases),{'tutor':90,'verifier':10})
        groups={}
        for c in self.dataset.cases:groups.setdefault(c.group_id,set()).add(c.split)
        self.assertTrue(all(len(v)==1 for v in groups.values()))

    def test_all_published_results_have_solutions_and_provenance(self):
        sources={s.id:s for s in self.dataset.sources}
        for c in self.dataset.cases:
            if c.bucket!='worked':continue
            with self.subTest(case=c.id):
                self.assertTrue(c.numbers or c.symbolic_results)
                self.assertTrue(all(sources[id].publication for id in c.source_ids))
                self.assertTrue(all(n.source_quote for n in c.numbers))

    def test_alterations_are_not_tutor_training_answers(self):
        lookup={c.id:c for c in self.dataset.cases}
        for c in self.dataset.cases:
            if c.purpose!='verifier':continue
            parent=lookup[c.alteration.parent_id]
            self.assertEqual(c.split,parent.split)
            self.assertEqual(c.group_id,parent.group_id)
            self.assertNotEqual(c.candidate_answer,c.reference_answer)
            self.assertEqual(parent.reference_answer.replace(c.alteration.before,c.alteration.after,1),c.candidate_answer)

    def modified(self,change):
        temporary=tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(temporary.cleanup)
        dest=Path(temporary.name)/'dataset';shutil.copytree(DIRECTORY,dest)
        p=dest/'dataset.v1.json';raw=json.loads(p.read_text());change(raw);p.write_text(json.dumps(raw,ensure_ascii=False))
        return dest

    def test_duplicate_records_and_cross_split_families_are_rejected(self):
        dest=self.modified(lambda r:r['cases'].__setitem__(1,r['cases'][0]))
        with self.assertRaises(ValueError):load_baseline(dest)
        def change(r):r['cases'][0]['group_id']=next(c['group_id'] for c in r['cases'] if c['split']=='validation')
        dest=self.modified(change)
        with self.assertRaises(ValueError):load_baseline(dest)

    def test_changed_published_value_or_source_quote_is_rejected(self):
        def change(r):r['cases'][0]['numbers'][0]['source_quote']='invented solution'
        with self.assertRaises(ValueError):load_baseline(self.modified(change))
        def value(r):r['cases'][0]['numbers'][0]['value']=999
        with self.assertRaises(ValueError):load_baseline(self.modified(value))

    def test_spice_numbers_are_read_from_actual_measurements(self):
        for c in self.dataset.cases:
            if c.bucket!='ngspice':continue
            run=json.loads((DIRECTORY/'spice'/(c.id+'.json')).read_text())
            self.assertIn('ngspice-45.2',run['version'])
            for n in c.numbers:self.assertEqual(n.value,run['measurements'][n.measure])

    def test_cached_ohm_bridge_and_filter_have_independent_analytic_sanity_checks(self):
        def values(id):return json.loads((DIRECTORY/'spice'/(id+'.json')).read_text())['measurements']
        self.assertAlmostEqual(values('spice-ohm')['m_i'],5/220,places=12)
        self.assertAlmostEqual(values('spice-ohm')['m_p'],25/220,places=12)
        a=1/1000+1/2000+1/470;d=1/1500+1/2200+1/470;b=-1/470
        vl=((10/1000)*d-b*(10/1500))/(a*d-b*b)
        vr=(a*(10/1500)-b*(10/1000))/(a*d-b*b)
        self.assertAlmostEqual(values('spice-bridge')['m_v'],vl-vr,places=12)
        self.assertAlmostEqual(values('spice-rl-low')['m_v'],1/math.sqrt(2),places=12)
        self.assertAlmostEqual(values('spice-rl-low')['m_phase'],-45,places=10)

    def test_symbolic_cases_and_simulation_values_remain_separate(self):
        case=next(c for c in self.dataset.cases if c.id=='worked-bin-fraction')
        self.assertEqual(case.symbolic_results,['5.375'])
        self.assertAlmostEqual(4+1+.25+.125,float(case.symbolic_results[0]))
        answer=SubmitAnswer(response=case.reference_answer,kind='theory',evidence_ids=[],uses_measurements=False,learning_notes=[])
        payload=payload_for(case,answer,{s.id:s for s in self.dataset.sources})
        self.assertEqual(payload.response.response,case.reference_answer)
        self.assertEqual(payload.reference.numbers,[])

    def test_metrics_do_not_mix_tutor_failures_with_negative_controls(self):
        rows=[{'purpose':'tutor','status':'pass','errors':[],'bucket':'theory'},
            {'purpose':'verifier','status':'fail','errors':[],'bucket':'stress'}]
        result=summary(rows)
        self.assertEqual(result['tutor']['status'],{'pass':1})
        self.assertEqual(result['verifier']['status'],{'fail':1})

    def test_tutor_requires_actual_calculation_and_structured_results(self):
        c=self.dataset.cases[0]
        answer=SubmitAnswer(response=c.reference_answer,kind='theory',evidence_ids=[],uses_measurements=False,learning_notes=[],numeric_results=[])
        payload=payload_for(c,answer,{s.id:s for s in self.dataset.sources})
        checks=answer_checks(c,answer,payload,mode='tutor',state={'trace':[]})
        self.assertFalse(checks['structured_numeric_results'])
        self.assertFalse(checks['tool_calculate_or_loaded_divider_voltage_or_power_from_current_or_power_from_voltage_or_resistor_current_or_series_voltage_drop_or_sine_voltage'])
        self.assertTrue(all(answer_checks(c,answer,payload,mode='references',state=None).values()))

    def test_model_changes_across_generation_and_extraction_invalidate_run(self):
        row={'generation_metrics':{'model_observations':[{'model_name':'a','system_fingerprint':'x'}]},
            'extractor_metrics':{'model_observations':[{'model_name':'a','system_fingerprint':'x'}]}}
        validate_model_identity([row])
        row['extractor_metrics']['model_observations'][0]['system_fingerprint']='y'
        with self.assertRaises(ValueError):validate_model_identity([row])

    def test_advanced_worked_questions_provide_inputs_without_retrieval(self):
        cases={c.id:c for c in self.dataset.cases}
        self.assertIn('fase iniziale nulla',cases['worked-sine-samples'].question)
        self.assertIn('v(t)=15 sin(2 pi 60 t)',cases['worked-sine-samples'].question)
        for id,tokens in {
            'worked-lc-filter':['L1 2 3 100m','L2 3 4 250m','C1 3 0 100u','V(4,0)'],
            'worked-transformer':['L2 2 4 1','L3 3 5 25','Rbogus1 5 0 1e10','V(2,0)'],
        }.items():
            for token in tokens:self.assertIn(token,cases[id].question)


class RunnerTests(unittest.IsolatedAsyncioTestCase):
    async def test_reference_run_keeps_negative_controls_and_never_generates_tutor_answers(self):
        dataset,_=load_baseline()
        positive=dataset.cases[0];negative=next(c for c in dataset.cases if c.purpose=='verifier')
        class Nli:
            identity={'provider':'test-only'}
            def assert_unchanged(self):pass
        seen=[]
        async def verify(payload,*args,**kwargs):
            seen.append(payload.response.response)
            status='fail' if payload.response.response==negative.candidate_answer else 'pass'
            return AnswerVerification(numeric_status=status,explanation_status='pass',completeness_status='pass',status=status,
                mentions=[],inventory=None,inventory_attempts=[],numeric_checks=[],nli_checks=[],errors=[]),TurnMetrics()
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'report.json'
            with patch('run_baseline.check_endpoint',new=AsyncMock()),patch('run_baseline.verify_answer',side_effect=verify),patch('run_baseline.generate',new=AsyncMock()) as generate:
                report,_=await run(Settings(),Nli(),split='all',case_ids=[positive.id,negative.id],output=output)
                generate.assert_not_awaited()
            self.assertEqual(report['status'],'completed')
            self.assertEqual(seen,[positive.reference_answer,negative.candidate_answer])
            self.assertFalse(report['baseline_approved'])
            self.assertFalse(report['human_calibrated'])
            self.assertEqual(report['summary']['verifier']['status'],{'fail':1})
            with self.assertRaises(ValueError):await run(Settings(),Nli(),output=output)


class MathToolTests(unittest.TestCase):
    def test_waveforms_and_rc_transient_are_computable_without_model_arithmetic(self):
        values=[dict(name='peak',value=15,unit='V'),dict(name='f',value=60,unit='Hz'),dict(name='t',value=5,unit='ms')]
        self.assertAlmostEqual(arithmetic('peak*sin(2*pi*f*t)',values)['value'],15*math.sin(2*math.pi*60*.005))
        values=[dict(name='v',value=10,unit='V'),dict(name='r',value=3300,unit='ohm'),dict(name='c',value=69,unit='uF'),dict(name='t',value=.2,unit='s')]
        self.assertAlmostEqual(arithmetic('v*(1-exp(-t/(r*c)))',values)['value'],10*(1-math.exp(-.2/(3300*69e-6))))
        self.assertAlmostEqual(arithmetic('cos(pi)',[])['value'],-1)

    def test_power_decibels_and_dimensionless_fractional_powers(self):
        q=[dict(name='out',value=10,unit='W'),dict(name='inp',value=1,unit='W')]
        result=arithmetic('10*log10(out/inp)',q)
        self.assertAlmostEqual(result['value'],10)
        self.assertEqual(result['unit'],'1')
        self.assertAlmostEqual(arithmetic('10**(10/20)',[])['value'],math.sqrt(10))

    def test_forbidden_code_and_dimensioned_logarithms_rejected(self):
        for expression in ["__import__('os').system('false')",'log10(-1)','10**100000','exp(100000)','sin(10000000)','I=V/R']:
            with self.assertRaises(ValueError):arithmetic(expression,[])
        with self.assertRaises(ValueError):arithmetic('log10(v)',[dict(name='v',value=10,unit='V')])

    def test_phase_unicode_sign_latex_and_ratio_units(self):
        text=r'La fase è −45^{\circ}; il guadagno è 10 dB; il rapporto è 100 volte.'
        self.assertEqual([(m.value,m.unit) for m in mentions(text)],[(-45,'deg'),(10,'dB'),(100,'1')])
        validate_numeric_results(text,[NumericAnswer(subject='rapporto',quantity='guadagno',context='DC',value=100,unit='1')])


class RealSpiceTests(unittest.TestCase):
    @unittest.skipUnless(os.getenv('AI_TEST_NGSPICE_BIN'),'Riesecuzione reale richiede AI_TEST_NGSPICE_BIN; nessun download implicito')
    def test_rerun_all_thirty_simulations(self):
        dataset,_=load_baseline()
        with tempfile.TemporaryDirectory() as tmp:
            for c in dataset.cases:
                if not c.spice_id:continue
                with self.subTest(case=c.id):
                    run=run_spice(os.environ['AI_TEST_NGSPICE_BIN'],DIRECTORY/'spice'/(c.id+'.cir'),Path(tmp),[n.measure for n in c.numbers])
                    for n in c.numbers:
                        self.assertTrue(math.isclose(run['measurements'][n.measure],n.value,rel_tol=n.relative_tolerance,abs_tol=n.absolute_tolerance))


if __name__=='__main__':unittest.main()
