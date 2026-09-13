/**
 * Builds the precomputed national snapshot the dashboard reads.
 *
 * Run with:  npx tsx scripts/build-snapshot.mts
 *            AAROGYA_BUILD_WORKERS=1 npx tsx scripts/build-snapshot.mts   (one thread)
 * Output:    src/data/national-snapshot.json      the national roll-up
 *            src/data/districts/<CODE>.json       one payload per district
 *
 * This is the batch job. Against real data it would run nightly off a DVDMS /
 * HMIS extract; here it runs off the simulator. Either way the app reads the
 * same artefact, which is the point -- the UI has no idea where the numbers
 * came from.
 *
 * CROSS-DISTRICT REDISTRIBUTION
 * =============================
 * Each district is planned against a CLUSTER: itself plus its nearest districts,
 * which may give but not receive -- each district's own needs are solved on its
 * own turn. The 150 km road-distance cap does not bind: facilities scatter up to
 * 85 km from their own headquarters, so neighbouring districts physically
 * interleave, and the first cross-district order this produced moved stock 10 km
 * between two districts whose headquarters are 100 km apart.
 *
 * ONE SHARED PLANNER STATE ACROSS THE WHOLE COUNTRY. This is the correctness
 * requirement, not an optimisation: without it two districts' plans would each
 * believe they had the whole of a shared neighbour's surplus, and the national
 * totals would promise the same batch twice.
 *
 * PLANNING IN ROUNDS, ON EVERY CORE
 * =================================
 * Planning is order-dependent -- a district planned earlier gets first refusal
 * on the stock it shares with a later one -- so it cannot simply be split across
 * threads. It CAN be split where no stock is shared. Two districts whose
 * clusters have no district in common read and write disjoint parts of the
 * planner state (every key begins with a facility id, and every facility id
 * with its district code), so their plans are independent of which is computed
 * first. The build colours the districts greedily, in table order, into rounds
 * of mutually disjoint clusters; a round runs on every worker thread at once,
 * and the next round starts from the state the last one left.
 *
 * The result is deterministic -- same table, same rounds, same answer -- but it
 * is a different fixed order from the one a single thread would use, which is
 * why the round count is published with the snapshot rather than implied. At
 * 769 districts a single thread takes over half an hour; the rounds are what
 * make a national rebuild a job somebody can schedule rather than a morning.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DISTRICTS, STATES, STATES_BY_CODE, DISTRICTS_BY_CODE, districtNeighbours } from '../src/lib/domain/geo';
import { DEMO_SCALE } from '../src/lib/sim/facilities';
import { FORECAST_HORIZON_DAYS } from '../src/lib/forecast/timesfm';
import type {
  NationalSnapshot,
  DistrictSnapshot,
  StateSnapshot,
  AlertRow,
  NationalTotals,
  CrossDistrictLink,
} from '../src/lib/snapshot-types';
import {
  runDistrictJob,
  DistrictStateIndex,
  StateCache,
  type DistrictJob,
  type DistrictResult,
} from './snapshot/district-job';
import { ASOF, loadForecastCache, loadForecastMethod } from './snapshot/inputs';
import { poolThreads, raisePriority } from './lib/pool';

const MAX_ALERTS = 250;
const NEIGHBOUR_RADIUS_KM = 250;
const MAX_NEIGHBOURS = 4;
/** Facility tiers, biggest first -- the order the supply chain runs in. */
const TIER_ORDER = ['DW', 'DH', 'SDH', 'CHC', 'PHC', 'SC'] as const;

/**
 * Threads: as many as memory allows, never more than the cores.
 *
 * Memory, not cores, runs out first. A thread holds its cluster's simulated
 * districts, an LRU of recent ones and the planner's transient Monte Carlo
 * draws -- about half a gigabyte at peak. The first run of this build started
 * twelve threads on a laptop with four gigabytes free, paged, and ran at 11% CPU
 * slower than one thread would have. So the count is derived from the memory
 * actually free when the build starts, and `AAROGYA_BUILD_WORKERS` overrides it.
 */
