"""Prove costruite su fonti pubblicate: aspettative tecniche, mai voti umani."""
from typing import Literal

from pydantic import Field, model_validator

from circuit_ai.contracts.shared import (ExperimentManifest, JudgeEvaluation, JudgeInput, Schema)

Criterion = Literal["relevance", "completeness", "groundedness", "compliance"]
Variant = Literal["correct_concise", "correct_explained", "controlled_error"]


class ProbeQuantity(Schema):
    value: float = Field(description="Valore della quantità alterata, espresso nell'unità canonica dichiarata.")
    unit: str = Field(description="Unità canonica dopo l'alterazione: A, V, W oppure ohm.")


class ControlledMutation(Schema):
    kind: Literal["numeric_value", "unit", "component_swap", "truth_table", "rms_confusion", "unsupported_claim", "component_mapping"] = Field(description="Errore deliberato; questa etichetta non viene inviata al judge.")
    before: str = Field(min_length=1, description="Passaggio corretto da sostituire una sola volta nella risposta spiegata.")
    after: str = Field(min_length=1, description="Passaggio alterato che introduce l'errore controllato.")
    explanation: str = Field(min_length=1, description="Motivazione del difetto rispetto al riferimento pubblicato, riservata al report.")
    reference_indices: list[int] = Field(default_factory=list, description="Indici delle etichette numeriche originali: uno per valore/unità, due per uno scambio.")
    wrong_quantity: ProbeQuantity | None = Field(default=None, description="Quantità errata per controllare che l'alterazione numerica sia effettiva.")
    logic_gate: Literal["and", "xor"] | None = Field(default=None, description="Operatore indipendente usato per verificare una mutazione della tabella di verità.")
    logic_inputs: tuple[Literal[0, 1], Literal[0, 1]] | None = Field(default=None, description="Ingresso binario cui si applica l'errore di tabella.")
    wrong_output: Literal[0, 1] | None = Field(default=None, description="Uscita deliberatamente errata per la riga logica.")
    target_criterion: Criterion = Field(default="groundedness", description="Dimensione che deve rilevare l'errore; non impone voti sulle altre dimensioni.")
    maximum_score: Literal[0, 1] = Field(default=1, description="Massimo voto accettabile sulla dimensione bersaglio, non un voto umano inventato.")


class JudgeProbeCase(Schema):
    case_id: str = Field(description="ID del caso nel dataset dei libri cui queste tre risposte si riferiscono.")
    correct_concise: str = Field(min_length=1, max_length=16000, description="Risposta breve proposta, costruita per coprire i concetti e i risultati della soluzione pubblicata.")
    correct_explained: str = Field(min_length=1, max_length=16000, description="Risposta proposta con procedimento esplicito, che copre gli stessi requisiti della versione breve.")
    mutation: ControlledMutation = Field(description="Trasformazione locale della risposta spiegata per ottenere il controllo negativo.")


class JudgeProbeSuite(Schema):
    format_version: Literal[1] = Field(default=1, description="Versione del formato delle prove controllate del judge.")
    id: str = Field(description="Identità stabile della suite, distinta dal dataset delle domande.")
    version: str = Field(description="Versione delle risposte e delle mutazioni, da incrementare quando vengono modificate.")
    dataset_bundle_sha256: str = Field(pattern=r"^[a-f0-9]{64}$", description="Impronta del dataset di riferimento: impedisce di applicare queste risposte a domande o soluzioni cambiate.")
    author: str = Field(description="Autore reale delle prove assistite; le soluzioni originali restano attribuite nel corpus.")
    expectation_basis: str = Field(description="Metodo di costruzione e limiti delle aspettative, distinto dalla calibrazione con etichette umane.")
    cases: list[JudgeProbeCase] = Field(min_length=1, description="Tre risposte per ciascun esercizio: breve, spiegata e alterata.")


class ScoreRange(Schema):
    minimum: Literal[0, 1, 2] = Field(description="Minimo voto compatibile con l'aspettativa del controllo.")
    maximum: Literal[0, 1, 2] = Field(description="Massimo voto compatibile con l'aspettativa del controllo.")

    @model_validator(mode="after")
    def ordered(self):
        if self.minimum > self.maximum:
            raise ValueError("Intervallo dei voti invertito")
        return self


class ScheduledProbe(Schema):
    case_id: str = Field(description="Esercizio di origine, usato per non contare varianti e ripetizioni come casi indipendenti.")
    variant: Variant = Field(description="Tipo di risposta, conservato solo dal runner e mai inserito nell'input del judge.")
    repetition: int = Field(ge=1, description="Ripetizione della stessa prova; non aumenta la copertura di esercizi distinti.")


class JudgeProbeTrial(Schema):
    scheduled: ScheduledProbe = Field(description="Identità della prova e posizione logica della ripetizione.")
    split: Literal["development", "validation"] = Field(description="Split originale della famiglia di esercizi.")
    group_id: str = Field(description="Famiglia originaria, condivisa dalle varianti dello stesso esercizio.")
    input: JudgeInput = Field(description="Input esatto inviato al judge; privo di etichette della variante, mutazioni e voti attesi.")
    input_sha256: str = Field(description="Impronta dell'input esatto per confronti e revisioni successive.")
    expectations: dict[Criterion, ScoreRange] = Field(description="Limiti dei voti attesi, applicati solo dopo la risposta del judge.")
    judge: JudgeEvaluation = Field(description="Output strutturato e metriche effettive del solo judge.")
    expectations_met: bool | None = Field(description="Null se il judge non ha completato; false per un disaccordo, true per i limiti soddisfatti. Non certifica la correttezza della suite.")


