"""NLI contestuale: provenienza originale, finestre complete e budget reali."""
import re

from numeric_verification import mentions
from verification_schemas import (NliAnchors, NliCheck, NliPassage, NliPreparation, NliSourceSpan,
                                  NliTextUnit)

PROTOCOL = {
    'version': 7,
    'pairing': 'contextual_response_and_reference_claims_to_complete_token_bounded_evidence_windows',
    'normalization': 'balanced_markdown_and_latex_presentation_v2_no_numeric_repair',
    'segmentation': 'explicit_subject_clauses_preserving_conditional_scope_v1',
    'window_overlap_units': 0,
    'max_window_units': 1,
    'max_pairs_per_answer': 256,
    'aggregation': 'all_targets; full_window_coverage; entailment_and_contradiction_conflict_is_review',
    'thresholds_changed': False,
    'llm_rewriting': False,
    'question_as_evidence': False,
    'anchors': 'explicit_identifiers_si_declarations_and_named_quantities_v2_no_score_rewrite',
    'deterministic_support': 'exact_whole_contextual_unit_identity_no_substring_or_numeric_repair',
    'numeric_declarations': 'unique_full_label_and_si_unit_existing_dataset_tolerances_v1',
}

# Delimitatori di matematica e codice: la punteggiatura interna non è un confine.
PROTECTED = re.compile(r'```[\s\S]*?(?:```|\Z)|(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|'
    r'\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\$)[^$]*?(?<!\\)\$')
LIST = re.compile(r'^\s*(?:\*\*)?(?:\d+[.)]|[-+*])\s+')
PUNCTUATION = re.compile(r'[!?]+|\.(?=\s|$)')
SEMICOLON = re.compile(r';(?=\s+(?:il|la|i|le|un|una|the|a|an)\s+)', re.I)
SHORT_REPLY = re.compile(r'^(?:no|sì|si|yes|non necessariamente|not necessarily)[.!]?$', re.I)
ABBREVIATIONS = {'es', 'ecc', 'fig', 'eq', 'sig', 'prof', 'dr', 'vs'}
TITLE = re.compile(r'^(?:(?:calcolo|analisi|verifica|misura|misure|risultati?|conclusione|conclusioni|'
    r'ipotesi|limiti?|limite|corrente|potenza|tensione|resistenza|passo|step|summary|results|'
    r'assumptions|conclusion|current|voltage|power)(?:\s+(?:della?|delle|del|di|in|per|the|of|and|e)\b.*)?'
    r'(?:\s*\([^)]*\))?|ecco la spiegazione teorica|in sintesi)$', re.I)
SCOPE = re.compile(r'(?:\bche|\bthat|assume(?:s)?|ipotesi|seguent[ei]|following|'
    r'non è corretto dire|è errato dire|for example|ad esempio)', re.I)
ASSERTION = re.compile(r'\b(?:è|sono|sia|ha|hanno|vale|significa|stabilisce|indica|fornisce|'
    r'calcola|calcolat[oa]|risulta|determina|equivale|uguale|assume|assunt[oa]|'
    r'genera|dissipa|assorbe|cambia|dipende|produce|aumenta|diminuisce|presenta(?:no)?|'
    r'può|possono|deve|devono|is|are|means|equals|assuming|therefore|because|where|se|quando|dove)\b', re.I)
TITLE_WORDS = set(('calcolo analisi verifica misura misure risultato risultati conclusione conclusioni '
    'ipotesi limite limiti corrente correnti potenza potenze tensione tensioni resistenza resistenze '
    'passo step summary results assumptions conclusion current voltage power modello valori valore '
    'nominale nominali termico termici dissipata dissipate istantanea istantanee totale equivalente '
    'della delle del di in per e the of and dc ac rms').split())
QUANTITIES = {
    'voltage': r'\b(?:tension[ei]|voltage)\b|\bdifferenz[ae]\s+di\s+potenziale\b',
    'current': r'\b(?:corrent[ei]|current)\b',
    'power': r'\b(?:potenz[ae]|power)\b',
    'resistance': r'\b(?:resistenz[ae]|resistance)\b',
    'capacitance': r'\b(?:capacità|capacitance)\b',
    'inductance': r'\b(?:induttanz[ae]|inductance)\b',
    'frequency': r'\b(?:frequenz[ae]|frequency)\b',
    'temperature': r'\b(?:temperatur[ae]|temperature)\b',
}


