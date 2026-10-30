"""Risultati dichiarati dal tutor: la forma non certifica la verità del valore."""
from typing import Annotated
from pydantic import BaseModel, ConfigDict, Field, StringConstraints


class NumericAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    subject: str = Field(min_length=1, max_length=160, description="Componente/oggetto del risultato: conservare gli ID, es. R1.")
    quantity: str = Field(min_length=1, max_length=100, description="Grandezza fisica esplicita: tensione, corrente, potenza media/istantanea, ecc.")
    context: str = Field(min_length=1, max_length=240, description="Condizioni: DC/RMS/picco, istante/regime e ipotesi; non combinare contesti.")
    value: float = Field(description="Valore finito affermato, anche se errato; conservare il valore del tool, non un risultato atteso.")
    unit: str = Field(min_length=1, max_length=24, description="Unità esplicita con prefisso SI; 1 indica adimensionale.")


class AnswerDraft(BaseModel):
    """Contenuto finale del tutor; testo numerico e metadati sono costruiti dal server."""
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    explanation: str = Field(min_length=1, max_length=12000, description="Spiegazione qualitativa breve, formule simboliche (I²·R), ipotesi e limiti. Senza valori numerici: parametri e risultati vanno in numeric_results. Ammessi ID come R1 e costanti algebriche nelle formule simboliche. Nessun ragionamento interno.")
    numeric_results: list[NumericAnswer] = Field(max_length=80, description="Valori nominali richiesti letti dai tool e risultati calcolati, senza arrotondamenti o duplicati nel testo. Distinguere la provenienza nel context. [] senza valori affidabili; lo schema non prova la fisica.")
    learning_notes: list[Annotated[str, StringConstraints(min_length=1, max_length=320)]] = Field(max_length=5, description="Preferenze esplicite, obiettivi e concetti studiati; nessuna misura o inferenza personale. Ogni nota da 1 a 320 caratteri; [] se nulla da ricordare.")
    limitation: bool = Field(description="True se mancano dati affidabili: spiegare cosa manca. False altrimenti.")
