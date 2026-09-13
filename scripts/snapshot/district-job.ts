/**
 * ONE DISTRICT OF THE NATIONAL BATCH: simulate its cluster, plan it, write its payload.
 *
 * Shared by `scripts/build-snapshot.mts` (in process, when asked for one worker)
 * and `scripts/snapshot/worker.mts` (on a worker thread). Everything the national
 * roll-up needs comes back as a plain, structured-cloneable object, and the
 * district's own payload is written from here, so the main thread never has to
 * hold a district's simulated state at all.
 *
 * WHY A DISTRICT CAN BE PLANNED ON ANOTHER THREAD WITHOUT CHANGING ITS ANSWER
 * -------------------------------------------------------------------------
 * The planner shares one allocation state across the whole country -- a donor
 * drawn down for one district is already drawn down when the next is planned --
 * and that state is keyed by facility: `facilityId|drugId` for capacity, waste
 * budget and units given, `facilityId|drugId|batchNo` for batch commitments.
 * Facility ids begin with their district code. A district's plan therefore reads
 * and writes ONLY the keys of the districts in its cluster (itself and its
 * donors), and two districts whose clusters share no district cannot see each
 * other's effect on the state at all. So the job takes the slice of the state
 * for its cluster, plans against it, and hands back the slice it changed.
 *
 * The donor's lead-time demand samples are not carried: they are a deterministic
 * function of the facility, the drug and the fit, so a thread that draws them
 * again draws the same numbers.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDistrictState, toTransferContexts, summariseDistrict } from '../../src/lib/pipeline';
import type { FacilityDrugState } from '../../src/lib/pipeline';
import { buildDistrictDetail } from '../../src/lib/district-detail';
import { planRedistribution, newPlannerState, type PlannerState } from '../../src/lib/optimize/redistribute';
import { DISTRICTS_BY_CODE, districtPopulation } from '../../src/lib/domain/geo';
import { districtReliability, districtPullFraction } from '../../src/lib/sim/inventory';
import {
  buildResourceStates,
  rollUpDistrictResources,
  DEFAULT_BED_HISTORY_DAYS,
} from '../../src/lib/sim/resources';
import type { ForecastCache, ForecastMethodMap } from '../../src/lib/forecast/timesfm';
import type { Facility } from '../../src/lib/domain/types';
import type { DistrictSnapshot, AlertRow } from '../../src/lib/snapshot-types';
import type { DistrictResourceRollup } from '../../src/lib/domain/resources';

export const SIMULATIONS = 600;
export const PLAN_SIMULATIONS = 500;
/** Seed the resource simulator off the SAME constant the pipeline defaults to. */
export const RESOURCE_SEED = 20260930;
/** Critical/high rows kept per (district, facility tier) for the national board. */
export const ALERTS_PER_TIER = 2;

/** The mutable part of the planner state, as it travels between threads. */
export interface StateSlice {
  capacity: [string, number][];
  committed: [string, number][];
  wasteBudget: [string, number][];
  given: [string, number][];
}

export interface DistrictJob {
  index: number;
  code: string;
  /** The district itself first, then its donor neighbours. */
  cluster: string[];
  slice: StateSlice;
  asOfIso: string;
  builtAt: string;
  districtDir: string;
}

export interface LinkContribution {
  fromCode: string;
  toCode: string;
  orders: number;
  units: number;
  transportCostInr: number;
  shortfallAvertedUnits: number;
  trips: number;
}

export interface DistrictResult {
  index: number;
  code: string;
  snap: DistrictSnapshot;
  detailBytes: number;
  slice: StateSlice;
  timesfmPositions: number;
  crostonPositions: number;
  alerts: AlertRow[];
  tierCounts: Record<string, { critical: number; high: number }>;
  vedCounts: Record<string, { critical: number; high: number }>;
  links: LinkContribution[];
  plan: {
    transfers: number;
    trips: number;
    crossDistrictTrips: number;
    crossDistrictOrders: number;
    rideAlongOrders: number;
    unconsolidatedCostInr: number;
    totalCostInr: number;
    totalWasteAvertedInr: number;
    totalShortfallAverted: number;
    netBenefitInr: number;
  };
  zeroStockPositions: number;
  population: number;
  resources: DistrictResourceRollup;
  cache: { hits: number; misses: number };
  seconds: number;
}

