import type { DistrictSummary } from '@/lib/pipeline';
import type { DistrictResourceRollup } from '@/lib/domain/resources';

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

/**
 * The district resource picture as it travels in the snapshot.
 *
 * An alias, not a redeclaration: a parallel interface listing the same
 * twenty-odd fields would be a second place to forget to add one, and the first
 * field that existed on only one of them would be a district page and a
 * national page quoting different occupancy rates out of the same build. The
 * alias exists purely so consumers can name the snapshot-side type without
 * importing the simulator's vocabulary.
 */
export type DistrictResourceSnapshot = DistrictResourceRollup;

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
  /**
   * Beds and workforce for this district.
   *
   * Carried on the same row as the stock figures, not in a parallel snapshot,
   * because the whole argument of this layer is that they are one picture: the
   * `facilitiesWithoutPharmacist` count on this object is the reason the
   * `zeroStockShare` next to it deserves an error bar.
   */
  resources: DistrictResourceSnapshot;
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
  // --- resource layer, summed across the state's districts ---
  functionalBeds: number;
  occupiedBeds: number;
  /** occupiedBeds / functionalBeds. Recomputed from the sums, never averaged from rates. */
  bedOccupancyRate: number;
  staffSanctioned: number;
  staffInPosition: number;
  staffPresent: number;
  vacancyRate: number;
  absenteeismRate: number;
  facilitiesWithoutPharmacist: number;
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

  /**
   * The two resources the challenge names alongside medicines, at national
   * scale. Kept in the same totals object rather than a sibling one: a
   * ministry-facing summary that reported drugs, beds and people from three
   * different objects would be three reports, and the entire point of a
   * federated platform is that it is one.
   */
  sanctionedBeds: number;
  functionalBeds: number;
  /** Functional beds today's present nursing establishment can actually cover. */
  staffedBeds: number;
  occupiedBeds: number;
  bedOccupancyRate: number;
  /** Facilities at or above 95% of functional bed strength. */
  facilitiesAtCapacity: number;
  /** Patient-days of admission demand that arrived and found no bed, over the occupancy window. */
  unmetBedDays: number;
  staffSanctioned: number;
  staffInPosition: number;
  staffPresent: number;
  vacancyRate: number;
  absenteeismRate: number;
  specialistSanctioned: number;
  specialistInPosition: number;
  /** Stock-holding facilities with no pharmacist in position to keep the register. */
  facilitiesWithoutPharmacist: number;
  facilitiesWithoutMedicalOfficer: number;
  subCentresWithoutAnm: number;
  facilitiesUnverifiedReporting: number;
  /** Catchment served by a facility whose stock figures nobody is in position to verify. */
  populationUnderUnverifiedReporting: number;
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