const WORKERS = poolThreads(550);
const CACHE_PER_WORKER = 6;

const FORECAST_CACHE = loadForecastCache();
const FORECAST_METHOD = loadForecastMethod();

const outPath = resolve(process.cwd(), 'src/data/national-snapshot.json');
const districtDir = resolve(process.cwd(), 'src/data/districts');
mkdirSync(districtDir, { recursive: true });

// ---- the rounds ---------------------------------------------------------------

const clusters = DISTRICTS.map((d) => [
  d.code,
  ...districtNeighbours(d.code, NEIGHBOUR_RADIUS_KM, MAX_NEIGHBOURS).map((n) => n.code),
]);

const rounds: number[][] = [];
{
  const occupied: Set<string>[] = [];
  for (let i = 0; i < DISTRICTS.length; i++) {
    let r = 0;
    while (r < rounds.length && clusters[i].some((c) => occupied[r].has(c))) r++;
    if (r === rounds.length) {
      rounds.push([]);
      occupied.push(new Set());
    }
    rounds[r].push(i);
    for (const c of clusters[i]) occupied[r].add(c);
  }
}
const largestRound = Math.max(...rounds.map((r) => r.length));

console.log('Building national snapshot');
console.log('  as-of      :', ASOF.toISOString().slice(0, 10));
console.log('  clusters   :', 'radius ' + NEIGHBOUR_RADIUS_KM + 'km, up to ' + MAX_NEIGHBOURS + ' neighbours');
console.log('  districts  :', DISTRICTS.length, 'in', STATES.length, 'states and union territories');
console.log('  rounds     :', rounds.length, '(largest ' + largestRound + ' districts)');
console.log('  threads    :', WORKERS);
console.log('  scale      :', JSON.stringify(DEMO_SCALE));
console.log();

const t0 = Date.now();
// One stamp for the whole run, so the snapshot and every district file agree on
// which build they came from.
const builtAt = new Date().toISOString();
const plannerState = new DistrictStateIndex();
const results: DistrictResult[] = new Array(DISTRICTS.length);

const jobFor = (i: number): DistrictJob => ({
  index: i,
  code: DISTRICTS[i].code,
  cluster: clusters[i],
  slice: plannerState.slice(clusters[i]),
  asOfIso: ASOF.toISOString().slice(0, 10),
  builtAt,
  districtDir,
});

let done = 0;
const progress = (r: number) => {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(
    `  round ${String(r + 1).padStart(2)}/${rounds.length}  ${String(rounds[r].length).padStart(3)} districts  ` +
      `${String(done).padStart(3)}/${DISTRICTS.length}  ${elapsed}s`,
  );
};

