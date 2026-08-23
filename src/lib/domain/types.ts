/**
 * Core domain model for Aarogya Grid.
 *
 * Vocabulary follows India's public health supply chain so that the model maps
 * 1:1 onto systems a ministry already runs (e-Aushadhi / DVDMS, HMIS, ABDM HFR).
 *
 * Supply chain tiers, top to bottom:
 *   State Medical Store  ->  District Warehouse (CMSD)  ->  CHC  ->  PHC  ->  Sub-Centre
 */

/** Facility tiers as defined by Indian Public Health Standards (IPHS). */
export type FacilityType =
  | 'SC' // Sub-Centre           ~5,000 population
  | 'PHC' // Primary Health Centre ~30,000 population
  | 'CHC' // Community Health Centre ~120,000 population
  | 'SDH' // Sub-District Hospital
  | 'DH' // District Hospital
  | 'DW'; // District Warehouse (stocking point, not a care delivery point)

/**
 * VED criticality — the classification Indian drug logistics actually uses.
 * Vital drugs are the ones where a stock-out is a clinical emergency, so they
 * dominate the risk score regardless of consumption volume.
 */
export type VedClass = 'V' | 'E' | 'D';

/** ABC value classification (Pareto on annual consumption value). */
export type AbcClass = 'A' | 'B' | 'C';

/**
 * Demand seasonality archetypes. Each maps to a 12-element monthly multiplier
 * curve in `seasonality.ts`. These are MODELLING ASSUMPTIONS derived from the
 * epidemiological calendar, not measured constants — they are the first thing
 * to be replaced when real HMIS consumption history is connected.
 */
export type SeasonalityProfile =
  | 'flat'
  | 'monsoon_vector' // malaria, dengue, chikungunya — rises with the monsoon
  | 'monsoon_envenomation' // snakebite — tracks monsoon + agricultural activity
  | 'summer_enteric' // diarrhoeal disease, ORS — summer and early monsoon
  | 'winter_respiratory' // ARI, asthma exacerbation — winter peak
  | 'summer_heat' // heat stroke, IV fluids — pre-monsoon peak
  | 'obstetric'; // deliveries — mild, near-flat seasonality

export interface Drug {
  /** Stable code; mirrors a state EDL / DVDMS item code. */
  id: string;
  name: string;
  /** Tablet, Injection, Syrup, Fluid, Consumable ... */
  form: string;
  strength: string;
  /** Therapeutic group, used for substitution and for roll-up reporting. */
  therapeuticGroup: string;
  /** Present on the National List of Essential Medicines. */
  nlem: boolean;
  ved: VedClass;
  /** Dispensing unit — the unit every quantity in the system is expressed in. */
  unit: string;
  shelfLifeMonths: number;
  seasonality: SeasonalityProfile;
  /** Indicative procurement cost per unit in INR. Used for ABC and for transfer economics. */
  unitCostInr: number;
  /** Cold chain items constrain which transfers are physically possible. */
  coldChain: boolean;
}

export interface Facility {
  /** ABDM Health Facility Registry ID where available, else a synthetic stable ID. */
  id: string;
  name: string;
  type: FacilityType;
  stateCode: string;
  stateName: string;
  districtCode: string;
  districtName: string;
  block?: string;
  lat: number;
  lon: number;
  /** Catchment population — drives baseline demand. */
  population: number;
  /**
   * Sanctioned bed strength, from the IPHS norm table in `./resources.ts`, and
   * a coarse free-bed count stamped into the registry record.
   *
   * These two fields are the FACILITY REGISTER's view of beds -- what an ABDM
   * Health Facility Registry record carries. The live picture (functional vs
   * sanctioned strength, ward mix, seasonal occupancy, and the admission demand
   * that exceeded capacity and so never appeared in any return) lives in
   * `BedState` and is produced by `@/lib/sim/resources`. When occupancy matters,
   * read that; these are the establishment figures it is measured against.
   */
  bedsSanctioned: number;
  bedsAvailable: number;
  /** The stocking point this facility draws replenishment from. */
  parentId: string | null;
  /**
   * Road distance in km to the parent stocking point. Real road distance beats
   * great-circle distance for transfer feasibility; we fall back to haversine
   * with a detour factor until a routing API is connected.
   */
  distanceToParentKm: number;
}

/** A physical batch of a drug held at a facility. Batches matter because expiry drives waste. */
export interface StockBatch {
  batchNo: string;
  quantity: number;
  /** ISO date. */
  expiryDate: string;
  receivedDate: string;
}

