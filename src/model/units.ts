// Formattazione in notazione ingegneristica (1.5 kΩ, 100 µF, 3.16 mA...).

const PREFIXES: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
  [1e-9, 'n'],
  [1e-12, 'p'],
  [1e-15, 'f'],
];

export function formatSI(value: number, unit = '', digits = 3): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return `0 ${unit}`.trim();
  const abs = Math.abs(value);
  let scale = 1e-15;
  let prefix = 'f';
  for (const [s, p] of PREFIXES) {
    if (abs >= s) {
      scale = s;
      prefix = p;
      break;
    }
  }
  const scaled = value / scale;
  const str = Number(scaled.toPrecision(digits)).toString();
  return `${str} ${prefix}${unit}`.trim();
}