type SliceField = keyof StateSlice;
const FIELDS: SliceField[] = ['capacity', 'committed', 'wasteBudget', 'given'];

/**
 * The district a planner-state key belongs to: its first three dash-separated
 * parts, because keys begin with a facility id (`DST-08-AJMER-DH-001|…`) and a
 * district code's slug never contains a dash.
 */
const districtOfKey = (key: string): string => {
  const a = key.indexOf('-');
  const b = key.indexOf('-', a + 1);
  const c = key.indexOf('-', b + 1);
  return key.slice(0, c);
};

/**
 * The national planner state, held by district.
 *
 * A flat map would do, and did, until the country had 769 districts: slicing a
 * cluster out of it meant testing every key in the country against five
 * prefixes for every job, and by the second half of the run the main thread
 * spent longer slicing than twelve threads spent planning. Bucketed by
 * district, a slice costs the size of the slice.
 */
export class DistrictStateIndex {
  private readonly buckets = new Map<string, Record<SliceField, Map<string, number>>>();

  private bucket(code: string) {
    let b = this.buckets.get(code);
    if (!b) {
      b = { capacity: new Map(), committed: new Map(), wasteBudget: new Map(), given: new Map() };
      this.buckets.set(code, b);
    }
    return b;
  }

  slice(cluster: string[]): StateSlice {
    const out: StateSlice = { capacity: [], committed: [], wasteBudget: [], given: [] };
    for (const code of cluster) {
      const b = this.buckets.get(code);
      if (!b) continue;
      for (const f of FIELDS) for (const e of b[f]) out[f].push(e);
    }
    return out;
  }

  merge(slice: StateSlice): void {
    for (const f of FIELDS) {
      for (const [k, v] of slice[f]) this.bucket(districtOfKey(k))[f].set(k, v);
    }
  }
}

/** The whole of a (thread-local) planner state, as a slice to send back. */
function toSlice(state: PlannerState): StateSlice {
  return {
    capacity: [...state.capacity],
    committed: [...state.committed],
    wasteBudget: [...state.wasteBudget],
    given: [...state.given],
  };
}

function stateFromSlice(slice: StateSlice): PlannerState {
  const s = newPlannerState();
  for (const [k, v] of slice.capacity) s.capacity.set(k, v);
  for (const [k, v] of slice.committed) s.committed.set(k, v);
  for (const [k, v] of slice.wasteBudget) s.wasteBudget.set(k, v);
  for (const [k, v] of slice.given) s.given.set(k, v);
  return s;
}

/**
 * A small LRU of simulated district states, per thread.
 *
 * A district is simulated once per thread for every cluster that needs it; the
 * table is ordered by state, so neighbours arrive together and most lookups hit.
 * ~13 MB a district at full size, so the cap is what keeps a pool of threads
 * inside a laptop's memory.
 */
export class StateCache {
  private readonly map = new Map<string, FacilityDrugState[]>();
  hits = 0;
  misses = 0;
  constructor(
    private readonly size: number,
    private readonly config: { asOf: Date; forecastCache: ForecastCache | null; forecastMethod: ForecastMethodMap | null },
  ) {}

  get(code: string): FacilityDrugState[] {
    const hit = this.map.get(code);
    if (hit) {
      this.hits++;
      this.map.delete(code);
      this.map.set(code, hit);
      return hit;
    }
    this.misses++;
    const built = buildDistrictState(code, {
      asOf: this.config.asOf,
      simulations: SIMULATIONS,
      forecastCache: this.config.forecastCache,
      forecastMethod: this.config.forecastMethod,
    });
    while (this.map.size >= this.size) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    this.map.set(code, built);
    return built;
  }
}