def anchors(premise, hypothesis):
    def identifiers(text):
        ids = {'component:' + value for value in re.findall(r'\b[RCLVDQMUI]\d+\b', text)}
        gates = set(re.findall(r'\b(?:XNOR|XOR|NAND|NOR|AND|NOT|OR)\b', text))
        gates.update(value.upper() for value in re.findall(r'\b(?:porta|gate)\s+(xnor|xor|nand|nor|and|not|or)\b', text, re.I))
        return sorted(ids | {'gate:' + gate for gate in gates})
    p, h = identifiers(premise), identifiers(hypothesis)
    def quantities(text):
        found = {q for q, pattern in QUANTITIES.items() if re.search(pattern, text, re.I)}
        units = {'V': 'voltage', 'A': 'current', 'W': 'power', 'ohm': 'resistance', 'F': 'capacitance',
                 'H': 'inductance', 'Hz': 'frequency', 'degC': 'temperature'}
        found.update(units[m.unit] for m in mentions(text) if m.unit in units)
        # Assegnazioni simboliche convenzionali della fisica del progetto.
        symbols = {'V': 'voltage', 'I': 'current', 'P': 'power', 'R': 'resistance',
                   'C': 'capacitance', 'L': 'inductance', 'f': 'frequency'}
        found.update(symbols[s] for s in re.findall(r'\b([VIPRCLf])\s*(?:=|≈)', text))
        return sorted(found)
    pq, hq = quantities(premise), quantities(hypothesis)
    disjoint_ids = any({value for value in p if value.startswith(kind)}
        and {value for value in h if value.startswith(kind)}
        and not {value for value in p if value.startswith(kind)}.intersection(
            value for value in h if value.startswith(kind)) for kind in ('component:', 'gate:'))
    reason = ('different_identifiers' if disjoint_ids else
              'different_quantities' if pq and hq and not set(pq).intersection(hq) else None)
    return NliAnchors(premise_identifiers=p, hypothesis_identifiers=h,
        premise_quantities=pq, hypothesis_quantities=hq, comparable=reason is None, reason=reason)


def normalize(text):
    """Solo presentazione: conserva numeri, negazioni, simboli e operatori."""
    text = re.sub(r'\\(?:text|mathrm)\{([^{}]*)\}', r'\1', text)
    for command, replacement in (('Omega', 'Ω'), ('cdot', '·'), ('times', '×'), ('qquad', ' '), ('quad', ' ')):
        text = re.sub(r'\\' + command + r'\b', lambda _: replacement, text)
    text = re.sub(r'\\[,;! ]', ' ', text)
    for pattern in (r'(?<!\\)\$\$([\s\S]*?)(?<!\\)\$\$',
                    r'(?<!\\)\$(?!\$)([^$]*?)(?<!\\)\$', r'\\\(([\s\S]*?)\\\)', r'\\\[([\s\S]*?)\\\]'):
        text = re.sub(pattern, r'\1', text)
    lines = []
    for line in text.splitlines():
        line = re.sub(r'^\s*#{1,6}\s+', '', line)
        line = re.sub(r'^\s*>\s+', '', line)
        line = re.sub(r'(?<!\w)\*\*(?=\S)(.+?)(?<=\S)\*\*(?!\w)', r'\1', line)
        line = re.sub(r'(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)', r'\1', line)
        line = re.sub(r'`([^`\n]+)`', r'\1', line)
        line = LIST.sub('', line)
        if not re.search(r'[=≈<>]|\\(?:frac|sqrt)\b', line):
            line = re.sub(r'(?<![\w*])\*(?=\S)([^*\n]+)(?<=\S)\*(?![\w*])', r'\1', line)
            line = re.sub(r'(?<![\w_])_(?=\S)([^_\n]+)(?<=\S)_(?![\w_])', r'\1', line)
        lines.append(line.strip())
    return '\n'.join(line for line in lines if line).strip()


