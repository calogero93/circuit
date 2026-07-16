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
import { DigitalSimulator, isPurelyDigital } from '../engine/digital.ts';
import { MixedSignalSimulator, isMixed } from '../engine/mixed.ts';
import type { SimResult, Simulator, TransientSession } from '../engine/simulator.ts';
import { useStudio, type ABConfig, type Probe } from '../store/studio.ts';
import { pinKey } from '../model/types.ts';
import { vsinDef } from '../library/sources.ts';

export interface BodePoint {
  f: number;
  gainDb: number[];
  phaseDeg: number[];
}

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
  private digitalSim: Simulator = new DigitalSimulator();
  private mixedSim: Simulator = new MixedSignalSimulator();
  /** Sceglie il motore per dominio: digitale puro, misto (coordinatore) o analogico. */
  private simFor(circuit: Circuit): Simulator {
    if (isPurelyDigital(circuit)) return this.digitalSim;
    if (isMixed(circuit)) return this.mixedSim;
    return this.simulator;
  }
  frame: SimFrame | null = null;
  samples: ScopeSample[] = [];
  bodePoints: BodePoint[] = [];
  ghostBodePoints: BodePoint[] = [];

  private session: TransientSession | null = null;
  private ghostSession: TransientSession | null = null;
  private compiled: CompiledCircuit | null = null;
  private ghostCompiled: CompiledCircuit | null = null;
  private circuit: Circuit | null = null;
  private ab: ABConfig | null = null;
  private ghostOn = false;
  private dt = 1e-4;
  private probes: Probe[] = [];
  private scopeMode: 'time' | 'bode' = 'time';
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
    const circuit = useStudio.getState().circuit;
    const compiled = compile(circuit);
    return { compiled, result: this.simFor(circuit).dcOperatingPoint(compiled) };
  }

  private sync(): void {
    const s = useStudio.getState();
    const circuitChanged = s.circuit !== this.circuit;
    const dtChanged = s.timestep !== this.dt;
    const abChanged = s.ab !== this.ab || (s.abGhost && s.ab !== null) !== this.ghostOn;
    const probesChanged = s.probes !== this.probes;
    const spanChanged = this.recomputeDecimation(s.scopeTimespan, s.timestep);
    const scopeModeChanged = s.scopeMode !== this.scopeMode;
    this.scopeMode = s.scopeMode;

    const needsBodeRecompute = scopeModeChanged || circuitChanged || abChanged || probesChanged;

    this.probes = s.probes;

    if (s.scopeMode === 'bode' && needsBodeRecompute) {
      if (!this.compiled || circuitChanged) {
        this.compiled = compile(s.circuit);
      }
      this.bodePoints = this.runBodeFor(this.compiled);

      const isGhostActive = s.abGhost && s.ab !== null;
      if (isGhostActive && s.ab) {
        if (!this.ghostCompiled || circuitChanged || abChanged) {
          this.ghostCompiled = compile(applyAB(s.circuit, s.ab));
        }
        this.ghostBodePoints = this.runBodeFor(this.ghostCompiled);
      } else {
        this.ghostBodePoints = [];
      }
    }

    if (!circuitChanged && !dtChanged && !abChanged) {
      if (probesChanged || spanChanged || scopeModeChanged) this.samples = [];
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
    this.session = this.simFor(s.circuit).transient(this.compiled, {
      dt: this.dt,
      initialStates: carried,
      t0,
    });

    if (this.ghostOn && s.ab) {
      const ghostCarried = this.ghostSession?.states() ?? carried;
      const ghostCircuit = applyAB(s.circuit, s.ab);
      this.ghostCompiled = compile(ghostCircuit);
      this.ghostSession = this.simFor(ghostCircuit).transient(this.ghostCompiled, {
        dt: this.dt,
        initialStates: ghostCarried,
        t0,
      });
    } else {
      this.ghostCompiled = null;
      this.ghostSession = null;
    }
    if (dtChanged || spanChanged || scopeModeChanged) this.samples = [];
  }

  runBodeFor(compiled: CompiledCircuit | null): BodePoint[] {
    if (!compiled || this.probes.length === 0) return [];

    // Trova la prima sorgente compatibile con AC o generica sorgente di tensione
    const srcItem = compiled.items.find((item) =>
      ['vsin', 'vsinPhase', 'pulse', 'vdc'].includes(item.inst.type)
    );
    if (!srcItem) return [];

    const srcCompId = srcItem.inst.id;
    const inNet = compiled.netOfPin.get(pinKey({ component: srcCompId, pin: 0 })) ?? -1;

    const points: BodePoint[] = [];
    const nPoints = 35;
    const fMin = 10;
    const fMax = 100000;

    for (let i = 0; i < nPoints; i++) {
      const logF = Math.log10(fMin) + (i / (nPoints - 1)) * (Math.log10(fMax) - Math.log10(fMin));
      const f = Math.pow(10, logF);

      const sweptItems = compiled.items.map((item) => {
        if (item.inst.id === srcCompId) {
          return {
            ...item,
            inst: {
              ...item.inst,
              params: {
                ...item.inst.params,
                freq: f,
                amp: Number(item.inst.params.amp ?? item.inst.params.V ?? 1.0),
                offset: Number(item.inst.params.offset ?? 0),
              },
            },
            def: vsinDef,
          };
        }
        return item;
      });
      const sweptCompiled = { ...compiled, items: sweptItems };

      const T = 1 / f;
      const stepsPerCycle = 40;
      const dt = T / stepsPerCycle;
      const totalSteps = 4 * stepsPerCycle;

      const session = this.simulator.transient(sweptCompiled, { dt });

      const inVals: number[] = [];
      const outVals: number[][] = this.probes.map(() => []);
      const times: number[] = [];

      for (let step = 0; step < totalSteps; step++) {
        const res = session.step();
        if (step >= 3 * stepsPerCycle) {
          times.push(res.time);
          inVals.push(res.voltageOfNet(inNet));
          this.probes.forEach((probe, pIdx) => {
            const outNet = compiled.netOfPin.get(pinKey(probe.pin)) ?? -1;
            outVals[pIdx].push(res.voltageOfNet(outNet));
          });
        }
      }

      const inMax = Math.max(...inVals);
      const inMin = Math.min(...inVals);
      const inAmp = Math.max(1e-6, (inMax - inMin) / 2);

      const inPeakIdx = inVals.indexOf(inMax);
      const tInPeak = times[inPeakIdx] ?? 0;

      const gainDb: number[] = [];
      const phaseDeg: number[] = [];

      this.probes.forEach((_, pIdx) => {
        const pVals = outVals[pIdx];
        const pMax = Math.max(...pVals);
        const pMin = Math.min(...pVals);
        const pAmp = (pMax - pMin) / 2;

        const gain = pAmp / inAmp;
        let db = 20 * Math.log10(gain);
        if (isNaN(db) || !isFinite(db)) db = -100;
        if (db < -100) db = -100;

        const pPeakIdx = pVals.indexOf(pMax);
        const tOutPeak = times[pPeakIdx] ?? 0;

        let deltaT = tOutPeak - tInPeak;
        while (deltaT > T / 2) deltaT -= T;
        while (deltaT < -T / 2) deltaT += T;

        let phase = (deltaT / T) * 360;
        if (isNaN(phase)) phase = 0;

        gainDb.push(db);
        phaseDeg.push(phase);
      });

      points.push({ f, gainDb, phaseDeg });
    }

    return points;
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
