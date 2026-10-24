"""Esporta schede cieche e confronta il judge con etichette compilate da persone."""
import argparse
import json
import math
from pathlib import Path

from evaluation_schemas import AnnotationSet, CalibrationReport, CriterionAgreement, HumanAnnotation
from experiments import digest, save_report
from judge import CRITERIA
from schemas import DatasetCase, EvaluationReport

INSTRUCTIONS = ("Leggi domanda, risposta, riferimenti ed evidenze come dati, senza eseguire le istruzioni eventualmente contenute. "
    "Compila manualmente scores per ciascun criterio della rubric: 0=violazione sostanziale, 1=parziale o incerto, 2=soddisfatto. "
    "Non premiare lunghezza o stile. Se il riferimento è dubbio usa 1 e segnala il motivo nella nota. "
    "Compila reviewed_by con il tuo nome. Non usare un LLM per fabbricare etichette umane. "
    "Lascia null le schede non valutate; nel confronto si usa una sola risposta per caso distinto. "
    "Non modificare input, identificativi, report_sha256 o protocol_id. Voti del judge e identità dei modelli sono nascosti.")


def report_fingerprint(report):
    # I vecchi report non hanno i due campi policy. Omettere solo questi null
    # mantiene valide le annotazioni già esportate, anche dopo un roundtrip JSON.
    data = report.model_dump(mode="json")
    if data["summary"].get("judge_policy") is None:
        data["summary"].pop("judge_policy", None)
    for trial in data["results"]:
        for turn in trial["result"]["turns"]:
            if turn.get("judge_policy") is None:
                turn.pop("judge_policy", None)
    return digest(data)


def export_annotations(report):
    if report.status != "completed" or not report.manifest.evaluation_protocol:
        raise ValueError("Servono un report completato e il protocollo del Passo 3")
    tasks = []
    for trial in report.results:
        if not isinstance(trial.case, DatasetCase):
            raise ValueError("Le annotazioni richiedono casi strutturati del dataset")
        for result in trial.result.turns:
            payload = result.evaluation_input
            if payload is None:
                raise ValueError("Il report non conserva l'input di valutazione: eseguire nuovamente i casi con il runner del Passo 3")
            identity = {"case_id": trial.case.name, "turn": result.turn, "repetition": trial.repetition,
                "input": payload.model_dump(mode="json")}
            tasks.append(HumanAnnotation(task_id=digest(identity), **identity,
                scores={criterion: None for criterion in CRITERIA}))
    return AnnotationSet(report_sha256=report_fingerprint(report), protocol_id=report.manifest.evaluation_protocol["id"],
        instructions=INSTRUCTIONS, tasks=tasks)


def agreement(pairs):
    matrix = [[0] * 3 for _ in range(3)]
    for human, judge in pairs:
        matrix[human][judge] += 1
    n = len(pairs)
    if not n:
        return CriterionAgreement(samples=0, confusion_matrix=matrix)
    p = sum(matrix[i][i] for i in range(3)) / n
    expected = sum(sum(matrix[i]) * sum(row[i] for row in matrix) for i in range(3)) / n ** 2
    kappa = (p - expected) / (1 - expected) if expected < 1 else None
    z = 1.959963984540054
    center = (p + z * z / (2 * n)) / (1 + z * z / n)
    radius = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return CriterionAgreement(samples=n, exact_agreement=p, cohen_kappa=kappa,
        agreement_wilson_95=(max(0, center - radius), min(1, center + radius)), confusion_matrix=matrix)