def source_span(text, start, end, origin, reference_index=None):
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return NliSourceSpan(origin=origin, reference_index=reference_index,
        start=start, end=end, quote=text[start:end])


def formula_only(text):
    """Un'equazione isolata non è una prova NLI del metodo di calcolo."""
    if text.lstrip().startswith('```'):
        return True
    plain = normalize(text)
    if not re.search(r'[=≈<>]|\\frac\b', plain):
        return False
    # Un nome di grandezza ("corrente", "potenza") rende già la riga una
    # dichiarazione linguistica: non dipendere da un elenco incompleto di verbi.
    math_words = {'frac', 'sqrt', 'sin', 'cos', 'tan', 'exp', 'log', 'log10', 'pi', 'rms',
                  'abs', 'mean', 'circ', 'ohm', 'kohm', 'mohm', 'hz', 'khz', 'mhz', 'deg', 'rad',
                  'mv', 'kv', 'ma', 'ua', 'mw', 'kw', 'ms', 'us', 'ns', 'nf', 'uf', 'pf', 'mh', 'uh'}
    words = re.findall(r'[^\W\d]+', re.sub(r'[⁰¹²³⁴⁵⁶⁷⁸⁹]', ' ', plain), re.UNICODE)
    def symbol(word):
        return (len(word) == 1 or len(word) <= 2 and word.isupper() or word.lower() in math_words or '_' in word
                or bool(re.fullmatch(r'[VIRP](?:in|out|rms|peak|pk|pp|total|load|eq)', word, re.I)))
    return all(symbol(word) for word in words)


def fits(nli, premise, hypothesis):
    # Stesso limite di trasporto per esecuzione diretta e HTTP. Nessun token stimato.
    p, h = normalize(premise), normalize(hypothesis)
    return len(p) <= 20000 and len(h) <= 12000 and nli.count_tokens(p, h) <= nli.max_tokens


def _blocks(text):
    """Paragrafi, voci di elenco e blocchi matematici, con offset originali."""
    protected = list(PROTECTED.finditer(text))
    lines = []
    position = 0
    for line in text.splitlines(keepends=True):
        lines.append((position, position + len(line)))
        position += len(line)
    blocks, pending, i = [], None, 0
    while i < len(lines):
        start, end = lines[i]
        line = text[start:end]
        if not line.strip():
            if pending is not None:
                blocks.append(pending)
                pending = None
            i += 1
            continue
        crossing = [p for p in protected if p.start() < end and p.end() > end]
        while crossing:
            end = max(p.end() for p in crossing)
            while i + 1 < len(lines) and lines[i][1] < end:
                i += 1
            end = max(end, lines[i][1])
            crossing = [p for p in protected if p.start() < end and p.end() > end]
        line = text[start:end]
        decorated = bool(re.match(r'^\s*#{1,6}\s+', line) or
            re.fullmatch(r'\s*\*\*[^\n]+\*\*\s*', line))
        separate = bool(LIST.match(line) or decorated or line.rstrip().endswith(':') or '\n' in line.rstrip('\n'))
        if separate:
            if pending is not None:
                blocks.append(pending)
                pending = None
            blocks.append((start, end))
        else:
            pending = (pending[0], end) if pending else (start, end)
        i += 1
    if pending is not None:
        blocks.append(pending)
    return blocks, protected


def _sentence_ranges(text, start, end, protected):
    marker = LIST.match(text[start:end])
    body_start = start + marker.end() if marker else start
    previous = start
    separators = list(PUNCTUATION.finditer(text, start, end))
    if not re.match(r'^\s*(?:se|quando|qualora|if|when|assuming|supponendo|assumendo)\b', text[body_start:end], re.I):
        separators += list(SEMICOLON.finditer(text, start, end))
    for match in sorted(separators, key=lambda m: m.start()):
        if match.start() < body_start or any(p.start() <= match.start() < p.end() for p in protected):
            continue
        if match[0] == '.':
            word = re.search(r'([A-Za-zÀ-ÿ]+)$', text[previous:match.start()])
            if word and word[1].lower() in ABBREVIATIONS:
                continue
            if re.search(r'(?:\b[A-Za-z]\.)+[A-Za-z]$', text[previous:match.start()]):
                continue
        yield previous, match.end()
        previous = match.end()
    if text[previous:end].strip():
        yield previous, end


