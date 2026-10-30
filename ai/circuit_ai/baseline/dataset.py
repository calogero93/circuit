"""Audit del nuovo dataset: composizione, fonti, famiglie, mutazioni e log ngspice."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re

from circuit_ai.contracts.baseline import Benchmark100, BenchmarkCase
from circuit_ai.evaluation.experiments import ROOT, digest, file_digest
from circuit_ai.evaluation.sources import local_source, verify_publications
from circuit_ai.integrations.spice import netlist_text
from circuit_ai.core.paths import EVALS_DIR

DIRECTORY=EVALS_DIR/'baseline'


def load_baseline(directory=DIRECTORY, *, verify_pdfs=False):
    directory=Path(directory).resolve()
    dataset=Benchmark100.model_validate_json((directory/'dataset.v1.json').read_text())
    if Counter(c.bucket for c in dataset.cases) != {'worked':30,'ngspice':30,'theory':20,'stress':20}:
        raise ValueError('Composizione diversa da 30/30/20/20')
    if Counter(c.split for c in dataset.cases) != {'development':80,'validation':20}:
        raise ValueError('Servono 80 record di sviluppo e 20 di validazione')
    if Counter(c.purpose for c in dataset.cases) != {'tutor':90,'verifier':10}:
        raise ValueError('Separare 90 domande tutor e 10 controlli negativi')
    if Counter(c.challenge for c in dataset.cases if c.bucket=='stress') != {'altered':10,'ambiguous':5,'difficult':5}:
        raise ValueError('Stress: servono 10 alterati, 5 ambigui e 5 difficili')
    sources={s.id:s for s in dataset.sources}
    cases={c.id:c for c in dataset.cases}
    if len(sources)!=len(dataset.sources) or len(cases)!=100:raise ValueError('Identificativi duplicati')
    files={directory/'dataset.v1.json',directory/'catalog.v1.json',directory/'spice/scenarios.v1.json'}
    catalog=json.loads((directory/'catalog.v1.json').read_text())
    authored=[*catalog['worked'],*catalog['theory'],*catalog['stress']]
    if {c['id'] for c in authored}!={c.id for c in dataset.cases if c.bucket!='ngspice'}:
        raise ValueError('Catalogo e dataset non corrispondono')
    for entry in authored:
        raw=dict(entry);sid=raw.pop('book').lower()+'-'+'-'.join(str(p) for p in raw.pop('pages'));raw.pop('section')
        raw['source_ids']=[sid]+(['protocol-boundaries'] if raw['id']=='stress-injected-guarantee' else [])
        if BenchmarkCase.model_validate(raw)!=cases[raw['id']]:raise ValueError('Dataset non rigenerato dopo una modifica al catalogo')
    scenarios={s['id']:s for s in json.loads((directory/'spice/scenarios.v1.json').read_text())['scenarios']}
    if set(scenarios)!={c.spice_id for c in dataset.cases if c.spice_id}:raise ValueError('Specifica SPICE non corrispondente ai casi')
    for source in sources.values():
        path=local_source(ROOT,source.path);files.add(path)
        if hashlib.sha256(source.excerpt.encode()).hexdigest()!=source.sha256 or source.excerpt not in path.read_text():
            raise ValueError(f'Estratto o hash cambiato: {source.id}')
    groups,pages,questions={},{},set()
    for case in dataset.cases:
        if set(case.source_ids)-sources.keys():raise ValueError('Fonte sconosciuta')
        if case.group_id in groups and groups[case.group_id]!=case.split:raise ValueError('Famiglia in split diversi')
        groups[case.group_id]=case.split
        key=(re.sub(r'\s+',' ',case.question.strip().casefold()),case.candidate_answer)
        if key in questions:raise ValueError('Record duplicato')
        questions.add(key)
        excerpts='\n'.join(sources[s].excerpt for s in case.source_ids)
        normalized=re.sub(r'\s+','',excerpts)
        for number in case.numbers:
            if number.source_quote and re.sub(r'\s+','',number.source_quote) not in normalized:
                raise ValueError(f'Risultato non trovato nella pagina pubblicata: {case.id}: {number.source_quote}')
        if case.bucket=='worked' and any(symbol not in normalized for symbol in case.symbolic_results):
            raise ValueError(f'Risultato simbolico non trovato: {case.id}')
        for sid in case.source_ids:
            pub=sources[sid].publication
            if pub:
                for page in pub.pdf_pages:
                    k=(pub.pdf_sha256,page)
                    if k in pages and pages[k]!=case.split:raise ValueError('Pagina pubblicata condivisa tra split')
                    pages[k]=case.split
        if case.alteration:
            a=case.alteration;parent=cases.get(a.parent_id)
            if parent is None or parent.group_id!=case.group_id or parent.split!=case.split or parent.reference_answer!=case.reference_answer:
                raise ValueError('Mutazione senza caso corretto nello stesso gruppo/split')
            if parent.reference_answer.count(a.before)!=1 or parent.reference_answer.replace(a.before,a.after,1)!=case.candidate_answer:
                raise ValueError('Mutazione diversa da quella dichiarata')
        if case.spice_id:
            netlist=directory/'spice'/(case.spice_id+'.cir');log=netlist.with_suffix('.log');output=netlist.with_suffix('.json')
            files.update([netlist,log,output]);run=json.loads(output.read_text())
            if netlist.read_text()!=netlist_text(scenarios[case.spice_id]):raise ValueError('Netlist diversa dalla specifica curata')
            if file_digest(netlist)!=run['netlist_sha256'] or file_digest(log)!=run['log_sha256']:
                raise ValueError('Netlist o log ngspice cambiati')
            for number in case.numbers:
                if number.measure not in run['measurements'] or number.value != run['measurements'][number.measure]:
                    raise ValueError('Valore non prodotto dalla misura ngspice dichiarata')
    if verify_pdfs:verify_publications(sources,ROOT)
    identity={p.relative_to(ROOT).as_posix():file_digest(p) for p in sorted(files)}
    return dataset,{'id':'circuit-baseline-100','version':dataset.version,'status':'provisional',
        'files_sha256':identity,'bundle_sha256':digest(identity)}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--verify-pdfs',action='store_true');a=p.parse_args()
    d,identity=load_baseline(verify_pdfs=a.verify_pdfs)
    print('Record:',len(d.cases),'categorie:',dict(Counter(c.bucket for c in d.cases)))
    print('Split:',dict(Counter(c.split for c in d.cases)),'scopi:',dict(Counter(c.purpose for c in d.cases)))
    print('Famiglie distinte:',len({c.group_id for c in d.cases}),'hash:',identity['bundle_sha256'])
