"""Unica rappresentazione dei numeri; metadati derivati solo dal turno corrente."""
import re
import json

from langchain_core.messages import HumanMessage, ToolMessage

from circuit_ai.contracts.answer import AnswerDraft
from circuit_ai.tools.physics import TOOLS
from circuit_ai.verification.numbers import NUMBER, mentions, normalized, same
from circuit_ai.contracts.shared import Evidence, SubmitAnswer

CIRCUIT_TOOLS = {"getCircuitSnapshot", "getNetlist", "runDC", "runTransient", "measureComponent", "measureNode"}
NUMERIC_TOOLS = {*TOOLS, "calculate", "simulateCircuit"}
PLAIN_NUMBER = re.compile(r"(?<![\w.,])" + NUMBER + r"(?!\w|[.,]\d)")
MATH_BLOCK = re.compile(r"\$\$.*?\$\$|(?<!\$)\$(?!\$).*?(?<!\$)\$(?!\$)|\\\(.*?\\\)|\\\[.*?\\\]", re.DOTALL)
CHARGING_IDENTITY = re.compile(r"(?<![\w.,])1(?=\s*[-−]\s*(?:e\s*\^\s*\{[^{}]*[A-Za-z][^{}]*\}|\\exp\s*\(\s*[-−]?[A-Za-z\\]))")
# Unità dei parametri nominali comuni, dichiarate in src/library/passives.ts
# e sources.ts. Non inferire unità di parametri sconosciuti o di misure.
PARAMETER_UNITS = {
    "resistor": {"R": "ohm", "ratedPower": "W", "deratingStart": "°C", "maxTemperature": "°C",
                 "thermalResistance": "°C/W", "thermalCapacity": "J/°C"},
    "capacitor": {"C": "F"}, "inductor": {"L": "H"},
    "vdc": {"V": "V"}, "idc": {"I": "A"},
    "vsin": {"amp": "V", "freq": "Hz", "offset": "V"},
    "pulse": {"Vh": "V", "Vl": "V", "freq": "Hz", "duty": "%"},
}


def circuit_inputs(state, current_messages):
    """Solo configurazione nominale da letture riuscite e correnti, mai misure."""
    available = {e["call_id"]: e["tool"] for e in state.get("evidence", [])}
    for message in current_messages:
        if not isinstance(message, ToolMessage) or available.get(message.tool_call_id) != message.name:
            continue
        if message.name not in {"getCircuitSnapshot", "getNetlist", "measureComponent"}:
            continue
        envelope = json.loads(message.content)
        if not envelope.get("ok"):
            continue
        data = envelope["data"]
        if message.name == "getCircuitSnapshot":
            components = data.get("netlist", {}).get("components", [])
        elif message.name == "getNetlist":
            components = data.get("components", [])
        else:
            components = [data]
        for component in components:
            for key, unit in PARAMETER_UNITS.get(component.get("type"), {}).items():
                value = component.get("params", {}).get(key)
                if type(value) in (int, float):
                    number, canonical = normalized(value, unit)
                    yield float(number), canonical