def units(text, *, origin='response', reference_index=None):
    blocks, protected = _blocks(text)
    output, headings, scope, reply = [], [], None, None
    previous_list = False
    for start, end in blocks:
        raw = text[start:end]
        plain = normalize(raw)
        label = re.sub(r'^\d+[.)]\s*', '', plain).strip().rstrip(':').strip()
        markdown = re.match(r'^\s*(#{1,6})\s+', raw)
        heading_like = bool(markdown or raw.strip().startswith('**') and raw.strip().endswith('**')
                            or raw.rstrip().endswith(':'))
        title = (TITLE.fullmatch(label) and not ASSERTION.search(label) and not mentions(label)
                 and not re.search(r'[=<>]', label)
                 and all(w.lower() in TITLE_WORDS or len(w) <= 2 for w in re.findall(r'[^\W\d]+', label)))
        is_structure = bool(SHORT_REPLY.fullmatch(label) or title
                            or heading_like and raw.rstrip().endswith(':') and SCOPE.search(label))
        span = source_span(text, start, end, origin, reference_index)
        if markdown:
            level = len(markdown[1])
            headings = [(old_level, old_span) for old_level, old_span in headings if old_level < level]
            scope = None
        if is_structure:
            output.append(NliTextUnit(span=span, context=[], kind='structure'))
            if SHORT_REPLY.fullmatch(label):
                reply = span
            elif markdown:
                headings.append((len(markdown[1]), span))
            else:
                scope = span
            continue
        is_list = bool(LIST.match(raw))
        if previous_list and not is_list:
            scope = None
        contexts = [s for _, s in headings] + ([scope] if scope else []) + ([reply] if reply else [])
        ranges = list(_sentence_ranges(text, start, end, protected))
        # "No." non vive separato dalla spiegazione che gli dà significato.
        if len(ranges) > 1 and SHORT_REPLY.fullmatch(normalize(text[ranges[0][0]:ranges[0][1]])):
            ranges = [(ranges[0][0], ranges[1][1]), *ranges[2:]]
        previous = None
        for left, right in ranges:
            current = source_span(text, left, right, origin, reference_index)
            if current.quote:
                linked = re.match(r'^(?:quest[oaie]|ciò|tale|ess[oaie]|quindi|it|this|these|they|therefore)\b',
                    normalize(current.quote), re.I)
                # Un rinvio come "questi risultati" non aggiunge alla nuova
                # affermazione anche il valore della misura precedente.
                context = contexts + ([previous] if previous is not None and linked
                    and not mentions(previous.quote) and not formula_only(previous.quote) else [])
                output.append(NliTextUnit(span=current, context=context, kind='claim'))
                previous = current
        if markdown:
            headings.append((len(markdown[1]), span))
        reply = None
        if not is_list:
            scope = None
        # Un'introduzione assertiva resta verificata anche autonomamente, ma
        # qualifica le voci successive (es. "Nella realtà ... non lineari:").
        if raw.rstrip().endswith(':'):
            scope = span
        previous_list = is_list
    return output


def passage(spans):
    """Ordina e unisce intervalli sovrapposti, senza duplicare il contesto."""
    ordered = sorted(spans, key=lambda s: (s.origin, s.reference_index if s.reference_index is not None else -1, s.start))
    merged = []
    for span in ordered:
        if not span.quote:
            continue
        if (merged and merged[-1].origin == span.origin and merged[-1].reference_index == span.reference_index
                and span.start <= merged[-1].end):
            last = merged[-1]
            if span.end > last.end:
                suffix = span.quote[last.end - span.start:]
                merged[-1] = last.model_copy(update={'end': span.end, 'quote': last.quote + suffix})
        else:
            merged.append(span)
    return NliPassage(raw='\n'.join(s.quote for s in merged), spans=merged)


