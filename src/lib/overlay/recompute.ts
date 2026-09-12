import { getFacilityById, facilitiesInDistrict } from '@/lib/facility-lookup';
import { formularyFor, DRUGS_BY_ID, type CatalogueDrug } from '@/lib/domain/drugs';
import { facilityLeadTime } from '@/lib/sim/facilities';
import { simulateInventory } from '@/lib/sim/inventory';
import { fitDemandCensored } from '@/lib/forecast/croston';
import { computeStockRisk } from '@/lib/forecast/risk';
import {
  districtForecast,
  facilityShares,
  scaleForecast,
  uncensoredMean,
  FORECAST_CONTEXT_DAYS,
  type ForecastCache,
  type ForecastMethodMap,
  type ForecastSource,
} from '@/lib/forecast/timesfm';
import type { Facility, StockRisk } from '@/lib/domain/types';

/**
 * Tier 1: re-score ONE position, synchronously, inside the request.
 *
 * WHY THIS IS ALLOWED TO BE SYNCHRONOUS
 * -------------------------------------
 * A whole district is 1.2 s of pipeline for 632 positions, so one facility is
 * 55-80 ms of that -- affordable inside a POST handler, and the difference
 * between "your report was received" and "your report changed the board". The
 * acceptance test for the day is that this lands under 100 ms.
 *
 * WHAT IT MUST AGREE WITH
 * -----------------------
 * The recomputed row has to be comparable with the one the nightly batch wrote,
 * or the console would show a jump caused by the code path rather than by the
 * report. So this reproduces the batch's arithmetic exactly: same seed, same
 * as-of, same censored fit, same district forecast, same per-class method gate.
 * The ONLY difference is `onHand`.
 *
 * THE FORECAST IS INJECTED, NOT IMPORTED
 * --------------------------------------
 * Same reason the pipeline injects it: the cache is 2.5 MB, and a module that
 * imports it cannot be pulled into anything that does not need it. Here it buys
 * one more thing -- testability. `runtime-forecast.ts` is marked `server-only`,
 * which throws outside a bundler, so a module that imported it could never be
 * exercised by a plain Node test. The route supplies the cache; the test
 * supplies whatever it wants to test against.
 *
 * WHY THE WHOLE DISTRICT IS SIMULATED FOR ONE DRUG
 * ------------------------------------------------
 * TimesFM forecasts the district, and a facility's share of it cannot be known
 * without the other facilities' demand levels. So every carrier of this one drug
 * in this one district is simulated -- about 22 sims, not 22 x 47 -- which is
 * what keeps a Tier-1 recompute inside its budget while still producing a share
 * identical to the batch's.
 */

export interface RecomputedPosition {
  facility: Facility;
  drug: CatalogueDrug;
  /** Risk at the newly reported on-hand. */
  risk: StockRisk;
  /** Risk at the ledger's on-hand, for a before/after the UI can show. */
  previousRisk: StockRisk;
  previousOnHand: number;
  forecastSource: ForecastSource;
  districtShare?: number;
  elapsedMs: number;
}

/** Must match `build-snapshot.mts`, or this scores a different world. */
const ASOF = new Date(Date.UTC(2026, 8, 30));
const SEED = 20260930;
const HISTORY_DAYS = 365;
/**
 * Draws for an interactive recompute.
 *
 * The batch uses 600 because it runs 128 times; this runs once, for one
 * position, while somebody waits. 1,200 halves the Monte Carlo noise on the
 * number that is about to be shown as a change, for about 20 ms.
 */
const SIMULATIONS = 1200;

export class UnknownFacilityError extends Error {}
export class UnstockedDrugError extends Error {}

export interface RecomputeForecast {
  cache: ForecastCache | null;
  /** Null means "TimesFM wherever the cache has it". */
  method: ForecastMethodMap | null;
}

/**
 * Re-score one facility x drug at a corrected on-hand.
 *
 * Throws rather than returning null for the two cases a caller must distinguish:
 * a facility that does not exist (a bad request) and a drug the facility has no
 * business holding (a resolver mistake worth surfacing, not silently accepting).
 */
export function recomputePosition(
  facilityId: string,
  drugId: string,
  onHand: number,
  forecastSetup: RecomputeForecast = { cache: null, method: null },
): RecomputedPosition {
  const started = Date.now();

  const facility = getFacilityById(facilityId);
  if (!facility) throw new UnknownFacilityError('Unknown facility: ' + facilityId);

  const formulary = formularyFor(facility.type);
  const drug = formulary.find((d) => d.id === drugId);
  if (!drug) {
    // `getDrug` THROWS on an id that is not in the catalogue at all, so naming
    // the drug has to be the guarded part rather than the happy path -- an
    // unknown id must surface as this typed error, not as a raw catalogue throw
    // that the route would turn into a 500.
    const known = DRUGS_BY_ID[drugId];
    throw new UnstockedDrugError(
      facility.name + ' (' + facility.type + ') does not stock ' + (known ? known.name : drugId),
    );
  }

  const leadTimeDays = facilityLeadTime(facility);
  const sim = simulateInventory(facility, drug, {
    asOf: ASOF,
    historyDays: HISTORY_DAYS,
    seed: SEED,
  });
  const fit = fitDemandCensored(sim.recordedSeries, sim.censoredMask);

  // The per-class gate the backtest decided, applied exactly as the batch does.
  const method = forecastSetup.method;
  const allowed = !method || method[fit.pattern] === 'timesfm';
  const district = allowed
    ? districtForecast(forecastSetup.cache, facility.districtCode, drug.id)
    : null;

  let forecast;
  let districtShare: number | undefined;

  if (district) {
    // Every carrier of this drug in the district, so the share matches the batch.
    const carriers = facilitiesInDistrict(facility.districtCode).filter((f) =>
      formularyFor(f.type).some((d) => d.id === drug.id),
    );
    const levels = carriers.map((f) => {
      if (f.id === facility.id) {
        return uncensoredMean(sim.recordedSeries, sim.censoredMask, FORECAST_CONTEXT_DAYS);
      }
      const other = simulateInventory(f, drug, {
        asOf: ASOF,
        historyDays: HISTORY_DAYS,
        seed: SEED,
      });
      return uncensoredMean(other.recordedSeries, other.censoredMask, FORECAST_CONTEXT_DAYS);
    });
    const split = facilityShares(levels);
    const mine = carriers.findIndex((f) => f.id === facility.id);
    districtShare = mine >= 0 ? split[mine] : 0;
    forecast = scaleForecast(district, districtShare);
  }

  const base = {
    facilityId: facility.id,
    drug,
    fit,
    batches: sim.batches,
    leadTimeDays,
    asOf: ASOF,
    population: facility.population,
    simulations: SIMULATIONS,
    forecast,
  };

  return {
    facility,
    drug,
    risk: computeStockRisk({ ...base, onHand }),
    previousRisk: computeStockRisk({ ...base, onHand: sim.onHand }),
    previousOnHand: sim.onHand,
    forecastSource: forecast ? 'timesfm' : 'croston',
    districtShare,
    elapsedMs: Date.now() - started,
  };
}
