"""Legge i valori originali e li confronta: l'LLM assegna ruoli, non riscrive numeri."""
from decimal import Decimal
import math
import re

from circuit_ai.contracts.verification import NumericCheck, NumericMention

NUMBER = r"[+−-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+−-]?\d+)?"
SCALES = {"1": ("1", 1), "%": ("percent", 1), "percent": ("percent", 1),
    "°C": ("degC", 1), "degC": ("degC", 1), "°C/W": ("degC/W", 1), "J/°C": ("J/degC", 1)}
SCALES.update({'dB':('dB',1),'deg':('deg',1),'°':('deg',1),'rad':('rad',1),
    r'^\circ':('deg',1),r'^{\circ}':('deg',1),'gradi':('deg',1),
    'volte':('1',1),'adimensionale':('1',1),'watts':('W',1),'watt':('W',1),
    'volts':('V',1),'volt':('V',1),'amperes':('A',1),'ampere':('A',1),'amps':('A',1)})
for base in ("V", "A", "W", "s", "Hz", "ohm", "F", "H", "J"):
    SCALES[base] = (base, 1)
    for prefix, scale in (("p", 1e-12), ("n", 1e-9), ("u", 1e-6), ("m", 1e-3), ("k", 1e3), ("M", 1e6)):
        SCALES[prefix + base] = (base, scale)
for prefix in ("", "p", "n", "u", "m", "k", "M"):
    SCALES[prefix + "Ω"] = SCALES[prefix + "ohm"]
for base in ("V", "A", "W", "s", "Hz", "ohm", "F", "H", "J", "Ω"):
    SCALES["µ" + base] = SCALES["u" + base]
    SCALES["μ" + base] = SCALES["u" + base]
UNIT = "|".join(re.escape(u) for u in sorted(SCALES, key=len, reverse=True) if u != "1")
TOKEN = re.compile(r"(?<![\w.,])(?P<number>" + NUMBER + r")\s*(?:\\[,;! ]\s*)*"
    r"(?P<unit>\\(?:text|mathrm)\{\s*(?:" + UNIT + r"|\\Omega)\s*\}|\\Omega|" + UNIT +
    r")(?![\w²³]|\s*(?:\^|/\s*[A-Za-z\\]))")


def normalized(value, unit):
    unit = unit.replace(r"\Omega", "Ω").strip()
    if unit not in SCALES:
        raise ValueError(f"Unità non supportata dal confronto: {unit}")
    canonical, scale = SCALES[unit]
    result = Decimal(str(value).replace(",", ".").replace('−','-')) * Decimal(str(scale))
    if not result.is_finite() or not math.isfinite(float(result)):
        raise ValueError("Quantità non finita")
    return result, canonical


def token_unit(match):
    unit = match['unit']
    wrapper = re.fullmatch(r"\\(?:text|mathrm)\{\s*(.*?)\s*\}", unit)
    return wrapper[1] if wrapper else unit


def mentions(text):
    output = []
    for match in TOKEN.finditer(text):
        unit = token_unit(match)
        value, unit = normalized(match['number'], unit)
        output.append(NumericMention(id=len(output), start=match.start(), end=match.end(),
            quote=match[0], value=float(value), unit=unit))
    if len(output) > 160:
        raise ValueError("Troppe occorrenze numeriche: nessuna troncatura silenziosa")
    return output


def same(value, expected, absolute=0, relative=1e-6):
    value, expected = Decimal(str(value).replace('−','-')), Decimal(str(expected).replace('−','-'))
    return abs(value - expected) <= max(Decimal(str(absolute)), Decimal(str(relative)) * abs(expected))


def validate_numeric_results(text, results):
    for result in results:
        value, unit = normalized(result.value, result.unit)
        if unit == "1":
            dimensional = [m.span() for m in TOKEN.finditer(text) if normalized(m['number'],token_unit(m))[1] != '1']
            found = any(not any(start <= m.start() and m.end() <= end for start, end in dimensional)
                and same(m[0].replace(',', '.'), value) for m in re.finditer(r"(?<![\w.,])" + NUMBER + r"(?![\w.,])", text))
        else:
            found = any(m.unit == unit and same(m.value, value) for m in mentions(text))
        if not found:
            raise ValueError("Valore/unità del risultato strutturato assenti dalla risposta originale")


def validate_inventory(payload, occurrences, inventory):
    bindings = {b.mention_id: b for b in inventory.bindings}
    if set(bindings) != {m.id for m in occurrences}:
        raise ValueError("L'inventario deve coprire tutte e sole le occorrenze, senza omissioni")
    for m in occurrences:
        b = bindings[m.id]
        if b.reference_index is None:
            continue
        if not 0 <= b.reference_index < len(payload.reference.numbers):
            raise ValueError("Indice del riferimento numerico non valido")
        ref = payload.reference.numbers[b.reference_index]
        _, unit = normalized(ref.value, ref.unit)
        if unit != m.unit:
            raise ValueError(f"Associazione non valida: mention_id={m.id} ha unità {m.unit}, reference_index={b.reference_index} ha unità {unit}. Correggere l'indice, non il numero.")
        wanted = re.findall(r"\bR\d+\b", ref.label)
        prefix = payload.response.response[max(0, m.start - 100):m.start]
        actual = re.findall(r"(?<![A-Za-z0-9])R\d+\b", prefix)
        if wanted and actual and wanted[-1] != actual[-1]:
            raise ValueError(f"Associazione non valida: mention_id={m.id} appartiene esplicitamente a {actual[-1]}, il riferimento a {wanted[-1]}. Non scegliere l'indice in base al valore.")


def verify_numbers(payload, occurrences, inventory):
    checks = []
    def add(mention, index, status, detail, expected=None):
        checks.append(NumericCheck(mention_id=mention.id if mention else None, reference_index=index,
            status=status, actual_value=mention.value if mention else None, expected_value=expected,
            unit=mention.unit if mention else None, detail=detail))
    validate_inventory(payload, occurrences, inventory)
    bindings = {b.mention_id: b for b in inventory.bindings}
    given = mentions(payload.question)
    covered = set()
    for m in occurrences:
        b = bindings[m.id]
        if b.role == "given":
            good = any(g.unit == m.unit and same(g.value, m.value) for g in given)
            add(m, None, "pass" if good else "review", "Dato presente nella domanda; associazione e condizioni richiedono anche controllo semantico." if good else "Il valore dichiarato come dato non compare con questa unità nella domanda.")
        elif b.role in {"refuted", "unknown"}:
            add(m, None, "review", "Confutazione o ruolo incerto: non equivale a un risultato verificato; serve risoluzione semantica.")
        elif b.reference_index is None:
            add(m, None, "review", "Risultato non coperto da un riferimento indipendente.")
        else:
            index = b.reference_index
            ref = payload.reference.numbers[index]
            expected, unit = normalized(ref.value, ref.unit)
            good = unit == m.unit and same(m.value, expected, ref.absolute_tolerance, ref.relative_tolerance)
            add(m, index, "pass" if good else "fail", f"Confronto con {ref.label}; componente esplicito, unità e tolleranze controllati. Le associazioni implicite e le ipotesi restano da valutare semanticamente.", float(expected))
            covered.add(index)
    for index, ref in enumerate(payload.reference.numbers):
        if index not in covered:
            add(None, index, "review", f"Nessun risultato associato a {ref.label}; la presenza altrove di un numero non basta.", ref.value)
    return checks


def aggregate(statuses):
    statuses = list(statuses)
    return "fail" if "fail" in statuses else "review" if "review" in statuses else "pass"