def evidence_windows(text, target, nli, *, origin, reference_index=None):
    """Copre tutti i brani, senza ranking o troncatura; un'unità enorme resta esplicita."""
    parsed = units(text, origin=origin, reference_index=reference_index)
    if not parsed:
        return [passage([source_span(text, 0, len(text), origin, reference_index)])]
    whole = passage([source_span(text, 0, len(text), origin, reference_index)])
    if len(parsed) <= PROTOCOL['max_window_units'] and fits(nli, whole.raw, target.raw):
        return [whole]
    result, first, index = [], 0, 0
    while first < len(parsed):
        best, next_index = None, first
        index = first
        while index < min(len(parsed), first + PROTOCOL['max_window_units']):
            span = source_span(text, parsed[first].span.start, parsed[index].span.end, origin, reference_index)
            candidate = passage([span, *(s for unit in parsed[first:index + 1] for s in unit.context)])
            if not fits(nli, candidate.raw, target.raw):
                break
            best, next_index = candidate, index + 1
            index += 1
        if best is None:
            # Nessuna divisione arbitraria della frase: il caso verrà segnato review.
            result.append(passage([parsed[first].span, *parsed[first].context]))
            first += 1
        else:
            result.append(best)
            # Sovrappone un'unità solo se permette comunque di avanzare.
            first = next_index - 1 if next_index - first > 1 and next_index < len(parsed) else next_index
    return result


