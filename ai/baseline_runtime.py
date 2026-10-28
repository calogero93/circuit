"""Tool offline del banco di prova: stessi calcoli del tutor e simulazioni del caso corrente."""
import asyncio
from pathlib import Path

from langchain_core.tools import StructuredTool

from calculation_engine import arithmetic  # Compatibilità con gli script storici.
from calculation_tools import calculation_tools
from schemas import NoInput
from spice_reference import run_spice


def benchmark_tools(case, dataset_dir, binary, artifact_dir):
    tools=calculation_tools()
    if case.spice_id:
        async def simulate():
            netlist=Path(dataset_dir)/'spice'/(case.spice_id+'.cir')
            result=await asyncio.to_thread(run_spice,binary,netlist,Path(artifact_dir)/case.id,
                [n.measure for n in case.numbers])
            return {'scope':'Simulazione offline dell’esercizio, non circuito live del browser',
                'observations':[{'label':n.label,'value':result['measurements'][n.measure],'unit':n.unit} for n in case.numbers],
                'engine':'ngspice','netlist_sha256':result['netlist_sha256']}
        tools.append(StructuredTool.from_function(coroutine=simulate,name='simulateCircuit',args_schema=NoInput,
            description='Esegue con ngspice la netlist dell’esercizio corrente e restituisce solo risultati numerici, senza soluzione teorica. È una simulazione offline, non una misura del browser; non servono metadati live nella risposta.'))
    return tools