export interface StockPosition {
  facilityId: string;
  drugId: string;
  batches: StockBatch[];
  /** Sum of batch quantities — denormalised for query speed. */
  onHand: number;
  /** Units already committed to an inbound/outbound transfer. */
  committed: number;
  /** Last time this position was confirmed by a human or a device. */
  lastReportedAt: string | null;
  /**
   * How the last report arrived. This is a first-class field because data
   * provenance is the whole problem: a dashboard is only as good as the
   * last-mile reporting that feeds it.
   */
  lastReportSource: ReportSource | null;
}

export type ReportSource =
  | 'voice' // spoken report transcribed and structured by Gemini
  | 'photo_register' // photograph of the paper stock register, read by Gemini vision
  | 'whatsapp_text'
  | 'manual_web'
  | 'dvdms_sync' // pulled from an existing state DVDMS/e-Aushadhi instance
  | 'seed'; // generated by the simulator

/** One movement of stock. The append-only ledger the rest of the system derives from. */
export interface StockTransaction {
  id: string;
  facilityId: string;
  drugId: string;
  /** ISO date. */
  date: string;
  type: 'issue' | 'receipt' | 'adjustment' | 'expiry_writeoff' | 'transfer_in' | 'transfer_out';
  /** Positive for inbound, negative for outbound. */
  quantity: number;
  batchNo?: string;
  source: ReportSource;
}

/** Output of the forecasting engine for one facility x drug pair. */
export interface StockRisk {
  facilityId: string;
  drugId: string;
  onHand: number;
  /** Forecast mean daily demand over the planning horizon. */
  forecastDailyDemand: number;
  /** Standard deviation of daily demand — drives the safety stock. */
  demandSigma: number;
  /** onHand / forecastDailyDemand, capped. Infinity when demand is ~0. */
  daysOfCover: number;
  /** Replenishment lead time in days for this facility. */
  leadTimeDays: number;
  /** Reorder point = expected lead time demand + safety stock. */
  reorderPoint: number;
  /** Probability of hitting zero before replenishment lands. 0..1 */
  stockoutProbability: number;
  /**
   * Expected UNITS of demand that will go unmet before replenishment lands.
   *
   * This is the metric the optimiser actually spends against. Probability alone
   * cannot rank two facilities: a 40% chance of being 2 vials short is not the
   * same decision as a 40% chance of being 200 short, and a transfer should go
   * where it averts the most unmet demand per rupee of transport.
   */
  expectedShortfallUnits: number;
  /** Units expiring inside the horizon that will not be consumed — avoidable waste. */
  projectedExpiryWaste: number;
  /** Composite 0..100. Blends stock-out probability with VED criticality and population exposed. */
  riskScore: number;
  severity: 'critical' | 'high' | 'moderate' | 'low';
}

/**
 * One batch inside one dispatch order — the executable line of a stock
 * transfer note.
 *
 * A dispatch is carried out by a storekeeper against physical shelves. An order
 * that states a single total and names a single batch is not executable unless
 * that batch actually holds the total: the person holding the paper opens the
 * cupboard, finds fewer units under that batch number, and the transfer stalls
 * on a discrepancy nobody in the chain is authorised to resolve. Quantities are
 * therefore committed batch by batch, earliest expiry first.
 */
export interface TransferLine {
  batchNo: string;
  quantity: number;
  /** ISO date. */
  expiryDate: string;
  /** Days from the plan's as-of date to expiry — the FEFO ordering key. */
  daysToExpiry: number;
}

/** A single recommended physical movement of stock between two facilities. */
export interface TransferRecommendation {
  fromFacilityId: string;
  toFacilityId: string;
  drugId: string;
  quantity: number;
  /**
   * Earliest-expiring batch in the pick list (FEFO). Kept for callers that show
   * one batch number; `lines` is what a dispatch note must print, because a
   * single order may legitimately draw on more than one batch.
   */
  batchNo: string;
  /** Batch-by-batch pick list. Quantities sum to `quantity`. */
  lines: TransferLine[];
  distanceKm: number;
  estimatedCostInr: number;
  /** Units of avoidable expiry waste this transfer rescues. */
  wasteAvertedUnits: number;
  /** Reduction in the receiving facility's stock-out probability, 0..1. */
  riskReduction: number;
  /** Plain-language justification, safe to put in front of a district officer. */
  rationale: string;
}
