// Profilo termico didattico: curva lineare di derating e modello RC concentrato.
// I valori predefiniti non identificano un componente commerciale specifico.
import type { DeviceState, Params } from '../model/device.ts';

export const RESISTOR_POWER_DEFAULTS = {
  ratedPower: 0.25,
  deratingStart: 70,
  maxTemperature: 155,
  thermalResistance: 0, // 0: ricavata dal profilo nominale, non misurata
  thermalCapacity: 0.02,
};

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resistorPowerData(params: Params, power: number, ambient: number,
  state: DeviceState = {}, dt: number | null = null): Record<string, number | string | boolean> {
  const d = RESISTOR_POWER_DEFAULTS;
  const rated = finite(params.ratedPower, d.ratedPower);
  const start = finite(params.deratingStart, d.deratingStart);
  const maximum = finite(params.maxTemperature, d.maxTemperature);
  const specifiedTheta = finite(params.thermalResistance, d.thermalResistance);
  const capacity = finite(params.thermalCapacity, d.thermalCapacity);
  const valid = rated > 0 && maximum > start && capacity > 0 && specifiedTheta >= 0;
  const rating = rated > 0 ? rated : d.ratedPower;
  const span = maximum > start ? maximum - start : d.maxTemperature - d.deratingStart;
  const theta = specifiedTheta > 0 ? specifiedTheta : span / rating;
  const allowed = rating * Math.max(0, Math.min(1, (maximum - ambient) / span));
  const p = Math.max(0, power);
  const previous = state.thermalInitialized ? state.temperature : ambient;
  const tau = theta * (capacity > 0 ? capacity : d.thermalCapacity);
  const equilibrium = ambient + p * theta;
  const duration = dt === null ? 0 : (state.powerDuration ?? 0) + dt;
  const energy = dt === null ? 0 : (state.energy ?? 0) + p * dt;
  const mean = duration > 0 ? energy / duration : p;
  const temperature = dt === null ? equilibrium : previous +
    (equilibrium - previous) * -Math.expm1(-dt / tau);
  const tolerance = 1 + 1e-9;
  const meanOverload = mean > allowed * tolerance;
  const peakOverload = p > allowed * tolerance;
  const overtemperature = temperature >= maximum;
  const status = !valid ? 'invalid-rating' : overtemperature ? 'thermal-limit' :
    meanOverload ? 'overload' : peakOverload ? 'peak-overload' :
    allowed > 0 && mean / allowed >= 0.8 ? 'near-limit' : 'ok';
  const data: Record<string, number | string | boolean> = {
    ratedPower: rating, allowedPower: allowed, ambientTemperature: ambient,
    deratingStart: start, maxTemperature: maximum, thermalResistance: theta,
    thermalResistanceEstimated: specifiedTheta === 0, thermalCapacity: capacity,
    thermalTimeConstant: tau, temperature, steadyTemperature: equilibrium,
    temperatureMode: dt === null ? 'steady-state' : 'transient',
    meanPower: mean, powerDuration: duration, energy,
    peakPowerOverload: peakOverload, meanPowerOverload: meanOverload,
    temperatureExceeded: overtemperature, powerStatus: status, powerRatingValid: valid,
  };
  if (allowed > 0) {
    data.powerLoadPercent = 100 * mean / allowed;
    data.peakPowerLoadPercent = 100 * p / allowed;
  }
  return data;
}

export const POWER_STATUS_LABELS: Record<string, string> = {
  ok: 'Entro il limite',
  'near-limit': 'Margine ridotto',
  'peak-overload': 'Potenza istantanea oltre il limite',
  overload: 'Sovraccarico di potenza',
  'thermal-limit': 'Limite termico raggiunto',
  'invalid-rating': 'Parametri termici non validi',
};
