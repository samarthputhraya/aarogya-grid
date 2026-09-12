/**
 * Scoring a shared seasonal index on data it has never seen.
 *
 * WHAT IS BEING MEASURED, PRECISELY
 * ---------------------------------
 * The only thing that crosses a state line in this design is a seasonal index.
 * So the only honest question about federation is: how much is that index worth
 * to the state that receives it? Everything else -- the level of each series,
 * the drug mix, the district structure -- is local, known locally, and identical
 * in every arm of the comparison. Holding all of it fixed and varying ONLY the
 * index is what makes the difference attributable.
 *
 * THE FORECAST
 * ------------
 * A node fitted on the first `fitDays` days must predict the rest of the window.
 * For each district x drug series:
 *
 *     level = mean over the FIT days of  y_t / index[month(t)]      (deseasonalise)
 *     pred_t = level * index[month(t)]                              (reseasonalise)
 *
 * The level is estimated locally and only from the fit window, so a state that
 * joined in April -- when malaria demand is at 0.5x its annual mean -- and uses
 * a flat index will conclude that April was normal and under-forecast the
 * monsoon by half. That is not a contrived failure; it is the specific mistake
 * the seasonality module's own docstring names as the commonest cause of
 * monsoon stock-outs, reproduced here as a measurement.
 *
 * A constant rescaling of the index cancels exactly: multiply `index` by c and
 * `level` divides by c. The metric therefore depends on the index's SHAPE and
 * not on its normalisation, which is what lets a locally fitted index and a
 * nationally pooled one be compared without either being renormalised first.
 *
 * WHY THE SCORE IS TAKEN OVER A PLANNING HORIZON, NOT OVER SINGLE DAYS
 * --------------------------------------------------------------------
 * This was measured the wrong way first, and the wrong way looked plausible.
 * Scored day by day, a correct seasonal index made the Antidotes group 18%
 * WORSE -- including the oracle index fitted on the state's own full history,
 * which cannot possibly be a worse description of that state than a flat line.
 *
 * The cause is not the model, it is the loss. A district dispenses anti-snake
 * venom at a fraction of a vial a day: the distribution is mostly zero, its mean
 * is around 0.4 and its MEDIAN is 0. Mean absolute error is minimised by the
 * median, so forecasting zero beats forecasting the correct conditional mean,
 * and any model that correctly doubles its expectation for August is punished
 * for it. A metric that rewards forecasting zero for a vital emergency drug
 * would have been a bad thing to publish.
 *
 * So the unit of scoring is a 21-day block -- the same horizon the forecast
 * cache runs at and the longest lead time in the network, which is to say the
 * quantity a reorder point is actually computed from. Over 21 days the same
 * series totals six to twenty vials, the distribution stops being degenerate,
 * and the loss measures what the supply chain is really trying to get right.
 * Both the block figure and the raw daily one are reported, and both arms of
 * every comparison are scored identically.
 *
 * THE METRIC
 * ----------
 * Absolute (and squared) error per block, divided by the series' own mean block
 * total over the evaluation window -- so a sachet of ORS and a vial of
 * anti-snake venom contribute on the same scale, and the figure reads as
 * "typical error, as a fraction of typical demand". The scaler is the same for
 * every arm.
 */

/** The planning horizon: the forecast cache's own, and the network's longest lead time. */
export const BLOCK_DAYS = 21;

export interface SeriesScore {
  /** Mean absolute block error / mean block demand. */
  scaledMae: number;
  /** Root mean squared block error / mean block demand. */
  scaledRmse: number;
  /** Blocks scored. */
  blocks: number;
  /** Mean block demand over the evaluation window -- the scaler. */
  scale: number;
}

/**
 * Score one series against one seasonal index.
 *
 * Returns null when no arm could say anything useful: a series with no demand
 * at all in the fit window has no level to estimate, and one with no demand in
 * the evaluation window has no scale to divide by. Both are excluded from every
 * arm identically and counted by the caller, rather than being scored as a
 * perfect or a catastrophic prediction depending on which way the zero falls.
 */
export function scoreSeries(
  values: number[],
  index: number[],
  months: number[],
  fitDays: number,
  blockDays: number = BLOCK_DAYS,
): SeriesScore | null {
  let levelSum = 0;
  let levelDays = 0;
  let fitTotal = 0;
  for (let t = 0; t < fitDays; t++) {
    const ix = index[months[t]];
    if (!(ix > 0)) continue;
    levelSum += values[t] / ix;
    levelDays += 1;
    fitTotal += values[t];
  }
  if (levelDays === 0 || !(fitTotal > 0)) return null;
  const level = levelSum / levelDays;

  /*
   * Whole blocks only. A trailing partial block would be scored against a
   * smaller total than the blocks before it and would drag the scaler, so the
   * remainder is dropped -- identically in every arm, since the block grid
   * depends only on `fitDays` and never on the index being tested.
   */
  const evalDays = values.length - fitDays;
  const blocks = Math.floor(evalDays / blockDays);
  if (blocks < 1) return null;

  let absError = 0;
  let sqError = 0;
  let actualTotal = 0;
  for (let b = 0; b < blocks; b++) {
    let actual = 0;
    let pred = 0;
    for (let i = 0; i < blockDays; i++) {
      const t = fitDays + b * blockDays + i;
      actual += values[t];
      pred += level * index[months[t]];
    }
    const d = actual - pred;
    absError += Math.abs(d);
    sqError += d * d;
    actualTotal += actual;
  }
  const scale = actualTotal / blocks;
  if (!(scale > 0)) return null;

  return {
    scaledMae: absError / blocks / scale,
    scaledRmse: Math.sqrt(sqError / blocks) / scale,
    blocks,
    scale,
  };
}

/** Twelve ones: the arm that assumes demand has no season at all. */
export const FLAT_INDEX: number[] = new Array(12).fill(1);

/** UTC month for each day of a window, computed once and reused across every arm. */
export function monthsOf(startDate: Date, days: number): number[] {
  const out: number[] = new Array(days);
  for (let t = 0; t < days; t++) {
    out[t] = new Date(startDate.getTime() + t * 86400000).getUTCMonth();
  }
  return out;
}
