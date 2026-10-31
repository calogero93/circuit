// Text is untrusted; CSV quoting alone does not neutralize spreadsheet formulas.
export function csvField(value: string | number): string {
  let text = String(value);
  if (typeof value === 'string' && /^[\s\p{Cc}\p{Cf}]*[=+@-]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function timeCSV(probes: readonly { label: string }[], samples: readonly { t: number; v: number[] }[]): string {
  const header = ['Tempo (s)', ...probes.map(p => `${p.label} (V)`)].map(csvField).join(',');
  // Only solver-produced numbers enter these rows; preserve the existing precision.
  return [header, ...samples.map(s => [s.t.toFixed(6), ...s.v.map(v => v.toFixed(4))].join(','))].join('\n');
}

export function bodeCSV(probes: readonly { label: string }[], points: readonly { f: number; gainDb: number[]; phaseDeg: number[] }[]): string {
  const header = ['Frequenza (Hz)', ...probes.flatMap(p => [`${p.label} Guadagno (dB)`, `${p.label} Fase (deg)`])].map(csvField).join(',');
  return [header, ...points.map(p => [p.f.toFixed(2), ...p.gainDb.flatMap((g, i) => [g.toFixed(2), (p.phaseDeg[i] ?? 0).toFixed(1)])].join(','))].join('\n');
}
