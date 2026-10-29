"""Regressione NLI su contrasti e risposte salvate; nessuna nuova generazione LLM."""
import argparse
from collections import Counter
import json
from pathlib import Path
import platform
from uuid import uuid4

from baseline_dataset import load_baseline
from experiments import ROOT, digest, file_digest, git_provenance, source_snapshot, utc_now
from nli_context import PROTOCOL
from nli_http import HttpNLI
from nli_verifier import LocalNLI, explanation_checks, semantic_status
from schemas import JudgeInput, SubmitAnswer
from verification_schemas import ExplanationReference, NliControlSuite

CONTROL_PATH = Path(__file__).parent / 'evals/nli/controls.v1.json'


def load_controls(path=CONTROL_PATH):
    dataset, identity = load_baseline()
    suite = NliControlSuite.model_validate_json(Path(path).read_text())
    if suite.dataset_bundle_sha256 != identity['bundle_sha256']:
        raise ValueError('Controlli associati a un dataset diverso')
    cases = {c.id: c for c in dataset.cases}
    if len({c.id for c in suite.cases}) != len(suite.cases):
        raise ValueError('ID controllo duplicato')
    for item in suite.cases:
        if item.case_id not in cases or any(s not in '\n'.join(cases[item.case_id].facts) for s in item.reference_statements):
            raise ValueError('Un controllo usa fatti assenti dal riferimento originale: ' + item.id)
    return suite, dataset, identity


def _references(statements, sources):
    return [ExplanationReference(statement=s, source_ids=sources, evidence_ids=[], required=True) for s in statements]


def _baseline_payload(case, answer, dataset):
    from run_baseline import payload_for
    return payload_for(case, answer, {s.id: s for s in dataset.sources})


def build_jobs(suite, dataset, identity, saved_reports):
    cases = {c.id: c for c in dataset.cases}
    jobs, skipped, inputs = [], [], {}
    for item in suite.cases:
        case = cases[item.case_id]
        payload = _baseline_payload(case, SubmitAnswer(response=item.response, kind='theory', evidence_ids=[],
            uses_measurements=False, learning_notes=[]), dataset)
        jobs.append({'id': 'control:' + item.id, 'cohort': 'controls:' + item.category, 'case_id': case.id,
            'expected': {'direction': item.direction, 'status': item.expected_status, 'rationale': item.rationale},
            'payload': payload, 'references': _references(item.reference_statements, case.source_ids), 'old': None})
    for path in saved_reports:
        path = Path(path).resolve()
        raw = json.loads(path.read_text())
        inputs[str(path)] = file_digest(path)
        if raw.get('status') != 'completed':
            raise ValueError('Usare soltanto report completati: ' + str(path))
        report_identity = raw.get('dataset')
        if report_identity and report_identity != identity:
            raise ValueError('Report di un dataset differente')
        mode = raw.get('mode', 'generation')
        for index, row in enumerate(raw['results']):
            if mode == 'tutor' and row.get('purpose') == 'verifier':
                skipped.append({'path': str(path), 'index': index, 'reason': 'Controllo negativo già presente nel run references.'})
                continue
            if row.get('input') and row.get('answer'):
                payload = JudgeInput.model_validate(row['input'])
                if digest(payload) != row['input_sha256']:
                    raise ValueError('Input originale modificato nel report')
                id = row['id']
                if id not in cases:
                    raise ValueError('Caso originale non presente nel dataset attuale')
                if payload.reference.concepts != cases[id].facts:
                    raise ValueError('I fatti del report non corrispondono al dataset verificato')
                keys = ('label', 'value', 'unit', 'absolute_tolerance', 'relative_tolerance')
                if ([tuple(getattr(n, k) for k in keys) for n in payload.reference.numbers]
                        != [tuple(getattr(n, k) for k in keys) for n in cases[id].numbers]):
                    raise ValueError('I riferimenti numerici del report non corrispondono al dataset verificato')
                # I fatti provengono dall'input originale, non dalla risposta del tutor.
                refs = _references(payload.reference.concepts, cases[id].source_ids)
                old = {k: row['verification'][k] for k in ('numeric_status', 'explanation_status', 'completeness_status', 'status')}
                old['nli_unexecuted'] = sum(c['scores'] is None for c in row['verification']['nli_checks'])
                cohort = 'references:negative' if row.get('purpose') == 'verifier' else 'references:positive' if mode == 'references' else 'saved:tutor'
            elif row.get('answer') and row.get('suite') == 'ngspice':
                id = row['case_id']
                case = cases[id]
                payload = _baseline_payload(case, SubmitAnswer.model_validate(row['answer']), dataset)
                refs = _references(case.facts, case.source_ids)
                old, cohort = None, 'saved:recent-ngspice'
            else:
                skipped.append({'path': str(path), 'index': index,
                    'reason': 'Nessuna risposta completa della baseline con input ricostruibile; non è uno score NLI.'})
                continue
            jobs.append({'id': path.parent.name + ':' + str(index) + ':' + id, 'cohort': cohort, 'case_id': id,
                'expected': None, 'payload': payload, 'references': refs, 'old': old})
    return jobs, skipped, inputs


