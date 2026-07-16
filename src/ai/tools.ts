// Interfaccia a strumenti per l'AI (seam §4.5): il modello e il motore
// espongono tool che il tutor DEVE chiamare prima di affermare fatti sul
// circuito. Ogni feature AI futura riusa questi tool.

import { compile } from '../model/netlist.ts';
import { getDef, listDefs } from '../model/registry.ts';
import { pinKey } from '../model/types.ts';
import { useStudio } from '../store/studio.ts';
import { simController } from '../viz/controller.ts';
import { getLesson } from '../lessons/data.ts';

/** Definizioni tool in formato API Anthropic. */
export const TOOL_DEFINITIONS = [
  {
    name: 'getNetlist',
    description:
      'Restituisce la netlist corrente: componenti con parametri e connettività per nodo (net). Chiamalo SEMPRE prima di ragionare sul circuito.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'runDC',
    description:
      'Calcola il punto di lavoro DC: tensioni di tutti i nodi e correnti/tensioni di ogni componente.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'runTransient',
    description:
      'Esegue una simulazione transitoria dedicata e restituisce le forme d\'onda campionate delle tensioni di nodo (per vedere ripple, transitori, forme d\'onda).',
    input_schema: {
      type: 'object',
      properties: {
        duration_ms: { type: 'number', description: 'Durata simulata in millisecondi (max 5000)' },
        dt_us: { type: 'number', description: 'Passo temporale in microsecondi (default 100)' },
      },
      required: ['duration_ms'],
      additionalProperties: false,
    },
  },
  {
    name: 'measureNode',
    description:
      'Misura la tensione LIVE di un nodo (etichetta net, es. "n1" o "gnd") nella simulazione in corso, più il valore al punto di lavoro DC.',
    input_schema: {
      type: 'object',
      properties: { nodeId: { type: 'string', description: 'Etichetta della net, es. "n1"' } },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'measureComponent',
    description:
      'Misura un componente nella simulazione live: parametri, correnti ai pin e grandezze interne (vd, ic, vbe...).',
    input_schema: {
      type: 'object',
      properties: { componentId: { type: 'string', description: 'Id del componente, es. "R1"' } },
      required: ['componentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'listComponents',
    description: 'Elenca i tipi di componente disponibili nella libreria, con descrizione didattica e parametri.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'getLessonState',
    description: 'Stato della lezione corrente: quale lezione, a che passo, configurazione A/B e sonde attive.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

type Json = Record<string, unknown>;

function netlistSnapshot(): Json {
  const { circuit } = useStudio.getState();
  const compiled = compile(circuit);
  return {
    components: circuit.components.map((c) => {
      const def = getDef(c.type);
      return {
        id: c.id,
        type: c.type,
        name: def.name,
        params: c.params,
        pins: def.pins.map((p, i) => ({
          name: p.name,
          net: compiled.netLabel(compiled.netOfPin.get(pinKey({ component: c.id, pin: i })) ?? -1),
        })),
      };
    }),
    wires: circuit.wires.length,
    nets: [...new Set([...compiled.netOfPin.values()])].map((n) => compiled.netLabel(n)),
    hasGround: circuit.components.some((c) => getDef(c.type).isGround),
  };
}

function dcSnapshot(): Json {
  const { compiled, result } = simController.runDC();
  const nodeVoltages: Record<string, number> = {};
  for (let n = -1; n < compiled.nNodes; n++) {
    nodeVoltages[compiled.netLabel(n)] = round(result.voltageOfNet(n));
  }
  const components: Record<string, Json> = {};
  for (const [id, out] of result.outputs) {
    components[id] = { data: roundAll(out.data), pinCurrents: out.pinCurrents.map(round) };
  }
  return { converged: result.converged, nodeVoltages, components };
}

function transientSnapshot(input: Json): Json {
  const durationMs = Math.min(Math.max(Number(input.duration_ms) || 100, 1), 5000);
  const dtUs = Math.min(Math.max(Number(input.dt_us) || 100, 1), 10_000);
  const dt = dtUs * 1e-6;
  const { circuit } = useStudio.getState();
  const compiled = compile(circuit);
  const session = simController.simulator.transient(compiled, { dt });
  const steps = Math.min(Math.round((durationMs / 1000) / dt), 500_000);
  const samplesWanted = 100;
  const every = Math.max(1, Math.floor(steps / samplesWanted));
  const time: number[] = [];
  const nets: Record<string, number[]> = {};
  for (let n = 0; n < compiled.nNodes; n++) nets[compiled.netLabel(n)] = [];
  let converged = true;
  for (let k = 0; k < steps; k++) {
    const res = session.step();
    if (!res.converged) {
      converged = false;
      break;
    }
    if (k % every === 0) {
      time.push(round(res.time));
      for (let n = 0; n < compiled.nNodes; n++) nets[compiled.netLabel(n)].push(round(res.voltageOfNet(n)));
    }
  }
  return { converged, dt_us: dtUs, time_s: time, nodeVoltages: nets };
}

function measureNode(input: Json): Json {
  const nodeId = String(input.nodeId ?? '');
  const frame = simController.frame;
  if (!frame) return { error: 'nessuna simulazione attiva' };
  const nets = new Map<string, number>();
  for (const net of new Set(frame.compiled.netOfPin.values())) {
    nets.set(frame.compiled.netLabel(net), net);
  }
  if (!nets.has(nodeId)) {
    return { error: `nodo sconosciuto: ${nodeId}`, nodiDisponibili: [...nets.keys()] };
  }
  const net = nets.get(nodeId)!;
  const dc = simController.runDC();
  return {
    nodeId,
    liveVoltage: round(frame.result.voltageOfNet(net)),
    liveTime: round(frame.result.time),
    dcVoltage: round(dc.result.voltageOfNet(net)),
  };
}

function measureComponent(input: Json): Json {
  const id = String(input.componentId ?? '');
  const { circuit } = useStudio.getState();
  const inst = circuit.components.find((c) => c.id === id);
  if (!inst) {
    return { error: `componente sconosciuto: ${id}`, disponibili: circuit.components.map((c) => c.id) };
  }
  const out = simController.frame?.result.outputs.get(id);
  return {
    id,
    type: inst.type,
    params: inst.params,
    live: out ? { data: roundAll(out.data), pinCurrents: out.pinCurrents.map(round) } : null,
  };
}

function lessonState(): Json {
  const s = useStudio.getState();
  const lesson = s.lessonId ? getLesson(s.lessonId) : null;
  return {
    lessonId: s.lessonId,
    title: lesson?.title ?? null,
    objective: lesson?.objective ?? null,
    step: lesson ? { index: s.lessonStep, total: lesson.steps.length, ...lesson.steps[s.lessonStep] } : null,
    ab: s.ab ? { ...s.ab, confrontoAttivo: s.abGhost } : null,
    probes: s.probes.map((p) => ({ label: p.label, pin: p.pin })),
    presentazione: s.presentation,
  };
}

function round(x: number): number {
  return Number.isFinite(x) ? Number(x.toPrecision(6)) : x;
}

function roundAll(o: Record<string, number | string | boolean>): Record<string, number | string | boolean> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v]));
}

/** Esegue un tool per nome; non lancia mai (gli errori tornano al modello). */
export function executeTool(name: string, input: Json): Json {
  try {
    switch (name) {
      case 'getNetlist':
        return netlistSnapshot();
      case 'runDC':
        return dcSnapshot();
      case 'runTransient':
        return transientSnapshot(input);
      case 'measureNode':
        return measureNode(input);
      case 'measureComponent':
        return measureComponent(input);
      case 'listComponents':
        return {
          library: listDefs().map((d) => ({
            type: d.type,
            name: d.name,
            description: d.description,
            params: d.params.map((p) => `${p.key} (${p.label}, ${p.unit || '—'})`),
          })),
        };
      case 'getLessonState':
        return lessonState();
      default:
        return { error: `tool sconosciuto: ${name}` };
    }
  } catch (e) {
    return { error: `errore nell'esecuzione di ${name}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