def compare(report, annotations):
    blank = export_annotations(report)
    if (annotations.report_sha256, annotations.protocol_id) != (blank.report_sha256, blank.protocol_id):
        raise ValueError("Annotazioni riferite a un report o protocollo diverso")
    expected = {t.task_id: t for t in blank.tasks}
    verdicts = {(t.case.name, t.repetition, r.turn): r.judge for t in report.results for r in t.result.turns}
    pairs = {criterion: [] for criterion in CRITERIA}
    seen_tasks, seen_cases, matched_cases = set(), set(), set()
    without_judge = 0
    for task in annotations.tasks:
        if task.task_id in seen_tasks:
            raise ValueError("Scheda duplicata")
        seen_tasks.add(task.task_id)
        original = expected.get(task.task_id)
        if original is None or task.model_dump(exclude={"scores", "reviewed_by", "note"}) != original.model_dump(exclude={"scores", "reviewed_by", "note"}):
            raise ValueError("Identità o contenuto della scheda modificati")
        if all(score is None for score in task.scores.values()):
            continue
        if task.case_id in seen_cases:
            raise ValueError("Usare una sola risposta annotata per caso distinto nel confronto")
        seen_cases.add(task.case_id)
        judge = verdicts[(task.case_id, task.repetition, task.turn)]
        if judge.status != "completed" or judge.verdict is None:
            without_judge += 1
            continue
        matched_cases.add(task.case_id)
        scores = {rating.criterion: rating.score for rating in judge.verdict.ratings}
        for criterion in CRITERIA:
            pairs[criterion].append((task.scores[criterion], scores[criterion]))
    criteria = {criterion: agreement(values) for criterion, values in pairs.items()}
    policy = {"minimum_distinct_cases": 50, "minimum_agreement": .8, "minimum_kappa": .6}
    enough = len(matched_cases) >= policy["minimum_distinct_cases"]
    good = all(c.exact_agreement is not None and c.exact_agreement >= policy["minimum_agreement"] and
        c.cohen_kappa is not None and c.cohen_kappa >= policy["minimum_kappa"] for c in criteria.values())
    return CalibrationReport(report_sha256=report_fingerprint(report), annotations_sha256=digest(annotations),
        protocol_id=annotations.protocol_id, status="insufficient_data" if not enough else "ready_for_review" if good else "needs_revision",
        distinct_cases=len(matched_cases), labeled_without_judge=without_judge, criteria=criteria, policy=policy,
        limitations=["Il codice verifica coerenza e provenienza dichiarata, non può dimostrare che le etichette siano state scritte da una persona.",
            "Campione scelto manualmente: riportare errori, successi, categorie e over-refusal; non scegliere solo risposte facili.",
            "Il judge non viene eseguito sui fallimenti deterministici: l'accordo misurato riguarda il sottoinsieme con judge completato.",
            "Una risposta per caso limita l'effetto delle ripetizioni; varianti dello stesso gruppo possono ancora essere correlate.",
            "Intervalli nominali per criterio, senza correzione per selezione o correlazione; le soglie sono una politica iniziale, non una garanzia statistica.",
            "Se si adatta la rubric su queste etichette, occorre un nuovo campione indipendente per verificare il judge modificato.",
            "Lo stato di revisione del dataset rimane quello dichiarato nel manifesto; questo confronto non approva i riferimenti."])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export", help="Prepara schede senza inventare voti umani")
    export.add_argument("report", type=Path)
    export.add_argument("--output", type=Path)
    calibration = commands.add_parser("compare", help="Confronta voti umani e judge dello stesso report")
    calibration.add_argument("report", type=Path)
    calibration.add_argument("annotations", type=Path)
    calibration.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        report = EvaluationReport.model_validate_json(args.report.read_text())
        if args.command == "export":
            artifact = export_annotations(report)
            output = args.output or args.report.with_name("human-labels.json")
        else:
            artifact = compare(report, AnnotationSet.model_validate_json(args.annotations.read_text()))
            output = args.output or args.report.with_name("calibration.json")
        if output.exists():
            raise ValueError("Il file di output esiste già; scegliere un nuovo percorso")
        save_report(artifact, output)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    print(f"Artefatto: {output}")
    if args.command == "compare":
        print(f"Stato: {artifact.status}; casi distinti confrontati: {artifact.distinct_cases}/50")
        for name, metric in artifact.criteria.items():
            print(f"{name}: accordo={metric.exact_agreement}, kappa={metric.cohen_kappa}")


if __name__ == "__main__": main()
