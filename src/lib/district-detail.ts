import type { FacilityType, TransferLine, VedClass } from '@/lib/domain/types';
import type { FacilityDrugState } from '@/lib/pipeline';
import type { RedistributionPlan, UnservedNeed } from '@/lib/optimize/redistribute';
import type { AlertRow, DistrictSnapshot } from '@/lib/snapshot-types';
import { getDrug } from '@/lib/domain/drugs';
import { horizonMultipliers } from '@/lib/forecast/seasonality';
import { emptyReasonHistogram, type UnservedReasonHistogram } from '@/lib/optimize/redistribute';
import type {
  CadreStaffing,
  PressureLevel,
  ReportingClass,
  ResourceState,
} from '@/lib/domain/resources';

/**
 * The per-district payload the district console reads.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * `buildDistrictState` + `planRedistribution` already run for every district
 * inside `scripts/build-snapshot.mts`, and the batch job then throws almost all
 * of it away -- it persists `transfers: number` and nothing else. The most
 * differentiated output in the repo (the dispatch rationales, the per-batch
 * pick lists, the needs the optimiser declined and why) is computed 128 times
 * per build and discarded. This is the contract that stops that happening. It
 * adds no analytics: every number here is already in `states` or `plan`, and
 * emitting it is serialisation, not computation.
 *
 * WHY PRECOMPUTED AND NOT COMPUTED PER REQUEST
 * --------------------------------------------
 * One district costs ~1.5 s of pipeline plus ~150 ms of solver. The pipeline is
 * deterministic (fixed seed, fixed as-of), so a request-time recompute would
 * produce byte-identical numbers for 1.7 s of latency and a Node process in the
 * request path. Precomputing buys the identical answer with a `readFile`.
 *
 * WHY ONE FILE PER DISTRICT
 * -------------------------
 * A static `import` of a combined file would be inlined into every one of the
 * 128 prerendered routes, so a single 4-5 MB bundle becomes 4-5 MB in each HTML
 * file. The page reads its own district's file from disk at build time instead.
 * That constraint is why the emitter below writes one `DistrictDetail`, not a
 * dictionary of them.
 *
 * DENORMALISATION IS DELIBERATE
 * -----------------------------
 * Same discipline as `AlertRow`: names, tiers, units and coordinates travel
 * alongside the ids, so the client joins nothing. The catalogue and the
 * facility network are both derivable in the browser, but making the UI derive
 * them means shipping the simulator to the browser to render a table.
 */

/**
 * One batch inside one dispatch order.
 *
 * Aliased rather than redeclared: `TransferLine` is what the optimiser
 * physically commits against a donor's shelves, and a district console that
 * printed a different shape would be printing a different promise. Two
 * definitions of the same row is exactly how a pick list and a plan drift
 * apart.
 */
export type DispatchLine = TransferLine;

/**
 * One executable stock transfer note.
 *
 * This is the artefact the whole route exists to put on screen. Everything an
 * officer needs to act -- who ships, who receives, how far, what it costs, which
 * batches come off which shelf, and the sentence explaining why -- is on this
 * object, because the alternative is a dashboard that shows a problem and names
 * no action.
 */
export interface DispatchOrder {
  /** Stable within a district: one order per donor x receiver x drug. */
  id: string;
  from: DispatchEndpoint;
  to: DispatchEndpoint;
  drugId: string;
  drugName: string;
  drugStrength: string;
  unit: string;
  ved: VedClass;
  coldChain: boolean;
  quantity: number;
  /** Batch-by-batch pick list. Quantities sum to `quantity`. */
  lines: DispatchLine[];
  distanceKm: number;
  estimatedCostInr: number;
  wasteAvertedUnits: number;
  /** Fall in the receiver's stock-out probability, 0..1. */
  riskReduction: number;
  /**
   * The receiver's position BEFORE the transfer, carried so the card can show
   * before/after without the client recomputing risk. Pass-2 (expiry rescue)
   * orders legitimately have a healthy receiver -- that pass moves dying stock
   * to whoever will consume it, not to whoever is short.
   */
  receiverOnHandBefore: number;
  receiverStockoutProbBefore: number;
  /** Verbatim from the optimiser. Never re-templated here -- see below. */
  rationale: string;
}

export interface DispatchEndpoint {
  id: string;
  name: string;
  type: FacilityType;
  lat: number;
  lon: number;
}

