"""Aritmetica decimale e dimensionale locale: nessun eval, I/O o solver browser."""
import ast
from dataclasses import dataclass
from decimal import Decimal, DecimalException, ROUND_HALF_EVEN, localcontext
import math
import re

from schemas import CalculatorInput, CalculatorOutput

# Dimensioni espresse nelle basi V, A, s.
BASE_UNITS = {"1": (0, 0, 0), "V": (1, 0, 0), "A": (0, 1, 0), "s": (0, 0, 1),
    "ohm": (1, -1, 0), "W": (1, 1, 0), "Hz": (0, 0, -1), "F": (-1, 1, 1), "H": (1, -1, 1)}
PREFIXES = {"p": "1e-12", "n": "1e-9", "u": "1e-6", "m": "1e-3", "k": "1e3", "M": "1e6"}
UNITS = {unit: (Decimal(1), dims) for unit, dims in BASE_UNITS.items()}
UNITS.update({prefix + unit: (Decimal(scale), dims) for prefix, scale in PREFIXES.items()
    for unit, dims in BASE_UNITS.items() if unit != "1"})
UNIT_PATTERN = "|".join(re.escape(u) for u in sorted(UNITS, key=len, reverse=True))
NUMBER = r"[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?"
QUANTITY = re.compile(r"(?<![\w.,])(" + NUMBER + r")\s*(" + UNIT_PATTERN + r")(?![\w²³]|\s*(?:\^|/))")


@dataclass(frozen=True)
class Value:
    number: Decimal
    dims: tuple[int, int, int] = (0, 0, 0)


def unit_name(unit):
    return unit.replace("Ω", "ohm").replace("Ω", "ohm").replace("µ", "u").replace("μ", "u")


def quantity(value, unit):
    unit = unit_name(unit)
    if unit not in UNITS:
        raise ValueError("Unità non supportata: usare unità SI e prefissi dichiarati")
    scale, dims = UNITS[unit]
    return bounded(Value(Decimal(str(value)) * scale, dims))


def bounded(value):
    if not value.number.is_finite() or (value.number and abs(value.number.adjusted()) > 100):
        raise ValueError("Valore fuori dal dominio numerico ammesso (esponenti decimali da -100 a 100)")
    if any(abs(n) > 24 for n in value.dims):
        raise ValueError("Dimensioni oltre il limite del calcolatore")
    return value


def same_dimensions(left, right):
    if left.dims != right.dims:
        raise ValueError("Unità dimensionalmente incompatibili")


