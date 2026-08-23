/**
 * Formatting helpers.
 *
 * Indian numbering is not a cosmetic choice here. An officer in a State
 * Directorate reads "2.03 Cr", not "20,318,102" and certainly not "$243k".
 * Getting this wrong is the fastest way to look like software written for
 * somewhere else.
 */

/** Indian short-scale currency: thousands, lakh (1e5), crore (1e7). */
export function inr(value: number, opts: { decimals?: number } = {}): string {
  const n = Math.round(value);
  const abs = Math.abs(n);
  const d = opts.decimals ?? 2;

  if (abs >= 1_00_00_000) return '₹' + (n / 1_00_00_000).toFixed(d).replace(/\.?0+$/, '') + ' Cr';
  if (abs >= 1_00_000) return '₹' + (n / 1_00_000).toFixed(d).replace(/\.?0+$/, '') + ' L';
  if (abs >= 1_000) return '₹' + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return '₹' + n.toLocaleString('en-IN');
}

/** Full Indian grouping (2,03,18,102) for places where precision matters. */
export function inrFull(value: number): string {
  return '₹' + Math.round(value).toLocaleString('en-IN');
}

export function count(value: number): string {
  return Math.round(value).toLocaleString('en-IN');
}

/** Compact counts for KPI tiles: 80,896 -> 80.9k, 2,32,60,000 -> 2.33 Cr. */
export function compactCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_00_00_000) return (value / 1_00_00_000).toFixed(2).replace(/\.?0+$/, '') + ' Cr';
  if (abs >= 1_00_000) return (value / 1_00_000).toFixed(1).replace(/\.0$/, '') + ' L';
  if (abs >= 1_000) return (value / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(value));
}

/** Population, which reads better in millions than in lakh for a national total. */
export function population(value: number): string {
  if (value >= 1_00_00_000) return (value / 1_00_00_000).toFixed(2) + ' Cr';
  if (value >= 1_00_000) return (value / 1_00_000).toFixed(1) + ' L';
  return count(value);
}

export function pct(value: number, decimals = 1): string {
  return (value * 100).toFixed(decimals) + '%';
}

export function days(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 999) return '999+';
  return value.toFixed(value < 10 ? 1 : 0) + 'd';
}

export type Severity = 'critical' | 'high' | 'moderate' | 'low';

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: 'var(--color-sev-critical)',
  high: 'var(--color-sev-high)',
  moderate: 'var(--color-sev-moderate)',
  low: 'var(--color-sev-low)',
};

/** Tailwind classes for a severity chip. */
export const SEVERITY_CLASS: Record<Severity, string> = {
  critical: 'text-sev-critical bg-sev-critical/10 border-sev-critical/30',
  high: 'text-sev-high bg-sev-high/10 border-sev-high/30',
  moderate: 'text-sev-moderate bg-sev-moderate/10 border-sev-moderate/25',
  low: 'text-sev-low bg-sev-low/10 border-sev-low/25',
};

export function severityOfScore(score: number): Severity {
  if (score >= 65) return 'critical';
  if (score >= 40) return 'high';
  if (score >= 18) return 'moderate';
  return 'low';
}

/**
 * Colour ramp for the choropleth, keyed on mean risk score.
 * Deliberately the same ramp as the severity chips so the map and the tables
 * cannot disagree about what "bad" looks like.
 */
export function riskColor(score: number): string {
  if (score >= 30) return '#ff4d5e';
  if (score >= 22) return '#ff7a45';
  if (score >= 16) return '#ff9838';
  if (score >= 11) return '#ffd23f';
  if (score >= 6) return '#a3d977';
  return '#34d399';
}

export const VED_LABEL: Record<string, string> = {
  V: 'Vital',
  E: 'Essential',
  D: 'Desirable',
};

export const FACILITY_LABEL: Record<string, string> = {
  SC: 'Sub-Centre',
  PHC: 'Primary Health Centre',
  CHC: 'Community Health Centre',
  SDH: 'Sub-District Hospital',
  DH: 'District Hospital',
  DW: 'District Warehouse',
};