/**
 * A stock position, in the same shape the national alert board already renders.
 *
 * Extending `AlertRow` rather than defining a parallel row means the two boards
 * cannot disagree about what a row is, and the national table component drops
 * onto the district page unchanged. The extra fields are the ones that only
 * make sense at district scale, where the reader is the person who actually
 * places the indent: the reorder point they are being measured against, the
 * demand rate behind it, and how much of the history was censored by stock-outs
 * (which is the honest caveat on every forecast in the table).
 */
export interface PositionRow extends AlertRow {
  reorderPoint: number;
  forecastDailyDemand: number;
  demandPattern: string;
  forecastMethod: string;
  /** Days in the 365-day ledger where the shelf closed at zero. */
  censoredDays: number;
  projectedExpiryWaste: number;
}

/** One facility in the district, rolled up across its whole formulary. */
export interface FacilityRow {
  id: string;
  name: string;
  type: FacilityType;
  lat: number;
  lon: number;
  population: number;
  parentId: string | null;
  distanceToParentKm: number;
  leadTimeDays: number;
  positions: number;
  criticalPositions: number;
  zeroStockPositions: number;
  meanRiskScore: number;
}

/**
 * One position's full 365-day history, for the single forecast chart.
 *
 * Exactly one of these is emitted per district, and that is a size decision as
 * much as an editorial one: three 365-element arrays is roughly as much JSON as
 * the entire dispatch order list, so this does not scale to "a chart per row".
 * One well-chosen position demonstrates intermittent-demand fitting, censoring,
 * the Monte Carlo reorder point and seasonality in a single figure; a hundred
 * of them demonstrate nothing and cost 100x.
 */
export interface SeriesProbe {
  facilityId: string;
  facilityName: string;
  drugId: string;
  drugName: string;
  unit: string;
  /** Daily recorded issues -- what the forecaster saw, stock-outs and all. */
  recorded: number[];
  /** Per-day censoring flag, aligned to `recorded`. */
  censored: boolean[];
  /**
   * Modelled on-hand path. Not emitted today: `InventorySimResult` keeps the
   * closing batches, not the daily balance, and reconstructing it here would be
   * a second implementation of the simulator's FEFO logic that could silently
   * disagree with the first. Declared so a future emitter has a place to put it.
   */
  onHandPath?: number[];
  fittedDailyDemand: number;
  reorderPoint: number;
  onHand: number;
  leadTimeDays: number;
  /** Forward seasonal multipliers, one per day, for the shaded band. */
  seasonalMultipliers: number[];
}

/** Plan economics for one district -- the honest version, cost included. */
export interface DistrictEconomics {
  transfers: number;
  transportCostInr: number;
  wasteAvertedUnits: number;
  wasteAvertedInr: number;
  shortfallAvertedUnits: number;
  /**
   * Benefit minus cost, INR. Shown, but the UI must label it policy-weighted:
   * the benefit term values a unit of averted Vital shortage at 25x its price
   * (`DEFAULT_SHORTAGE_PENALTY` in `redistribute.ts`), which is a ministry dial,
   * not a measurement. Quoted as cash it is not defensible; quoted as what it
   * is, it is the most interesting number on the page.
   */
  netBenefitInr: number;
  unservedReceivers: number;
  /** transfers / (transfers + unservedReceivers). The denominator, on screen. */
  coverageShare: number;
  reasonHistogram: UnservedReasonHistogram;
}

/**
 * One facility's bed and workforce position, denormalised for direct rendering.
 *
 * Same discipline as `FacilityRow` above -- and deliberately a SEPARATE row
 * rather than more columns on that one. `FacilityRow` answers "how bad is this
 * facility's stock?" and is joined to the position table; this answers "what
 * does this facility physically have -- beds, and people?" and is joined to
 * nothing. Merging them would force every consumer of the stock roster to carry
 * the workforce establishment, and force the resource panel to carry risk
 * scores it does not render.
 *
 * The cadre breakdown travels inline because it is the whole finding: a single
 * "12 of 20 posts filled" hides that the twelve are nurses and the eight are
 * the specialists that make it a referral unit.
 */
export interface ResourceFacilityRow {
  id: string;
  name: string;
  type: FacilityType;
  lat: number;
  lon: number;
  population: number;

