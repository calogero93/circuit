"""Passo 2: carica, controlla e rende revisionabile il dataset; non valuta il testo LLM."""
import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re

from circuit_ai.evaluation.fixtures import build_fixture, transient
from circuit_ai.evaluation.sources import local_source, verify_publications
from circuit_ai.evaluation.experiments import ROOT, digest, file_digest
from circuit_ai.contracts.shared import DatasetCase, DatasetCorpus, EvaluationDataset, FixtureCatalog
from circuit_ai.tools.catalog import BROWSER_TOOLS
from circuit_ai.core.paths import EVALS_DIR

DATA_DIR = EVALS_DIR
TEXTBOOK_DIR = DATA_DIR / "textbook"


@dataclass(frozen=True)
class DatasetBundle:
    dataset: EvaluationDataset
    fixtures: dict
    corpus: dict
    files: dict

    def identity(self):
        if any(not path.is_relative_to(ROOT) for path in self.files):
            raise ValueError("Per eseguire esperimenti, conservare gli artefatti del dataset dentro la repository")
        hashes = {path.relative_to(ROOT).as_posix(): value for path, value in self.files.items()}
        return {"id": self.dataset.id, "version": self.dataset.version, "status": self.dataset.status,
                "files_sha256": hashes, "bundle_sha256": digest(hashes)}


def calculate_reference(reference):
    p = reference.inputs
    calculations = {
        "given": lambda: p["value"],
        "ohm_current": lambda: p["V"] / p["R"],
        "resistor_power": lambda: p["V"] ** 2 / p["R"],
        "divider_voltage": lambda: p["V"] * p["R2"] / (p["R"] + p["R2"]),
        "series_resistance": lambda: p["R1"] + p["R2"] + p["R3"],
        "series_current": lambda: p["V"] / (p["R1"] + p["R2"] + p["R3"]),
        "series_voltage": lambda: p["V"] * p["Rtarget"] / (p["R1"] + p["R2"] + p["R3"]),
        "parallel_resistance": lambda: 1 / (1 / p["R1"] + 1 / p["R2"] + 1 / p["R3"]),
        "parallel_current": lambda: p["V"] * (1 / p["R1"] + 1 / p["R2"] + 1 / p["R3"]),
        "rc_tau": lambda: p["R"] * p["C"],
        "rc_step": lambda: p["V"] * -math.expm1(-p["t"] / (p["R"] * p["C"])),
        "cutoff": lambda: 1 / (2 * math.pi * p["R"] * p["C"]),
        "derating": lambda: p["ratedPower"] * max(0., min(1., (p["maximum"] - p["ambient"]) / (p["maximum"] - p["start"]))),
        "power_load_percent": lambda: 100 * p["power"] / p["allowed"],
        "thermal_equilibrium": lambda: p["ambient"] + p["power"] * p["theta"],
        "led_resistor": lambda: (p["V"] - p["Vf"]) / p["I"],
        "logic_and": lambda: float(bool(p["a"]) and bool(p["b"])),
    }
    value = calculations[reference.calculation]()
    if not math.isfinite(value): raise ValueError("Riferimento analitico non finito")
    return value


