import type { DeviceOutputs } from '../model/device.ts';
import { formatSI } from '../model/units.ts';
import { POWER_STATUS_LABELS } from '../library/resistorPower.ts';

export function ResistorPowerPanel({ outputs, converged }: { outputs?: DeviceOutputs; converged: boolean }) {
  if (!outputs || !converged) return <section className="power-panel"><h4>Dimensionamento di potenza</h4><p>Misure non disponibili o simulazione non convergente.</p></section>;
  const d = outputs.data;
  const status = String(d.powerStatus);
  const dc = d.temperatureMode === 'steady-state';
  const statusLabel = status === 'thermal-limit' && dc ? 'Limite termico previsto a regime' : POWER_STATUS_LABELS[status];
  const load = Number(d.powerLoadPercent);
  return (
    <section className={`power-panel power-${status}`} aria-label="Dimensionamento di potenza">
      <h4>Dimensionamento di potenza</h4>
      <p className="power-status" role="status">{statusLabel}</p>
      <dl>
        <dt>Potenza istantanea</dt><dd>{formatSI(Number(d.p), 'W', 3)}</dd>
        <dt>Potenza media{dc ? ' (DC)' : ' dall’avvio'}</dt><dd>{formatSI(Number(d.meanPower), 'W', 3)}</dd>
        <dt>Potenza nominale</dt><dd>{formatSI(Number(d.ratedPower), 'W', 3)}</dd>
        <dt>Consentita a {Number(d.ambientTemperature).toFixed(1)} °C</dt><dd>{formatSI(Number(d.allowedPower), 'W', 3)}</dd>
        <dt>Utilizzo medio</dt><dd>{Number.isFinite(load) ? `${load.toFixed(1)}%` : 'Nessuna potenza disponibile'}</dd>
        <dt>{dc ? 'Temperatura stimata a regime' : 'Temperatura stimata'}</dt><dd>{Number(d.temperature).toFixed(1)} °C</dd>
        <dt>Limite di temperatura</dt><dd>{Number(d.maxTemperature).toFixed(1)} °C</dd>
      </dl>
      <p className="muted">P = V × I = I² × R. La potenza nominale non cambia il valore della resistenza.</p>
      {!dc && <p className="muted">Media su {formatSI(Number(d.powerDuration), 's', 3)} simulati; un picco richiede anche la verifica dei limiti impulsivi.</p>}
      <p className="muted">Stima termica didattica{d.thermalResistanceEstimated ? ', con resistenza termica ricavata dal profilo nominale' : ''}. Il sovraccarico segnala il rischio: il componente non viene interrotto automaticamente.</p>
      {!d.powerRatingValid && <p>Imposta una potenza e una capacità termica positive, una resistenza termica ≥ 0 e una temperatura massima superiore all’inizio derating.</p>}
    </section>
  );
}