  // --- beds ---
  sanctionedBeds: number;
  /** Beds that can actually take a patient today. */
  functionalBeds: number;
  /** Functional beds the present nursing establishment can cover. Often the real ceiling. */
  staffedBeds: number;
  occupiedBeds: number;
  occupancyRate: number;
  pressure: PressureLevel;
  meanOccupancyRate: number;
  peakOccupancyRate: number;
  daysAtCapacity: number;
  /** Patient-days that arrived and found no bed. Invisible in any real occupancy return. */
  unmetBedDays: number;

  // --- workforce ---
  staffSanctioned: number;
  staffInPosition: number;
  staffPresent: number;
  vacancyRate: number;
  absenteeismRate: number;
  cadres: CadreStaffing[];
  /** Worst-first, in the words a district officer would use. Empty for an adequately staffed facility. */
  criticalGaps: string[];

  // --- the link to the stock figures in the table above ---
  reportingClass: ReportingClass;
  reportingScore: number;
  reportingNote: string;
  /** Multiplier on modelled drug consumption implied by ward occupancy. */
  consumptionPressure: number;
}

/**
 * One facility's full occupancy history, for the single bed chart.
 *
 * Exactly one per district, and for the same reason `SeriesProbe` is capped at
 * one: two 180-element arrays for every bed-holding facility would dwarf the
 * dispatch orders, and the ninth occupancy line teaches nobody anything the
 * first one did not.
 *
 * The chosen facility is the one with the most unmet bed-days, because that is
 * the facility where the two series SEPARATE -- and the gap between them is the
 * point. `occupied` is what an HMIS occupancy return contains and it flattens
 * against the capacity line; `demand` is the admission pressure that actually
 * presented and keeps climbing above it. A ward that reports 100% for six weeks
 * is not a ward operating at full utilisation, and this chart is the only place
 * that difference is visible.
 */
export interface OccupancyProbe {
  facilityId: string;
  facilityName: string;
  facilityType: FacilityType;
  sanctionedBeds: number;
  functionalBeds: number;
  /** ISO date of the LAST element. The series ends on the as-of date. */
  asOf: string;
  /** Daily occupied beds, capped at functional strength. What a real return contains. */
  occupied: number[];
  /** Daily admission demand before the cap. Ground truth; unobservable in production. */
  demand: number[];
}

/**
 * The district's beds-and-people payload.
 *
 * There is no roll-up field here on purpose: the district-level totals already
 * ride on `DistrictDetail.district.resources`, which is the SAME object the
 * national board renders for this district. Emitting a second copy is how a
 * district page and a national page start quoting different occupancy rates for
 * the same district out of the same build.
 */
export interface DistrictResources {
  facilities: ResourceFacilityRow[];
  occupancy: OccupancyProbe | null;
}

export interface DistrictDetail {
  asOf: string;
  builtAt: string;
  buildSeconds: number;
  /** Exactly the row the national board shows for this district -- reused, not recomputed. */
  district: DistrictSnapshot;
  economics: DistrictEconomics;
  orders: DispatchOrder[];
  /**
   * Every critical and high position in the district.
   *
   * No top-6 cap here, unlike the national alert list. That cap is what makes
   * the national board show 228 district hospitals and zero sub-centres: taking
   * the worst six per district takes the six biggest facilities. Within one
   * district all ~630 positions are present, so the tier filter has real rows
   * behind every chip.
   */
  positions: PositionRow[];
  /** Worst unmet needs, already sorted worst-first by the planner. */
  unserved: UnservedNeed[];
  facilities: FacilityRow[];
  probe: SeriesProbe | null;
  /**
   * Beds and workforce -- the two resources the medicine layer has always
   * depended on and could not see.
   */
  resources: DistrictResources;
}

export type { UnservedNeed, UnservedReason, UnservedReasonHistogram } from '@/lib/optimize/redistribute';
/**
 * Re-exported so the console imports its entire payload contract from one
 * module. The client never reaches into `@/lib/sim/**` -- importing a simulator
 * into a `'use client'` component is how a browser bundle ends up carrying a
 * Monte Carlo engine in order to render a table.
 */
export type {
  CadreStaffing,
  PressureLevel,
  ReportingClass,
  StaffCadre,
} from '@/lib/domain/resources';

/** How many unserved rows to carry. The histogram keeps the full count. */
const MAX_UNSERVED_ROWS = 40;
/** Days of forward seasonality shipped with the probe. */
const PROBE_HORIZON_DAYS = 90;
/**
 * A series with fewer non-zero days than this is a flat line with a few spikes,
 * which demonstrates the estimator badly. Croston is interesting precisely on
 * intermittent-but-present demand.
 */