if (WORKERS === 1) {
  const cache = new StateCache(32, { asOf: ASOF, forecastCache: FORECAST_CACHE, forecastMethod: FORECAST_METHOD });
  for (let r = 0; r < rounds.length; r++) {
    for (const i of rounds[r]) {
      const result = runDistrictJob(jobFor(i), cache);
      plannerState.merge(result.slice);
      results[i] = result;
      done++;
    }
    progress(r);
  }
} else {
  raisePriority();
  const pool = Array.from(
    { length: WORKERS },
    () =>
      new Worker(new URL('./snapshot/worker.mts', import.meta.url), {
        workerData: { cacheSize: CACHE_PER_WORKER },
      }),
  );
  const recentByWorker = new Map(pool.map((w) => [w, new Set<string>()]));
  try {
    for (let r = 0; r < rounds.length; r++) {
      const queue = [...rounds[r]];
      await new Promise<void>((resolveRound, rejectRound) => {
        let outstanding = queue.length;
        const feed = (w: Worker) => {
          if (queue.length === 0) return;
          /*
           * Affinity. Each thread caches the districts it simulated last, so a
           * job goes to the free thread that already holds most of its cluster.
           * Handed out blindly, neighbouring clusters scattered across threads
           * and every thread re-simulated the same districts.
           */
          const recent = recentByWorker.get(w)!;
          let best = 0;
          let bestOverlap = -1;
          for (let q = 0; q < queue.length; q++) {
            let overlap = 0;
            for (const c of clusters[queue[q]]) if (recent.has(c)) overlap++;
            if (overlap > bestOverlap) {
              best = q;
              bestOverlap = overlap;
              if (overlap === clusters[queue[q]].length) break;
            }
          }
          const [i] = queue.splice(best, 1);
          for (const c of clusters[i]) {
            recent.delete(c);
            recent.add(c);
          }
          while (recent.size > CACHE_PER_WORKER) recent.delete(recent.values().next().value as string);
          // The slice is taken as the job is handed out. Within a round no
          // other job can touch it, so it is the same as taking it at the start.
          w.postMessage(jobFor(i));
        };
        for (const w of pool) {
          w.removeAllListeners('message');
          w.removeAllListeners('error');
          w.on('message', (msg: { ok: true; result: DistrictResult } | { ok: false; code: string; error: string }) => {
            if (!msg.ok) {
              rejectRound(new Error('district ' + msg.code + ' failed on a worker:\n' + msg.error));
              return;
            }
            plannerState.merge(msg.result.slice);
            results[msg.result.index] = msg.result;
            done++;
            outstanding--;
            if (outstanding === 0) resolveRound();
            else feed(w);
          });
          w.on('error', rejectRound);
          feed(w);
        }
      });
      progress(r);
    }
  } finally {
    await Promise.all(pool.map((w) => w.terminate()));
  }
}

// ---- the national roll-up, in table order ------------------------------------
//
// Everything below reads `results` by index, never in the order threads finished,
// so the snapshot is the same however the work was scheduled.

const totals: NationalTotals = {
  districts: 0,
  states: STATES.length,
  facilities: 0,
  trackedPositions: 0,
  criticalPositions: 0,
  highPositions: 0,
  zeroStockPositions: 0,
  populationCovered: 0,
  expectedShortfallUnits: 0,
  projectedWasteInr: 0,
  transfers: 0,
  transportCostInr: 0,
  wasteAvertedInr: 0,
  shortfallAverted: 0,
  netBenefitInr: 0,
  trips: 0,
  crossDistrictTrips: 0,
  crossDistrictOrders: 0,
  rideAlongOrders: 0,
  unconsolidatedCostInr: 0,
  sanctionedBeds: 0,
  functionalBeds: 0,
  opdAttendedToday: 0,
  opdMeanDaily: 0,
  opdTurnedAway: 0,
  opdDaysClosed: 0,
  staffedBeds: 0,
  occupiedBeds: 0,
  bedOccupancyRate: 0,
  facilitiesAtCapacity: 0,
  unmetBedDays: 0,
  staffSanctioned: 0,
  staffInPosition: 0,
  staffPresent: 0,
  vacancyRate: 0,
  absenteeismRate: 0,
  specialistSanctioned: 0,
  specialistInPosition: 0,
  facilitiesWithoutPharmacist: 0,
  facilitiesWithoutMedicalOfficer: 0,
  subCentresWithoutAnm: 0,
  facilitiesUnverifiedReporting: 0,
  populationUnderUnverifiedReporting: 0,
};

const districts: DistrictSnapshot[] = [];
const alerts: AlertRow[] = [];
const alertTotals: Record<string, { tier: string; critical: number; high: number }> = {};
const alertTotalsByVed: Record<string, { ved: string; critical: number; high: number }> = {};
const crossLinks = new Map<string, CrossDistrictLink>();
let timesfmPositions = 0;
let crostonPositions = 0;
let districtBytes = 0;
let cacheHits = 0;
let cacheMisses = 0;