def evaluate(expression, variables):
    try:
        tree = ast.parse(expression, mode="eval")
    except (SyntaxError, ValueError) as exc:
        raise ValueError("Espressione aritmetica non valida") from exc
    if sum(1 for _ in ast.walk(tree)) > 96:
        raise ValueError("Espressione troppo complessa")

    def visit(node, depth=0):
        if depth > 16:
            raise ValueError("Espressione troppo profonda")
        child = lambda item: visit(item, depth + 1)
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            literal = ast.get_source_segment(expression, node)
            if len(literal) > 48 or not re.fullmatch(r"(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", literal):
                raise ValueError("Costante numerica non supportata")
            return bounded(Value(Decimal(literal)))
        if isinstance(node, ast.Name) and node.id in variables:
            return variables[node.id]
        if isinstance(node, ast.Name):
            raise ValueError(f"Variabile sconosciuta {node.id}: nomi disponibili {', '.join(variables) or '(nessuno)'}. Rispettare maiuscole/minuscole")
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = child(node.operand)
            return bounded(Value(-value.number if isinstance(node.op, ast.USub) else value.number, value.dims))
        if isinstance(node, ast.BinOp):
            left, right = child(node.left), child(node.right)
            if isinstance(node.op, (ast.Add, ast.Sub)):
                same_dimensions(left, right)
                number = left.number + right.number if isinstance(node.op, ast.Add) else left.number - right.number
                return bounded(Value(number, left.dims))
            if isinstance(node.op, (ast.Mult, ast.Div)):
                divide = isinstance(node.op, ast.Div)
                if divide and not right.number:
                    raise ValueError("Divisione per zero")
                number = left.number / right.number if divide else left.number * right.number
                return bounded(Value(number, tuple(a - b if divide else a + b for a, b in zip(left.dims, right.dims))))
            if isinstance(node.op, ast.Pow):
                if right.dims != (0, 0, 0) or right.number != right.number.to_integral_value() or abs(right.number) > 8:
                    raise ValueError("Esponente intero adimensionale richiesto, da -8 a 8")
                if not left.number and right.number <= 0:
                    raise ValueError("Potenza dello zero non definita")
                exponent = int(right.number)
                return bounded(Value(left.number ** exponent, tuple(a * exponent for a in left.dims)))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            name = node.func.id
            if name not in {"sqrt", "abs", "mean", "rms"} or not 1 <= len(node.args) <= 16:
                raise ValueError("Funzione non supportata")
            values = [child(item) for item in node.args]
            first = values[0]
            if name in {"sqrt", "abs"}:
                if len(values) != 1:
                    raise ValueError("La funzione richiede un solo argomento")
                if name == "abs":
                    return Value(abs(first.number), first.dims)
                if first.number < 0 or any(a % 2 for a in first.dims):
                    raise ValueError("Radice non reale o dimensioni non rappresentabili")
                return bounded(Value(first.number.sqrt(), tuple(a // 2 for a in first.dims)))
            for value in values:
                same_dimensions(first, value)
            number = sum((v.number if name == "mean" else v.number ** 2 for v in values), Decimal(0)) / len(values)
            return bounded(Value(number if name == "mean" else number.sqrt(), first.dims))
        raise ValueError("Sono consentiti solo numeri, variabili e operatori/funzioni aritmetici dichiarati")
    return visit(tree.body)


def close(left, right):
    same_dimensions(left, right)
    return abs(left.number - right.number) <= Decimal("1e-6") * max(abs(left.number), abs(right.number))


def claimed_in_quote(claimed, text):
    text = unit_name(text.replace(r"\Omega", "Ω"))
    text = re.sub(r"\\(?:text|mathrm)\{\s*(" + UNIT_PATTERN + r")\s*\}", lambda m: m[1], text)
    text = re.sub(r"\\(?:[,;:! ]|quad\b|qquad\b)", " ", text)
    if claimed.dims == (0, 0, 0):
        dimensional_spans = [m.span() for m in QUANTITY.finditer(text) if UNITS[m[2]][1] != (0, 0, 0)]
        return any(not any(start <= m.start() and m.end() <= end for start, end in dimensional_spans)
            and close(Value(Decimal(m[0].replace(",", "."))), claimed)
            for m in re.finditer(r"(?<![\w.,])" + NUMBER + r"(?![\w.,])", text))
    for match in QUANTITY.finditer(text):
        value = quantity(match[1].replace(",", "."), match[2])
        if value.dims == claimed.dims and close(value, claimed):
            return True
    return False


def calculate(request: CalculatorInput, response_text: str):
    if request.response_quote not in response_text:
        raise ValueError("La citazione non è presente nel campo response.response dei dati correnti. Copiare un passaggio reale di quella risposta, non inventare un esempio")
    if len({variable.name for variable in request.variables}) != len(request.variables):
        raise ValueError("Nomi di variabili duplicati")
    try:
        with localcontext() as ctx:
            ctx.prec = 50
            ctx.rounding = ROUND_HALF_EVEN
            ctx.Emax, ctx.Emin = 1000, -1000
            variables = {value.name: quantity(value.value, value.unit) for value in request.variables}
            result = evaluate(request.expression, variables)
            claimed = quantity(request.claimed_value, request.claimed_unit) if request.claimed_value is not None else None
            if claimed is not None and not claimed_in_quote(claimed, request.response_quote):
                raise ValueError("Il risultato dichiarato non compare nella citazione")
            matches = close(result, claimed) if claimed is not None else None
            unit = next((name for name, dims in BASE_UNITS.items() if dims == result.dims), None)
            if unit is None:
                unit = " ".join(f"{name}^{power}" for name, power in zip(("V", "A", "s"), result.dims) if power)
            number = float(result.number)
            if not math.isfinite(number):
                raise ValueError("Risultato non finito")
            return CalculatorOutput(value=number, decimal_value=str(result.number), unit=unit,
                claimed_matches=matches, limitation="Verifica aritmetica e dimensioni sui dati forniti. Non certifica la scelta della formula, la provenienza dei valori, le associazioni ai componenti o le affermazioni non numeriche.")
    except DecimalException as exc:
        raise ValueError("Operazione oltre il dominio decimale ammesso") from exc