const PROBE_MIN_NONZERO_PERIODS = 24;

export interface DistrictDetailMeta {
  /** Evaluation date the whole snapshot is computed against. */
  asOf: Date;
  /** Wall-clock stamp of the build, ISO. */
  builtAt: string;
  /** Seconds the whole snapshot build took -- quoted in the deployability argument. */
  buildSeconds: number;
  /** The national row for this district, so both views quote one set of figures. */
  district: DistrictSnapshot;
}

/**
 * Assemble the district payload. Pure: same inputs, same bytes, every time.
 *
 * Takes the two objects the batch job already holds in scope. It deliberately
 * does not take a district code and go fetch anything -- pulling the network or
 * the ledger again here would make the emitted file a different computation
 * from the one the national totals were derived from, and the two would drift
 * the first time a seed or an as-of date changed.
 */
export function buildDistrictDetail(
  states: FacilityDrugState[],
  plan: RedistributionPlan,
  resources: ResourceState[],
  meta: DistrictDetailMeta,
): DistrictDetail {
  const positionByKey = new Map(states.map((s) => [s.facility.id + '|' + s.drug.id, s]));
  const facilityById = new Map(states.map((s) => [s.facility.id, s.facility]));

  const orders: DispatchOrder[] = [];
  for (const t of plan.transfers) {
    const from = facilityById.get(t.fromFacilityId);
    const to = facilityById.get(t.toFacilityId);
    // Both endpoints came out of the same `states` array the planner was fed,
    // so a miss means the two inputs are from different districts. Skip rather
    // than emit an order with a blank endpoint on a printable dispatch note.
    if (!from || !to) continue;

    const receiver = positionByKey.get(t.toFacilityId + '|' + t.drugId);
    const drug = getDrug(t.drugId);

    orders.push({
      id: t.fromFacilityId + '|' + t.toFacilityId + '|' + t.drugId,
      from: { id: from.id, name: from.name, type: from.type, lat: from.lat, lon: from.lon },
      to: { id: to.id, name: to.name, type: to.type, lat: to.lat, lon: to.lon },
      drugId: drug.id,
      drugName: drug.name,
      drugStrength: drug.strength,
      unit: drug.unit,
      ved: drug.ved,
      coldChain: drug.coldChain,
      quantity: t.quantity,
      lines: t.lines,
      distanceKm: +t.distanceKm.toFixed(1),
      estimatedCostInr: Math.round(t.estimatedCostInr),
      wasteAvertedUnits: +t.wasteAvertedUnits.toFixed(1),
      riskReduction: +t.riskReduction.toFixed(4),
      receiverOnHandBefore: receiver?.risk.onHand ?? 0,
      receiverStockoutProbBefore: +(receiver?.risk.stockoutProbability ?? 0).toFixed(4),
      // Verbatim. This string is generated at the moment of the decision, from
      // the samples that decision was made against; regenerating it from the
      // rounded fields above would produce a sentence that quietly disagrees
      // with the plan it describes.
      rationale: t.rationale,
    });
  }

  const positions: PositionRow[] = states
    .filter((s) => s.risk.severity === 'critical' || s.risk.severity === 'high')
    .sort((a, b) => b.risk.riskScore - a.risk.riskScore || b.risk.expectedShortfallUnits - a.risk.expectedShortfallUnits)
    .map((s) => ({
      facilityId: s.facility.id,
      facilityName: s.facility.name,
      facilityType: s.facility.type,
      districtCode: s.facility.districtCode,
      districtName: s.facility.districtName,
      stateName: s.facility.stateName,
      lat: s.facility.lat,
      lon: s.facility.lon,
      population: s.facility.population,
      drugId: s.drug.id,
      drugName: s.drug.name,
      drugStrength: s.drug.strength,
      unit: s.drug.unit,
      ved: s.drug.ved,
      onHand: s.risk.onHand,
      // -1 is the national board's sentinel for "no measurable demand, so cover
      // is infinite". Kept identical here so one cell renderer serves both.
      daysOfCover: Number.isFinite(s.risk.daysOfCover) ? +s.risk.daysOfCover.toFixed(1) : -1,
      leadTimeDays: s.leadTimeDays,
      stockoutProbability: +s.risk.stockoutProbability.toFixed(3),
      expectedShortfallUnits: +s.risk.expectedShortfallUnits.toFixed(1),
      riskScore: s.risk.riskScore,
      severity: s.risk.severity,
      reorderPoint: Math.round(s.risk.reorderPoint),
      forecastDailyDemand: +s.risk.forecastDailyDemand.toFixed(3),
      demandPattern: s.fit.pattern,
      forecastMethod: s.fit.method,
      censoredDays: countCensored(s),
      projectedExpiryWaste: Math.round(s.risk.projectedExpiryWaste),
    }));

  const facilities = rollUpFacilities(states);

  const served = plan.transfers.length;
  const denominator = served + plan.unservedReceivers;

  return {
    asOf: meta.asOf.toISOString().slice(0, 10),
    builtAt: meta.builtAt,
    buildSeconds: meta.buildSeconds,
    district: meta.district,
    economics: {
      transfers: served,
      transportCostInr: Math.round(plan.totalCostInr),
      wasteAvertedUnits: Math.round(plan.totalWasteAvertedUnits),
      wasteAvertedInr: Math.round(plan.totalWasteAvertedInr),
      shortfallAvertedUnits: Math.round(plan.totalShortfallAverted),
      netBenefitInr: Math.round(plan.netBenefitInr),
      unservedReceivers: plan.unservedReceivers,
      coverageShare: denominator > 0 ? +(served / denominator).toFixed(4) : 0,
      // Copied, not aliased: the plan object is reused across the build loop and
      // a shared histogram would accumulate across districts.
      reasonHistogram: { ...emptyReasonHistogram(), ...plan.unservedByReason },
    },
    orders,
    positions,
    unserved: plan.unserved.slice(0, MAX_UNSERVED_ROWS),
    facilities,
    probe: pickProbe(states, meta.asOf),
    resources: {
      facilities: rollUpResourceFacilities(resources),
      occupancy: pickOccupancyProbe(resources),
    },
  };
}

