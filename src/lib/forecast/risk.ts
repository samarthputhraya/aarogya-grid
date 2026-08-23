import type { Drug, StockBatch, StockRisk, VedClass } from '@/lib/domain/types';
import type { DemandFit } from './croston';
import { horizonMultipliers } from './seasonality';
import { createRng, hashSeed } from '@/lib/rng';

/**
 * Stock-out risk and expiry-waste projection.
 *
 * WHY MONTE CARLO AND NOT A NORMAL APPROXIMATION
 * ----------------------------------------------
 * The textbook reorder point assumes lead-time demand is normally distributed.
 * For a PHC dispensing anti-snake venom a handful of times a year, that
 * assumption is badly wrong -- the true distribution has a large point mass at
 * zero and a long right tail, and a normal approximation will happily hand you
 * a negative reorder point or a service level that is nowhere near what you
 * asked for.
 *
 * So we simulate the compound Bernoulli process directly: each day either has
 * a demand or does not, and when it does the size is drawn from a gamma fitted
 * to the observed conditional mean and spread. Seasonality scales the size
 * day by day across the lead time, so a June reading is evaluated against June
 * demand rather than an annual average.
 */

/** How much a stock-out of this drug class actually hurts a patient. */
const VED_WEIGHT: Record<VedClass, number> = {
  V: 1.0, // Vital -- stock-out is a clinical emergency
  E: 0.7, // Essential
  D: 0.4, // Desirable
};

const DEFAULT_SIMULATIONS = 2000;

export interface RiskInput {
  facilityId: string;
  drug: Drug;
  fit: DemandFit;
  onHand: number;
  batches: StockBatch[];
  /** Replenishment lead time for this facility, in days. */
  leadTimeDays: number;
  /** How far ahead to project expiry waste. */
  horizonDays?: number;
  /** Evaluation date. */
  asOf: Date;
  /** Catchment population, used for exposure weighting. */
  population: number;
  /** Target cycle service level for the reorder point. */
  serviceLevel?: number;
  simulations?: number;
}

/** Draw a positive demand size with the given mean and sd, via a gamma. */
function drawSize(
  rng: ReturnType<typeof createRng>,
  mean: number,
  sd: number,
): number {
  if (mean <= 0) return 0;
  if (sd <= 0) return Math.max(1, Math.round(mean));
  const shape = (mean / sd) ** 2;
  const scale = sd ** 2 / mean;
  return Math.max(1, Math.round(rng.gamma(shape, scale)));
}

/**
 * Simulate cumulative demand over `days`, returning one sample per simulation.
 *
 * HOW SEASONALITY IS APPLIED
 * --------------------------
 * Seasonality shows up differently depending on the item, and getting this
 * wrong distorts the tail badly:
 *
 *   - For a RARE item (anti-snake venom), monsoon does not make each bite need
 *     more vials -- it makes bites happen more often. Seasonality belongs on
 *     the occurrence probability.
 *   - For a HIGH-VOLUME item (paracetamol), demand happens every working day
 *     regardless of season; what changes is how much goes out each day.
 *     Seasonality belongs on the demand size.
 *
 * So we route the multiplier by the fitted demand pattern. Either way the
 * expected demand is identical (p * mult * size = p * size * mult); only the
 * shape of the distribution differs -- and the shape is exactly what drives
 * the stock-out tail we are trying to estimate.
 *
 * When p * mult would exceed 1 the probability saturates, and the leftover
 * scaling spills into the size term so the mean is still preserved.
 */
function simulateHorizonDemand(
  fit: DemandFit,
  multipliers: number[],
  simulations: number,
  seed: number,
): number[] {
  const rng = createRng(seed);
  const samples: number[] = new Array(simulations);
  const p = fit.demandProbability;
  const scaleOccurrence = fit.pattern === 'intermittent' || fit.pattern === 'lumpy';

  // Precompute the per-day (probability, size multiplier) pair once rather than
  // per simulation -- this loop runs simulations * leadTimeDays times.
  const day = multipliers.map((mult) => {
    if (!scaleOccurrence) return { p, sizeMult: mult };
    const pScaled = Math.min(1, p * mult);
    const sizeMult = pScaled > 0 ? (p * mult) / pScaled : 1;
    return { p: pScaled, sizeMult };
  });

  for (let s = 0; s < simulations; s++) {
    let cum = 0;
    for (let d = 0; d < day.length; d++) {
      if (rng.bool(day[d].p)) {
        cum += drawSize(rng, fit.meanSize * day[d].sizeMult, fit.sigmaSize * day[d].sizeMult);
      }
    }
    samples[s] = cum;
  }
  return samples;
}

/**
 * Lead-time demand samples for one facility x drug pair.
 *
 * Exposed so the redistribution optimiser can draw the distribution ONCE and
 * then price many candidate transfer quantities against it. Re-running the
 * Monte Carlo for every (donor, receiver, quantity) triple it considers would
 * make the optimiser quadratic in simulation cost for no added accuracy --
 * the distribution does not change when we move stock, only the position we
 * evaluate it at does.
 */
export function leadTimeDemandSamples(
  facilityId: string,
  drug: Drug,
  fit: DemandFit,
  leadTimeDays: number,
  asOf: Date,
  simulations = DEFAULT_SIMULATIONS,
): number[] {
  if (fit.meanDemand <= 0 || fit.demandProbability <= 0) return new Array(simulations).fill(0);
  const multipliers = horizonMultipliers(drug.seasonality, asOf, Math.max(1, leadTimeDays));
  const seed = hashSeed(facilityId, drug.id, asOf.toISOString().slice(0, 10));
  return simulateHorizonDemand(fit, multipliers, simulations, seed);
}

