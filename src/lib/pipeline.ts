import type { Facility } from '@/lib/domain/types';
import { formularyFor, type CatalogueDrug } from '@/lib/domain/drugs';
import { DISTRICTS_BY_CODE } from '@/lib/domain/geo';
import { generateNetwork, facilityLeadTime, DEMO_SCALE, type NetworkScale } from '@/lib/sim/facilities';
import { simulateInventory, type InventorySimResult } from '@/lib/sim/inventory';
import { fitDemandCensored, type DemandFit } from '@/lib/forecast/croston';
import { computeStockRisk } from '@/lib/forecast/risk';
import {
  districtForecast,
  facilityShares,
  scaleForecast,
  uncensoredMean,
  seriesId,
  FORECAST_CONTEXT_DAYS,
  type DailyForecast,
  type ForecastCache,
  type ForecastMethodMap,
  type ForecastSource,
} from '@/lib/forecast/timesfm';
import type { StockRisk } from '@/lib/domain/types';
import type { TransferContext } from '@/lib/optimize/redistribute';

/**
 * The end-to-end pipeline: facilities -> simulated ledger -> demand fit ->
 * risk -> transfer contexts.
 *
 * This is the seam where a real deployment swaps in real data. Everything
 * downstream consumes `FacilityDrugState`, so replacing `simulateInventory`
 * with a DVDMS/e-Aushadhi extract and `generateNetwork` with an ABDM Health
 * Facility Registry pull changes this file and nothing else.
 *
 * Note the pipeline fits demand with `fitDemandCensored`, not `fitDemand`. That
 * is the production-correct choice: the ledger it reads is censored by
 * stock-outs. Measured effect, from `scripts/eval-censoring.mts`: overall
 * forecast bias goes from -3.8% to -1.0%, and in the worst-served ("disrupted")
 * districts from -10.0% to -2.6% -- a 7.4 percentage point absolute change,
 * concentrated exactly where being wrong is most expensive.
 *
 * The correction is listwise deletion of stocked-out periods, not imputation of
 * the demand that went unrecorded. That is a deliberate, conservative choice:
 * stock-outs are missing-not-at-random, so imputing them requires assumptions we
 * cannot defend on this data. Deletion removes most of the bias without
 * inventing any of it.
 */

export interface PipelineConfig {
  asOf: Date;
  historyDays?: number;
  seed?: number;
  scale?: NetworkScale;
  /** Monte Carlo draws per risk evaluation. Lower for national sweeps. */
  simulations?: number;
  /** Restrict the formulary, e.g. to a single tracer drug for a fast sweep. */
  drugFilter?: (d: CatalogueDrug) => boolean;
  /**
   * The committed TimesFM cache, INJECTED rather than imported.
   *
   * It is ~3 MB, and a static JSON import is inlined into every route that
   * transitively imports it. Passing it in keeps it out of every bundle and out
   * of the reach of anything that does not need it -- the site reads the
   * snapshot this pipeline writes, never the cache itself.
   *
   * Absent (or `AAROGYA_NO_BQ=1`) means every position falls back to Croston,
   * which is a supported path and is checked in the build.
   */
  forecastCache?: ForecastCache | null;
  /**
   * Which demand classes TimesFM is allowed to serve, from the backtest.
   *
   * Absent means "TimesFM wherever the cache has it". Present means the measured
   * per-class winner decides, so a class where Croston held its own keeps it.
   */
  forecastMethod?: ForecastMethodMap | null;
  /**
   * Corrections committed since the batch job ran.
   *
   * THE SEAM THE README ALREADY PROMISES. This is applied between
   * `simulateInventory` and `computeStockRisk`, which is precisely where a real
   * deployment's live DVDMS read would land: the simulator stands in for the
   * ledger, and anything more recent than the ledger overrides it. Six lines,
   * and it is what makes a spoken stock report change a risk score without a
   * rebuild.
   */
  overlay?: (facilityId: string, drugId: string) => { onHand?: number };
}

