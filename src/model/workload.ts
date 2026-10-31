// One preflight for the execution paths used by imports, edits and the controller.
import type { Circuit, PinRef } from './types.ts';
import { compile, type CompiledCircuit } from './netlist.ts';
import { getDef } from './registry.ts';
import { isPurelyDigital } from '../engine/digital.ts';
import { analogSystemSize, isMixed } from '../engine/mixed.ts';
import { IMPORT_LIMITS, assertImportBudget, assertCircuitCollections, assertSolverDimension, importError } from './importLimits.ts';
import { applyAB, type ABConfig } from './ab.ts';

export interface SimulationWorkload {
  circuit: Circuit;
  scopeMode?: 'time' | 'bode';
  probes?: readonly { pin: PinRef }[];
  ab?: ABConfig | null;
  abGhost?: boolean;
}

export function validProbe(circuit: Circuit, pin: PinRef): boolean {
  const component = circuit.components.find(c => c.id === pin.component);
  return !!component && Number.isInteger(pin.pin) && pin.pin >= 0 && pin.pin < getDef(component.type).pins.length;
}

export function bodeSource(compiled: CompiledCircuit) {
  return compiled.items.find(item => ['vsin', 'vsinPhase', 'pulse', 'vdc'].includes(item.inst.type));
}

export function assertBodeWorkload(compiled: CompiledCircuit, probes: number): void {
  if (!probes || !bodeSource(compiled)) return;
  assertSolverDimension(compiled.nNodes, compiled.nBranches, IMPORT_LIMITS.bodeDimension);
  if (probes > IMPORT_LIMITS.bodeProbes) importError(`massimo ${IMPORT_LIMITS.bodeProbes} sonde per lo sweep Bode`);
}

function validateExecution(circuit: Circuit, scopeMode: 'time' | 'bode', probes: number): void {
  const compiled = compile(circuit);
  if (!isPurelyDigital(circuit)) {
    const system = isMixed(circuit) ? analogSystemSize(compiled) : compiled;
    assertSolverDimension(system.nNodes, system.nBranches);
  }
  // Bode currently uses the analog solver, independently of the live engine.
  if (scopeMode === 'bode') assertBodeWorkload(compiled, probes);
}

export function assertSimulationWorkload({ circuit, scopeMode = 'time', probes = [], ab, abGhost }: SimulationWorkload): void {
  assertImportBudget(circuit, true);
  assertCircuitCollections(circuit as unknown as Record<string, unknown>);
  if (probes.length > IMPORT_LIMITS.probes || probes.some(p => !p.pin || typeof p.pin.component !== 'string' || !Number.isInteger(p.pin.pin) || p.pin.pin < 0)) importError('sonde non valide o troppo numerose');
  validateExecution(circuit, scopeMode, probes.length);
  if (abGhost && ab) validateExecution(applyAB(circuit, ab), scopeMode, probes.length);
}
