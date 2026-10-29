"""Dichiarazioni scalari esplicite: confronto con dati indipendenti, non con NLI."""
import re

from numeric_verification import mentions, normalized, same
from verification_schemas import NliNumericDeclaration, NliNumericProof


CASE_PREFIX = 'Per il modello dichiarato:'


def declaration(text, normalize):
    text = normalize(text)
    prefix = text.startswith(CASE_PREFIX)
    if prefix:
        text = text[len(CASE_PREFIX):].strip()
    match = re.fullmatch(r'([^=:\n<>]+?)\s*[=:]\s*(.+)', text)
    if not match:
        return None
    label, measure = match[1].strip(), match[2].strip()
    observed = mentions(measure)
    if len(observed) != 1:
        return None
    value = observed[0]
    # Niente formule, commenti, condizioni o altri valori nascosti dopo l'unità.
    remainder = measure[:value.start] + measure[value.end:]
    if remainder.strip() not in {'', '.'}:
        return None
    return NliNumericDeclaration(label=label, value=value.value, unit=value.unit, case_model_prefix=prefix)


def compare(actual_text, source_text, references, normalize):
    actual, source = declaration(actual_text, normalize), declaration(source_text, normalize)
    if actual is None or source is None or actual.label != source.label or actual.unit != source.unit:
        return None
    matches = [(index, ref) for index, ref in enumerate(references)
        if normalize(ref.label) == actual.label and normalized(ref.value, ref.unit)[1] == actual.unit]
    if len(matches) != 1:
        return None  # Ambiguità: non scegliere il riferimento in base al numero.
    index, ref = matches[0]
    expected, unit = normalized(ref.value, ref.unit)
    if not same(source.value, expected, ref.absolute_tolerance, ref.relative_tolerance):
        raise ValueError('Fatto numerico incoerente con il dataset: ' + source.label)
    return NliNumericProof(reference_index=index, label=actual.label, actual_value=actual.value,
        source_value=source.value, expected_value=float(expected), unit=unit,
        absolute_tolerance=ref.absolute_tolerance, relative_tolerance=ref.relative_tolerance,
        case_model_prefix=actual.case_model_prefix or source.case_model_prefix)


def status(proof):
    return 'pass' if same(proof.actual_value, proof.expected_value,
        proof.absolute_tolerance, proof.relative_tolerance) else 'fail'


def valid_proof(check):
    """Ricontrolla la prova dal testo: uno score assente non diventa un pass."""
    from nli_context import normalize
    p = check.preparation
    if not (p and p.reason == 'numeric_reference' and p.numeric_proof and p.coverage_complete
            and check.scores is None and p.premise_spans and p.hypothesis_spans):
        return False
    origins = ('reference', 'response') if check.direction == 'faithfulness' else ('response', 'reference')
    if (any(s.origin != origins[0] for s in p.premise_spans)
            or any(s.origin != origins[1] for s in p.hypothesis_spans)
            or check.premise != normalize(p.raw_premise) or check.hypothesis != normalize(p.raw_hypothesis)):
        return False
    actual, source = ((p.raw_hypothesis, p.raw_premise) if check.direction == 'faithfulness'
                      else (p.raw_premise, p.raw_hypothesis))
    actual, source = declaration(actual, normalize), declaration(source, normalize)
    proof = p.numeric_proof
    return bool(actual and source and actual.label == source.label == proof.label
        and actual.unit == source.unit == proof.unit and actual.value == proof.actual_value
        and source.value == proof.source_value
        and proof.case_model_prefix == (actual.case_model_prefix or source.case_model_prefix)
        and same(source.value, proof.expected_value, proof.absolute_tolerance, proof.relative_tolerance)
        and check.status == status(proof))