export interface FacilityDrugState {
  facility: Facility;
  drug: CatalogueDrug;
  fit: DemandFit;
  risk: StockRisk;
  leadTimeDays: number;
  sim: InventorySimResult;
  /** Which model produced the demand path this position's risk was scored against. */
  forecastSource: ForecastSource;
  /** This facility's share of its district's forecast, when one was used. */
  forecast?: DailyForecast;
  /** Share of the district's demand for this drug, 0..1. Null on the Croston path. */
  districtShare?: number;
  /** True when a committed report, not the ledger, supplied `onHand`. */
  overlaid?: boolean;
}

const DEFAULTS = {
  historyDays: 365,
  seed: 20260930,
  simulations: 1200,
};

/**
 * One position, before its risk has been scored.
 *
 * The pipeline runs in two passes because a facility's forecast cannot be known
 * until every facility in its district has been simulated: TimesFM forecasts the
 * DISTRICT total, and splitting that across facilities needs all of their demand
 * levels at once. Pass one simulates and fits; pass two scores.
 *
 * This costs nothing in memory -- `FacilityDrugState` already retains every
 * `sim`, so the whole set was being held to the end of the call regardless.
 */
interface PendingPosition {
  facility: Facility;
  drug: CatalogueDrug;
  sim: InventorySimResult;
  fit: DemandFit;
  leadTimeDays: number;
  /** Mean demand over days this facility could actually have dispensed. */
  demandLevel: number;
}

/**
 * Run the pipeline over an explicit set of facilities.
 *
 * NOTE ON SCOPE: the facilities passed in are treated as the COMPLETE network
 * for their districts, because district forecast shares are normalised across
 * them. Every caller builds its set with `generateNetwork` over whole districts,
 * which satisfies that; handing this function a partial district would inflate
 * each surviving facility's share of the district's demand.
 */
export function buildStates(
  facilities: Facility[],
  config: PipelineConfig,
): FacilityDrugState[] {
  const cfg = { ...DEFAULTS, ...config };

  // ---- Pass 1: simulate the ledger and fit demand -------------------------
  const pending: PendingPosition[] = [];

  for (const facility of facilities) {
    let formulary = formularyFor(facility.type);
    if (cfg.drugFilter) formulary = formulary.filter(cfg.drugFilter);
    const leadTimeDays = facilityLeadTime(facility);

    for (const drug of formulary) {
      const sim = simulateInventory(facility, drug, {
        asOf: cfg.asOf,
        historyDays: cfg.historyDays,
        seed: cfg.seed,
      });

      // The forecast only ever sees the censored ledger, exactly as in production.
      const fit = fitDemandCensored(sim.recordedSeries, sim.censoredMask);

      pending.push({
        facility,
        drug,
        sim,
        fit,
        leadTimeDays,
        // Measured over the same 90-day window TimesFM read, so the share
        // describes the same period as the forecast it is splitting.
        demandLevel: uncensoredMean(sim.recordedSeries, sim.censoredMask, FORECAST_CONTEXT_DAYS),
      });
    }
  }

  // ---- Disaggregate each district forecast across its facilities -----------
  const forecasts = new Map<PendingPosition, DailyForecast>();
  const shares = new Map<PendingPosition, number>();

  if (cfg.forecastCache) {
    const groups = new Map<string, PendingPosition[]>();
    for (const p of pending) {
      const key = seriesId(p.facility.districtCode, p.drug.id);
      const group = groups.get(key);
      if (group) group.push(p);
      else groups.set(key, [p]);
    }

    for (const [, members] of groups) {
      const first = members[0];
      const district = districtForecast(
        cfg.forecastCache,
        first.facility.districtCode,
        first.drug.id,
      );
      // No cached forecast for this series: the whole group stays on Croston.
      // Recorded per position via `forecastSource`, not assumed away.
      if (!district) continue;

      const split = facilityShares(members.map((m) => m.demandLevel));
      members.forEach((m, i) => {
        forecasts.set(m, scaleForecast(district, split[i]));
        shares.set(m, split[i]);
      });
    }
  }

  // ---- Pass 2: score risk against whichever demand path applies -----------
  const out: FacilityDrugState[] = [];

  for (const p of pending) {
    // The backtest decides per demand class, and the class is this facility's
    // own `fit.pattern` -- the series whose accuracy was actually measured.
    const allowed = !cfg.forecastMethod || cfg.forecastMethod[p.fit.pattern] === 'timesfm';
    const forecast = allowed ? forecasts.get(p) : undefined;

    // A committed report is more recent than the ledger, so it wins.
    const override = cfg.overlay?.(p.facility.id, p.drug.id);
    const onHand = typeof override?.onHand === 'number' ? override.onHand : p.sim.onHand;

    const risk = computeStockRisk({
      facilityId: p.facility.id,
      drug: p.drug,
      fit: p.fit,
      onHand,
      batches: p.sim.batches,
      leadTimeDays: p.leadTimeDays,
      asOf: cfg.asOf,
      population: p.facility.population,
      simulations: cfg.simulations,
      forecast,
    });

    out.push({
      facility: p.facility,
      drug: p.drug,
      fit: p.fit,
      risk,
      leadTimeDays: p.leadTimeDays,
      sim: p.sim,
      forecastSource: forecast ? 'timesfm' : 'croston',
      forecast,
      districtShare: forecast ? shares.get(p) : undefined,
      overlaid: override?.onHand !== undefined,
    });
  }

  return out;
}

