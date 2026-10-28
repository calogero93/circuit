"""Diagnostica congiunta: contratto numerico Pydantic + NLI, senza promuovere baseline."""
import argparse
import asyncio
from dataclasses import replace
import json
from pathlib import Path
from uuid import uuid4

from answer_verifier import EXTRACTION_PROMPT, verify_answer
from config import Settings
from dataset import TEXTBOOK_DIR, load_dataset, select_cases
from experiments import ROOT, create_manifest, digest, file_digest, source_snapshot, utc_now
from judge import local_judge_settings
from nli_verifier import LocalNLI
from verification_schemas import AnswerVerification, ResponseInventory
from verification_references import load_references
from verify_judge import altered_response, check_endpoint, load_probes, probe_input


def summarize(results):
    positive = [r for r in results if r['variant'] != 'controlled_error']
    negative = [r for r in results if r['variant'] == 'controlled_error']
    return {"attempted": len(results), "positive": len(positive), "negative": len(negative),
        "positive_pass": sum(r['verification']['status'] == 'pass' for r in positive),
        "positive_fail": sum(r['verification']['status'] == 'fail' for r in positive),
        "positive_review": sum(r['verification']['status'] == 'review' for r in positive),
        "negative_false_pass": sum(r['verification']['status'] == 'pass' for r in negative),
        "negative_fail": sum(r['verification']['status'] == 'fail' for r in negative),
        "negative_review": sum(r['verification']['status'] == 'review' for r in negative),
        "operational_errors": sum(bool(r['verification']['errors']) for r in results)}