/**
 * Expected units of demand left unmet if we hold `onHand` against these samples.
 * Averaged over ALL samples, so runs that met demand contribute zero.
 */
export function expectedShortfall(samples: number[], onHand: number): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const s of samples) {
    if (s > onHand) total += s - onHand;
  }
  return total / samples.length;
}

/** Fraction of samples that exceed `onHand`. */
export function stockoutProbabilityAt(samples: number[], onHand: number): number {
  if (samples.length === 0) return 0;
  let n = 0;
  for (const s of samples) if (s > onHand) n++;
  return n / samples.length;
}

/** Empirical quantile of an unsorted sample. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Project how many units will expire unused inside the horizon.
 *
 * Consumption is applied first-expiry-first-out, which is what a well-run
 * store actually does, so this measures avoidable waste rather than the raw
 * expiring quantity. Waste found here is what makes a transfer worth its
 * transport cost -- moving stock that would otherwise be written off is
 * strictly better than moving stock that would have been used anyway.
 */
export function projectExpiryWaste(
  batches: StockBatch[],
  dailyDemand: number,
  multipliers: number[],
  asOf: Date,
): number {
  const remaining = batches
    .map((b) => ({ expiry: new Date(b.expiryDate + 'T00:00:00Z').getTime(), qty: b.quantity }))
    .filter((b) => b.qty > 0)
    .sort((a, b) => a.expiry - b.expiry);

  let waste = 0;
  const cursor = new Date(asOf.getTime());

  for (let d = 0; d < multipliers.length; d++) {
    const today = cursor.getTime();

    // Anything that reached its expiry date with stock still on it is waste.
    for (const b of remaining) {
      if (b.qty > 0 && b.expiry <= today) {
        waste += b.qty;
        b.qty = 0;
      }
    }

    // Consume the day, earliest expiry first.
    let need = dailyDemand * multipliers[d];
    for (const b of remaining) {
      if (need <= 0) break;
      if (b.qty <= 0) continue;
      const take = Math.min(b.qty, need);
      b.qty -= take;
      need -= take;
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return Math.round(waste);
}

/**
 * Composite 0-100 risk score.
 *
 * This is a decision-support ranking, not a probability. It blends three
 * things a district officer weighs implicitly: how likely the stock-out is,
 * how bad it is clinically if it happens, and how many people are exposed.
 * Keeping the three factors separate and visible is deliberate -- an officer
 * who disagrees with the weighting can see exactly which term to argue with.
 */
export function scoreRisk(
  stockoutProbability: number,
  ved: VedClass,
  population: number,
): number {
  const criticality = VED_WEIGHT[ved];
  // Log-scaled exposure: a CHC serving 120k outranks a sub-centre serving 5k,
  // but not by 24x -- the marginal patient matters less as the catchment grows.
  const exposure = Math.min(1, Math.log10(Math.max(population, 1) + 10) / Math.log10(500_000));
  const score = 100 * stockoutProbability * criticality * (0.65 + 0.35 * exposure);
  return Math.round(Math.min(100, Math.max(0, score)));
}

export function severityOf(score: number): StockRisk['severity'] {
  if (score >= 65) return 'critical';
  if (score >= 40) return 'high';
  if (score >= 18) return 'moderate';
  return 'low';
}

export function computeStockRisk(input: RiskInput): StockRisk {
  const {
    facilityId,
    drug,
    fit,
    onHand,
    batches,
    leadTimeDays,
    asOf,
    population,
    horizonDays = 90,
    serviceLevel = 0.95,
    simulations = DEFAULT_SIMULATIONS,
  } = input;

  const leadMultipliers = horizonMultipliers(drug.seasonality, asOf, Math.max(1, leadTimeDays));
  const horizonMults = horizonMultipliers(drug.seasonality, asOf, horizonDays);

  // Seasonally-adjusted mean daily demand over the lead time.
  const leadSeasonMean =
    leadMultipliers.reduce((a, b) => a + b, 0) / Math.max(1, leadMultipliers.length);
  const forecastDailyDemand = fit.meanDemand * leadSeasonMean;

  let stockoutProbability = 0;
  let reorderPoint = 0;
  let expectedShortfallUnits = 0;

  if (fit.meanDemand > 0 && fit.demandProbability > 0) {
    const seed = hashSeed(facilityId, drug.id, asOf.toISOString().slice(0, 10));
    const samples = simulateHorizonDemand(fit, leadMultipliers, simulations, seed);
    let exceed = 0;
    let shortfall = 0;
    for (const s of samples) {
      if (s > onHand) {
        exceed++;
        shortfall += s - onHand;
      }
    }
    stockoutProbability = exceed / samples.length;
    // Mean over ALL samples, not just the ones that breached -- this is the
    // expected shortfall, so runs that met demand contribute a zero.
    expectedShortfallUnits = shortfall / samples.length;

    const sorted = [...samples].sort((a, b) => a - b);
    reorderPoint = Math.ceil(quantile(sorted, serviceLevel));
  }

  const daysOfCover =
    forecastDailyDemand > 0 ? onHand / forecastDailyDemand : Number.POSITIVE_INFINITY;

  const projectedExpiryWaste = projectExpiryWaste(batches, fit.meanDemand, horizonMults, asOf);

  const riskScore = scoreRisk(stockoutProbability, drug.ved, population);

  return {
    facilityId,
    drugId: drug.id,
    onHand,
    forecastDailyDemand,
    demandSigma: fit.sigma,
    daysOfCover,
    leadTimeDays,
    reorderPoint,
    stockoutProbability,
    expectedShortfallUnits,
    projectedExpiryWaste,
    riskScore,
    severity: severityOf(riskScore),
  };
}
