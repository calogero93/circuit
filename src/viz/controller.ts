// Controller della simulazione real-time: layer di probe/visualizzazione.
// Compila la netlist, fa avanzare la transitoria a ogni frame e pubblica gli
// OUTPUT della simulazione (SimResult); la UI legge da qui, mai dallo stato
// interno del motore (seam §4.3). Gestisce anche la sessione "fantasma" per
// il confronto A/B (bypassa/togli un componente).

import { create } from 'zustand';
import { compile, type CompiledCircuit } from '../model/netlist.ts';
import type { Circuit } from '../model/types.ts';
import { AnalogSimulator } from '../engine/analog.ts';
import { DigitalSimulator, isPurelyDigital } from '../engine/digital.ts';
import { MixedSignalSimulator, isMixed } from '../engine/mixed.ts';
import type { SimResult, Simulator, TransientSession } from '../engine/simulator.ts';
import { useStudio, type ABConfig, type Probe } from '../store/studio.ts';
import { pinKey } from '../model/types.ts';
import { vsinDef } from '../library/sources.ts';
import { PlaybackClock, type PlaybackSpeed } from './playback.ts';
import { assertBodeWorkload, assertSimulationWorkload, bodeSource } from '../model/workload.ts';

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
export const useSimTick = create<{ tick: number; time: number; converged: boolean; playbackLag: number }>(() => ({
  tick: 0,
  time: 0,
  converged: true,
  playbackLag: 0,
}));

import { applyAB } from '../model/ab.ts';
export { applyAB } from '../model/ab.ts';

const MAX_SAMPLES = 3000;
const FRAME_BUDGET_MS = 8;