for (const res of results) {
  const { snap, plan, resources: rr } = res;
  districts.push(snap);
  districtBytes += res.detailBytes;
  timesfmPositions += res.timesfmPositions;
  crostonPositions += res.crostonPositions;
  cacheHits += res.cache.hits;
  cacheMisses += res.cache.misses;

  totals.districts++;
  totals.facilities += snap.facilities;
  totals.trackedPositions += snap.trackedPositions;
  totals.criticalPositions += snap.criticalPositions;
  totals.highPositions += snap.highPositions;
  totals.zeroStockPositions += res.zeroStockPositions;
  totals.populationCovered += res.population;
  totals.expectedShortfallUnits += snap.expectedShortfallUnits;
  totals.projectedWasteInr += snap.projectedWasteInr;
  totals.transfers += plan.transfers;
  totals.trips += plan.trips;
  totals.crossDistrictTrips += plan.crossDistrictTrips;
  totals.crossDistrictOrders += plan.crossDistrictOrders;
  totals.rideAlongOrders += plan.rideAlongOrders;
  totals.unconsolidatedCostInr += plan.unconsolidatedCostInr;
  totals.transportCostInr += plan.totalCostInr;
  totals.wasteAvertedInr += plan.totalWasteAvertedInr;
  totals.shortfallAverted += plan.totalShortfallAverted;
  totals.netBenefitInr += plan.netBenefitInr;

  // Resource totals are accumulated as COUNTS and normalised into rates once,
  // after the loop: averaging district rates would weight a six-bed PHC district
  // equally with a 200-bed one.
  totals.sanctionedBeds += rr.sanctionedBeds;
  totals.functionalBeds += rr.functionalBeds;
  totals.staffedBeds += rr.staffedBeds;
  totals.occupiedBeds += rr.occupiedBeds;
  totals.facilitiesAtCapacity += rr.facilitiesAtCapacity;
  totals.unmetBedDays += rr.unmetBedDays;
  totals.staffSanctioned += rr.staffSanctioned;
  totals.staffInPosition += rr.staffInPosition;
  totals.staffPresent += rr.staffPresent;
  totals.specialistSanctioned += rr.specialistSanctioned;
  totals.specialistInPosition += rr.specialistInPosition;
  totals.opdAttendedToday += rr.opdAttendedToday;
  totals.opdMeanDaily += rr.opdMeanDaily;
  totals.opdTurnedAway += rr.opdTurnedAway;
  totals.opdDaysClosed += rr.opdDaysClosed;
  totals.facilitiesWithoutPharmacist += rr.facilitiesWithoutPharmacist;
  totals.facilitiesWithoutMedicalOfficer += rr.facilitiesWithoutMedicalOfficer;
  totals.subCentresWithoutAnm += rr.subCentresWithoutAnm;
  totals.facilitiesUnverifiedReporting += rr.unverifiedReportingFacilities;
  totals.populationUnderUnverifiedReporting += rr.populationUnderUnverifiedReporting;

  alerts.push(...res.alerts);
  for (const [tier, c] of Object.entries(res.tierCounts)) {
    const row = (alertTotals[tier] ??= { tier, critical: 0, high: 0 });
    row.critical += c.critical;
    row.high += c.high;
  }
  for (const [ved, c] of Object.entries(res.vedCounts)) {
    const row = (alertTotalsByVed[ved] ??= { ved, critical: 0, high: 0 });
    row.critical += c.critical;
    row.high += c.high;
  }

  for (const l of res.links) {
    const key = l.fromCode + '>' + l.toCode;
    let link = crossLinks.get(key);
    if (!link) {
      const fromD = DISTRICTS_BY_CODE[l.fromCode];
      const toD = DISTRICTS_BY_CODE[l.toCode];
      link = {
        fromDistrictCode: l.fromCode,
        fromDistrictName: fromD.name,
        fromStateCode: fromD.stateCode,
        fromLat: fromD.lat,
        fromLon: fromD.lon,
        toDistrictCode: l.toCode,
        toDistrictName: toD.name,
        toStateCode: toD.stateCode,
        toLat: toD.lat,
        toLon: toD.lon,
        trips: 0,
        orders: 0,
        units: 0,
        transportCostInr: 0,
        shortfallAvertedUnits: 0,
        crossState: fromD.stateCode !== toD.stateCode,
      };
      crossLinks.set(key, link);
    }
    link.orders += l.orders;
    link.units += l.units;
    link.transportCostInr += l.transportCostInr;
    link.shortfallAvertedUnits += l.shortfallAvertedUnits;
    link.trips += l.trips;
  }
}

