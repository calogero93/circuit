import unittest
from decimal import ROUND_DOWN, localcontext

from langchain_core.messages import AIMessage

from config import Settings
from dataset import TEXTBOOK_DIR, load_dataset
from judge import calculator_tool, judge_answer
from judge_calculator import calculate
from schemas import CalculatorInput
from verify_judge import probe_input
from test_evaluators import judge_reply
from test_tutor import FakeModel


def request(expression, variables=None, quote="Calcolo di prova", claimed=None):
    return CalculatorInput(expression=expression, variables=[{"name":name,**value} for name,value in (variables or {}).items()], response_quote=quote,
        claimed_value=claimed['value'] if claimed else None,claimed_unit=claimed['unit'] if claimed else None)


class CalculatorTests(unittest.TestCase):
    def test_power_has_correct_value_dimensions_and_compares_actual_claim(self):
        quote = "P = 18 V × 6 A = 18 W"
        output = calculate(request("v*i", {"v": {"value":18,"unit":"V"}, "i":{"value":6,"unit":"A"}},
            quote, {"value":18,"unit":"W"}), quote)
        self.assertEqual((output.value, output.unit), (108, "W"))
        self.assertFalse(output.claimed_matches)
        correct = quote.replace("= 18 W", "= 108 W")
        self.assertTrue(calculate(request("v*i", {"v":{"value":18,"unit":"V"},"i":{"value":6,"unit":"A"}},
            correct, {"value":108,"unit":"W"}), correct).claimed_matches)

    def test_prefixes_and_electrical_units(self):
        quote = "I = 9 V / 18 kohm = 500 µA"
        out = calculate(request("v/r", {"v":{"value":9,"unit":"V"},"r":{"value":18,"unit":"kohm"}},
            quote, {"value":500,"unit":"uA"}), quote)
        self.assertEqual((out.value, out.unit), (.0005,"A"))
        self.assertTrue(out.claimed_matches)
        quote = "P = 108 \\, \\text{W}"
        out = calculate(request("i**2*r", {"i":{"value":6,"unit":"A"},"r":{"value":3,"unit":"Ω"}},
            quote, {"value":108,"unit":"W"}), quote)
        self.assertEqual((out.value, out.unit, out.claimed_matches), (108,"W",True))

    def test_decimal_arithmetic_and_rms_are_computed(self):
        out = calculate(request("0.1+0.2"), "Calcolo di prova")
        self.assertEqual(out.decimal_value, "0.3")
        self.assertIsNone(out.claimed_matches)
        values = {"a":{"value":3,"unit":"V"},"b":{"value":-3,"unit":"V"}}
        mean = calculate(request("mean(a,b)",values), "Calcolo di prova")
        rms = calculate(request("rms(a,b)",values), "Calcolo di prova")
        self.assertEqual((mean.value,rms.value,rms.unit), (0,3,"V"))
        self.assertEqual(calculate(request("sqrt(9)"), "Calcolo di prova").value, 3)

    def test_incompatible_dimensions_and_undefined_operations_are_errors(self):
        values={"v":{"value":3,"unit":"V"},"i":{"value":2,"unit":"A"}}
        for expression in ("v+i", "mean(v,i)", "1/0", "0**0", "sqrt(-1)", "sqrt(v)", "2**9", "2**0.5"):
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                calculate(request(expression,values), "Calcolo di prova")

    def test_executable_constructs_and_unbounded_work_are_rejected(self):
        for expression in ("__import__('os').system('id')", "(1).__class__", "a[0]", "[x for x in (1,2)]",
                "True", "'hello'", "1e101", "1e999999", "abs(x=1)", "+"*20+"1"):
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                calculate(request(expression), "Calcolo di prova")

    def test_quotes_and_claims_cannot_be_invented(self):
        with self.assertRaisesRegex(ValueError,"citazione"):
            calculate(request("1+1",quote="Testo inventato"), "Risposta effettiva")
        with self.assertRaisesRegex(ValueError,"non compare"):
            calculate(request("1+1",quote="Il valore è 3 V",claimed={"value":2,"unit":"V"}), "Il valore è 3 V")
        with self.assertRaises(ValueError):
            calculate(request("x",{"x":{"value":1,"unit":"nonsense"}}), "Calcolo di prova")

    def test_small_values_are_not_rounded_to_zero_by_an_absolute_tolerance(self):
        quote="La corrente è 0 A"
        output=calculate(request("i",{"i":{"value":1e-15,"unit":"A"}},quote,{"value":0,"unit":"A"}),quote)
        self.assertFalse(output.claimed_matches)

    def test_precision_and_rounding_do_not_depend_on_callers_decimal_context(self):
        with localcontext() as context:
            context.prec, context.rounding = 3, ROUND_DOWN
            output=calculate(request("1/6"),"Calcolo di prova")
        self.assertEqual(output.decimal_value,"0."+"1"+"6"*48+"7")

    def test_wire_schema_has_explicit_array_items_without_unresolved_references(self):
        import json
        tool=calculator_tool()
        self.assertNotIn('"$ref"',json.dumps(tool))
        item=tool['function']['parameters']['properties']['variables']['items']
        self.assertEqual(set(item['properties']),{'name','value','unit'})
        self.assertIn('ohm',item['properties']['unit']['enum'])
        self.assertNotIn('ohm/Ω',item['properties']['unit']['enum'])

    def test_variables_have_unique_case_sensitive_names(self):
        with self.assertRaisesRegex(ValueError,'Variabile sconosciuta v'):
            calculate(request('v',{'V':{'value':1,'unit':'V'}}),'Calcolo di prova')
        duplicate=CalculatorInput(expression='v',variables=[{'name':'v','value':1,'unit':'V'},{'name':'v','value':2,'unit':'V'}],response_quote='Calcolo di prova')
        with self.assertRaisesRegex(ValueError,'duplicati'):
            calculate(duplicate,'Calcolo di prova')

    def test_dimensionless_claim_cannot_match_a_dimensional_quantity(self):
        quote='La potenza è 108 W'
        with self.assertRaisesRegex(ValueError,'non compare'):
            calculate(request('108',quote=quote,claimed={'value':108,'unit':'1'}),quote)
        quote='Il rapporto è 108'
        self.assertTrue(calculate(request('108',quote=quote,claimed={'value':108,'unit':'1'}),quote).claimed_matches)


