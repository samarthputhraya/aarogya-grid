import type { Facility } from '@/lib/domain/types';
import { formularyFor, type CatalogueDrug } from '@/lib/domain/drugs';
import { DISTRICTS_BY_CODE } from '@/lib/domain/geo';
import { generateNetwork, facilityLeadTime, DEMO_SCALE, type NetworkScale } from '@/lib/sim/facilities';
import { simulateInventory, type InventorySimResult } from '@/lib/sim/inventory';
import { fitDemandCensored, type DemandFit } from '@/lib/forecast/croston';
import { computeStockRisk } from '@/lib/forecast/risk';
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
}

export interface FacilityDrugState {
  facility: Facility;
  drug: CatalogueDrug;
  fit: DemandFit;
  risk: StockRisk;
  leadTimeDays: number;
  sim: InventorySimResult;
}

const DEFAULTS = {
  historyDays: 365,
  seed: 20260930,
  simulations: 1200,
};

/** Run the pipeline over an explicit set of facilities. */
export function buildStates(
  facilities: Facility[],
  config: PipelineConfig,
): FacilityDrugState[] {
  const cfg = { ...DEFAULTS, ...config };
  const out: FacilityDrugState[] = [];

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

      const risk = computeStockRisk({
        facilityId: facility.id,
        drug,
        fit,
        onHand: sim.onHand,
        batches: sim.batches,
        leadTimeDays,
        asOf: cfg.asOf,
        population: facility.population,
        simulations: cfg.simulations,
      });

      out.push({ facility, drug, fit, risk, leadTimeDays, sim });
    }
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