def resolve_fixture_path(scenario, path):
    name, *keys = path.split(".")
    if name == "runDC": value = build_fixture(scenario, dc=True)
    elif name == "getCircuitSnapshot": value = build_fixture(scenario)
    elif name == "runTransient": value = transient(scenario)
    else: raise ValueError(f"Tool non supportato nel riferimento: {name}")
    for key in keys:
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def validate_cases(cases, fixtures, corpus):
    ids, questions, groups, publication_splits = set(), set(), {}, {}
    tool_names = {name for name, *_ in BROWSER_TOOLS} | {"search_info"}
    for case in cases:
        if case.name in ids: raise ValueError(f"ID duplicato: {case.name}")
        ids.add(case.name)
        normalized = re.sub(r"\s+", " ", case.question.strip().casefold())
        if normalized in questions: raise ValueError(f"Domanda duplicata: {case.name}")
        questions.add(normalized)
        if case.group_id in groups and groups[case.group_id] != case.split:
            raise ValueError(f"Varianti dello stesso gruppo in split diversi: {case.group_id}")
        groups[case.group_id] = case.split
        if case.evaluation_mode == "closed_book" and (case.retrieved_source_ids or
                any(t.reference.tool_policy != "forbidden" for t in [case, *case.followups])):
            raise ValueError(f"Caso closed_book con accesso ai tool o alle soluzioni: {case.name}")
        if case.evaluation_mode == "controlled_rag" and (not case.retrieved_source_ids or
                any(t.reference.tool_policy != "required" or
                    not t.reference.citation_source_ids or
                    not set(t.reference.citation_source_ids) <= set(case.retrieved_source_ids) or
                    ["search_info"] not in t.reference.required_tool_groups for t in [case, *case.followups])):
            raise ValueError(f"Caso controlled_rag senza retrieval e citazioni richiesti: {case.name}")
        if case.evaluation_mode == "live_tools" and (case.retrieved_source_ids or
                any(t.reference.tool_policy != "required" or
                    not any(group and set(group) <= {name for name, *_ in BROWSER_TOOLS} for group in t.reference.required_tool_groups)
                    for t in [case, *case.followups])):
            raise ValueError(f"Caso live_tools senza evidenze browser richieste: {case.name}")
        sources = set(case.provenance.source_ids) | set(case.retrieved_source_ids)
        for turn in [case, *case.followups]:
            if turn.fixture_id not in fixtures: raise ValueError(f"Fixture sconosciuta in {case.name}: {turn.fixture_id}")
            ref = turn.reference
            sources.update(ref.citation_source_ids)
            names = set(ref.forbidden_tools) | {name for group in ref.required_tool_groups for name in group}
            if names - tool_names: raise ValueError(f"Tool sconosciuti in {case.name}: {names - tool_names}")
            if any(not group or set(group) <= set(ref.forbidden_tools) for group in ref.required_tool_groups):
                raise ValueError(f"Requisiti tool incoerenti in {case.name}")
            if ref.tool_policy == "forbidden" and ref.required_tool_groups:
                raise ValueError(f"Tool vietati e richiesti nello stesso caso: {case.name}")
            for number in ref.numbers:
                units = {"ohm_current": "A", "resistor_power": "W", "divider_voltage": "V", "rc_tau": "s",
                    "series_resistance": "ohm", "series_current": "A", "series_voltage": "V",
                    "parallel_resistance": "ohm", "parallel_current": "A",
                    "rc_step": "V", "cutoff": "Hz", "derating": "W", "power_load_percent": "percent",
                    "thermal_equilibrium": "degC", "led_resistor": "ohm", "logic_and": "logic"}
                if number.calculation in units and number.unit != units[number.calculation]:
                    raise ValueError(f"Unità del riferimento incoerente in {case.name}: {number.label}")
                calculated = calculate_reference(number)
                if not math.isclose(number.value, calculated, rel_tol=1e-9, abs_tol=1e-10):
                    raise ValueError(f"Etichetta numerica incoerente in {case.name}: {number.label}")
                if number.fixture_path:
                    actual = resolve_fixture_path(fixtures[turn.fixture_id], number.fixture_path)
                    if not isinstance(actual, (float, int)) or not math.isclose(actual, number.value,
                            rel_tol=1e-9, abs_tol=1e-10):
                        raise ValueError(f"Fixture e riferimento discordano in {case.name}: {number.label}")
        if sources - corpus.keys(): raise ValueError(f"Fonti sconosciute in {case.name}: {sources - corpus.keys()}")
        for source_id in sources:
            publication = corpus[source_id].publication
            if publication:
                if case.evaluation_mode is None:
                    raise ValueError(f"Un caso da pubblicazione richiede evaluation_mode: {case.name}")
                for page in publication.pdf_pages:
                    key = (publication.pdf_sha256, page)
                    if key in publication_splits and publication_splits[key] != case.split:
                        raise ValueError(f"Soluzioni della stessa pagina pubblicata in split diversi: {case.name}")
                    publication_splits[key] = case.split
        if case.adversarial_document and not case.retrieved_source_ids:
            raise ValueError("Un documento malevolo deve appartenere a un caso RAG controllato")
        if "search_info" in {tool for group in case.reference.required_tool_groups for tool in group} and not case.retrieved_source_ids:
            raise ValueError(f"Fonte documentale mancante in {case.name}")