/**
 * Trim facility resource states down to what the console renders.
 *
 * The important word is TRIM. A `ResourceState` carries two 180-element daily
 * series per facility, and at demo scale that is 22 facilities per district
 * across 128 districts -- roughly a million numbers that would be written to
 * disk, shipped to a browser, and used to render a table of totals. The series
 * survive for exactly one facility, in `pickOccupancyProbe`.
 *
 * Sorted worst-first on the thing the panel exists to surface: how much of the
 * facility's designed establishment is actually present today.
 */
function rollUpResourceFacilities(resources: ResourceState[]): ResourceFacilityRow[] {
  return resources
    .map((r) => ({
      id: r.facilityId,
      name: r.facilityName,
      type: r.facilityType,
      lat: r.lat,
      lon: r.lon,
      population: r.population,

      sanctionedBeds: r.beds.sanctionedBeds,
      functionalBeds: r.beds.functionalBeds,
      staffedBeds: r.staffedBeds,
      occupiedBeds: r.beds.occupied,
      occupancyRate: r.beds.occupancyRate,
      pressure: r.beds.pressure,
      meanOccupancyRate: r.beds.meanOccupancyRate,
      peakOccupancyRate: r.beds.peakOccupancyRate,
      daysAtCapacity: r.beds.daysAtCapacity,
      unmetBedDays: r.beds.unmetBedDays,

      staffSanctioned: r.staffing.sanctioned,
      staffInPosition: r.staffing.inPosition,
      staffPresent: r.staffing.presentToday,
      vacancyRate: r.staffing.vacancyRate,
      absenteeismRate: r.staffing.absenteeismRate,
      cadres: r.staffing.cadres,
      criticalGaps: r.staffing.criticalGaps,

      reportingClass: r.reporting.class,
      reportingScore: r.reporting.score,
      reportingNote: r.reporting.note,
      consumptionPressure: r.linkage.consumptionPressure,
    }))
    .sort(
      (a, b) =>
        a.staffPresent / Math.max(1, a.staffSanctioned) -
          b.staffPresent / Math.max(1, b.staffSanctioned) ||
        b.unmetBedDays - a.unmetBedDays ||
        a.name.localeCompare(b.name),
    );
}

/**
 * Choose the one occupancy history worth charting: the facility where recorded
 * occupancy and actual admission demand diverge the most.
 *
 * Falls back to the fullest ward when nothing in the district ever exceeded its
 * capacity -- a legitimate outcome for a well-provisioned district, which
 * produces a chart where the two lines sit on top of each other. That is a real
 * answer rather than a missing one, and it is worth showing.
 */
