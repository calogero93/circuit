"""Dataset 100: provenienza, scopi e risultati attesi espliciti e revisionabili."""
from typing import Literal

from pydantic import Field, model_validator

from circuit_ai.contracts.shared import CalculationVariable, DatasetSource
from circuit_ai.contracts.verification import Contract


# Alias per i client del benchmark; il contratto appartiene ai tool condivisi.
from circuit_ai.contracts.calculations import ArithmeticInput


class ExpectedNumber(Contract):
    label: str = Field(min_length=1, description="Componente, grandezza e condizioni del valore atteso.")
    value: float = Field(description="Valore di riferimento pubblicato o misurato da ngspice, mai generato da un LLM.")
    unit: str = Field(description="Unità SI o unità esplicita del risultato, compresi dB e deg.")
    absolute_tolerance: float = Field(default=1e-8, ge=0, description="Tolleranza assoluta, dichiarata prima della valutazione.")
    relative_tolerance: float = Field(default=.001, ge=0, le=.05, description="Tolleranza relativa per arrotondamenti del libro o della simulazione.")
    source_quote: str | None = Field(default=None, description="Passaggio originale che contiene il risultato pubblicato; richiesto per gli esercizi svolti.")
    measure: str | None = Field(default=None, description="Nome della misura realmente eseguita da ngspice, non un valore inserito a mano.")


class Alteration(Contract):
    parent_id: str = Field(description="Caso base corretto, da mantenere nello stesso split della variante.")
    before: str = Field(min_length=1, description="Passaggio corretto sostituito una sola volta.")
    after: str = Field(min_length=1, description="Passaggio volutamente errato nel candidato del verificatore.")
    reason: str = Field(min_length=1, description="Motivo documentato dell'errore, riservato al report e non al modello valutato.")


class BenchmarkCase(Contract):
    id: str = Field(pattern=r'^[a-z0-9-]+$', description="Identità stabile del record, distinta dalla famiglia di esercizi.")
    bucket: Literal['worked','ngspice','theory','stress'] = Field(description="Strato del campione: 30/30/20/20 record.")
    purpose: Literal['tutor','verifier'] = Field(description="Tutor genera una risposta; verifier valuta un candidato alterato. Non aggregare i due scopi in un'unica accuracy.")
    challenge: Literal['standard','altered','ambiguous','difficult'] = Field(description="Tipo di difficoltà, distinto dal fatto che la risposta attesa sia corretta.")
    group_id: str = Field(description="Famiglia di circuito/esempio: varianti e corrispondenti casi negativi non attraversano gli split.")
    split: Literal['development','validation'] = Field(description="Sviluppo o validazione; nessun adattamento guidato dai risultati di validation.")
    question: str = Field(min_length=1, description="Domanda italiana presentata al tutor, senza la soluzione del riferimento.")
    reference_answer: str = Field(min_length=1, description="Risposta corretta proposta con valori, spiegazioni e limiti attribuiti alle fonti.")
    facts: list[str] = Field(min_length=1, description="Affermazioni fattuali del riferimento NLI; non istruzioni o parole chiave.")
    source_ids: list[str] = Field(min_length=1, description="Fonti e risultati ngspice effettivamente presenti nel catalogo.")
    numbers: list[ExpectedNumber] = Field(default_factory=list, description="Risultati numerici indipendenti da confrontare, inclusi eventuali valori intermedi richiesti.")
    answer_kind: Literal['theory','limitation'] = Field(default='theory', description="Tipo atteso nel banco offline; non si inventano misure di un browser reale.")
    spice_id: str | None = Field(default=None, description="Artefatto di simulazione associato, per i 30 circuiti verificati.")
    candidate_answer: str | None = Field(default=None, description="Risposta volutamente alterata, riservata ai controlli del verificatore.")
    alteration: Alteration | None = Field(default=None, description="Mutazione locale verificabile, mai una risposta da insegnare al tutor.")
    symbolic_results: list[str] = Field(default_factory=list, description="Risultati non rappresentabili da una quantità fisica, per esempio notazione binaria o espressione booleana.")

    @property
    def name(self):
        return self.id

    @model_validator(mode='after')
    def coherent(self):
        if self.purpose == 'verifier':
            if self.challenge != 'altered' or not self.candidate_answer or self.alteration is None:
                raise ValueError('Il controllo negativo richiede candidato e mutazione')
        elif self.candidate_answer is not None or self.alteration is not None:
            raise ValueError('Un caso tutor non contiene una risposta alterata')
        if (self.bucket == 'ngspice') != (self.spice_id is not None):
            raise ValueError('Solo i 30 casi ngspice hanno una simulazione associata')
        if self.bucket == 'worked' and not self.numbers and not self.symbolic_results:
            raise ValueError('Un esercizio svolto richiede un risultato pubblicato')
        if self.bucket == 'worked' and any(n.source_quote is None for n in self.numbers):
            raise ValueError('Un risultato svolto richiede il passaggio della soluzione')
        return self


class Benchmark100(Contract):
    version: str = Field(description="Versione del nuovo dataset, distinta dagli esperimenti precedenti.")
    status: Literal['proposed'] = Field(description="Dati attribuiti e verificati tecnicamente, senza inventare una revisione umana.")
    author: str = Field(description="Autore reale dell'adattamento; gli autori tecnici restano nelle fonti.")
    sources: list[DatasetSource] = Field(description="Catalogo degli estratti pubblicati e degli artefatti di simulazione.")
    cases: list[BenchmarkCase] = Field(min_length=100, max_length=100, description="100 record: 90 domande del tutor e 10 controlli negativi del verificatore.")
