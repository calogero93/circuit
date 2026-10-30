import unittest

from pydantic import BaseModel

import circuit_ai.contracts.calculations as calculation_schemas
from circuit_ai.tools.engine import arithmetic
from circuit_ai.tools.physics import calculation_tools, execute
from circuit_ai.core.config import Settings
from circuit_ai.tools.catalog import make_tools, tool_schemas


def q(value, unit):
    return {"value": value, "unit": unit}


class CalculationTests(unittest.TestCase):
    def test_ohm_and_power_dc_rms_with_prefixes(self):
        args = {"voltage": q(18, "V"), "resistance": q(3, "ohm")}
        self.assertEqual(execute("resistor_current", args)[0]["value"], 6)
        self.assertEqual(execute("power_from_voltage", args)[0]["value"], 108)
        power, _ = execute("power_from_current", {"current": q(20, "mA"), "resistance": q(1, "kΩ")})
        self.assertEqual(power["unit"], "W")
        self.assertAlmostEqual(power["value"], .4)

    def test_loaded_divider_does_not_ignore_the_load(self):
        output, _ = execute("loaded_divider_voltage", {"voltage": q(9, "V"), "upper": q(1, "kohm"),
            "lower": q(2.2, "kohm"), "load": q(1, "kohm")})
        self.assertEqual(output["unit"], "V")
        self.assertAlmostEqual(output["value"], 11 / 3)

    def test_series_target_and_sine_physical_units(self):
        args = {"voltage": q(9, "V"), "resistors": [dict(id="R" + str(i + 1), **q(v, "kohm"))
            for i, v in enumerate([3, 10, 5])], "target_id": "R2"}
        self.assertEqual(execute("series_voltage_drop", args)[0]["value"], 5)
        with self.assertRaisesRegex(ValueError, "assente"):
            execute("series_voltage_drop", dict(args, target_id="R9"))
        args["resistors"][0]["id"] = "R2"
        with self.assertRaisesRegex(ValueError, "duplicati"):
            execute("series_voltage_drop", args)
        output, _ = execute("sine_voltage", {"amplitude": q(15, "V"), "frequency": q(60, "Hz"), "time": q(5, "ms")})
        self.assertEqual(output["unit"], "V")
        self.assertAlmostEqual(output["value"], 14.2658477444273)

    def test_invalid_units_nonfinite_and_nonpositive_resistances(self):
        for current, resistance in [(q(20, "V"), q(1, "ohm")), (q(float("nan"), "A"), q(1, "ohm")),
                (q(1, "A"), q(0, "ohm")), (q(1, "A"), q(-1, "ohm"))]:
            with self.assertRaises(ValueError):
                execute("power_from_current", {"current": current, "resistance": resistance})

    def test_math_errors_are_actionable_without_changing_the_expression(self):
        with self.assertRaisesRegex(ValueError, r"\*\*"):
            arithmetic("2^3", [])
        with self.assertRaisesRegex(ValueError, "inutilizzate"):
            arithmetic("15*sin(2*pi*60*.005)", [{"name": "amplitude", **q(15, "V")}])
        with self.assertRaisesRegex(ValueError, "Variabile sconosciuta"):
            arithmetic("vin/r", [{"name": "r", **q(1, "ohm")}])

    def test_all_fields_are_described_and_tools_have_public_schemas(self):
        for cls in vars(calculation_schemas).values():
            if isinstance(cls, type) and issubclass(cls, BaseModel) and cls.__module__ == 'circuit_ai.contracts.calculations':
                for name, field in cls.model_fields.items():
                    self.assertTrue(field.description, f"{cls.__name__}.{name}")
        self.assertIn("power_from_current", tool_schemas())
        self.assertIn("power_from_current", {t.name for t in make_tools(Settings())})


class ToolInvocationTests(unittest.IsolatedAsyncioTestCase):
    async def test_langchain_executes_the_bound_formula_and_validates_units(self):
        tools = {t.name: t for t in calculation_tools()}
        result = await tools["power_from_current"].ainvoke({"current": q(20, "mA"), "resistance": q(1, "kohm")})
        self.assertEqual((result["value"], result["unit"]), (.4, "W"))
        result = await tools["resistor_current"].ainvoke({"voltage": q(9, "V"), "resistance": q(3, "ohm")})
        self.assertEqual((result["value"], result["unit"]), (3, "A"))
        with self.assertRaises(ValueError):
            await tools["power_from_current"].ainvoke({"current": q(20, "V"), "resistance": q(1, "ohm")})