export function runDistrictJob(job: DistrictJob, cache: StateCache): DistrictResult {
  const t0 = Date.now();
  const hits0 = cache.hits;
  const misses0 = cache.misses;
  const asOf = new Date(job.asOfIso + 'T00:00:00Z');
  const d = DISTRICTS_BY_CODE[job.code];

  const states = cache.get(d.code);
  const summary = summariseDistrict(states);
  const neighbourStates = job.cluster.slice(1).flatMap((code) => cache.get(code));

  const plannerState = stateFromSlice(job.slice);
  const plan = planRedistribution(
    toTransferContexts([...states, ...neighbourStates]),
    {
      asOf,
      simulations: PLAN_SIMULATIONS,
      // Neighbours may give but not receive: their own needs are planned on
      // their own turn, against the same shared state.
      eligibleReceiver: (c) => c.facility.districtCode === d.code,
    },
    plannerState,
  );

  // The resource layer, over the SAME facility objects the stock pipeline ran on.
  const facilities: Facility[] = [];
  const seen = new Set<string>();
  for (const st of states) {
    if (seen.has(st.facility.id)) continue;
    seen.add(st.facility.id);
    facilities.push(st.facility);
  }
  const resources = buildResourceStates(facilities, {
    asOf,
    historyDays: DEFAULT_BED_HISTORY_DAYS,
    seed: RESOURCE_SEED,
  });
  const resourceRollup = rollUpDistrictResources(resources);
  const population = districtPopulation(d.code);

  const crossDistrictOrders = plan.trips.filter((t) => t.crossDistrict).reduce((acc, t) => acc + t.orders, 0);
  const snap: DistrictSnapshot = {
    ...summary,
    reliability: +districtReliability(d.code).toFixed(3),
    pullFraction: +districtPullFraction(d.code).toFixed(3),
    population,
    transfers: plan.transfers.length,
    transportCostInr: Math.round(plan.totalCostInr),
    wasteAvertedInr: Math.round(plan.totalWasteAvertedInr),
    shortfallAverted: Math.round(plan.totalShortfallAverted),
    netBenefitInr: Math.round(plan.netBenefitInr),
    trips: plan.trips.length,
    crossDistrictTrips: plan.crossDistrictTrips,
    crossDistrictOrders,
    rideAlongOrders: plan.rideAlongsServed,
    resources: resourceRollup,
  };

  const detail = buildDistrictDetail(
    states,
    plan,
    resources,
    {
      asOf,
      builtAt: job.builtAt,
      // Seconds THIS district took, not the whole run: what a live recompute costs.
      buildSeconds: +((Date.now() - t0) / 1000).toFixed(2),
      district: snap,
    },
    neighbourStates,
  );
  const detailJson = JSON.stringify(detail);
  writeFileSync(resolve(job.districtDir, d.code + '.json'), detailJson);

  let timesfmPositions = 0;
  let crostonPositions = 0;
  for (const st of states) {
    if (st.forecastSource === 'timesfm') timesfmPositions++;
    else crostonPositions++;
  }

  // Cross-district flows, rolled up to the district pair.
  const links = new Map<string, LinkContribution>();
  {
    const districtOf = new Map<string, string>();
    for (const st of [...states, ...neighbourStates]) districtOf.set(st.facility.id, st.facility.districtCode);
    const tripIds = new Set(plan.trips.map((t) => t.id));
    const countedTrip = new Set<string>();
    for (const t of plan.transfers) {
      const fromCode = districtOf.get(t.fromFacilityId);
      const toCode = districtOf.get(t.toFacilityId);
      if (!fromCode || !toCode || fromCode === toCode) continue;
      if (!DISTRICTS_BY_CODE[fromCode] || !DISTRICTS_BY_CODE[toCode]) continue;
      const key = fromCode + '>' + toCode;
      let link = links.get(key);
      if (!link) {
        link = { fromCode, toCode, orders: 0, units: 0, transportCostInr: 0, shortfallAvertedUnits: 0, trips: 0 };
        links.set(key, link);
      }
      link.orders++;
      link.units += t.quantity;
      link.transportCostInr += t.estimatedCostInr;
      link.shortfallAvertedUnits += t.shortfallAvertedUnits;
      // A trip carries several orders; count the vehicle once.
      if (!countedTrip.has(t.corridorId)) {
        countedTrip.add(t.corridorId);
        if (tripIds.has(t.corridorId)) link.trips++;
      }
    }
  }

  /*
   * The board is a stratified sample: the worst two critical/high positions per
   * (district, facility tier). Ranking a district's positions on risk alone
   * ranks them on facility size, because the score carries a log-population
   * exposure term -- see the note at the national cut in build-snapshot.mts.
   */
  const perTier = new Map<string, FacilityDrugState[]>();
  for (const s of states) {
    if (s.risk.severity !== 'critical' && s.risk.severity !== 'high') continue;
    const bucket = perTier.get(s.facility.type);
    if (bucket) bucket.push(s);
    else perTier.set(s.facility.type, [s]);
  }
  const worst: FacilityDrugState[] = [];
  for (const bucket of perTier.values()) {
    bucket.sort((a, b) => b.risk.riskScore - a.risk.riskScore);
    worst.push(...bucket.slice(0, ALERTS_PER_TIER));
  }
  const tierCounts: DistrictResult['tierCounts'] = {};
  const vedCounts: DistrictResult['vedCounts'] = {};
  for (const s of states) {
    const row = (tierCounts[s.facility.type] ??= { critical: 0, high: 0 });
    const vedRow = (vedCounts[s.drug.ved] ??= { critical: 0, high: 0 });
    if (s.risk.severity === 'critical') {
      row.critical++;
      vedRow.critical++;
    } else if (s.risk.severity === 'high') {
      row.high++;
      vedRow.high++;
    }
  }
  const alerts: AlertRow[] = worst.map((s) => ({
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
    daysOfCover: Number.isFinite(s.risk.daysOfCover) ? +s.risk.daysOfCover.toFixed(1) : -1,
    leadTimeDays: s.leadTimeDays,
    stockoutProbability: +s.risk.stockoutProbability.toFixed(3),
    expectedShortfallUnits: +s.risk.expectedShortfallUnits.toFixed(1),
    riskScore: s.risk.riskScore,
    severity: s.risk.severity,
  }));

  return {
    index: job.index,
    code: d.code,
    snap,
    detailBytes: Buffer.byteLength(detailJson),
    // The thread's state only ever held this cluster's keys: the slice it was
    // given plus whatever planning added, all of it for facilities in the cluster.
    slice: toSlice(plannerState),
    timesfmPositions,
    crostonPositions,
    alerts,
    tierCounts,
    vedCounts,
    links: [...links.values()],
    plan: {
      transfers: plan.transfers.length,
      trips: plan.trips.length,
      crossDistrictTrips: plan.crossDistrictTrips,
      crossDistrictOrders,
      rideAlongOrders: plan.rideAlongsServed,
      unconsolidatedCostInr: plan.transfers.reduce((acc, t) => acc + t.standaloneCostInr, 0),
      totalCostInr: plan.totalCostInr,
      totalWasteAvertedInr: plan.totalWasteAvertedInr,
      totalShortfallAverted: plan.totalShortfallAverted,
      netBenefitInr: plan.netBenefitInr,
    },
    zeroStockPositions: Math.round(summary.zeroStockShare * summary.trackedPositions),
    population,
    resources: resourceRollup,
    cache: { hits: cache.hits - hits0, misses: cache.misses - misses0 },
    seconds: (Date.now() - t0) / 1000,
  };
}