function pickOccupancyProbe(resources: ResourceState[]): OccupancyProbe | null {
  const withBeds = resources.filter(
    (r) => r.beds.functionalBeds > 0 && r.beds.occupiedSeries.length > 0,
  );
  if (withBeds.length === 0) return null;

  const chosen = [...withBeds].sort(
    (a, b) =>
      b.beds.unmetBedDays - a.beds.unmetBedDays || b.beds.occupancyRate - a.beds.occupancyRate,
  )[0];

  return {
    facilityId: chosen.facilityId,
    facilityName: chosen.facilityName,
    facilityType: chosen.facilityType,
    sanctionedBeds: chosen.beds.sanctionedBeds,
    functionalBeds: chosen.beds.functionalBeds,
    asOf: chosen.beds.asOf,
    occupied: chosen.beds.occupiedSeries,
    demand: chosen.beds.demandSeries,
  };
}

function countCensored(s: FacilityDrugState): number {
  let n = 0;
  for (const c of s.sim.censoredMask) if (c) n++;
  return n;
}

/**
 * Facility-level roll-up.
 *
 * Exists so the roster and the map can size and colour a facility without
 * shipping all ~630 positions to compute one mean per node. Risk is a plain
 * mean over the facility's own positions -- unlike the district figure, which
 * is population-weighted, because within one facility every position serves the
 * same catchment and the weight would cancel.
 */
function rollUpFacilities(states: FacilityDrugState[]): FacilityRow[] {
  const rows = new Map<string, FacilityRow & { riskSum: number }>();

  for (const s of states) {
    let row = rows.get(s.facility.id);
    if (!row) {
      row = {
        id: s.facility.id,
        name: s.facility.name,
        type: s.facility.type,
        lat: s.facility.lat,
        lon: s.facility.lon,
        population: s.facility.population,
        parentId: s.facility.parentId,
        distanceToParentKm: +s.facility.distanceToParentKm.toFixed(1),
        leadTimeDays: s.leadTimeDays,
        positions: 0,
        criticalPositions: 0,
        zeroStockPositions: 0,
        meanRiskScore: 0,
        riskSum: 0,
      };
      rows.set(s.facility.id, row);
    }
    row.positions++;
    if (s.risk.severity === 'critical') row.criticalPositions++;
    if (s.risk.onHand === 0) row.zeroStockPositions++;
    row.riskSum += s.risk.riskScore;
  }

  return [...rows.values()]
    .map(({ riskSum, ...row }) => ({
      ...row,
      meanRiskScore: row.positions > 0 ? +(riskSum / row.positions).toFixed(1) : 0,
    }))
    .sort((a, b) => b.meanRiskScore - a.meanRiskScore || a.name.localeCompare(b.name));
}

/**
 * Choose the one position whose history is worth charting.
 *
 * Worst Vital position with a series that actually shows something. The
 * non-zero-period floor is the important half: the highest-risk position in a
 * district is often a sub-centre holding zero of an item it dispenses twice a
 * year, and plotting 365 zeros with two spikes teaches a viewer nothing about
 * intermittent-demand forecasting. Falls back through Vital-with-history, then
 * any-class-with-history, then null.
 */
function pickProbe(states: FacilityDrugState[], asOf: Date): SeriesProbe | null {
  const usable = states
    .filter((s) => s.fit.nonZeroPeriods >= PROBE_MIN_NONZERO_PERIODS && s.sim.recordedSeries.length > 0)
    .sort((a, b) => b.risk.riskScore - a.risk.riskScore);

  const chosen = usable.find((s) => s.drug.ved === 'V') ?? usable[0];
  if (!chosen) return null;

  return {
    facilityId: chosen.facility.id,
    facilityName: chosen.facility.name,
    drugId: chosen.drug.id,
    drugName: chosen.drug.name,
    unit: chosen.drug.unit,
    recorded: chosen.sim.recordedSeries,
    censored: chosen.sim.censoredMask,
    fittedDailyDemand: +chosen.fit.meanDemand.toFixed(4),
    reorderPoint: Math.round(chosen.risk.reorderPoint),
    onHand: chosen.risk.onHand,
    leadTimeDays: chosen.leadTimeDays,
    seasonalMultipliers: horizonMultipliers(chosen.drug.seasonality, asOf, PROBE_HORIZON_DAYS).map(
      (m) => +m.toFixed(3),
    ),
  };
}
