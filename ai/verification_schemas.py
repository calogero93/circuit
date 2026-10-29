"""Contratti del verificatore numerico + NLI; tutti gli esiti restano separati."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_serializer, model_validator


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


class NliTokenCount(Contract):
    model_id: str = Field(description="Identità del classificatore e del tokenizer che conteranno e valuteranno la stessa coppia.")
    tokens: int = Field(ge=0, description="Token effettivi della coppia, inclusi i token speciali, senza troncatura.")
    max_tokens: int = Field(ge=1, description="Limite effettivo del classificatore; non un limite stimato in caratteri.")


class NliSourceSpan(Contract):
    origin: Literal["response", "reference"] = Field(description="Testo originale cui appartiene l'intervallo; la domanda non è una premessa fattuale.")
    reference_index: int | None = Field(description="Indice del fatto originale quando origin=reference; null per la risposta.")
    start: int = Field(ge=0, description="Offset iniziale in caratteri Python nel testo originale.")
    end: int = Field(ge=0, description="Offset finale esclusivo nel testo originale.")
    quote: str = Field(description="Sottostringa originale esatta, prima della normalizzazione di presentazione.")


class NliTextUnit(Contract):
    span: NliSourceSpan = Field(description="Intervallo originale della frase o del blocco, incluse formule che non vanno spezzate.")
    context: list[NliSourceSpan] = Field(description="Titoli, condizioni o prefissi originali necessari a leggere l'unità; mai fatti aggiunti dal verificatore.")
    kind: Literal["claim", "structure"] = Field(description="Claim viene verificato; structure è soltanto un marcatore o un titolo riconosciuto, conservato nel contesto.")


class NliPassage(Contract):
    raw: str = Field(description="Concatenazione degli intervalli originali ordinati, prima della normalizzazione di presentazione.")
    spans: list[NliSourceSpan] = Field(description="Provenienza completa dei brani concatenati; non si campionano frasi in base al risultato NLI.")


class NliAnchors(Contract):
    premise_identifiers: list[str] = Field(description="ID di componenti e porte logiche esplicitamente nominati nell'evidenza; nessun ID inferito dal classificatore.")
    hypothesis_identifiers: list[str] = Field(description="ID espliciti nominati nell'affermazione; distinguere OR da XOR e R1 da R2.")
    premise_quantities: list[str] = Field(description="Grandezze nominate o indicate da quantità SI e assegnazioni simboliche convenzionali nell'evidenza; nessuna inferenza del classificatore.")
    hypothesis_quantities: list[str] = Field(description="Grandezze nominate o indicate da unità/assegnazioni nell'affermazione; una corrente non è una tensione.")
    comparable: bool = Field(description="False se entrambi i testi nominano soltanto ID o grandezze disgiunti. True non dimostra da solo pertinenza o correttezza.")
    reason: Literal["different_identifiers", "different_quantities"] | None = Field(description="Motivo del mancato collegamento; null se questa verifica non trova un disallineamento esplicito.")


class NliNumericDeclaration(Contract):
    label: str = Field(min_length=1, description="Etichetta completa della dichiarazione scalare, conservando ID, condizioni e maiuscole; nessuna associazione per somiglianza del valore.")
    value: float = Field(description="Valore realmente letto dalla dichiarazione, normalizzato in SI dal parser numerico.")
    unit: str = Field(description="Unità SI normalizzata; i prefissi non vengono ignorati.")
    case_model_prefix: bool = Field(description="True solo per il prefisso generico 'Per il modello dichiarato:' del caso corrente; altri qualificatori non vengono eliminati.")


class NliNumericProof(Contract):
    reference_index: int = Field(ge=0, description="Unico riferimento indipendente identificato da etichetta e unità, mai dal valore più vicino.")
    label: str = Field(description="Etichetta esatta condivisa da dichiarazione, fatto e riferimento numerico.")
    actual_value: float = Field(description="Valore dichiarato effettivo in SI, anche se errato; non viene corretto col valore atteso.")
    source_value: float = Field(description="Valore presente nel fatto di riferimento, controllato contro il riferimento numerico indipendente.")
    expected_value: float = Field(description="Valore indipendente del dataset, senza sostituzione nella risposta.")
    unit: str = Field(description="Unità SI comune alla dichiarazione e al riferimento.")
    absolute_tolerance: float = Field(ge=0, description="Tolleranza assoluta SI già dichiarata nel dataset; non adattata al risultato.")
    relative_tolerance: float = Field(ge=0, description="Tolleranza relativa del dataset, invariata.")
    case_model_prefix: bool = Field(description="Prefisso generico del modello corrente presente su almeno un lato. Condizioni specifiche o altri prefissi impediscono questa prova.")


class NliPreparation(Contract):
    target_id: str = Field(description="Identità del requisito confrontato; aggrega tutte le finestre dello stesso target senza confondere frasi uguali in posizioni diverse.")
    window_index: int = Field(ge=0, description="Indice della finestra di evidenza effettivamente confrontata.")
    window_count: int = Field(ge=1, description="Numero totale delle finestre previste per il target, incluse quelle non verificabili.")
    token_count: int | None = Field(description="Token reali della coppia normalizzata; null se non conteggiabile.")
    coverage_complete: bool = Field(description="Target coperto dall'identità testuale completa oppure da tutte le finestre previste. False se un limite lascia evidenza non verificata; nessuna promozione implicita.")
    reason: Literal["evaluated", "oversized_unit", "budget_exhausted", "tokenizer_error", "model_error", "structure_only", "non_linguistic", "anchor_mismatch", "exact_reference", "numeric_reference"] = Field(description="Confronto neurale, prova testuale o numerica deterministica, non applicabilità o mancato collegamento; le prove deterministiche non producono probabilità NLI.")
    raw_premise: str = Field(description="Evidenza originale con eventuale contesto originale, prima di rimuovere solo marcatori di presentazione.")
    raw_hypothesis: str = Field(description="Target originale e contesto conservato; non una parafrasi generata da un LLM.")
    premise_spans: list[NliSourceSpan] = Field(description="Intervalli originali che compongono l'evidenza, verificabili senza consultare un LLM.")
    hypothesis_spans: list[NliSourceSpan] = Field(description="Intervalli del target, inclusi titoli e condizioni necessari a interpretarlo.")
    anchors: NliAnchors | None = Field(default=None, description="Controllo deterministico degli ID e delle grandezze; assente nei protocolli precedenti.")
    numeric_proof: NliNumericProof | None = Field(default=None, description="Confronto deterministico di una dichiarazione scalare con etichetta univoca e tolleranze del dataset; nessuna interpretazione NLI dei numeri.")

    @model_serializer(mode="wrap")
    def serialize_preparation(self, handler):
        data = handler(self)
        for field in ("anchors", "numeric_proof"):
            if field not in self.model_fields_set:
                data.pop(field, None)
        return data


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
    preparation: NliPreparation | None = Field(default=None, description="Provenienza, copertura e budget del protocollo contestuale; assente nei report storici.")

    @model_serializer(mode="wrap")
    def serialize_check(self, handler):
        data = handler(self)
        if "preparation" not in self.model_fields_set:
            data.pop("preparation", None)
        return data


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


class NliControl(Contract):
    id: str = Field(min_length=1, description="Identificativo stabile del controllo NLI, distinto dai casi della baseline.")
    case_id: str = Field(description="Caso di origine dei fatti pubblicati, verificato contro il dataset di base.")
    category: Literal["semantic", "formatting", "long_context", "policy"] = Field(description="Contrasti semantici, presentazione, lunghezza o regole del protocollo: non sono un'unica accuracy.")
    reference_statements: list[str] = Field(min_length=1, description="Fatti originali esatti o loro sottostringhe, presenti nei riferimenti del caso di origine; nessuna risposta attesa generata dall'NLI.")
    response: str = Field(min_length=1, max_length=16000, description="Testo controllato da verificare, con eventuali errori intenzionali. Non viene corretto prima della valutazione.")
    direction: Literal["faithfulness", "completeness"] = Field(description="Direzione per cui è dichiarato l'esito atteso del controllo.")
    expected_status: Status = Field(description="Esito desiderato derivato dal contrasto con i fatti o dalla policy, non da un precedente punteggio NLI.")
    rationale: str = Field(min_length=1, description="Motivo del controllo e della sua aspettativa; proposta assistita, non etichetta umana calibrata.")


class NliControlSuite(Contract):
    version: str = Field(description="Versione dei controlli e delle aspettative.")
    dataset_bundle_sha256: str = Field(pattern=r"^[a-f0-9]{64}$", description="Identità del dataset di base che contiene fonti e fatti dei controlli.")
    review_status: Literal["proposed"] = Field(description="Contrasti derivati da fonti esperte; non costituiscono calibrazione umana del classificatore.")
    author: str = Field(description="Autore effettivo dei contrasti, distinto dagli autori dei libri.")
    cases: list[NliControl] = Field(min_length=1, description="Controlli riproducibili; versionare ogni modifica alle aspettative.")