def load_dataset(directory=DATA_DIR, *, root=ROOT, verify_sources=True):
    directory = Path(directory)
    paths = [directory / name for name in ("dataset.v1.json", "fixtures.v1.json", "corpus.v1.json")]
    data = EvaluationDataset.model_validate_json(paths[0].read_text())
    fixture_catalog = FixtureCatalog.model_validate_json(paths[1].read_text())
    corpus_catalog = DatasetCorpus.model_validate_json(paths[2].read_text())
    fixtures = {f.id: f for f in fixture_catalog.fixtures}
    corpus = {s.id: s for s in corpus_catalog.sources}
    if len(fixtures) != len(fixture_catalog.fixtures) or len(corpus) != len(corpus_catalog.sources):
        raise ValueError("Identificativi duplicati nel catalogo di fixture o fonti")
    for source in corpus.values():
        if hashlib.sha256(source.excerpt.encode()).hexdigest() != source.sha256:
            raise ValueError(f"Hash estratto non valido: {source.id}")
        if verify_sources:
            path = local_source(root, source.path)
            if source.excerpt not in path.read_text():
                raise ValueError(f"Estratto non più presente nella fonte: {source.id}; revisionare il caso")
            if source.publication:
                paths.append(path)  # Include anche attribuzioni e trascrizioni nell'identità.
    validate_cases(data.cases, fixtures, corpus)
    if data.status == "reviewed" and any(c.provenance.review_status != "accepted" for c in data.cases):
        raise ValueError("Un dataset reviewed richiede la revisione di tutti i casi")
    return DatasetBundle(data, fixtures, corpus, {path.resolve(): file_digest(path) for path in paths})


def select_cases(bundle, *, split="development", category=None, case_name=None, include_rag=False, mode=None):
    cases = [case for case in bundle.dataset.cases if case.provenance.review_status != "rejected"
        and (split == "all" or case.split == split)
        and (not category or case.category == category)
        and (not case_name or case.name == case_name)
        and (not mode or case.evaluation_mode == mode)
        and (include_rag or not case.retrieved_source_ids)]
    if not cases: raise ValueError("Nessun caso corrisponde ai filtri; verificare split, ID e abilitazione RAG")
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="Elenca domande e categorie senza contattare il modello")
    parser.add_argument("--show", help="Mostra tutti i riferimenti di un caso, riservati alla revisione")
    parser.add_argument("--directory", type=Path, default=DATA_DIR)
    parser.add_argument("--source", help="Mostra estratto e provenienza di una fonte, riservati alla revisione")
    parser.add_argument("--verify-publications", action="store_true", help="Verifica SHA-256 dei PDF locali e presenza degli estratti nelle pagine dichiarate; richiede Poppler")
    args = parser.parse_args()
    bundle = load_dataset(args.directory)
    if args.verify_publications:
        print("Estratti verificati nei PDF:", verify_publications(bundle.corpus, ROOT))
    print(f"{bundle.dataset.id} {bundle.dataset.version}: {len(bundle.dataset.cases)} casi, stato {bundle.dataset.status}")
    print("Split:", dict(Counter(c.split for c in bundle.dataset.cases)))
    print("Categorie:", dict(Counter(c.category for c in bundle.dataset.cases)))
    print("Revisione:", dict(Counter(c.provenance.review_status for c in bundle.dataset.cases)))
    print("SHA-256 bundle:", bundle.identity()["bundle_sha256"])
    if args.list:
        for case in bundle.dataset.cases:
            print(f"{case.name:30} {case.split:12} {case.category:13} {case.evaluation_mode or 'legacy':15} {case.question}")
    if args.show:
        case = next((c for c in bundle.dataset.cases if c.name == args.show), None)
        if case is None: parser.error("Caso sconosciuto")
        print(case.model_dump_json(indent=2))
    if args.source:
        if args.source not in bundle.corpus: parser.error("Fonte sconosciuta")
        print(bundle.corpus[args.source].model_dump_json(indent=2))


if __name__ == "__main__": main()