/** Build the full state for one district. */
export function buildDistrictState(
  districtCode: string,
  config: PipelineConfig,
): FacilityDrugState[] {
  const district = DISTRICTS_BY_CODE[districtCode];
  if (!district) throw new Error('Unknown district code: ' + districtCode);
  const network = generateNetwork(config.scale ?? DEMO_SCALE, [district], config.seed ?? DEFAULTS.seed);
  return buildStates(network, config);
}

/** Adapt pipeline output into the shape the optimiser consumes. */
export function toTransferContexts(states: FacilityDrugState[]): TransferContext[] {
  return states.map((s) => ({
    facility: s.facility,
    drug: s.drug,
    fit: s.fit,
    risk: s.risk,
    batches: s.sim.batches,
    leadTimeDays: s.leadTimeDays,
    // Carried through so the planner prices transfers against the SAME demand
    // distribution the risk score came from. Without it the optimiser would
    // re-derive lead-time demand from Croston alone and size a transfer against
    // a different world than the one that flagged the shortage.
    forecast: s.forecast,
  }));
}

/** Roll facility-level risk up to a single district indicator. */
export interface DistrictSummary {
  districtCode: string;
  districtName: string;
  stateCode: string;
  stateName: string;
  lat: number;
  lon: number;
  facilities: number;
  trackedPositions: number;
  criticalPositions: number;
  highPositions: number;
  /** Population-weighted mean risk score, 0..100. */
  meanRiskScore: number;
  /** Share of tracked positions currently at zero stock. */
  zeroStockShare: number;
  expectedShortfallUnits: number;
  projectedWasteInr: number;
}

export function summariseDistrict(states: FacilityDrugState[]): DistrictSummary {
  const first = states[0];
  const district = DISTRICTS_BY_CODE[first.facility.districtCode];

  const facilities = new Set(states.map((s) => s.facility.id)).size;
  let critical = 0;
  let high = 0;
  let zero = 0;
  let shortfall = 0;
  let wasteInr = 0;
  let weightedRisk = 0;
  let weight = 0;

  for (const s of states) {
    if (s.risk.severity === 'critical') critical++;
    else if (s.risk.severity === 'high') high++;
    if (s.risk.onHand === 0) zero++;
    shortfall += s.risk.expectedShortfallUnits;
    wasteInr += s.risk.projectedExpiryWaste * s.drug.unitCostInr;
    const w = Math.max(1, s.facility.population);
    weightedRisk += s.risk.riskScore * w;
    weight += w;
  }

  return {
    districtCode: district.code,
    districtName: district.name,
    stateCode: district.stateCode,
    stateName: district.stateName,
    lat: district.lat,
    lon: district.lon,
    facilities,
    trackedPositions: states.length,
    criticalPositions: critical,
    highPositions: high,
    meanRiskScore: weight > 0 ? +(weightedRisk / weight).toFixed(1) : 0,
    zeroStockShare: states.length > 0 ? +(zero / states.length).toFixed(4) : 0,
    expectedShortfallUnits: +shortfall.toFixed(1),
    projectedWasteInr: Math.round(wasteInr),
  };
}
