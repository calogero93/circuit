// Controller della simulazione real-time: layer di probe/visualizzazione.
// Compila la netlist, fa avanzare la transitoria a ogni frame e pubblica gli
// OUTPUT della simulazione (SimResult); la UI legge da qui, mai dallo stato
// interno del motore (seam §4.3). Gestisce anche la sessione "fantasma" per
// il confronto A/B (bypassa/togli un componente).

import { create } from 'zustand';
import { compile, type CompiledCircuit } from '../model/netlist.ts';
import { getDef } from '../model/registry.ts';
import type { Circuit } from '../model/types.ts';
import { AnalogSimulator } from '../engine/analog.ts';
import type { SimResult, Simulator, TransientSession } from '../engine/simulator.ts';
import { useStudio, type ABConfig, type Probe } from '../store/studio.ts';
import { pinKey } from '../model/types.ts';

export interface SimFrame {
  compiled: CompiledCircuit;
  result: SimResult;
  ghostCompiled: CompiledCircuit | null;
  ghost: SimResult | null;
}

export interface ScopeSample {
  t: number;
  v: number[]; // per indice di sonda
  g: number[] | null; // valori della sessione fantasma
}

/** Tick a bassa frequenza per i consumer React (colori fili, valori vivi). */
export const useSimTick = create<{ tick: number; time: number; converged: boolean }>(() => ({
  tick: 0,
  time: 0,
  converged: true,
}));

/** Applica la modifica A/B al circuito (per la sessione fantasma). */
export function applyAB(circuit: Circuit, ab: ABConfig): Circuit {
  if (ab.mode === 'remove') {
    // Il componente sparisce (circuito aperto), ma le net restano intatte:
    // i pin altrui che erano collegati TRAMITE un suo pin vengono ricuciti.
    const isTarget = (ref: { component: string }) => ref.component === ab.componentId;
    const kept = circuit.wires.filter((w) => !isTarget(w.from) && !isTarget(w.to));
    const stitched: Circuit['wires'] = [];
    const def = circuit.components.find((c) => c.id === ab.componentId);
    const pinCount = def ? getDef(def.type).pins.length : 0;
    for (let pin = 0; pin < pinCount; pin++) {
      const others = circuit.wires
        .filter((w) => (isTarget(w.from) && w.from.pin === pin) || (isTarget(w.to) && w.to.pin === pin))
        .map((w) => (isTarget(w.from) ? w.to : w.from));
      for (let i = 1; i < others.length; i++) {
        stitched.push({ id: `__ab_stitch_${pin}_${i}`, from: others[0], to: others[i] });
      }
    }
    return {
      ...circuit,
      components: circuit.components.filter((c) => c.id !== ab.componentId),
      wires: [...kept, ...stitched],
    };
  }
  // bypass: cortocircuito tra i primi due pin
  const inst = circuit.components.find((c) => c.id === ab.componentId);
  if (!inst || getDef(inst.type).pins.length < 2) return circuit;
  return {
    ...circuit,
    wires: [
      ...circuit.wires,
      {
        id: `__ab_bypass__`,
        from: { component: ab.componentId, pin: 0 },
        to: { component: ab.componentId, pin: 1 },
      },
    ],
  };
}

const MAX_SAMPLES = 3000;
const FRAME_BUDGET_MS = 8;

class SimController {
  readonly simulator: Simulator = new AnalogSimulator();
  frame: SimFrame | null = null;
  samples: ScopeSample[] = [];

  private session: TransientSession | null = null;
  private ghostSession: TransientSession | null = null;
  private compiled: CompiledCircuit | null = null;
  private ghostCompiled: CompiledCircuit | null = null;
  private circuit: Circuit | null = null;
  private ab: ABConfig | null = null;
  private ghostOn = false;
  private dt = 1e-4;
  private probes: Probe[] = [];
  private decimation = 1;
  private stepCount = 0;
  private lastTickPush = 0;
  private raf = 0;

  get time(): number {
    return this.session?.time ?? 0;
  }

