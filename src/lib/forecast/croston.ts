/**
 * Intermittent-demand forecasting.
 *
 * WHY NOT A NEURAL NETWORK
 * ------------------------
 * PHC drug consumption is not a smooth time series. A sub-centre may dispense
 * anti-snake venom four times in a year. Feeding that to an LSTM (or to naive
 * moving averages, or to most off-the-shelf forecasters) produces confidently
 * wrong numbers, because those methods assume demand occurs every period.
 *
 * The literature for this exact shape of data is Croston's method and its
 * descendants, which decompose the series into two independent processes:
 *   (1) how big a demand is when it happens, and
 *   (2) how often demand happens.
 *
 * We implement Croston (1972), the Syntetos-Boylan Approximation (2005) which
 * removes the known positive bias in Croston, and TSB (Teunter, Syntetos &
 * Babai, 2011) which decays the demand probability during zero periods and
 * therefore handles items drifting into obsolescence -- a real effect when a
 * treatment protocol changes and a drug stops being prescribed.
 *
 * Selection between them is automatic, via the Syntetos-Boylan-Croston
 * classification of the series (see classifyDemand).
 */

export type ForecastMethod = 'croston' | 'sba' | 'tsb' | 'ses';

/** Syntetos-Boylan-Croston demand categories. */
export type DemandPattern = 'smooth' | 'intermittent' | 'erratic' | 'lumpy';

export interface DemandFit {
  method: ForecastMethod;
  pattern: DemandPattern;
  /** Forecast mean demand per period (per day, in our usage). */
  meanDemand: number;
  /** Standard deviation of per-period demand, from the compound Bernoulli model. */
  sigma: number;
  /** Probability that any given period has non-zero demand. */
  demandProbability: number;
  /** Mean size of a demand, conditional on demand occurring. */
  meanSize: number;
  /** Std dev of demand size, conditional on demand occurring. */
  sigmaSize: number;
  /** Average Demand Interval -- mean periods between demands. */
  adi: number;
  /** Squared coefficient of variation of non-zero demand sizes. */
  cv2: number;
  /** Number of periods the fit was computed over. */
  periods: number;
  /** Number of non-zero periods observed. */
  nonZeroPeriods: number;
}

/**
 * Syntetos-Boylan-Croston classification.
 *
 * The cut-offs (ADI = 1.32, CV^2 = 0.49) are the published values at which
 * SBA expected mean-square-error overtakes Croston; they are not arbitrary.
 */
export function classifyDemand(adi: number, cv2: number): DemandPattern {
  const intermittent = adi >= 1.32;
  const variable = cv2 >= 0.49;
  if (!intermittent && !variable) return 'smooth';
  if (intermittent && !variable) return 'intermittent';
  if (!intermittent && variable) return 'erratic';
  return 'lumpy';
}

/** Simple exponential smoothing -- the fallback for genuinely smooth series. */
function ses(series: number[], alpha: number): number {
  if (series.length === 0) return 0;
  let level = series[0];
  for (let i = 1; i < series.length; i++) {
    level = alpha * series[i] + (1 - alpha) * level;
  }
  return level;
}

/**
 * Croston method and the SBA variant.
 *
 * Both estimates are updated ONLY in periods where demand occurs, which is the
 * defining property of the method (and the source of its bias, which SBA fixes
 * with the (1 - alpha/2) deflator).
 */
function crostonCore(
  series: number[],
  alpha: number,
  debias: boolean,
): { meanDemand: number; meanSize: number; adi: number } {
  const firstIdx = series.findIndex((v) => v > 0);
  if (firstIdx === -1) return { meanDemand: 0, meanSize: 0, adi: Infinity };

  let sizeEst = series[firstIdx];
  let intervalEst = firstIdx + 1;
  let periodsSinceDemand = 0;

  for (let i = firstIdx + 1; i < series.length; i++) {
    periodsSinceDemand++;
    if (series[i] > 0) {
      sizeEst = alpha * series[i] + (1 - alpha) * sizeEst;
      intervalEst = alpha * periodsSinceDemand + (1 - alpha) * intervalEst;
      periodsSinceDemand = 0;
    }
  }

  const safeInterval = intervalEst > 0 ? intervalEst : 1;
  const raw = sizeEst / safeInterval;
  // SBA deflator removes the known positive bias in Croston.
  const meanDemand = debias ? raw * (1 - alpha / 2) : raw;
  return { meanDemand, meanSize: sizeEst, adi: safeInterval };
}

/**
 * TSB -- updates the demand PROBABILITY every period, including zero periods.
 *
 * This is what lets the forecast decay toward zero for a drug that has stopped
 * moving, instead of holding a stale estimate forever the way Croston does.
 */
function tsbCore(
  series: number[],
  alpha: number,
  beta: number,
): { meanDemand: number; meanSize: number; probability: number } {
  const firstIdx = series.findIndex((v) => v > 0);
  if (firstIdx === -1) return { meanDemand: 0, meanSize: 0, probability: 0 };

  let sizeEst = series[firstIdx];
  let probEst = 1 / (firstIdx + 1);

  for (let i = firstIdx + 1; i < series.length; i++) {
    if (series[i] > 0) {
      probEst = probEst + beta * (1 - probEst);
      sizeEst = sizeEst + alpha * (series[i] - sizeEst);
    } else {
      probEst = probEst + beta * (0 - probEst);
    }
  }
  return { meanDemand: probEst * sizeEst, meanSize: sizeEst, probability: probEst };
}

