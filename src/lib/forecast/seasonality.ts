import type { SeasonalityProfile } from '@/lib/domain/types';

/**
 * Monthly demand multipliers by epidemiological archetype (index 0 = January).
 *
 * PROVENANCE -- READ THIS BEFORE QUOTING ANY NUMBER HERE
 * -----------------------------------------------------
 * These curves encode the SHAPE of India's disease calendar: vector-borne
 * illness tracking the monsoon, envenomation tracking monsoon field work,
 * enteric illness peaking in the hot months, respiratory illness peaking in
 * winter. The shapes are the modelling assumption the whole simulator rests on.
 *
 * They are NOT measured constants. Nothing here should be presented as an
 * empirical finding. When real HMIS / DVDMS consumption history is connected,
 * these curves are replaced by a fitted seasonal index per district and per
 * therapeutic group -- the code path does not change, only the source of the
 * numbers. `fitSeasonalIndex` below is that replacement, ready to use.
 */
const RAW_PROFILES: Record<SeasonalityProfile, number[]> = {
  flat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  // Malaria / dengue / chikungunya: breeding follows the monsoon, cases lag it.
  monsoon_vector: [0.5, 0.45, 0.45, 0.55, 0.7, 1.0, 1.5, 1.9, 2.0, 1.7, 1.0, 0.65],
  // Snakebite: monsoon plus peak agricultural field activity.
  monsoon_envenomation: [0.35, 0.35, 0.5, 0.7, 0.9, 1.4, 1.9, 2.0, 1.8, 1.3, 0.6, 0.4],
  // Diarrhoeal disease / ORS / IV fluids: hot months and early monsoon.
  summer_enteric: [0.6, 0.6, 0.8, 1.1, 1.5, 1.7, 1.6, 1.4, 1.1, 0.9, 0.7, 0.6],
  // Acute respiratory infection, asthma exacerbation: winter peak.
  winter_respiratory: [1.6, 1.5, 1.1, 0.8, 0.6, 0.6, 0.7, 0.7, 0.8, 1.0, 1.4, 1.7],
  // Heat stroke, dehydration: pre-monsoon peak.
  summer_heat: [0.5, 0.6, 0.9, 1.5, 2.0, 1.9, 1.0, 0.8, 0.7, 0.6, 0.5, 0.5],
  // Deliveries: only mild seasonality.
  obstetric: [1.05, 1.0, 1.0, 0.98, 0.95, 0.95, 1.0, 1.02, 1.03, 1.02, 1.0, 1.0],
};

/** Normalise a curve so its mean is exactly 1 -- multipliers must not shift the annual total. */
function normalise(curve: number[]): number[] {
  const mean = curve.reduce((a, b) => a + b, 0) / curve.length;
  return curve.map((v) => v / mean);
}

export const SEASONAL_PROFILES: Record<SeasonalityProfile, number[]> = Object.fromEntries(
  Object.entries(RAW_PROFILES).map(([k, v]) => [k, normalise(v)]),
) as Record<SeasonalityProfile, number[]>;

/** Multiplier for a given profile on a given date. */
export function seasonalIndex(profile: SeasonalityProfile, date: Date): number {
  return SEASONAL_PROFILES[profile][date.getUTCMonth()];
}

/**
 * Per-day multipliers across a forward horizon.
 *
 * Used by the risk engine so that lead-time demand is evaluated against the
 * season we are actually heading into. A PHC holding 30 days of cover on the
 * 1st of June does not have 30 days of cover -- it has roughly 20, because
 * malaria demand is about to double. Flat-average forecasting misses exactly
 * this, and it is the single most common cause of monsoon stock-outs.
 */
export function horizonMultipliers(
  profile: SeasonalityProfile,
  start: Date,
  days: number,
): number[] {
  const out: number[] = new Array(days);
  const cursor = new Date(start.getTime());
  for (let i = 0; i < days; i++) {
    out[i] = SEASONAL_PROFILES[profile][cursor.getUTCMonth()];
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Mean seasonal multiplier over a forward horizon. */
export function meanHorizonMultiplier(
  profile: SeasonalityProfile,
  start: Date,
  days: number,
): number {
  const m = horizonMultipliers(profile, start, days);
  return m.reduce((a, b) => a + b, 0) / m.length;
}

/**
 * Fit a seasonal index directly from observed history -- the production path.
 *
 * Takes daily observations paired with their dates, computes a classical
 * ratio-to-moving-average style monthly index, and shrinks it toward 1.0 in
 * proportion to how little data supports each month. Shrinkage matters: with
 * two Augusts of history you do not want to trust an August multiplier of 3.4.
 *
 * @param minObs months with fewer observations than this are pulled hard toward 1.
 */
export function fitSeasonalIndex(
  observations: { date: Date; value: number }[],
  minObs = 30,
): number[] {
  const sums = new Array(12).fill(0);
  const counts = new Array(12).fill(0);
  for (const o of observations) {
    const m = o.date.getUTCMonth();
    sums[m] += o.value;
    counts[m] += 1;
  }
  const overallMean =
    observations.length > 0
      ? observations.reduce((a, b) => a + b.value, 0) / observations.length
      : 0;
  if (overallMean <= 0) return new Array(12).fill(1);

  const index = sums.map((s, i) => {
    if (counts[i] === 0) return 1;
    const raw = s / counts[i] / overallMean;
    // Shrink toward 1 by the fraction of the target sample size we actually have.
    const weight = Math.min(1, counts[i] / minObs);
    return weight * raw + (1 - weight) * 1;
  });
  return normalise(index);
}