  start(): void {
    this.sync();
    useStudio.subscribe(() => this.sync());
    const loop = () => {
      this.advance();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  /** Punto di lavoro DC on-demand (probe, tool AI). */
  runDC(): { compiled: CompiledCircuit; result: SimResult } {
    const compiled = compile(useStudio.getState().circuit);
    return { compiled, result: this.simulator.dcOperatingPoint(compiled) };
  }

  private sync(): void {
    const s = useStudio.getState();
    const circuitChanged = s.circuit !== this.circuit;
    const dtChanged = s.timestep !== this.dt;
    const abChanged = s.ab !== this.ab || (s.abGhost && s.ab !== null) !== this.ghostOn;
    const probesChanged = s.probes !== this.probes;
    const spanChanged = this.recomputeDecimation(s.scopeTimespan, s.timestep);

    this.probes = s.probes;
    if (!circuitChanged && !dtChanged && !abChanged) {
      if (probesChanged || spanChanged) this.samples = [];
      return;
    }

    this.circuit = s.circuit;
    this.dt = s.timestep;
    this.ab = s.ab;
    this.ghostOn = s.abGhost && s.ab !== null;

    // continuità: gli stati (carica dei condensatori...) sopravvivono all'edit
    const carried = this.session?.states();
    const t0 = this.session?.time ?? 0;
    this.compiled = compile(s.circuit);
    this.session = this.simulator.transient(this.compiled, {
      dt: this.dt,
      initialStates: carried,
      t0,
    });

    if (this.ghostOn && s.ab) {
      const ghostCarried = this.ghostSession?.states() ?? carried;
      this.ghostCompiled = compile(applyAB(s.circuit, s.ab));
      this.ghostSession = this.simulator.transient(this.ghostCompiled, {
        dt: this.dt,
        initialStates: ghostCarried,
        t0,
      });
    } else {
      this.ghostCompiled = null;
      this.ghostSession = null;
    }
    if (dtChanged || spanChanged) this.samples = [];
  }

  private recomputeDecimation(timespan: number, dt: number): boolean {
    const k = Math.max(1, Math.round(timespan / dt / 1500));
    const changed = k !== this.decimation;
    this.decimation = k;
    return changed;
  }

  private advance(): void {
    const s = useStudio.getState();
    if (!this.session || !this.compiled) return;
    const start = performance.now();
    let result: SimResult | null = null;
    let ghost: SimResult | null = null;

    if (s.running) {
      while (performance.now() - start < FRAME_BUDGET_MS) {
        result = this.session.step();
        if (this.ghostSession) ghost = this.ghostSession.step();
        if (!result.converged) break;
        this.stepCount += 1;
        if (this.stepCount % this.decimation === 0) this.pushSample(result, ghost);
      }
    }

    if (result) {
      this.frame = {
        compiled: this.compiled,
        result,
        ghostCompiled: this.ghostCompiled,
        ghost,
      };
    } else if (this.frame === null) {
      // in pausa senza mai aver simulato: mostra il punto di lavoro DC
      const dc = this.simulator.dcOperatingPoint(this.compiled);
      this.frame = { compiled: this.compiled, result: dc, ghostCompiled: null, ghost: null };
    }

    const now = performance.now();
    if (now - this.lastTickPush > 60) {
      this.lastTickPush = now;
      useSimTick.setState((t) => ({
        tick: t.tick + 1,
        time: this.session?.time ?? 0,
        converged: this.frame?.result.converged ?? true,
      }));
    }
  }

  private pushSample(result: SimResult, ghost: SimResult | null): void {
    if (!this.compiled) return;
    const v = this.probes.map((p) => {
      const net = this.compiled!.netOfPin.get(pinKey(p.pin));
      return net === undefined ? NaN : result.voltageOfNet(net);
    });
    let g: number[] | null = null;
    if (ghost && this.ghostCompiled) {
      g = this.probes.map((p) => {
        const net = this.ghostCompiled!.netOfPin.get(pinKey(p.pin));
        return net === undefined ? NaN : ghost.voltageOfNet(net);
      });
    }
    this.samples.push({ t: result.time, v, g });
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }
}

export const simController = new SimController();

// hook di ispezione per i test e2e (metriche sulle tracce, non solo pixel)
declare global {
  interface Window {
    __circuitStudio?: { controller: SimController };
  }
}
if (typeof window !== 'undefined') {
  window.__circuitStudio = { controller: simController };
}
