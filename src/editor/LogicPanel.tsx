// Pannello "Logica": tavola di verità dal vivo del circuito digitale corrente.
// Enumera le combinazioni degli ingressi logici col MOTORE DIGITALE, evidenzia
// la riga attiva e permette di cliccarne una per impostare gli ingressi — il
// cause-effetto reso tabellare.

import { compile } from '../model/netlist.ts';
import { pinKey, type ComponentInstance } from '../model/types.ts';
import { setParam } from '../store/commands.ts';
import { useStudio } from '../store/studio.ts';
import { DigitalSimulator, isPurelyDigital } from '../engine/digital.ts';
import { DIGITAL } from '../library/digital.ts';

const sim = new DigitalSimulator();

const valuePin = (c: ComponentInstance): number => (c.type === 'logic_out' ? 0 : DIGITAL[c.type].outPin ?? 0);

export function LogicPanel() {
  const circuit = useStudio((s) => s.circuit);
  const execute = useStudio((s) => s.execute);

  if (!isPurelyDigital(circuit)) {
    return <p className="muted">La tavola di verità è disponibile per circuiti interamente digitali (ingressi, porte, uscite).</p>;
  }

  const sequential = circuit.components.some((c) => c.type === 'dff' || c.type === 'clock');
  const inputs = circuit.components.filter((c) => c.type === 'logic_in');
  const logicOuts = circuit.components.filter((c) => c.type === 'logic_out');
  const outputs = logicOuts.length
    ? logicOuts
    : circuit.components.filter((c) => c.type in DIGITAL && DIGITAL[c.type].outPin !== null && c.type !== 'logic_in' && c.type !== 'clock');

  if (sequential) {
    return <p className="muted">Circuito sequenziale (clock/flip-flop): la tavola combinatoria non si applica — osserva Q evolvere nel tempo sul canvas e sullo scope.</p>;
  }
  if (!inputs.length || !outputs.length) {
    return <p className="muted">Aggiungi almeno un ingresso logico e un’uscita (o una porta) per vedere la tavola.</p>;
  }
  if (inputs.length > 6) {
    return <p className="muted">Troppi ingressi per enumerare la tavola ({inputs.length}; massimo 6).</p>;
  }

  const vdd = (inputs[0].params.vdd as number) ?? 5;
  const n = inputs.length;
  const rows = [];
  for (let m = 0; m < 1 << n; m++) {
    const combo = inputs.map((_, i) => Boolean(m & (1 << (n - 1 - i))));
    const c2 = {
      ...circuit,
      components: circuit.components.map((c) => {
        const idx = inputs.findIndex((x) => x.id === c.id);
        return idx >= 0 ? { ...c, params: { ...c.params, high: combo[idx] } } : c;
      }),
    };
    const compiled = compile(c2);
    const res = sim.dcOperatingPoint(compiled);
    const outVals = outputs.map((o) => {
      const net = compiled.netOfPin.get(pinKey({ component: o.id, pin: valuePin(o) }));
      return net === undefined ? 0 : res.voltageOfNet(net) > vdd / 2 ? 1 : 0;
    });
    rows.push({ combo, outVals });
  }

  const curIdx = inputs.reduce((acc, c, i) => acc + (c.params.high ? 1 << (n - 1 - i) : 0), 0);

  const applyRow = (combo: boolean[]) => {
    inputs.forEach((c, i) => {
      if (Boolean(c.params.high) !== combo[i]) execute(setParam(c.id, 'high', c.params.high, combo[i]));
    });
  };

  return (
    <div className="logic-panel">
      <h3>Tavola di verità</h3>
      <p className="muted">Clicca una riga per impostare gli ingressi. La riga evidenziata è lo stato attuale.</p>
      <table className="truth-table">
        <thead>
          <tr>
            {inputs.map((c) => (
              <th key={c.id}>{c.id}</th>
            ))}
            <th className="sep" />
            {outputs.map((o) => (
              <th key={o.id}>{o.id}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i === curIdx ? 'current' : ''} onClick={() => applyRow(r.combo)}>
              {r.combo.map((b, k) => (
                <td key={k}>{b ? 1 : 0}</td>
              ))}
              <td className="sep" />
              {r.outVals.map((v, k) => (
                <td key={k} className={v ? 'on' : ''}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
