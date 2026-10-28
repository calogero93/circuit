import unittest

from answer_rendering import render_answer
from config import Settings
from graph import create_graph
from numeric_verification import mentions
from schemas import submit_answer_tool
from test_tutor import FakeModel, answer, call, custom_tool, input_state


def draft(value=1 / 3, unit="V"):
    return {"explanation": "Si applica la legge di Ohm a R1.", "numeric_results": [{"subject": "R1",
        "quantity": "tensione", "context": "DC", "value": value, "unit": unit}],
        "learning_notes": [], "limitation": False}


def state(tool="calculate", measured=False):
    return {"evidence": [{"call_id": "current", "tool": tool, "revision": 1 if measured else None,
        "measurement_valid": measured}], "revision_consistent": True}


class RenderingTests(unittest.TestCase):
    def test_repeating_decimals_are_rendered_once_without_changing_data(self):
        result = render_answer(draft(), state())
        self.assertEqual(result.numeric_results[0].value, 1 / 3)
        self.assertEqual(len(mentions(result.response)), 1)
        self.assertIn("0.333333333333 V", result.response)
        self.assertEqual(result.kind, "theory")
        self.assertFalse(result.uses_measurements)

    def test_renderer_does_not_correct_wrong_numbers_with_ground_truth(self):
        result = render_answer(draft(999), state())
        self.assertIn("999 V", result.response)
        self.assertEqual(result.numeric_results[0].value, 999)

    def test_metadata_are_owned_by_runtime_and_simulation_is_not_live(self):
        schema = submit_answer_tool()["function"]["parameters"]
        self.assertEqual(set(schema["required"]), {"explanation", "numeric_results", "learning_notes", "limitation"})
        for field in ("kind", "evidence_ids", "uses_measurements"):
            self.assertNotIn(field, schema["properties"])
            with self.assertRaises(ValueError):
                render_answer(dict(draft(), **{field: []}), state())
        live = render_answer(draft(), state("getCircuitSnapshot", True))
        self.assertEqual((live.kind, live.uses_measurements, live.evidence_ids), ("circuit", True, ["current"]))
        offline = render_answer(draft(), state("simulateCircuit"))
        self.assertEqual((offline.kind, offline.uses_measurements), ("theory", False))

    def test_unreliable_or_missing_evidence_cannot_support_numbers(self):
        for evidence in ({}, state("getCircuitSnapshot"), state("getNetlist")):
            with self.assertRaisesRegex(ValueError, "richiedono un tool"):
                render_answer(draft(), evidence)
        with self.assertRaisesRegex(ValueError, "Revisioni incoerenti"):
            render_answer(draft(), dict(state(), revision_consistent=False))
        no_numbers = dict(draft(), numeric_results=[])
        self.assertEqual(render_answer(no_numbers, dict(state(), revision_consistent=False)).kind, "limitation")

    def test_duplicate_numeric_prose_and_unbounded_notes_are_rejected(self):
        for text in ("Risulta 0.33 V.", "Il guadagno è 100."):
            with self.assertRaisesRegex(ValueError, "solo in numeric_results"):
                render_answer(dict(draft(), explanation=text), state())
        with self.assertRaises(ValueError):
            render_answer(dict(draft(), learning_notes=["x" * 321]), state())
        render_answer(dict(draft(), explanation="1. Si applica Ohm a R1.\n2. Si controlla il risultato."), state())

    def test_input_quantities_are_allowed_but_results_and_invented_inputs_are_not(self):
        from langchain_core.messages import HumanMessage
        from schemas import ModelQuestion
        evidence = dict(state(), messages=[HumanMessage(content=ModelQuestion(
            question="Calcola la corrente con 18 V e 3 ohm.").model_dump_json())])
        result = render_answer(dict(draft(6, "A"), explanation="Con 18 V e 3 ohm si applica I = V/R."), evidence)
        self.assertIn("18 V", result.response)
        self.assertIn("6 A", result.response)
        for text in ("Con 19 V si applica Ohm.", "Il risultato è 6 A."):
            with self.assertRaisesRegex(ValueError, "solo in numeric_results"):
                render_answer(dict(draft(6, "A"), explanation=text), evidence)
        render_answer(dict(draft(108, "W"), explanation="Si usa P = V^{2}/R."), evidence)

    def test_units_implicit_in_the_question_can_come_from_successful_typed_inputs(self):
        from langchain_core.messages import HumanMessage
        from schemas import ModelQuestion
        current = dict(state(), messages=[HumanMessage(content=ModelQuestion(
            question="v(t)=15 sin(2 pi 60 t) V, t in secondi; calcola a t=5 ms.").model_dump_json())],
            trace=[{"tool": "sine_voltage", "ok": True, "input": {
                "amplitude": {"value": 15, "unit": "V"}, "frequency": {"value": 60, "unit": "Hz"},
                "time": {"value": 5, "unit": "ms"}}}])
        text = "La sorgente ha picco 15 V e frequenza 60 Hz. Si usa la sinusoide."
        render_answer(dict(draft(14.2658477444273), explanation=text), current)
        current["trace"][0]["ok"] = False
        with self.assertRaises(ValueError):
            render_answer(dict(draft(14.2658477444273), explanation=text), current)

    def test_nominal_circuit_inputs_are_current_and_never_confused_with_measurements(self):
        import json
        from langchain_core.messages import HumanMessage, ToolMessage
        from schemas import ModelQuestion
        question = HumanMessage(content=ModelQuestion(question="Leggi la corrente di R1.").model_dump_json())
        snapshot = ToolMessage(name="getCircuitSnapshot", tool_call_id="current", content=json.dumps({"ok": True,
            "data": {"netlist": {"components": [{"type": "resistor", "params": {"R": 3, "ratedPower": 200}}]},
                     "components": {"R1": {"data": {"p": 108}}}}}))
        current = dict(state("getCircuitSnapshot", True), messages=[question, snapshot])
        packet = dict(draft(6, "A"), explanation="R1 ha parametri nominali 3 ohm e 200 W. Si legge la corrente.")
        render_answer(packet, current)
        with self.assertRaises(ValueError):
            render_answer(dict(packet, explanation="La potenza misurata è 108 W."), current)
        # Anche riusando un ID, una lettura prima della domanda resta storica.
        with self.assertRaises(ValueError):
            render_answer(packet, dict(current, messages=[snapshot, question]))
        with self.assertRaises(ValueError):
            render_answer(packet, dict(current, evidence=[]))
        # Leggere una resistenza nominale dalla netlist non è un calcolo né
        # richiede misure convergenti: resta un dato della configurazione.
        nominal = dict(state("getCircuitSnapshot", False), messages=[question, snapshot])
        answer = render_answer(dict(draft(3, "ohm"), explanation="Si legge il parametro nominale di R1."), nominal)
        self.assertEqual((answer.kind, answer.uses_measurements), ("circuit", False))
        with self.assertRaises(ValueError):
            render_answer(dict(draft(4, "ohm"), explanation="Si legge il parametro nominale di R1."), nominal)


class GraphIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_context_pressure_keeps_the_final_contract_available(self):
        from langchain_core.tools import StructuredTool
        from dataclasses import replace
        from schemas import NoInput

        async def unused():
            raise AssertionError("Nessun tool operativo deve essere eseguito")
        tool = StructuredTool.from_function(coroutine=unused, name="unused", args_schema=NoInput,
            description="x" * 20000)
        model = FakeModel([answer("Serve una domanda più mirata.", kind="limitation")])
        result = await create_graph(replace(Settings(), context_max_tokens=9000), model=model,
            tools=[tool]).compile().ainvoke(input_state("Ciao"))
        self.assertEqual(result["answer"]["kind"], "limitation")
        self.assertEqual(result["metrics"]["model_calls"], 1)
        self.assertLess(result["metrics"]["prompt_tokens_estimate"], 9000)

    async def test_physical_calculation_through_the_real_graph_without_browser(self):
        from calculation_tools import calculation_tools
        model = FakeModel([call("power_from_current", {"current": {"value": 20, "unit": "mA"},
            "resistance": {"value": 1, "unit": "kohm"}}), answer("Si usa I²·R.", numbers=[(.4, "W")])])
        result = await create_graph(Settings(), model=model, tools=calculation_tools()).compile().ainvoke(input_state("Potenza RMS?"))
        self.assertEqual(result["answer"]["kind"], "theory")
        self.assertFalse(result["answer"]["uses_measurements"])
        self.assertEqual(result["answer"]["numeric_results"][0]["value"], .4)
        self.assertIn("0.4 W", result["answer"]["response"])

    async def test_previous_turn_cannot_supply_numeric_provenance(self):
        from langgraph.checkpoint.memory import InMemorySaver
        async def snapshot():
            return {"revision": 3, "converged": True, "measurementsAvailable": True}
        model = FakeModel([call(), answer("Misura di R1.", numbers=[(3, "V")]),
            answer("Confermo R1.", numbers=[(3, "V")]), answer("Occorre rileggere il circuito.", kind="limitation")])
        graph = create_graph(Settings(), model=model, tools=[custom_tool(snapshot)]).compile(checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "old-evidence"}}
        await graph.ainvoke(input_state("Misura"), config)
        result = await graph.ainvoke(input_state("Conferma"), config)
        self.assertEqual(result["schema_errors"], 1)
        self.assertEqual(result["answer"]["evidence_ids"], [])
        self.assertEqual(result["answer"]["kind"], "limitation")