/**
 * Fit a demand model to a per-period history and return everything the
 * inventory policy needs.
 *
 * The variance is derived, not fudged. Treating each period as a Bernoulli
 * trial with probability p and a demand size Z when it fires gives
 *
 *     Var[D] = p * Var[Z] + p * (1 - p) * E[Z]^2
 *
 * which is the compound Bernoulli variance. This matters: using a plain
 * standard deviation of the raw series (zeros included) understates the spike
 * risk that actually causes stock-outs.
 */
export function fitDemand(
  series: number[],
  opts: { alpha?: number; beta?: number; method?: ForecastMethod } = {},
): DemandFit {
  const alpha = opts.alpha ?? 0.15;
  const beta = opts.beta ?? 0.08;
  const periods = series.length;
  const nonZero = series.filter((v) => v > 0);
  const nonZeroPeriods = nonZero.length;

  if (periods === 0 || nonZeroPeriods === 0) {
    return {
      method: 'tsb',
      pattern: 'intermittent',
      meanDemand: 0,
      sigma: 0,
      demandProbability: 0,
      meanSize: 0,
      sigmaSize: 0,
      adi: Infinity,
      cv2: 0,
      periods,
      nonZeroPeriods: 0,
    };
  }

  const meanSizeObs = nonZero.reduce((a, b) => a + b, 0) / nonZeroPeriods;
  const varSizeObs =
    nonZeroPeriods > 1
      ? nonZero.reduce((acc, v) => acc + (v - meanSizeObs) ** 2, 0) / (nonZeroPeriods - 1)
      : 0;
  const cv2 = meanSizeObs > 0 ? varSizeObs / meanSizeObs ** 2 : 0;
  const adi = periods / nonZeroPeriods;
  const pattern = classifyDemand(adi, cv2);

  // Method selection follows the SBC grid: smooth series do not need Croston at
  // all; lumpy / obsolescence-prone series are best served by TSB.
  const method: ForecastMethod =
    opts.method ?? (pattern === 'smooth' ? 'ses' : pattern === 'lumpy' ? 'tsb' : 'sba');

  let meanDemand: number;
  let meanSize: number;
  let probability: number;

  if (method === 'ses') {
    meanDemand = ses(series, alpha);
    meanSize = meanSizeObs;
    probability = nonZeroPeriods / periods;
  } else if (method === 'tsb') {
    const r = tsbCore(series, alpha, beta);
    meanDemand = r.meanDemand;
    meanSize = r.meanSize;
    probability = r.probability;
  } else {
    const r = crostonCore(series, alpha, method === 'sba');
    meanDemand = r.meanDemand;
    meanSize = r.meanSize;
    probability = r.adi > 0 && Number.isFinite(r.adi) ? 1 / r.adi : 0;
  }

  // Compound Bernoulli variance, using the fitted probability and the observed
  // conditional size variance.
  const p = Math.min(Math.max(probability, 0), 1);
  const variance = p * varSizeObs + p * (1 - p) * meanSize ** 2;

  return {
    method,
    pattern,
    meanDemand: Math.max(0, meanDemand),
    sigma: Math.sqrt(Math.max(0, variance)),
    demandProbability: p,
    meanSize,
    sigmaSize: Math.sqrt(Math.max(0, varSizeObs)),
    adi,
    cv2,
    periods,
    nonZeroPeriods,
  };
}

/**
 * Censoring-aware demand fit.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * A stock ledger records what was DISPENSED, not what was NEEDED. On a day
 * when the shelf was empty, the record says zero -- indistinguishable from a
 * day when nobody came. Fit a forecast to that and you conclude the facility
 * has low demand, so you send less, so it stocks out sooner. The forecast
 * manufactures the shortage it then justifies.
 *
 * The fix is to recognise those days as CENSORED observations rather than
 * observed zeros, and to estimate the demand rate only from days where the
 * facility could actually have met demand. This is the standard unconstraining
 * correction from revenue management, and it is implementable in production
 * because the stock ledger already tells us which days had zero stock.
 *
 * @param series   recorded issues per period
 * @param censored true for periods where stock ran out, so the record is a
 *                 lower bound on demand rather than demand itself
 */
export function fitDemandCensored(
  series: number[],
  censored: boolean[],
  opts: { alpha?: number; beta?: number; method?: ForecastMethod } = {},
): DemandFit {
  const uncensored: number[] = [];
  for (let i = 0; i < series.length; i++) {
    if (!censored[i]) uncensored.push(series[i]);
  }

  // If almost everything is censored there is nothing trustworthy left to fit.
  // Fall back to the naive fit rather than returning a confident wrong answer
  // from a handful of points -- and the caller can see it via `periods`.
  if (uncensored.length < Math.max(14, series.length * 0.1)) {
    return fitDemand(series, opts);
  }

  return fitDemand(uncensored, opts);
}
