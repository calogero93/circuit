"""Esegue netlist curate con ngspice e conserva misure/log riproducibili."""
import json
import math
from pathlib import Path
import re
import subprocess

from circuit_ai.evaluation.experiments import file_digest


def netlist_text(scenario):
    commands=[]
    for command in scenario['commands']:
        match=re.match(r'meas tran (\w+) (.+)',command)
        if match:
            name=match[1]
            # Il comando meas formatta poche cifre; il vettore conserva il valore
            # effettivo, che print emette con numdgt=15. Nessun risultato è ricalcolato.
            commands.extend([f'meas tran measured_{name} {match[2]}',f'let {name} = measured_{name}',f'print {name}'])
        else:commands.append(command)
    return scenario['id']+'\n'+scenario['circuit']+'\n.options reltol=1e-8 abstol=1e-12 vntol=1e-10 temp=27 tnom=27\n.control\nset noaskquit\nset numdgt=15\n'+'\n'.join(commands)+'\nquit\n.endc\n.end\n'


def run_spice(binary, netlist, output_dir, measures):
    binary, netlist, output_dir = Path(binary).resolve(), Path(netlist).resolve(), Path(output_dir).resolve()
    if not binary.is_file() or not netlist.is_file():
        raise ValueError('Binario ngspice o netlist assente')
    output_dir.mkdir(parents=True, exist_ok=True)
    log = output_dir / (netlist.stem + '.log')
    # -n esclude configurazioni personali .spiceinit; nessuna shell viene invocata.
    process = subprocess.run([str(binary), '-n', '-b', '-o', str(log), str(netlist)],
        cwd=output_dir, capture_output=True, text=True, timeout=45)
    text = log.read_text() if log.exists() else process.stdout + process.stderr
    if process.returncode or re.search(r'(?im)^\s*(?:error|fatal|failed)\b|measurement.*failed', text):
        raise ValueError(f'Simulazione ngspice non riuscita: {netlist.name}; consultare {log}')
    values = {}
    for name in measures:
        found = re.findall(r'(?im)^\s*' + re.escape(name) + r'\s*=\s*([+-]?[\d.]+(?:e[+-]?\d+)?)', text)
        if len(found) != 1 or not math.isfinite(float(found[0])):
            raise ValueError(f'Misura {name} assente, duplicata o non finita in {netlist.name}')
        values[name] = float(found[0])
    version = subprocess.run([str(binary), '--version'], capture_output=True, text=True, check=True, timeout=10).stdout
    result = {'version': version, 'binary_sha256': file_digest(binary), 'netlist_sha256': file_digest(netlist),
        'log_sha256': file_digest(log), 'measurements': values,
        'command': ['ngspice','-n','-b','-o',log.name,netlist.name]}
    (output_dir / (netlist.stem + '.json')).write_text(json.dumps(result, indent=2) + '\n')
    return result
