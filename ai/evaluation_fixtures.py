"""Contesti analitici controllati del dataset; nessun calcolo dipende da un LLM."""
from copy import deepcopy
import math

from schemas import FixtureScenario


def thermal(power, rating, ambient, time_s=None):
    theta = 85 / rating
    allowed = rating * max(0., min(1., (155 - ambient) / 85))
    equilibrium = ambient + power * theta
    temperature = equilibrium if time_s is None else ambient + power * theta * -math.expm1(-time_s / (theta * .02))
    status = "thermal-limit" if temperature >= 155 else "overload" if power > allowed * (1 + 1e-9) else "near-limit" if allowed and power / allowed >= .8 else "ok"
    data = {"ratedPower": rating, "allowedPower": allowed, "ambientTemperature": ambient,
        "deratingStart": 70, "maxTemperature": 155, "thermalResistance": theta,
        "thermalResistanceEstimated": True, "thermalCapacity": .02, "thermalTimeConstant": theta * .02,
        "temperature": temperature, "steadyTemperature": equilibrium,
        "temperatureMode": "steady-state" if time_s is None else "transient", "meanPower": power,
        "powerDuration": time_s or 0, "energy": power * (time_s or 0),
        "peakPowerOverload": power > allowed, "meanPowerOverload": power > allowed,
        "temperatureExceeded": temperature >= 155, "powerStatus": status, "powerRatingValid": True}
    if allowed:
        data.update(powerLoadPercent=power / allowed * 100, peakPowerLoadPercent=power / allowed * 100)
    return data


def component(id, kind, params, nets):
    return {"id": id, "type": kind, "name": kind, "params": params,
            "pins": [{"name": name, "net": net} for name, net in zip(["a", "b"], nets)]}


def values(v, i, **data):
    return {"data": {"v": v, "i": i, "p": v * i, **data}, "pinCurrents": [i, -i]}


def build_fixture(scenario: FixtureScenario, *, time_s=None, dc=False):
    p = scenario.params
    voltage, resistance, rating, ambient = p.get("V", 10), p.get("R", 100), p.get("ratedPower", .25), p.get("ambient", 25)
    time_s = p.get("time_s", .1) if time_s is None else time_s
    resistor = {"R": resistance, "ratedPower": rating, "deratingStart": 70, "maxTemperature": 155,
                "thermalResistance": 0, "thermalCapacity": .02}
    components = [component("R1", "resistor", resistor, ["n1", "gnd"])]
    nodes = {"n1": voltage, "gnd": 0.}
    current = voltage / resistance
    if scenario.kind == "divider":
        r2 = p.get("R2", 1000)
        current = voltage / (resistance + r2)
        nodes["n2"] = current * r2
        components[0]["pins"][1]["net"] = "n2"
        components.append(component("R2", "resistor", {**resistor, "R": r2}, ["n2", "gnd"]))
    elif scenario.kind == "rc":
        capacitance = p.get("C", 1e-6)
        nodes["n2"] = voltage if dc else voltage * -math.expm1(-time_s / (resistance * capacitance))
        current = (voltage - nodes["n2"]) / resistance
        components[0]["pins"][1]["net"] = "n2"
        components.append(component("C1", "capacitor", {"C": capacitance}, ["n2", "gnd"]))
    elif scenario.kind == "ac":
        nodes["n1"] = 0. if dc else voltage * math.sin(2 * math.pi * p.get("frequency", 50) * time_s)
        current = nodes["n1"] / resistance
    outputs = {"R1": values(nodes["n1"] - nodes.get("n2", 0), current)}
    if scenario.kind not in {"rc", "ac"} or dc:
        outputs["R1"]["data"].update(thermal(outputs["R1"]["data"]["p"], rating, ambient, None if dc else time_s))
    if scenario.kind == "divider":
        outputs["R2"] = values(nodes["n2"], current, **thermal(current * current * r2, rating, ambient, None if dc else time_s))
    if scenario.kind == "rc":
        outputs["C1"] = values(nodes["n2"], current)
    if scenario.kind == "ac" and not dc:
        w = 2 * math.pi * p.get("frequency", 50)
        mean = voltage * voltage / resistance * (.5 - math.sin(2 * w * time_s) / (4 * w * time_s)) if time_s else 0.
        power = outputs["R1"]["data"]["p"]
        outputs["R1"]["data"].update(meanPower=mean, ratedPower=rating, allowedPower=rating,
            ambientTemperature=ambient, powerDuration=time_s, energy=mean * time_s,
            powerLoadPercent=100 * mean / rating, peakPowerLoadPercent=100 * power / rating,
            meanPowerOverload=mean > rating, peakPowerOverload=power > rating,
            powerStatus="overload" if mean > rating else "peak-overload" if power > rating else "ok")
    source_kind = "vsin" if scenario.kind == "ac" else "vdc"
    source_params = {"amp": voltage, "freq": p.get("frequency", 50), "offset": 0} if source_kind == "vsin" else {"V": voltage}
    components.extend([component("V1", source_kind, source_params, ["n1", "gnd"]),
                       {"id": "GND1", "type": "ground", "name": "Massa", "params": {}, "pins": [{"name": "gnd", "net": "gnd"}]}])
    outputs["V1"] = values(nodes["n1"], -current)
    outputs["GND1"] = {"data": {}, "pinCurrents": [0.]}
    if scenario.adversarial_payload:
        components[0]["name"] = scenario.adversarial_payload
    converged = scenario.kind != "nonconvergent"
    if not converged:
        components = [c for c in components if c["type"] != "ground"]
        nodes = {name: None for name in nodes}
        outputs = {id: {"data": {}, "pinCurrents": [None] * len(out["pinCurrents"])} for id, out in outputs.items() if id != "GND1"}
    diagnostics = {"iterations": 1, "residual": 0. if converged else None,
        "floatingNets": [] if converged else ["n1"], "warnings": [] if converged else ["Circuito senza riferimento affidabile"]}
    netlist = {"revision": scenario.revision, "components": components, "wires": len(components) + 1, "nets": list(nodes), "hasGround": converged}
    result = {"revision": scenario.revision, "converged": converged, "diagnostics": diagnostics, "nodeVoltages": nodes, "components": outputs}
    if dc:
        return result
    available = scenario.kind != "no-frame"
    return {**result, "netlist": netlist,
        "environment": {"temperature": ambient, "light": 50., "pressure": 101., "magneticField": 0., "humidity": 50.},
        "time_s": time_s if available else None, "measurementsAvailable": available,
        "converged": converged if available else False,
        "components": outputs if available else {}, "nodeVoltages": nodes if available else {}}