class CalculatorJudgeTests(unittest.IsolatedAsyncioTestCase):
    def payload(self, text):
        bundle=load_dataset(TEXTBOOK_DIR)
        case=next(c for c in bundle.dataset.cases if c.name=="book-dc-power-closed")
        return probe_input(bundle,case,text)[0]

    async def test_judge_receives_computed_result_and_trace_is_preserved(self):
        quote="P = 18 V × 6 A = 18 W"
        args={"expression":"v*i","variables":[{"name":"v","value":18,"unit":"V"},{"name":"i","value":6,"unit":"A"}],
            "response_quote":quote,"claimed_value":18,"claimed_unit":"W"}
        model=FakeModel([AIMessage(content="",tool_calls=[{"name":"calculator","id":"math-1","args":args}]),judge_reply(1)])
        result=await judge_answer(self.payload(quote),Settings(),model=model)
        self.assertEqual(result.status,"completed")
        self.assertEqual(result.metrics.model_calls,2)
        self.assertEqual(len(result.calculations),1)
        self.assertEqual(result.calculations[0].result.data.value,108)
        self.assertFalse(result.calculations[0].result.data.claimed_matches)
        self.assertTrue(any(getattr(m,"name",None)=="calculator" and '"value":108' in m.content for m in model.calls[1]))

    async def test_numeric_judge_cannot_skip_calculator(self):
        result=await judge_answer(self.payload("6 A e 108 W"),Settings(),model=FakeModel([judge_reply(),judge_reply(),judge_reply()]))
        self.assertEqual(result.status,"invalid")
        self.assertIsNone(result.verdict)

    async def test_invalid_calculation_is_returned_to_judge_and_can_be_corrected(self):
        quote="6 A e 108 W"
        bad={"expression":"1/0","variables":[],"response_quote":quote}
        good={"expression":"18*6","variables":[],"response_quote":quote}
        model=FakeModel([AIMessage(content="",tool_calls=[{"name":"calculator","id":"bad","args":bad}]),
            AIMessage(content="",tool_calls=[{"name":"calculator","id":"good","args":good}]),judge_reply()])
        result=await judge_answer(self.payload(quote),Settings(),model=model)
        self.assertEqual(result.status,"completed")
        self.assertEqual([c.result.ok for c in result.calculations],[False,True])
        self.assertIn("Divisione per zero",result.calculations[0].result.error)

    async def test_repeated_tool_errors_have_finite_budget_and_no_positive_verdict(self):
        quote="6 A e 108 W"
        messages=[AIMessage(content="",tool_calls=[{"name":"calculator","id":f"bad-{i}",
            "args":{"expression":"1/0","variables":[],"response_quote":quote}}]) for i in range(4)]
        result=await judge_answer(self.payload(quote),Settings(),model=FakeModel(messages))
        self.assertEqual(result.status,"invalid")
        self.assertEqual(len(result.calculations),4)
        self.assertIsNone(result.verdict)


if __name__ == "__main__":
    unittest.main()