def summarize(rows):
    return {cohort: {'attempted': sum(r['cohort'] == cohort for r in rows),
        'faithfulness': dict(Counter(r['explanation_status'] for r in rows if r['cohort'] == cohort)),
        'completeness': dict(Counter(r['completeness_status'] for r in rows if r['cohort'] == cohort)),
        'expectations': dict(Counter('matched' if r['expectation_met'] else 'unresolved' if r['observed_for_expectation'] == 'review'
            else 'mismatch' for r in rows if r['cohort'] == cohort and r['expected'])),
        'operational_or_size_limits': sum(r['operational_or_size_limits'] for r in rows if r['cohort'] == cohort),
        'neural_pairs': sum(r['neural_pairs'] for r in rows if r['cohort'] == cohort),
        'exact_reference_proofs': sum(r['exact_reference_proofs'] for r in rows if r['cohort'] == cohort),
        'numeric_reference_proofs': sum(r['numeric_reference_proofs'] for r in rows if r['cohort'] == cohort)}
        for cohort in sorted({r['cohort'] for r in rows})}


def run(nli, *, output, controls_path=CONTROL_PATH, saved_reports=()):
    output = Path(output)
    if output.exists():
        raise ValueError('Report esistente: non sovrascrivere gli esperimenti')
    suite, dataset, identity = load_controls(controls_path)
    jobs, skipped, inputs = build_jobs(suite, dataset, identity, saved_reports)
    inputs[str(Path(controls_path).resolve())] = file_digest(Path(controls_path))
    source = source_snapshot()
    commit, dirty = git_provenance(ROOT)
    manifest = {'execution': 'nli-only', 'llm_calls': 0, 'source_sha256': source,
        'git_commit': commit, 'worktree_dirty': dirty, 'python_version': platform.python_version()}
    current_model = nli.identity.get('model', nli.identity)
    comparable = {}
    for path in saved_reports:
        raw = json.loads(Path(path).read_text())
        old_identity = raw.get('nli')
        old_model = old_identity.get('model', old_identity) if old_identity else None
        comparable[str(Path(path).resolve())] = (all(digest(old_model.get(k)) == digest(current_model.get(k))
            for k in ('files_sha256', 'labels', 'max_tokens', 'dependency_versions'))
            and old_identity.get('confidence') == nli.confidence and old_identity.get('margin') == nli.margin) if old_model else None
    report = {'status': 'prepared', 'created_at': utc_now(), 'manifest': manifest,
        'protocol': PROTOCOL, 'protocol_sha256': digest(PROTOCOL), 'nli': nli.identity, 'dataset': identity,
        'inputs_sha256': inputs, 'legacy_classifier_matches': comparable, 'planned': len(jobs), 'skipped_input_records': skipped,
        'results': [], 'summary': {}, 'baseline_approved': False, 'human_calibrated': False,
        'limitations': ['Nessuna nuova risposta del tutor: solo riclassificazione degli stessi testi.',
            'Controlli proposti da Codex su fatti pubblicati: non etichette umane né validazione indipendente.',
            'I punteggi numerici storici non vengono ricalcolati o corretti; restano separati da NLI.',
            'Un esito pass NLI non certifica la verità fisica, la pertinenza o tutta la qualità della risposta.',
            'I vecchi score derivano dai report indicati, con la loro configurazione; il confronto va letto per coorte.']}

    def save():
        output.parent.mkdir(parents=True, exist_ok=True)
        tmp = output.with_suffix('.tmp')
        tmp.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
        tmp.replace(output)

    def integrity():
        if source_snapshot() != source or load_baseline()[1] != identity:
            raise ValueError('Codice o dataset cambiati durante il batch')
        if any(file_digest(Path(p)) != expected for p, expected in inputs.items()):
            raise ValueError('Input del confronto cambiati durante il batch')

    save()
    try:
        nli.assert_unchanged()
        report['status'] = 'running'
        for job in jobs:
            integrity()
            checks = explanation_checks(job['payload'], nli, job['references'])
            explanation = semantic_status(checks, 'faithfulness')
            completeness = semantic_status(checks, 'completeness')
            expected = job['expected']
            observed = (explanation if expected['direction'] == 'faithfulness' else completeness) if expected else None
            rows = [c.model_dump(mode='json') for c in checks]
            operational = sum(c.scores is None and c.preparation.reason not in {'structure_only', 'non_linguistic', 'exact_reference', 'numeric_reference'} for c in checks)
            report['results'].append({'id': job['id'], 'cohort': job['cohort'], 'case_id': job['case_id'],
                'expected': expected, 'observed_for_expectation': observed,
                'expectation_met': observed == expected['status'] if expected else None,
                'input': job['payload'].model_dump(mode='json'), 'input_sha256': digest(job['payload']),
                'references': [r.model_dump(mode='json') for r in job['references']], 'old': job['old'],
                'explanation_status': explanation, 'completeness_status': completeness,
                'operational_or_size_limits': operational, 'checks': rows,
                'neural_pairs': sum(c.scores is not None for c in checks),
                'exact_reference_proofs': sum(c.preparation.reason == 'exact_reference' for c in checks),
                'numeric_reference_proofs': sum(c.preparation.reason == 'numeric_reference' for c in checks)})
            report['summary'] = summarize(report['results'])
            save()
            print(f"{len(report['results'])}/{len(jobs)} {job['id']}: {explanation}/{completeness}", flush=True)
        integrity()
        nli.assert_unchanged()
        report['status'] = 'completed'
    except KeyboardInterrupt:
        report['status'] = 'interrupted'
        raise
    except Exception as exc:
        report['status'], report['error'] = 'invalidated', str(exc)
        raise
    finally:
        report['completed_at'] = utc_now()
        save()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    backend = parser.add_mutually_exclusive_group(required=True)
    backend.add_argument('--nli-model-dir', type=Path)
    backend.add_argument('--nli-base-url')
    parser.add_argument('--saved-report', action='append', type=Path, default=[])
    parser.add_argument('--controls', type=Path, default=CONTROL_PATH)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    nli = HttpNLI(args.nli_base_url) if args.nli_base_url else LocalNLI(args.nli_model_dir)
    try:
        report = run(nli, output=args.output or ROOT/'.local-notes/llmops/nli'/uuid4().hex/'report.json',
            controls_path=args.controls, saved_reports=args.saved_report)
    finally:
        if isinstance(nli, HttpNLI):
            nli.close()
    print(json.dumps(report['summary'], ensure_ascii=False))
    # Un controllo non risolto non approva la calibrazione o una baseline.
    return 0 if report['status'] == 'completed' and all(r['expectation_met'] for r in report['results'] if r['expected']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