class JudgeProbeSummary(Schema):
    planned: int = Field(ge=0, description="Numero di prove pianificate, comprese le ripetizioni critiche.")
    attempted: int = Field(ge=0, description="Prove effettivamente tentate e conservate nel report.")
    completed: int = Field(ge=0, description="Prove con JudgeVerdict valido; gli errori operativi sono esclusi dai tassi qualitativi.")
    operational_errors: int = Field(ge=0, description="Prove tentate senza un giudizio valido; non valgono come accordo né come errori semantici.")
    expectations_met: int = Field(ge=0, description="Giudizi che soddisfano i limiti proposti per la rispettiva prova.")
    positive_completed: int = Field(ge=0, description="Risposte proposte come corrette con judge completato.")
    false_rejections: int = Field(ge=0, description="Risposte proposte come corrette cui il judge ha assegnato almeno un voto inferiore a 2.")
    false_rejection_rate: float | None = Field(ge=0, le=1, description="Rifiuti delle risposte proposte come corrette diviso positivi completati; null senza denominatore. Condizionato alla validità delle aspettative.")
    negative_completed: int = Field(ge=0, description="Risposte con errore controllato e judge completato.")
    false_acceptances: int = Field(ge=0, description="Risposte alterate cui il judge ha assegnato 2 in tutte le dimensioni.")
    false_acceptance_rate: float | None = Field(ge=0, le=1, description="Accettazioni delle risposte alterate diviso negativi completati; null senza denominatore.")
    targeted_misses: int = Field(ge=0, description="Errori controllati non penalizzati nella dimensione bersaglio, anche quando un'altra dimensione evita l'accettazione totale.")
    style_pairs: int = Field(ge=0, description="Coppie breve/spiegata completate nello stesso esercizio e ripetizione.")
    concise_penalized: int = Field(ge=0, description="Coppie in cui almeno un criterio della risposta breve ha voto inferiore a quello della spiegata; segnale diagnostico, non prova causale di verbosity bias.")
    explained_penalized: int = Field(ge=0, description="Coppie in cui almeno un criterio della spiegata ha voto inferiore a quello della breve.")
    distinct_cases: int = Field(ge=0, description="Esercizi distinti effettivamente tentati; varianti e ripetizioni non li moltiplicano.")
    distinct_groups: int = Field(ge=0, description="Famiglie distinte tentate: il campione può essere correlato anche fra esercizi diversi.")
    outcome: Literal["not_evaluated", "needs_revision", "checks_passed"] = Field(description="Checks_passed richiede tutte le prove pianificate completate e aspettative soddisfatte; non abilita automaticamente una baseline o il push.")


class JudgeProbeReport(Schema):
    format_version: Literal[1] = Field(default=1, description="Versione del report di verifica del judge.")
    purpose: Literal["judge_verification"] = Field(default="judge_verification", description="Questa esecuzione valuta il judge su risposte predefinite, senza generare risposte del tutor.")
    manifest: ExperimentManifest = Field(description="Identità e parametri del modello che agisce da judge; nessuna chiave API viene conservata.")
    suite_id: str = Field(description="Identità della suite di controlli utilizzata.")
    suite_version: str = Field(description="Versione delle risposte e delle mutazioni.")
    suite_path: str = Field(description="Percorso locale alla repository del file delle prove.")
    suite_sha256: str = Field(description="Impronta del file della suite al momento della preparazione.")
    verification_schema_sha256: str = Field(description="Impronta dei contratti della suite e del report di verifica.")
    order_seed: int = Field(description="Seed dell'ordine delle prove, distinto dai parametri di generazione del judge.")
    repetitions: int = Field(ge=1, description="Ripetizioni di base per ciascuna delle tre risposte; corrisponde al valore nel manifesto.")
    critical_repetitions: int = Field(ge=1, description="Ripetizioni effettive per i casi critici, almeno pari alle ripetizioni di base; schedule resta l'elenco autorevole.")
    consecutive_error_limit: int = Field(ge=1, description="Numero di errori operativi consecutivi che interrompe il batch; i disaccordi semantici non interrompono la raccolta.")
    schedule: list[ScheduledProbe] = Field(description="Ordine esatto delle chiamate pianificate, conservato anche nei report preparati o interrotti.")
    status: Literal["prepared", "running", "completed", "unavailable", "interrupted", "invalidated"] = Field(description="Stato operativo dell'esecuzione, distinto dall'esito delle aspettative.")
    results: list[JudgeProbeTrial] = Field(default_factory=list, description="Prove tentate con input e giudizi effettivi; un errore non viene trasformato in un voto favorevole.")
    summary: JudgeProbeSummary = Field(description="Copertura, errori e confronti, senza mescolare tentativi operativi e disaccordi semantici.")
    completed_at: str | None = Field(default=None, description="Istante UTC di completamento o interruzione; null per un manifesto preparato.")
    error: str | None = Field(default=None, description="Errore operativo o di integrità, senza dettagli che possano contenere credenziali.")
    human_calibrated: Literal[False] = Field(default=False, description="Le aspettative sono prove assistite basate su fonti, non etichette umane.")
    baseline_approved: Literal[False] = Field(default=False, description="Un esito favorevole non congela né approva automaticamente la baseline.")
    limitations: list[str] = Field(description="Ambito del campione, affidabilità proposta delle risposte, dipendenza fra varianti e controlli semantici ancora da revisionare.")
