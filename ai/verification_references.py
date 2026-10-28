"""Carica fatti documentati, senza trasformare automaticamente rubric o domande in verità."""
from verification_schemas import ExplanationSuite


def load_references(bundle, path):
    suite = ExplanationSuite.model_validate_json(path.read_text())
    if suite.dataset_bundle_sha256 != bundle.identity()['bundle_sha256']:
        raise ValueError('Riferimenti NLI relativi a un altro dataset')
    if set(suite.cases) != {c.name for c in bundle.dataset.cases}:
        raise ValueError('I riferimenti NLI devono coprire tutti e soli i casi del dataset')
    for case in bundle.dataset.cases:
        refs = suite.cases[case.name]
        available = set(case.provenance.source_ids)
        if not refs or not any(r.required for r in refs) or len({r.statement for r in refs}) != len(refs):
            raise ValueError('Riferimenti NLI mancanti, duplicati o senza requisiti di completezza')
        for ref in refs:
            if set(ref.source_ids) - available or set(ref.evidence_ids) - ({'snapshot-1'} if case.evaluation_mode == 'live_tools' else set()):
                raise ValueError('Fonte o evidenza NLI non appartenente al caso')
    return suite