export class SimController {
  revision = 0;
  readonly simulator: Simulator = new AnalogSimulator();
  private digitalSim: Simulator = new DigitalSimulator();
  private mixedSim: Simulator = new MixedSignalSimulator();
  /** Sceglie il motore per dominio: digitale puro, misto (coordinatore) o analogico. */
  simFor(circuit: Circuit): Simulator {
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
  private epoch = -1;
  private ab: ABConfig | null = null;
  private ghostOn = false;
  private dt = 1e-4;
  private ambientTemperature = 25;
  private probes: Probe[] = [];
  private scopeMode: 'time' | 'bode' = 'time';
  private decimation = 1;
  private stepCount = 0;
  private lastTickPush = 0;
  private raf = 0;
  private unsubscribe: (() => void) | null = null;
  private clock = new PlaybackClock();
  private running = true;
  private playbackSpeed: PlaybackSpeed = 1;
  private visibilityChanged = () => this.clock.reset(performance.now());

  get time(): number {
    return this.session?.time ?? 0;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.sync();
    this.clock.reset(performance.now());
    this.unsubscribe = useStudio.subscribe(() => this.sync());
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibilityChanged);
    const loop = () => {
      this.advance();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.clock.reset(performance.now());
  }

  /** Punto di lavoro DC on-demand (probe, tool AI). */
  runDC(): { compiled: CompiledCircuit; result: SimResult } {
    const { circuit, environment } = useStudio.getState();
    const compiled = compile(circuit);
    return { compiled, result: this.simFor(circuit).dcOperatingPoint(compiled, { ambientTemperature: environment.temperature }) };
  }

  private sync(): void {
    const previous = { ...this };
    this.clock = Object.assign(new PlaybackClock(), this.clock);
    try { this.syncNext(); }
    catch (error) { Object.assign(this, previous); throw error; }
  }

  private syncNext(): void {
    const s = useStudio.getState();
    if (s.circuit !== this.circuit || s.probes !== this.probes || s.scopeMode !== this.scopeMode ||
        s.ab !== this.ab || (s.abGhost && s.ab !== null) !== this.ghostOn) assertSimulationWorkload(s);
    const circuitChanged = s.circuit !== this.circuit;
    const reset = s.simulationEpoch !== this.epoch;
    const temperatureChanged = s.environment.temperature !== this.ambientTemperature;
    if (circuitChanged || reset || temperatureChanged) this.revision += 1;
    const dtChanged = s.timestep !== this.dt;
    const abChanged = s.ab !== this.ab || (s.abGhost && s.ab !== null) !== this.ghostOn;
    const probesChanged = s.probes !== this.probes;
    const playbackChanged = s.running !== this.running || s.playbackSpeed !== this.playbackSpeed;
    this.running = s.running;
    this.playbackSpeed = s.playbackSpeed;
    if (playbackChanged || reset || circuitChanged || temperatureChanged || dtChanged || abChanged) {
      this.clock.reset(performance.now());
    }
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

    if (!circuitChanged && !dtChanged && !abChanged && !reset && !temperatureChanged) {
      if (probesChanged || spanChanged || scopeModeChanged) this.samples = [];
      return;
    }

    this.circuit = s.circuit;
    this.epoch = s.simulationEpoch;
    this.ambientTemperature = s.environment.temperature;
    this.dt = s.timestep;
    this.ab = s.ab;
    this.ghostOn = s.abGhost && s.ab !== null;

    // continuità: gli stati (carica dei condensatori...) sopravvivono all'edit
    const carried = reset ? undefined : this.session?.states();
    const t0 = reset ? 0 : this.session?.time ?? 0;
    this.compiled = compile(s.circuit);
    this.frame = null;
    this.session = this.simFor(s.circuit).transient(this.compiled, {
      dt: this.dt,
      ambientTemperature: this.ambientTemperature,
      initialStates: carried,
      t0,
    });

    if (this.ghostOn && s.ab) {
      const ghostCarried = reset ? undefined : this.ghostSession?.states() ?? carried;
      const ghostCircuit = applyAB(s.circuit, s.ab);
      this.ghostCompiled = compile(ghostCircuit);
      this.ghostSession = this.simFor(ghostCircuit).transient(this.ghostCompiled, {
        dt: this.dt,
        ambientTemperature: this.ambientTemperature,
        initialStates: ghostCarried,
        t0,
      });
    } else {
      this.ghostCompiled = null;
      this.ghostSession = null;
    }
    if (reset || dtChanged || spanChanged || scopeModeChanged) this.samples = [];
  }

  runBodeFor(compiled: CompiledCircuit | null): BodePoint[] {
    if (!compiled || this.probes.length === 0) return [];
    assertBodeWorkload(compiled, this.probes.length);

    // Trova la prima sorgente compatibile con AC o generica sorgente di tensione
    const srcItem = bodeSource(compiled);
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

      const session = this.simulator.transient(sweptCompiled, { dt, ambientTemperature: this.ambientTemperature });

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
    const start = performance.now();
    const active = s.running && (typeof document === 'undefined' || !document.hidden);
    this.clock.update(start, active, s.playbackSpeed);
    if (!this.session || !this.compiled || this.compiled.items.length === 0) return;
    let result: SimResult | null = null;
    let ghost: SimResult | null = null;

    if (active) {
      while (this.clock.ready(this.dt) && performance.now() - start < FRAME_BUDGET_MS) {
        const previousTime = this.session.time;
        const previousStates = this.ghostSession ? this.session.states() : undefined;
        result = this.session.step();
        if (!result.converged) break;
        if (this.ghostSession) {
          ghost = this.ghostSession.step();
          if (!ghost.converged) {
            // La coppia A/B è un avanzamento unico: annulla anche il principale.
            this.session = this.simFor(s.circuit).transient(this.compiled, {
              dt: this.dt, t0: previousTime, initialStates: previousStates,
              ambientTemperature: this.ambientTemperature,
            });
            result = { ...result, time: previousTime, converged: false, diagnostics: ghost.diagnostics };
            break;
          }
        }
        this.clock.consume(this.dt);
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
      const dc = this.simFor(s.circuit).dcOperatingPoint(this.compiled, { ambientTemperature: this.ambientTemperature });
      this.frame = { compiled: this.compiled, result: dc, ghostCompiled: null, ghost: null };
    }

    const now = performance.now();
    if (now - this.lastTickPush > 60) {
      this.lastTickPush = now;
      useSimTick.setState((t) => ({
        tick: t.tick + 1,
        time: this.session?.time ?? 0,
        converged: this.frame?.result.converged ?? true,
        playbackLag: active ? Math.max(0, this.clock.pendingSeconds - this.dt) : 0,
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
