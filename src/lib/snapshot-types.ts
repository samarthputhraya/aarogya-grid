import type { DistrictSummary } from '@/lib/pipeline';

/**
 * Shape of the precomputed national snapshot.
 *
 * WHY PRECOMPUTE
 * --------------
 * Evaluating one district -- simulating a year of ledger for ~630 stock
 * positions, fitting demand, and running Monte Carlo risk on each -- takes
 * about 1.5 seconds. Doing that for 128 districts on every page load would make
 * the national view unusable.
 *
 * So the national roll-up is built ahead of time by `scripts/build-snapshot.ts`
 * and served as static data, while district and facility views compute on
 * demand. That is also how this would work against real data: a nightly batch
 * job writes the national picture, and drill-downs query live.
 */

export interface DistrictSnapshot extends DistrictSummary {
  /** Modelled district supply reliability, 0..1. */
  reliability: number;
  /** How demand-driven (vs norm-based push) allocation is here, 0..1. */
  pullFraction: number;
  /** Modelled catchment population. */
  population: number;
  // Redistribution opportunity found in this district.
  transfers: number;
  transportCostInr: number;
  wasteAvertedInr: number;
  shortfallAverted: number;
  netBenefitInr: number;
}

export interface StateSnapshot {
  stateCode: string;
  stateName: string;
  abbr: string;
  districts: number;
  facilities: number;
  trackedPositions: number;
  criticalPositions: number;
  meanRiskScore: number;
  zeroStockShare: number;
  projectedWasteInr: number;
  netBenefitInr: number;
  population: number;
}

/** One high-risk stock position, denormalised for direct rendering. */
export interface AlertRow {
  facilityId: string;
  facilityName: string;
  facilityType: string;
  districtCode: string;
  districtName: string;
  stateName: string;
  lat: number;
  lon: number;
  population: number;
  drugId: string;
  drugName: string;
  drugStrength: string;
  unit: string;
  ved: string;
  onHand: number;
  daysOfCover: number;
  leadTimeDays: number;
  stockoutProbability: number;
  expectedShortfallUnits: number;
  riskScore: number;
  severity: string;
}

export interface NationalTotals {
  districts: number;
  states: number;
  facilities: number;
  trackedPositions: number;
  criticalPositions: number;
  highPositions: number;
  zeroStockPositions: number;
  populationCovered: number;
  expectedShortfallUnits: number;
  projectedWasteInr: number;
  transfers: number;
  transportCostInr: number;
  wasteAvertedInr: number;
  shortfallAverted: number;
  netBenefitInr: number;
}

export interface NationalSnapshot {
  /** Evaluation date the whole snapshot is computed against. */
  asOf: string;
  /** When the snapshot was built. */
  builtAt: string;
  /** Facilities generated per district, so the sample size is always visible. */
  scale: { chcPerDistrict: number; phcPerDistrict: number; scPerDistrict: number };
  /** Seconds the build took -- quoted in the deployability argument. */
  buildSeconds: number;
  totals: NationalTotals;
  districts: DistrictSnapshot[];
  states: StateSnapshot[];
  alerts: AlertRow[];
}