def contextual_checks(response, nli, references, numeric_references=()):
    targets = []
    parsed = units(response)
    for index, unit in enumerate(parsed):
        if unit.kind == 'claim':
            targets.append(('faithfulness', f'response:{index}', passage([*unit.context, unit.span]),
                'non_linguistic' if formula_only(unit.span.quote) else None))
    if not targets:
        targets.append(('faithfulness', 'response:no-assertion',
            passage([source_span(response, 0, len(response), 'response')]), 'structure_only'))
    for index, ref in enumerate(references):
        if ref.required:
            claims = [u for u in units(ref.statement, origin='reference', reference_index=index) if u.kind == 'claim']
            if not claims:
                # Un requisito senza affermazioni non è coperto per convenzione.
                targets.append(('completeness', f'reference:{index}:no-assertion',
                    passage([source_span(ref.statement, 0, len(ref.statement), 'reference', index)]), 'structure_only'))
            for part, unit in enumerate(claims):
                targets.append(('completeness', f'reference:{index}:{part}',
                    passage([*unit.context, unit.span]), 'non_linguistic' if formula_only(unit.span.quote) else None))
    checks, used = [], 0
    for direction, target_id, target, skip in targets:
        # Una copia integrale del fatto, compresi i qualificatori, è una prova
        # testuale relativa al riferimento. Non si simulano probabilità NLI.
        proof = None
        candidates = []
        if skip != 'structure_only':
            if direction == 'faithfulness':
                candidates = [passage([*u.context, u.span]) for i, ref in enumerate(references)
                    for u in units(ref.statement, origin='reference', reference_index=i) if u.kind == 'claim']
            else:
                candidates = [passage([*u.context, u.span]) for u in parsed if u.kind == 'claim']
            proof = next((p for p in candidates if p.raw == target.raw and p.raw.strip()), None)
        # Le dichiarazioni scalari esplicite sono confrontate con i numeri
        # indipendenti. Nessuna associazione per vicinanza del valore.
        from nli_numeric import compare, status as numeric_status
        numeric_rows = []
        for candidate in candidates:
            actual, source = (target, candidate) if direction == 'faithfulness' else (candidate, target)
            numeric = compare(actual.raw, source.raw, numeric_references, normalize)
            if numeric is not None:
                numeric_rows.append((candidate, numeric))
        if numeric_rows:
            for index, (candidate, numeric) in enumerate(numeric_rows):
                checks.append(NliCheck(direction=direction, premise=normalize(candidate.raw),
                    hypothesis=normalize(target.raw), scores=None, status=numeric_status(numeric),
                    detail='Dichiarazione scalare con etichetta e unità univoche: confronto deterministico con le tolleranze originali del dataset.',
                    preparation=NliPreparation(target_id=target_id, window_index=index, window_count=len(numeric_rows),
                        token_count=None, coverage_complete=True, reason='numeric_reference',
                        raw_premise=candidate.raw, raw_hypothesis=target.raw,
                        premise_spans=candidate.spans, hypothesis_spans=target.spans, numeric_proof=numeric)))
            continue
        if proof is not None:
            text = normalize(target.raw)
            check = NliCheck(direction=direction, premise=text, hypothesis=text, scores=None, status='pass',
                detail='Unità e qualificatori identici al riferimento: prova testuale deterministica, non un punteggio NLI.',
                preparation=NliPreparation(target_id=target_id, window_index=0, window_count=1, token_count=None,
                    coverage_complete=True, reason='exact_reference', raw_premise=proof.raw, raw_hypothesis=target.raw,
                    premise_spans=proof.spans, hypothesis_spans=target.spans, anchors=anchors(text, text)))
            checks.append(check)
            continue
        try:
            if skip:
                windows = [NliPassage(raw='', spans=[])]
            elif direction == 'faithfulness':
                # Si conserva il riferimento intero se rientra; altrimenti tutti i fatti.
                all_facts = passage([source_span(r.statement, 0, len(r.statement), 'reference', i)
                    for i, r in enumerate(references)])
                if (sum(len(units(r.statement)) for r in references) <= PROTOCOL['max_window_units']
                        and fits(nli, all_facts.raw, target.raw)):
                    windows = [all_facts]
                else:
                    windows = [window for i, ref in enumerate(references)
                        for window in evidence_windows(ref.statement, target, nli, origin='reference', reference_index=i)]
            else:
                windows = evidence_windows(response, target, nli, origin='response')
        except Exception as exc:
            windows = [NliPassage(raw='', spans=[])]
            skip = 'tokenizer_error'
            planning_error = f'Preparazione NLI non completata ({type(exc).__name__}); nessuna copertura presunta.'
        else:
            planning_error = None
        rows = []
        for index, window in enumerate(windows):
            reason, count = skip, None
            p, h = normalize(window.raw), normalize(target.raw)
            anchor = anchors(p, h)
            if not reason:
                try:
                    if len(p) > 20000 or len(h) > 12000:
                        reason = 'oversized_unit'
                    else:
                        count = nli.count_tokens(p, h)
                        if count > nli.max_tokens:
                            reason = 'oversized_unit'
                        elif used >= PROTOCOL['max_pairs_per_answer']:
                            reason = 'budget_exhausted'
                except Exception:
                    reason = 'tokenizer_error'
            if reason:
                detail = planning_error or {
                    'structure_only': 'La risposta contiene soltanto struttura o nessuna affermazione verificabile.',
                    'non_linguistic': 'Formula o codice isolato: serve una verifica matematica distinta; NLI non attribuisce supporto né contraddizione.',
                    'oversized_unit': 'Unità contestuale oltre il limite NLI: conservata integralmente, non troncata.',
                    'budget_exhausted': 'Budget di confronti esaurito: il target resta da verificare.',
                    'tokenizer_error': 'Conteggio token non disponibile: nessun budget stimato o supporto presunto.',
                }[reason]
                check = NliCheck(direction=direction, premise=p, hypothesis=h, scores=None, status='review', detail=detail)
            else:
                used += 1
                check = nli.check(p, h, direction)
                reason = 'evaluated' if check.scores is not None else 'model_error'
                if check.scores is not None and not anchor.comparable:
                    reason = 'anchor_mismatch'
                    check.status = 'review'
                    check.detail += ' ID o grandezze esplicitamente disgiunti: questi punteggi non provano supporto o contraddizione del target.'
            check.preparation = NliPreparation(target_id=target_id, window_index=index, window_count=len(windows),
                token_count=count, coverage_complete=True, reason=reason,
                raw_premise=window.raw, raw_hypothesis=target.raw,
                premise_spans=window.spans, hypothesis_spans=target.spans, anchors=anchor)
            rows.append(check)
        complete = all(c.scores is not None for c in rows)
        for row in rows:
            row.preparation.coverage_complete = complete
        checks.extend(rows)
    return checks