def validate_explanation(draft, state):
    """Consente dati della domanda, non risultati numerici duplicati nel testo."""
    question = ""
    current_messages = []
    for message in reversed(state.get("messages", [])):
        if isinstance(message, HumanMessage):
            question = json.loads(message.content)["question"]
            break
        current_messages.append(message)
    givens = mentions(question)
    # Una formula può avere unità implicite: i parametri fisici esplicitati
    # in una chiamata riuscita sono ingressi del calcolo, non nuovi risultati.
    # Non ne viene certificata l'associazione semantica con la domanda.
    def input_quantities(value):
        if isinstance(value, dict):
            if isinstance(value.get("unit"), str) and isinstance(value.get("value"), (int, float)):
                number, unit = normalized(value["value"], value["unit"])
                yield float(number), unit
            for nested in value.values():
                yield from input_quantities(nested)
        elif isinstance(value, list):
            for nested in value:
                yield from input_quantities(nested)
    tool_inputs = []
    for trace in state.get("trace", []):
        if trace["ok"] and trace["tool"] in {*TOOLS, "calculate"}:
            tool_inputs.extend(input_quantities(trace["input"]))
    tool_inputs.extend(circuit_inputs(state, current_messages))
    results = [normalized(n.value, n.unit) for n in draft.numeric_results]
    prose = re.sub(r"(?m)^\s*\d+[.)]\s+", "", draft.explanation)
    for mention in reversed(mentions(prose)):
        duplicate = any(unit == mention.unit and same(mention.value, value) for value, unit in results)
        given = (any(g.unit == mention.unit and same(g.value, mention.value) for g in givens)
                 or any(unit == mention.unit and same(value, mention.value) for value, unit in tool_inputs))
        if duplicate or not given:
            reason = "è già presente in numeric_results" if duplicate else "non è un dato nominale verificato o un ingresso della domanda"
            raise ValueError(f"Inserire i risultati solo in numeric_results. Rimuovere da explanation {mention.quote!r}: {reason}. "
                "Riscrivere explanation senza cifre tranne gli ID dei componenti; mantenere i valori affidabili in numeric_results.")
        prose = prose[:mention.start] + " " * (mention.end - mention.start) + prose[mention.end:]
    # Gli esponenti simbolici sono parte della formula, non un valore calcolato.
    prose = re.sub(r"(?:\^|\*\*)\s*\{?[+−-]?\d+\}?", "", prose)
    # L'identità 1−exp(−t/τ) è una formula, non una misura adimensionale.
    # Si maschera solo l'unità algebrica in un blocco matematico con esponente
    # simbolico; un risultato come τ=1 s o G=1 resta soggetto ai controlli.
    prose = MATH_BLOCK.sub(lambda block: CHARGING_IDENTITY.sub(" ", block[0]), prose)
    given_numbers = [m[0].replace(",", ".").replace("−", "-") for m in PLAIN_NUMBER.finditer(question)]
    for token in PLAIN_NUMBER.finditer(prose):
        value = token[0].replace(",", ".").replace("−", "-")
        duplicate = any(unit == "1" and same(value, result) for result, unit in results)
        if duplicate or not any(same(value, given) for given in given_numbers):
            raise ValueError(f"Inserire i risultati solo in numeric_results. Rimuovere da explanation il numero {token[0]!r}: "
                "è duplicato o non è un ingresso verificato. Usare formule simboliche e testo qualitativo; ID come R1 ammessi.")


def render_answer(args, state):
    draft = AnswerDraft.model_validate(args)
    validate_explanation(draft, state)
    evidence = [Evidence.model_validate(e) for e in state.get("evidence", [])]
    consistent = state.get("revision_consistent", True)
    if not consistent and draft.numeric_results:
        raise ValueError("Revisioni incoerenti: rimuovere i risultati e spiegare che occorre ripetere l'analisi")
    valid_measurement = any(e.measurement_valid for e in evidence)
    current_messages = []
    for message in reversed(state.get("messages", [])):
        if isinstance(message, HumanMessage):
            break
        current_messages.append(message)
    nominal = list(circuit_inputs(state, current_messages))
    nominal_only = bool(draft.numeric_results) and all(
        any(unit == result_unit and same(value, result_value) for value, unit in nominal)
        for result_value, result_unit in (normalized(n.value, n.unit) for n in draft.numeric_results))
    if draft.numeric_results and not (valid_measurement or nominal_only or any(e.tool in NUMERIC_TOOLS for e in evidence)):
        raise ValueError("I risultati numerici richiedono un tool di calcolo riuscito o misure convergenti di questo turno; non eseguire calcoli a mente")
    circuit = any(e.tool in CIRCUIT_TOOLS for e in evidence)
    response = draft.explanation
    if not consistent:
        response += "\n\nIl circuito è cambiato durante le letture: ripeti l'analisi sulla configurazione attuale."
    if draft.numeric_results:
        # Si formatta il valore dichiarato dal modello, mai il ground truth.
        lines = [f"- {n.subject} — {n.quantity} ({n.context}): {n.value:.12g} "
                 + ("adimensionale" if n.unit == "1" else n.unit) for n in draft.numeric_results]
        response += "\n\n" + "\n".join(lines)
    return SubmitAnswer(response=response,
        kind="limitation" if draft.limitation or not consistent else "circuit" if circuit else "theory",
        evidence_ids=list(dict.fromkeys(e.call_id for e in evidence)),
        uses_measurements=bool(circuit and valid_measurement and draft.numeric_results and consistent and not draft.limitation),
        learning_notes=draft.learning_notes, numeric_results=draft.numeric_results)
