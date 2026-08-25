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
 * So the national roll-up is built ahead of time by `scripts/build-snapshot.mts`
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
   * Vehicle movements behind `transfers`.
   *
   * Orders between the same two facilities travel together, so `transfers` is
   * what a storekeeper picks and `trips` is what the transport budget pays for.
   * The planner used to charge a separate vehicle per order per drug.
   */
  trips: number;
  /** Trips whose two ends sit in different districts. */
  crossDistrictTrips: number;
  /** Orders carried on a cross-district trip. */
  crossDistrictOrders: number;
  /** Orders admitted only because a vehicle was already going. */
  rideAlongOrders: number;
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
  /** Vehicle movements nationally. Always <= `transfers`. */
  trips: number;
  /** Trips crossing a district boundary -- the clause the brief asks for. */
  crossDistrictTrips: number;
  /** Orders carried on those trips. */
  crossDistrictOrders: number;
  /**
   * Orders served only because a vehicle was already going to that facility.
   *
   * These are needs the benefit/cost gate declined on their own and that were
   * then filled for the price of picking and handling. The count of stock-outs
   * that were being refused for a truck nobody needed to hire.
   */
  rideAlongOrders: number;
  /**
   * What the same orders would have cost billed one dedicated vehicle each --
   * the model this build replaced. Kept so the saving is a subtraction the
   * reader can do rather than a claim they have to accept.
   */
  unconsolidatedCostInr: number;

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

/**
 * One district-to-district flow, aggregated over every order between them.
 *
 * The national map draws these. Per-order arcs would be thousands of lines
 * between facility coordinates nobody can read at national zoom; a district
 * pair is the unit at which "medicine moved from here to there" is legible,
 * and it is the unit the brief's "cross-district redistribution" is written in.
 *
 * Directional on purpose. A pair that supplies in both directions is two rows,
 * because a corridor that only ever flows one way is a different finding from
 * one that balances.
 */
export interface CrossDistrictLink {
  fromDistrictCode: string;
  fromDistrictName: string;
  fromStateCode: string;
  fromLat: number;
  fromLon: number;
  toDistrictCode: string;
  toDistrictName: string;
  toStateCode: string;
  toLat: number;
  toLon: number;
  /** Vehicle movements between the two districts. */
  trips: number;
  /** Dispatch orders carried on them. */
  orders: number;
  /** Units of medicine moved. */
  units: number;
  transportCostInr: number;
  /** Expected units of unmet demand these orders prevent. */
  shortfallAvertedUnits: number;
  /** True when the two districts sit in different states. */
  crossState: boolean;
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
  /**
   * Every district-to-district flow the plan produced, largest first.
   *
   * The clause the challenge asks for, as data rather than as a claim: before
   * this existed, all 2,798 dispatch orders stayed inside the district that
   * raised them.
   */
  crossDistrictLinks: CrossDistrictLink[];
}