// --- state roll-up ---------------------------------------------------------
const stateMap = new Map<string, StateSnapshot>();
for (const d of districts) {
  const info = STATES_BY_CODE[d.stateCode];
  let s = stateMap.get(d.stateCode);
  if (!s) {
    s = {
      stateCode: d.stateCode,
      stateName: d.stateName,
      abbr: info?.abbr ?? d.stateCode,
      districts: 0,
      facilities: 0,
      trackedPositions: 0,
      criticalPositions: 0,
      meanRiskScore: 0,
      zeroStockShare: 0,
      projectedWasteInr: 0,
      netBenefitInr: 0,
      population: 0,
      functionalBeds: 0,
      occupiedBeds: 0,
      bedOccupancyRate: 0,
      staffSanctioned: 0,
      staffInPosition: 0,
      staffPresent: 0,
      vacancyRate: 0,
      absenteeismRate: 0,
      facilitiesWithoutPharmacist: 0,
      opdAttendedToday: 0,
    };
    stateMap.set(d.stateCode, s);
  }
  s.districts++;
  s.facilities += d.facilities;
  s.trackedPositions += d.trackedPositions;
  s.criticalPositions += d.criticalPositions;
  s.projectedWasteInr += d.projectedWasteInr;
  s.netBenefitInr += d.netBenefitInr;
  s.population += d.population;
  // Accumulate population-weighted risk; normalised below.
  s.meanRiskScore += d.meanRiskScore * d.population;
  s.zeroStockShare += d.zeroStockShare * d.trackedPositions;
  s.functionalBeds += d.resources.functionalBeds;
  s.opdAttendedToday += d.resources.opdAttendedToday;
  s.occupiedBeds += d.resources.occupiedBeds;
  s.staffSanctioned += d.resources.staffSanctioned;
  s.staffInPosition += d.resources.staffInPosition;
  s.staffPresent += d.resources.staffPresent;
  s.facilitiesWithoutPharmacist += d.resources.facilitiesWithoutPharmacist;
}
for (const s of stateMap.values()) {
  s.meanRiskScore = s.population > 0 ? +(s.meanRiskScore / s.population).toFixed(1) : 0;
  s.zeroStockShare = s.trackedPositions > 0 ? +(s.zeroStockShare / s.trackedPositions).toFixed(4) : 0;
  s.bedOccupancyRate = s.functionalBeds > 0 ? +(s.occupiedBeds / s.functionalBeds).toFixed(4) : 0;
  s.vacancyRate = s.staffSanctioned > 0 ? +(1 - s.staffInPosition / s.staffSanctioned).toFixed(4) : 0;
  s.absenteeismRate = s.staffInPosition > 0 ? +(1 - s.staffPresent / s.staffInPosition).toFixed(4) : 0;
}

alerts.sort((a, b) => b.riskScore - a.riskScore || b.expectedShortfallUnits - a.expectedShortfallUnits);

