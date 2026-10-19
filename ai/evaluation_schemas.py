"""Contratti delle annotazioni umane: nessuna etichetta viene generata dal modello."""
from typing import Literal

from pydantic import Field, model_validator

from judge import CRITERIA
from schemas import JudgeInput, Schema


class HumanAnnotation(Schema):
    task_id: str = Field(description="Hash immutabile di caso, turno, ripetizione e contenuto da valutare.")
    case_id: str = Field(description="ID del caso; per la calibrazione si annota una risposta per caso distinto.")
    turn: int = Field(ge=1, description="Turno della risposta nel caso conversazionale.")
    repetition: int = Field(ge=1, description="Ripetizione del caso nell'esperimento.")
    input: JudgeInput = Field(description="Stessi dati forniti al judge, senza i suoi voti o il nome del tutor; non modificare.")
    scores: dict[str, Literal[0, 1, 2] | None] = Field(description="Quattro voti umani secondo la rubric, inizialmente tutti null: non sono etichette già approvate.")
    reviewed_by: str | None = Field(default=None, min_length=1, description="Nome della persona che ha effettivamente letto e valutato la risposta; non un modello.")
    note: str | None = Field(default=None, description="Motivazione o segnalazione di riferimenti ambigui per migliorare la rubric.")

    @model_validator(mode="after")
    def labels_are_complete_or_blank(self):
        if set(self.scores) != set(CRITERIA):
            raise ValueError("Servono i quattro criteri della rubric")
        filled = sum(value is not None for value in self.scores.values())
        if filled not in {0, len(CRITERIA)}:
            raise ValueError("Compilare tutti i quattro voti della risposta oppure lasciarli tutti null")
        if filled and (not self.reviewed_by or not self.reviewed_by.strip()):
            raise ValueError("Le etichette richiedono il nome del revisore umano")
        return self


class AnnotationSet(Schema):
    format_version: Literal[1] = Field(default=1, description="Versione del formato di annotazione umana.")
    report_sha256: str = Field(description="Impronta del report immutabile da confrontare, per non associare etichette a risposte diverse.")
    protocol_id: str = Field(description="Impronta opaca del protocollo del judge; nessun voto o identità del modello è mostrato all'annotatore.")
    instructions: str = Field(description="Istruzioni di compilazione e rubric dei punteggi, senza suggerimenti del judge.")
    tasks: list[HumanAnnotation] = Field(description="Risposte da leggere e annotare manualmente; una per caso distinto nel confronto statistico.")


class CriterionAgreement(Schema):
    samples: int = Field(ge=0, description="Risposte di casi distinti confrontate per questo criterio.")
    exact_agreement: float | None = Field(default=None, ge=0, le=1, description="Frazione di voti esattamente uguali; null senza campioni.")
    agreement_wilson_95: tuple[float, float] | None = Field(default=None, description="Intervallo Wilson nominale al 95% sull'accordo osservato; casi rappresentativi e indipendenza non sono garantiti.")
    cohen_kappa: float | None = Field(default=None, ge=-1, le=1, description="Accordo corretto per le frequenze marginali; null se indefinito per assenza di variabilità.")
    confusion_matrix: list[list[int]] = Field(description="Matrice 3x3: righe voto umano 0/1/2, colonne voto judge 0/1/2.")


class CalibrationReport(Schema):
    format_version: Literal[1] = Field(default=1, description="Versione del confronto fra judge ed etichette umane.")
    report_sha256: str = Field(description="Impronta del report delle risposte e dei giudizi confrontati.")
    annotations_sha256: str = Field(description="Impronta delle annotazioni effettivamente usate.")
    protocol_id: str = Field(description="Protocollo specifico cui si riferisce il confronto; non vale automaticamente per altri judge o rubric.")
    status: Literal["insufficient_data", "needs_revision", "ready_for_review"] = Field(description="Ready richiede almeno 50 casi distinti e accordo sufficiente per tutti i criteri; non è una certificazione né un'approvazione automatica.")
    distinct_cases: int = Field(ge=0, description="Casi con etichette umane complete e giudizi automatici confrontabili, senza gonfiare il campione con ripetizioni.")
    labeled_without_judge: int = Field(ge=0, description="Risposte annotate ma senza judge completato, escluse dal confronto e mai considerate concordanti.")
    criteria: dict[str, CriterionAgreement] = Field(description="Accordo, intervalli, kappa e matrici separati per dimensione.")
    policy: dict[str, float | int] = Field(description="Soglie operative iniziali dichiarate, da rivedere con etichette reali: 50 casi, accordo 0.8, kappa 0.6.")
    limitations: list[str] = Field(description="Limiti del campione, selezione, riferimenti e necessità di un nuovo campione dopo la riscrittura della rubric.")
