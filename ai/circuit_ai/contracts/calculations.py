"""Argomenti fisici dei tool; ogni campo descrive quantità, unità e dominio."""
from typing import Literal
from pydantic import Field
from pydantic import BaseModel, ConfigDict
from circuit_ai.contracts.shared import CalculationVariable


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Voltage(Contract):
    value: float = Field(description='Tensione fornita, prima della conversione SI.')
    unit: Literal['V','mV','kV'] = Field(description='Unità di tensione, col prefisso originale.')


class Current(Contract):
    value: float = Field(description='Corrente DC o RMS fornita, non di picco.')
    unit: Literal['A','mA','uA','µA'] = Field(description='Unità di corrente col prefisso originale.')


class Resistance(Contract):
    value: float = Field(gt=0, description='Resistenza positiva fornita.')
    unit: Literal['ohm','Ω','kohm','kΩ','Mohm'] = Field(description='Unità di resistenza col prefisso originale.')


class Frequency(Contract):
    value: float = Field(ge=0, description='Frequenza della sinusoide nella domanda.')
    unit: Literal['Hz','kHz','MHz'] = Field(description='Unità della frequenza.')


class Time(Contract):
    value: float = Field(ge=0, description='Istante richiesto rispetto alla fase iniziale nulla.')
    unit: Literal['s','ms','us'] = Field(description='Unità del tempo, con prefisso.')


class ResistorCurrent(Contract):
    """Ohm: corrente DC di un resistore ideale."""
    voltage: Voltage = Field(description='Tensione DC ai capi del resistore.')
    resistance: Resistance = Field(description='Resistenza del componente.')


class PowerVoltage(Contract):
    """Potenza resistiva da tensione DC/RMS: V²/R."""
    voltage: Voltage = Field(description='Tensione DC o RMS indicata, non corrente.')
    resistance: Resistance = Field(description='Resistenza del componente.')


class PowerCurrent(Contract):
    """Potenza resistiva da corrente DC/RMS: I²·R."""
    current: Current = Field(description='Corrente DC/RMS, mai di picco.')
    resistance: Resistance = Field(description='Resistenza del componente.')


class NamedResistance(Resistance):
    id: str = Field(min_length=1, description='Identificatore originale, per esempio R1 o R2.')


class SeriesDrop(Contract):
    """Caduta su target_id in una serie senza diramazioni."""
    voltage: Voltage = Field(description='Tensione totale applicata alla serie.')
    resistors: list[NamedResistance] = Field(min_length=1,max_length=12,description='Tutti i resistori in serie, ciascuno con ID, valore e unità.')
    target_id: str = Field(description='ID del resistore di cui calcolare la caduta; deve comparire in resistors.')


class LoadedDivider(Contract):
    """Partitore caricato: tensione su lower in parallelo a load."""
    voltage: Voltage = Field(description='Tensione di alimentazione del partitore.')
    upper: Resistance = Field(description='Fra alimentazione e uscita.')
    lower: Resistance = Field(description='Fra uscita e massa.')
    load: Resistance = Field(description='Carico RL parallelo a lower; non ignorarlo.')


class SineVoltage(Contract):
    """Sinusoide istantanea: fase iniziale e offset nulli."""
    amplitude: Voltage = Field(description='Ampiezza di picco, non valore RMS.')
    frequency: Frequency = Field(description='Frequenza della sorgente.')
    time: Time = Field(description='Istante a cui valutare la tensione.')


class ArithmeticInput(Contract):
    expression: str = Field(min_length=1,max_length=256,description="Espressione senza assegnazioni o unità: V/R; potenze con **. Funzioni: sqrt,abs,mean,rms,log10,exp,sin,cos; costante pi. sin/cos in radianti, log10/exp adimensionali.")
    variables: list[CalculationVariable] = Field(max_length=16,description="Variabili tutte utilizzate: nome univoco sensibile alle maiuscole (es. R_total), valore, unità. Non ridefinire pi.")


class CalculationOutput(Contract):
    value: float = Field(description="Risultato finito calcolato dal software, nella unità dichiarata.")
    decimal_value: str = Field(description="Rappresentazione decimale prodotta dal motore; sin/cos usano float64.")
    unit: str = Field(description="Unità SI derivata dalle dimensioni dei parametri; 1 per rapporti adimensionali.")
    scope: str = Field(description="Calcolo locale sui parametri forniti; non è una misura del browser né prova della correttezza dei dati di ingresso.")