/**
 * THE NATIONAL CUT HAS TO BE STRATIFIED TOO.
 *
 * Taking the top 250 by `riskScore` is the top 250 biggest facilities, because
 * the score carries a log-population exposure term: measured once, 182 district
 * hospitals, 68 CHCs, ZERO PHCs and ZERO sub-centres, against a country holding
 * thousands of critical PHC positions. So the cut round-robins over tiers,
 * taking the worst remaining from each in turn, and SHIPS IN THAT ORDER -- a
 * re-sort by risk afterwards undid the fix once, because the console shows the
 * first 40 rows and they were all district hospitals again.
 */
function stratifiedCut(rows: AlertRow[], limit: number): AlertRow[] {
  const queues = new Map<string, AlertRow[]>();
  for (const r of rows) {
    const q = queues.get(r.facilityType);
    if (q) q.push(r);
    else queues.set(r.facilityType, [r]);
  }
  const lists = TIER_ORDER.map((tier) => queues.get(tier)).filter(
    (q): q is AlertRow[] => q !== undefined && q.length > 0,
  );
  const picked: AlertRow[] = [];
  let cursor = 0;
  while (picked.length < limit) {
    let tookOne = false;
    for (const list of lists) {
      if (cursor >= list.length) continue;
      picked.push(list[cursor]);
      tookOne = true;
      if (picked.length === limit) break;
    }
    if (!tookOne) break;
    cursor++;
  }
  return picked;
}

const shownAlerts = stratifiedCut(alerts, MAX_ALERTS);
const buildSeconds = +((Date.now() - t0) / 1000).toFixed(1);

