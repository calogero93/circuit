"""Contratti del verificatore numerico + NLI; tutti gli esiti restano separati."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


Status = Literal["pass", "fail", "review"]


class NumericMention(Contract):
    id: int = Field(ge=0, description="Indice assegnato dal parser, non dal modello; identifica una specifica occorrenza anche se il valore si ripete.")
    start: int = Field(ge=0, description="Offset iniziale dell'occorrenza nel testo originale, in caratteri Python.")
    end: int = Field(gt=0, description="Offset finale esclusivo nel testo originale.")
    quote: str = Field(description="Testo originale esatto che contiene numero e unità, senza ricostruzioni del modello.")
    value: float = Field(description="Valore letto dal parser in unità SI, senza fare calcoli LLM.")
    unit: str = Field(description="Unità SI normalizzata dal parser.")


class NumericBinding(Contract):
    mention_id: int = Field(ge=0, description="ID dell'occorrenza da classificare. Non si restituiscono valori numerici corretti o riscritti.")
    role: Literal["result", "given", "refuted", "unknown"] = Field(description="Result: risultato sostenuto; given: dato di ingresso ripreso dalla domanda; refuted: errore citato esplicitamente per confutarlo; unknown: ruolo non determinabile.")
    reference_index: int | None = Field(description="Indice del riferimento numerico cui è associato il risultato, considerando componente, grandezza e condizioni. Null per dati di ingresso, confutazioni o risultati non coperti; mai scegliere per somiglianza del valore.")


class ResponseInventory(Contract):
    bindings: list[NumericBinding] = Field(max_length=160, description="Esattamente una classificazione per OGNI occorrenza fornita dal parser, senza omissioni o duplicati. Non modificare il testo originale.")

    @model_validator(mode="after")
    def unique_mentions(self):
        if len({b.mention_id for b in self.bindings}) != len(self.bindings):
            raise ValueError("Occorrenze duplicate nell'inventario")
        if any(b.role != "result" and b.reference_index is not None for b in self.bindings):
            raise ValueError("Solo i risultati possono riferirsi a un indice numerico")
        return self


class InventoryAttempt(Contract):
    tool_name: str | None = Field(description="Nome effettivo della singola funzione restituita; null se assente o se ci sono più chiamate.")
    arguments: dict[str, JsonValue] | None = Field(description="Argomenti originali, anche se lo schema o le associazioni sono invalidi; nessuna correzione retroattiva.")
    accepted: bool = Field(description="True solo dopo schema, copertura e coerenza di unità e componenti espliciti verificati nel codice.")
    error: str | None = Field(description="Difetto dell'inventario, non prova di un errore nella risposta del tutor.")


class NumericCheck(Contract):
    mention_id: int | None = Field(description="Occorrenza verificata; null per controlli di copertura o del contratto globale.")
    reference_index: int | None = Field(description="Riferimento numerico confrontato; null se non applicabile.")
    status: Status = Field(description="Pass: confronto superato nel perimetro dichiarato; fail: contraddizione verificabile; review: dati o associazione non sufficienti.")
    actual_value: float | None = Field(description="Valore realmente presente nella risposta, letto dal parser; null per copertura.")
    expected_value: float | None = Field(description="Valore atteso indipendente presente nel dataset; mai generato dal modello estrattore.")
    unit: str | None = Field(description="Unità SI del confronto; null se non applicabile.")
    detail: str = Field(description="Motivazione verificabile del controllo e suoi limiti.")


class NliScores(Contract):
    entailment: float = Field(ge=0, le=1, description="Probabilità di supporto secondo il modello NLI; non è una probabilità calibrata di verità.")
    contradiction: float = Field(ge=0, le=1, description="Probabilità di contraddizione rispetto alla premessa, secondo il modello NLI.")
    neutral: float = Field(ge=0, le=1, description="Probabilità che il rapporto non sia determinabile dalla premessa.")

    @model_validator(mode="after")
    def probabilities(self):
        if abs(self.entailment + self.contradiction + self.neutral - 1) > 1e-5:
            raise ValueError("Le probabilità NLI devono sommare a uno")
        return self


class NliRequest(Contract):
    premise: str = Field(min_length=1, max_length=20000, description="Premessa fattuale, senza istruzioni eseguibili.")
    hypothesis: str = Field(min_length=1, max_length=12000, description="Affermazione da confrontare con la premessa.")


class NliResponse(Contract):
    model_id: str = Field(description="SHA-256 dell'identità dei pesi e del runtime caricati, per rilevare cambi durante un esperimento.")
    scores: NliScores | None = Field(description="Probabilità del classificatore, non inventate da un modello chat; null in caso di errore.")
    error: str | None = Field(description="Limite o errore operativo; non viene trasformato in supporto.")


class ExplanationReference(Contract):
    statement: str = Field(min_length=1, max_length=2400, description="Affermazione fattuale di riferimento, con soggetto e ipotesi espliciti; non un'istruzione al tutor o una parola chiave.")
    source_ids: list[str] = Field(description="Fonti pubblicate effettivamente disponibili che sostengono la parafrasi; non fonti inventate dal verificatore.")
    evidence_ids: list[str] = Field(description="Output tool correnti che sostengono fatti della fixture e corrispondenze ai componenti; [] nei casi teorici.")
    required: bool = Field(description="True se il concetto è richiesto anche nella verifica di completezza; false per fatti utilizzabili solo per controllare correttezza.")

    @model_validator(mode="after")
    def has_basis(self):
        if not self.source_ids and not self.evidence_ids:
            raise ValueError("Un riferimento NLI richiede una fonte o un'evidenza effettiva")
        return self


class NliCheck(Contract):
    direction: Literal["faithfulness", "completeness"] = Field(description="Faithfulness: riferimento→affermazione; completeness: risposta→concetto richiesto. I due controlli non sono intercambiabili.")
    premise: str = Field(description="Premessa esatta inviata al classificatore locale.")
    hypothesis: str = Field(description="Affermazione esatta o concetto richiesto confrontato con la premessa.")
    scores: NliScores | None = Field(description="Tre probabilità effettive; null se il confronto non è stato eseguito.")
    status: Status = Field(description="Contraddizione sufficientemente netta: fail; supporto netto: pass; neutro, incerto o errore operativo: review.")
    detail: str = Field(description="Criterio di decisione o limite operativo; nessun errore viene convertito in supporto.")


class ExplanationSuite(Contract):
    format_version: Literal[1] = Field(description="Versione del formato dei riferimenti fattuali NLI.")
    version: str = Field(description="Versione dei fatti e dei requisiti di completezza, da cambiare se vengono modificati.")
    dataset_bundle_sha256: str = Field(pattern=r"^[a-f0-9]{64}$", description="Dataset originale cui appartengono i fatti; impedisce l'uso dopo cambiamenti non revisionati.")
    author: str = Field(description="Autore reale delle parafrasi e delle corrispondenze, distinto dagli autori delle fonti pubblicate.")
    review_status: Literal["proposed"] = Field(description="Parafrasi assistite da revisionare, non etichette umane né verità certificate dal modello NLI.")
    cases: dict[str, list[ExplanationReference]] = Field(description="Riferimenti fattuali per ID del caso, con fonti/evidenze e obblighi di completezza espliciti.")


class AnswerVerification(Contract):
    numeric_status: Status = Field(description="Esito dei confronti numerici, separato dalle spiegazioni.")
    explanation_status: Status = Field(description="Esito delle singole affermazioni rispetto ai riferimenti.")
    completeness_status: Status = Field(description="Esito della copertura dei concetti richiesti.")
    status: Status = Field(description="Fail se una parte fallisce, review se almeno una parte è incerta, pass soltanto se tutte passano. Nessuna media compensativa.")
    mentions: list[NumericMention] = Field(description="Occorrenze numeriche originali con offset verificabili.")
    inventory: ResponseInventory | None = Field(description="Output Pydantic dell'estrattore; null se non disponibile o non valido.")
    inventory_attempts: list[InventoryAttempt] = Field(description="Tentativi effettivi dell'estrattore, con argomenti originali e motivi di rifiuto, anche quando un tentativo successivo recupera.")
    numeric_checks: list[NumericCheck] = Field(description="Controlli deterministici e copertura dei riferimenti numerici.")
    nli_checks: list[NliCheck] = Field(description="Confronti NLI effettivi, comprese incertezze e problemi di lunghezza.")
    errors: list[str] = Field(description="Errori operativi sanificati, distinti dalle risposte errate.")