async def run(bundle, cases, settings, nli, *, output, model=None):
    output = Path(output)
    if output.exists():
        raise ValueError("Report esistente: scegliere un nuovo percorso")
    suite_path = TEXTBOOK_DIR / "judge-probes.v1.json"
    suite = load_probes(bundle, suite_path)
    probes = {p.case_id: p for p in suite.cases}
    references_path = TEXTBOOK_DIR / 'explanation-references.v1.json'
    references = load_references(bundle, references_path)
    manifest = create_manifest(settings, cases, dataset_identity=bundle.identity())
    protocol = {"version": 1, "mode": "structured-numeric-and-local-nli",
        "inventory_schema_sha256": digest(ResponseInventory.model_json_schema()),
        "result_schema_sha256": digest(AnswerVerification.model_json_schema()),
        "extraction_prompt_sha256": digest(EXTRACTION_PROMPT), "nli": nli.identity,
        "explanation_references_sha256": file_digest(references_path), "explanation_reference_version": references.version,
        "nli_pairing": "whole_factual_reference_to_each_sentence; response_to_each_required_fact",
        "suite_sha256": file_digest(suite_path), "aggregation": "fail > review > pass; no compensating average"}
    report = {"id": uuid4().hex, "created_at": utc_now(), "status": "prepared", "error": None,
        "manifest": manifest.model_dump(mode="json"), "protocol": protocol,
        "planned": len(cases) * 3, "results": [], "summary": summarize([]),
        "human_calibrated": False, "baseline_approved": False,
        "limitations": ["Diagnostica su risposte curate già osservate; nessuna verifica indipendente o calibrazione umana.",
            "Il parser non è un interprete generale del linguaggio matematico; associazioni implicite, ruoli e quantità non coperte possono richiedere revisione.",
            "NLI usa parafrasi fattuali italiane proposte, attribuite alle fonti e alle fixture; non usa retrieval né tratta obiettivi della rubric o domande come fatti.",
            "Le soglie NLI sono provvisorie; neutralità e fallimenti operativi non provano che la risposta sia sbagliata.",
            "Rilevanza, stile, sicurezza e vincoli richiedono gli altri evaluator: questo verificatore non sostituisce l'intera rubric."]}
    def save():
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
        temporary.replace(output)
    def integrity():
        if source_snapshot() != manifest.configuration.source_sha256 or file_digest(suite_path) != protocol['suite_sha256'] or file_digest(references_path) != protocol['explanation_references_sha256']:
            raise ValueError("Sorgenti o suite cambiati durante il batch")
        if load_dataset(TEXTBOOK_DIR).identity() != bundle.identity():
            raise ValueError("Dataset o estratti cambiati durante il batch")
    save()
    try:
        await check_endpoint(settings)
        report['status'] = 'running'
        consecutive_errors = 0
        for case in cases:
            probe = probes[case.name]
            for variant in ('correct_concise', 'correct_explained', 'controlled_error'):
                integrity()
                text = altered_response(probe) if variant == 'controlled_error' else getattr(probe, variant)
                payload, _ = probe_input(bundle, case, text)
                result, metrics = await verify_answer(payload, settings, nli, references=references.cases[case.name], model=model)
                report['results'].append({"case_id": case.name, "group_id": case.group_id, "split": case.split,
                    "variant": variant, "input": payload.model_dump(mode="json"), "input_sha256": digest(payload),
                    "explanation_references": [r.model_dump(mode='json') for r in references.cases[case.name]],
                    "verification": result.model_dump(mode="json"), "extractor_metrics": metrics.model_dump(mode="json")})
                report['summary'] = summarize(report['results'])
                observations = [o for r in report['results'] for o in r['extractor_metrics']['model_observations']]
                if len({o['model_name'] for o in observations if o['model_name']}) > 1 or len({o['system_fingerprint'] for o in observations if o['system_fingerprint']}) > 1:
                    raise ValueError('Identità osservata dell\'estrattore cambiata durante il batch')
                save()
                print(f"{len(report['results'])}/{report['planned']} {case.name} {variant}: {result.status} "
                    f"(numeri={result.numeric_status}, spiegazione={result.explanation_status}, copertura={result.completeness_status})", flush=True)
                consecutive_errors = consecutive_errors + 1 if result.errors else 0
                if consecutive_errors >= 3:
                    report['status'], report['error'] = 'interrupted', 'Tre prove consecutive con errori operativi; risultati parziali conservati.'
                    return report
        integrity()
        nli.assert_unchanged()
        report['status'] = 'completed'
    except asyncio.CancelledError:
        report['status'], report['error'] = 'interrupted', 'Prova interrotta; risultati parziali conservati.'
        raise
    except Exception as exc:
        report['status'], report['error'] = 'invalidated', f"Prova non valida ({type(exc).__name__}): nessuna baseline approvata."
        raise
    finally:
        report['completed_at'] = utc_now()
        save()
    return report


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nli-model-dir', type=Path, required=True, help='Directory locale ONNX; non esegue download')
    parser.add_argument('--case')
    parser.add_argument('--split', choices=['development', 'validation', 'all'], default='development')
    parser.add_argument('--base-url', default='http://127.0.0.1:1235/v1')
    parser.add_argument('--model', default='google/gemma-4-e4b')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    settings = local_judge_settings(Settings.from_env(), model=args.model, base_url=args.base_url, context_tokens=12000)
    settings = replace(settings, max_output_tokens=4096, reasoning_effort='none')
    bundle = load_dataset(TEXTBOOK_DIR)
    cases = select_cases(bundle, split='all' if args.case else args.split, case_name=args.case)
    nli = LocalNLI(args.nli_model_dir)
    output = args.output or ROOT / '.local-notes/llmops/structured-nli' / uuid4().hex / 'report.json'
    report = await run(bundle, cases, settings, nli, output=output)
    print('Report:', output)
    print(json.dumps(report['summary'], ensure_ascii=False))
    print('Baseline approvata: no. Calibrazione umana: no.')
    return 0 if report['status'] == 'completed' and all(r['verification']['status'] == ('fail' if r['variant'] == 'controlled_error' else 'pass') for r in report['results']) else 1


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