const snapshot: NationalSnapshot = {
  asOf: ASOF.toISOString().slice(0, 10),
  builtAt,
  scale: DEMO_SCALE,
  buildSeconds,
  batch: {
    threads: WORKERS,
    rounds: rounds.length,
    largestRound,
    neighbourRadiusKm: NEIGHBOUR_RADIUS_KM,
    maxNeighbours: MAX_NEIGHBOURS,
  },
  forecast: {
    model: FORECAST_CACHE?.model ?? null,
    timesfmPositions,
    crostonPositions,
    seriesForecast: FORECAST_CACHE?.seriesForecast ?? 0,
    seriesRequested: FORECAST_CACHE?.seriesRequested ?? 0,
    byPattern: FORECAST_METHOD,
    horizonDays: FORECAST_HORIZON_DAYS,
    contextDays: FORECAST_CACHE?.contextDays ?? 0,
    forecastStart: FORECAST_CACHE?.forecastStart ?? null,
  },
  totals: {
    ...totals,
    expectedShortfallUnits: Math.round(totals.expectedShortfallUnits),
    projectedWasteInr: Math.round(totals.projectedWasteInr),
    transportCostInr: Math.round(totals.transportCostInr),
    unconsolidatedCostInr: Math.round(totals.unconsolidatedCostInr),
    wasteAvertedInr: Math.round(totals.wasteAvertedInr),
    shortfallAverted: Math.round(totals.shortfallAverted),
    netBenefitInr: Math.round(totals.netBenefitInr),
    bedOccupancyRate: totals.functionalBeds > 0 ? +(totals.occupiedBeds / totals.functionalBeds).toFixed(4) : 0,
    vacancyRate: totals.staffSanctioned > 0 ? +(1 - totals.staffInPosition / totals.staffSanctioned).toFixed(4) : 0,
    absenteeismRate: totals.staffInPosition > 0 ? +(1 - totals.staffPresent / totals.staffInPosition).toFixed(4) : 0,
  },
  districts,
  crossDistrictLinks: [...crossLinks.values()]
    .map((l) => ({
      ...l,
      transportCostInr: Math.round(l.transportCostInr),
      shortfallAvertedUnits: Math.round(l.shortfallAvertedUnits),
    }))
    // Biggest flows first; the full pair as the final tie-break so the order is total.
    .sort(
      (a, b) =>
        b.shortfallAvertedUnits - a.shortfallAvertedUnits ||
        b.units - a.units ||
        a.fromDistrictCode.localeCompare(b.fromDistrictCode) ||
        a.toDistrictCode.localeCompare(b.toDistrictCode),
    ),
  states: [...stateMap.values()].sort((a, b) => b.criticalPositions - a.criticalPositions || a.stateCode.localeCompare(b.stateCode)),
  alerts: shownAlerts,
  alertTotals: {
    critical: totals.criticalPositions,
    high: totals.highPositions,
    shown: shownAlerts.length,
    byTier: TIER_ORDER.map((tier) => alertTotals[tier]).filter(
      (r): r is { tier: string; critical: number; high: number } => r !== undefined,
    ),
    byCriticality: (['V', 'E', 'D'] as const).map((ved) => alertTotalsByVed[ved] ?? { ved, critical: 0, high: 0 }),
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(snapshot, null, 1));

const sizeKb = (JSON.stringify(snapshot).length / 1024).toFixed(0);
const t = snapshot.totals;
const inr = (v: number) => v.toLocaleString('en-IN');
console.log('\n' + '='.repeat(66));
console.log('Snapshot written to src/data/national-snapshot.json  (' + sizeKb + ' KB)');
console.log(
  '  + ' + DISTRICTS.length + ' district payloads in src/data/districts/  (' +
    (districtBytes / 1024 / 1024).toFixed(1) + ' MB total, ' +
    Math.round(districtBytes / DISTRICTS.length / 1024) + ' KB mean)',
);
console.log('  build time        :', buildSeconds + 's on ' + WORKERS + ' threads, ' + rounds.length + ' rounds');
console.log('  districts         :', t.districts, 'in', t.states, 'states and UTs');
console.log('  facilities        :', inr(t.facilities));
console.log('  stock positions   :', inr(t.trackedPositions));
console.log(
  '  demand model      :',
  snapshot.forecast.model
    ? snapshot.forecast.model + ' on ' + inr(timesfmPositions) + ' positions (' +
        ((timesfmPositions / Math.max(1, t.trackedPositions)) * 100).toFixed(1) + '%), Croston on ' + inr(crostonPositions)
    : 'censored Croston only (AAROGYA_NO_BQ=1 or no cache)',
);
console.log('  critical / high   :', inr(t.criticalPositions), '/', inr(t.highPositions));
console.log('  population covered:', (t.populationCovered / 1e6).toFixed(1) + 'M');
console.log('  stock to expiry   : ₹' + inr(t.projectedWasteInr));
console.log('  transfers found   :', inr(t.transfers), 'orders on', inr(t.trips), 'vehicle trips');
console.log('  cross-district    :', inr(t.crossDistrictTrips), 'trips carrying', inr(t.crossDistrictOrders), 'orders');
console.log('  rode an open trip :', inr(t.rideAlongOrders), 'orders');
console.log('  district pairs    :', snapshot.crossDistrictLinks.length, 'flows,', snapshot.crossDistrictLinks.filter((l) => l.crossState).length, 'of them across a state line');
console.log('  transport         : ₹' + inr(t.transportCostInr), 'vs ₹' + inr(t.unconsolidatedCostInr) + ' unconsolidated');
console.log('  waste rescued     : ₹' + inr(t.wasteAvertedInr));
console.log('  net benefit       : ₹' + inr(t.netBenefitInr));
console.log('  state cache       :', cacheHits + ' hits / ' + cacheMisses + ' misses');
console.log('  ' + '-'.repeat(62));
console.log('  beds func/sanc    :', inr(t.functionalBeds), '/', inr(t.sanctionedBeds), ' staffed:', inr(t.staffedBeds));
console.log('  staff sanc/pos/pre:', inr(t.staffSanctioned), '/', inr(t.staffInPosition), '/', inr(t.staffPresent));
console.log('  no pharmacist     :', inr(t.facilitiesWithoutPharmacist), 'stock-holding facilities');
console.log('='.repeat(66));