def transient(scenario, duration_ms=100, dt_us=100):
    if scenario.kind == "no-frame":
        scenario = scenario.model_copy(update={"kind": "resistor"})
    duration = min(duration_ms / 1000, .01)
    times = [duration * k / 4 for k in range(5)]
    samples = [build_fixture(scenario, time_s=t) for t in times]
    last = samples[-1]
    return {"revision": scenario.revision, "converged": last["converged"], "diagnostics": last["diagnostics"],
        "components": last["components"], "dt_us": dt_us, "actualDuration_s": duration,
        "truncated": duration + 1e-12 < duration_ms / 1000, "time_s": times,
        "nodeVoltages": {net: [s["nodeVoltages"][net] for s in samples] for net in last["nodeVoltages"]}}


class FixtureRuntime:
    def __init__(self, fixtures):
        self.fixtures = fixtures
        self.scenario = None
        self.calls = 0

    def activate(self, fixture_id):
        self.scenario = self.fixtures[fixture_id]
        self.calls = 0

    def bridge_factory(self, url):
        runtime = self
        class Bridge:
            async def __aenter__(self):
                if runtime.scenario.kind == "offline":
                    raise ConnectionError("Browser non collegato")
                return self
            async def __aexit__(self, *_): pass
            async def call(self, name, **args):
                return runtime.call(name, args)
        return Bridge()

    def call(self, name, args):
        self.calls += 1
        snapshot = build_fixture(self.scenario)
        dc = build_fixture(self.scenario, dc=True)
        if name == "getCircuitSnapshot": result = snapshot
        elif name == "getNetlist": result = snapshot["netlist"]
        elif name == "runDC": result = dc
        elif name == "runTransient": result = transient(self.scenario, args["duration_ms"], args.get("dt_us", 100))
        elif name == "measureComponent":
            id = args.get("componentId")
            component = next((c for c in snapshot["netlist"]["components"] if c["id"] == id), None)
            if not component: return {"error": "Componente sconosciuto", "disponibili": list(dc["components"])}
            result = {"id": id, "type": component["type"], "params": component["params"], "revision": snapshot["revision"],
                "time_s": snapshot["time_s"], "converged": snapshot["converged"], "live": snapshot["components"].get(id)}
        elif name == "measureNode":
            node = args.get("nodeId")
            if node not in snapshot["nodeVoltages"]: return {"error": "Nodo sconosciuto o frame live non disponibile", "nodiDisponibili": snapshot["netlist"]["nets"]}
            result = {"nodeId": node, "liveVoltage": snapshot["nodeVoltages"][node], "liveTime": snapshot["time_s"],
                "dcVoltage": dc["nodeVoltages"][node], "converged": snapshot["converged"], "dcConverged": dc["converged"],
                "diagnostics": snapshot["diagnostics"], "revision": snapshot["revision"]}
        elif name == "listComponents":
            result = {"library": [{"type": "resistor", "name": "Resistenza", "description": "Resistore ideale con dimensionamento termico didattico",
                "params": ["R (Resistenza, ohm)", "ratedPower (Potenza nominale, W)"]}]}
        elif name == "getLessonState":
            result = {"lessonId": "partitore", "title": "Partitore", "objective": "Comprendere il partitore",
                "step": {"index": 0, "total": 1, "text": "Osserva la tensione"}, "ab": None, "probes": [], "presentazione": False}
        else: return {"error": "Tool sconosciuto"}
        result = deepcopy(result)
        if "revision" in result and self.scenario.kind == "revision-change" and self.calls > 1:
            result["revision"] = self.scenario.revision + 1
            if "netlist" in result: result["netlist"]["revision"] = self.scenario.revision + 1
        return result
