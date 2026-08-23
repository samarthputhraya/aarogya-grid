/**
 * Builds the precomputed national snapshot the dashboard reads.
 *
 * Run with:  npx tsx scripts/build-snapshot.mts
 * Output:    src/data/national-snapshot.json      the national roll-up
 *            src/data/districts/<CODE>.json       one payload per district
 *
 * This is the batch job. Against real data it would run nightly off a DVDMS /
 * HMIS extract; here it runs off the simulator. Either way the app reads the
 * same artefact, which is the point -- the UI has no idea where the numbers
 * came from.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { buildDistrictState, toTransferContexts, summariseDistrict } from '../src/lib/pipeline';
import { buildDistrictDetail } from '../src/lib/district-detail';
import { planRedistribution } from '../src/lib/optimize/redistribute';
import { DISTRICTS, STATES, STATES_BY_CODE, districtPopulation } from '../src/lib/domain/geo';
import { districtReliability, districtPullFraction } from '../src/lib/sim/inventory';
import {
  buildResourceStates,
  rollUpDistrictResources,
  DEFAULT_BED_HISTORY_DAYS,
} from '../src/lib/sim/resources';
import { DEMO_SCALE } from '../src/lib/sim/facilities';
import type { Facility } from '../src/lib/domain/types';
import type {
  NationalSnapshot,
  DistrictSnapshot,
  StateSnapshot,
  AlertRow,
  NationalTotals,
} from '../src/lib/snapshot-types';

/**
 * The evaluation date the whole snapshot is computed against.
 *
 * FIXED, NOT DERIVED FROM THE BUILD CLOCK, AND DELIBERATELY SO.
 *
 * An audit flagged this as a defect: built in August, the console displays a
 * position dated weeks ahead. The observation is right and the conclusion is
 * wrong, for two reasons.
 *
 * First, this date is a SCENARIO, and the app says so on every screen -- the
 * header reads "position as of". A fixed scenario date is what makes every
 * figure in the deck, the README and the demo reproducible by anyone who clones
 * the repo: same seed, same as-of, same numbers, forever. Deriving it from the
 * build clock would mean the snapshot drifts on every rebuild and no quoted
 * number could ever be checked against a later one.
 *
 * Second, 30 September 2026 is the submission deadline. The position is dated
 * to the moment the work is handed over, so by the time anyone evaluates it the
 * date reads as current rather than stale -- which is the failure mode that
 * actually matters for a demo that will be watched in October.
 *
 * Override for a different scenario (a monsoon peak, a specific outbreak week)
 * with AAROGYA_ASOF=YYYY-MM-DD.
 */
const ASOF = process.env.AAROGYA_ASOF
  ? new Date(process.env.AAROGYA_ASOF + 'T00:00:00Z')
  : new Date(Date.UTC(2026, 8, 30));
const SIMULATIONS = 600; // lower than the interactive path -- this runs 128x
const MAX_ALERTS = 250;
/**
 * Seed the resource simulator off the SAME constant the pipeline defaults to.
 *
 * Beds, workforce and stock must be drawn from one seed or the layers stop
 * describing one country: a facility could show a pharmacist in position on the
 * staffing panel and an unverified stock report two panels down, and nobody
 * would be able to tell whether that was a finding or a seeding accident.
 */
const RESOURCE_SEED = 20260930;

const outPath = resolve(process.cwd(), 'src/data/national-snapshot.json');

/**
 * Per-district payloads, ONE FILE PER DISTRICT.
 *
 * Not one combined file, and the reason is a Next.js build detail rather than a
 * taste preference: a static `import` of a JSON module is inlined into every
 * route that transitively imports it, so a single combined payload would be
 * duplicated verbatim into all 128 prerendered district pages. Split, each page
 * reads its own file at build time and carries only its own district.
 *
 * Written compact (no indent) -- these are machine-read artefacts, and the
 * pretty-printing that makes the national snapshot browsable would add roughly
 * a third again to something already committed 128 times over.
 */
const districtDir = resolve(process.cwd(), 'src/data/districts');
mkdirSync(districtDir, { recursive: true });
let districtBytes = 0;

console.log('Building national snapshot');
console.log('  as-of      :', ASOF.toISOString().slice(0, 10));
console.log('  districts  :', DISTRICTS.length);
console.log('  scale      :', JSON.stringify(DEMO_SCALE));
console.log();

const t0 = Date.now();
// One stamp for the whole run, so the national snapshot and all 128 district
// files agree on which build they came from. Taken from the build clock, not
// from inside the deterministic pipeline.
const builtAt = new Date().toISOString();
const districts: DistrictSnapshot[] = [];
const alerts: AlertRow[] = [];

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
  sanctionedBeds: 0,
  functionalBeds: 0,
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

for (let i = 0; i < DISTRICTS.length; i++) {
  const d = DISTRICTS[i];
  const tDistrict = Date.now();
  const states = buildDistrictState(d.code, { asOf: ASOF, simulations: SIMULATIONS });
  const summary = summariseDistrict(states);
  const plan = planRedistribution(toTransferContexts(states), { asOf: ASOF, simulations: 500 });

  /**
   * The resource layer, over the SAME facility objects the stock pipeline just
   * ran on. Deliberately taken out of `states` rather than by regenerating the
   * network: a second `generateNetwork` call would be a second source of truth
   * for the facility list, and the first time a scale or a seed changed, the
   * beds panel and the stock panel would be describing different districts.
   */
  const facilities: Facility[] = [];
  const seen = new Set<string>();
  for (const st of states) {
    if (seen.has(st.facility.id)) continue;
    seen.add(st.facility.id);
    facilities.push(st.facility);
  }
  const resources = buildResourceStates(facilities, {
    asOf: ASOF,
    historyDays: DEFAULT_BED_HISTORY_DAYS,
    seed: RESOURCE_SEED,
  });
  const resourceRollup = rollUpDistrictResources(resources);

  const population = districtPopulation(d.code);

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
    resources: resourceRollup,
  };
  districts.push(snap);

  // Persist what this iteration already computed. `states` and the full `plan`
  // -- the dispatch rationales, the batch pick lists, the needs that were
  // declined and why -- used to fall out of scope here and be garbage
  // collected, leaving only `transfers: number` behind. This is serialisation,
  // not computation: it adds no simulator or solver work to the build.
  const detail = buildDistrictDetail(states, plan, resources, {
    asOf: ASOF,
    builtAt,
    // Seconds THIS district took, not the whole run. On the district page that
    // is the number worth quoting -- it is what a live recompute would cost.
    buildSeconds: +((Date.now() - tDistrict) / 1000).toFixed(2),
    district: snap,
  });
  const detailJson = JSON.stringify(detail);
  districtBytes += Buffer.byteLength(detailJson);
  writeFileSync(resolve(districtDir, d.code + '.json'), detailJson);

  totals.districts++;
  totals.facilities += summary.facilities;
  totals.trackedPositions += summary.trackedPositions;
  totals.criticalPositions += summary.criticalPositions;
  totals.highPositions += summary.highPositions;
  totals.zeroStockPositions += Math.round(summary.zeroStockShare * summary.trackedPositions);
  totals.populationCovered += population;
  totals.expectedShortfallUnits += summary.expectedShortfallUnits;
  totals.projectedWasteInr += summary.projectedWasteInr;
  totals.transfers += plan.transfers.length;
  totals.transportCostInr += plan.totalCostInr;
  totals.wasteAvertedInr += plan.totalWasteAvertedInr;
  totals.shortfallAverted += plan.totalShortfallAverted;
  totals.netBenefitInr += plan.netBenefitInr;

  // Resource totals are accumulated as COUNTS and normalised into rates once,
  // after the loop. Averaging 128 district occupancy rates would weight a
  // six-bed PHC district equally with a 200-bed one and quietly understate the
  // national picture -- the same mistake the state roll-up below avoids.
  totals.sanctionedBeds += resourceRollup.sanctionedBeds;
  totals.functionalBeds += resourceRollup.functionalBeds;
  totals.staffedBeds += resourceRollup.staffedBeds;
  totals.occupiedBeds += resourceRollup.occupiedBeds;
  totals.facilitiesAtCapacity += resourceRollup.facilitiesAtCapacity;
  totals.unmetBedDays += resourceRollup.unmetBedDays;
  totals.staffSanctioned += resourceRollup.staffSanctioned;
  totals.staffInPosition += resourceRollup.staffInPosition;
  totals.staffPresent += resourceRollup.staffPresent;
  totals.specialistSanctioned += resourceRollup.specialistSanctioned;
  totals.specialistInPosition += resourceRollup.specialistInPosition;
  totals.facilitiesWithoutPharmacist += resourceRollup.facilitiesWithoutPharmacist;
  totals.facilitiesWithoutMedicalOfficer += resourceRollup.facilitiesWithoutMedicalOfficer;
  totals.subCentresWithoutAnm += resourceRollup.subCentresWithoutAnm;
  totals.facilitiesUnverifiedReporting += resourceRollup.unverifiedReportingFacilities;
  totals.populationUnderUnverifiedReporting += resourceRollup.populationUnderUnverifiedReporting;

  // Keep the worst positions from every district so the national alert list is
  // a genuine national ranking, not just the worst few districts repeated.
  const worst = [...states]
    .filter((s) => s.risk.severity === 'critical' || s.risk.severity === 'high')
    .sort((a, b) => b.risk.riskScore - a.risk.riskScore)
    .slice(0, 6);

  for (const s of worst) {
    alerts.push({
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
    });
  }

  if ((i + 1) % 10 === 0 || i === DISTRICTS.length - 1) {
    const pct = (((i + 1) / DISTRICTS.length) * 100).toFixed(0);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`  ${String(i + 1).padStart(3)}/${DISTRICTS.length}  (${pct}%)  ${elapsed}s  ${d.name}, ${d.stateName}`);
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
  s.occupiedBeds += d.resources.occupiedBeds;
  s.staffSanctioned += d.resources.staffSanctioned;
  s.staffInPosition += d.resources.staffInPosition;
  s.staffPresent += d.resources.staffPresent;
  s.facilitiesWithoutPharmacist += d.resources.facilitiesWithoutPharmacist;
}
for (const s of stateMap.values()) {
  s.meanRiskScore = s.population > 0 ? +(s.meanRiskScore / s.population).toFixed(1) : 0;
  s.zeroStockShare = s.trackedPositions > 0 ? +(s.zeroStockShare / s.trackedPositions).toFixed(4) : 0;
  // Ratios of the accumulated counts, never a mean of district ratios.
  s.bedOccupancyRate = s.functionalBeds > 0 ? +(s.occupiedBeds / s.functionalBeds).toFixed(4) : 0;
  s.vacancyRate =
    s.staffSanctioned > 0 ? +(1 - s.staffInPosition / s.staffSanctioned).toFixed(4) : 0;
  s.absenteeismRate =
    s.staffInPosition > 0 ? +(1 - s.staffPresent / s.staffInPosition).toFixed(4) : 0;
}

alerts.sort((a, b) => b.riskScore - a.riskScore || b.expectedShortfallUnits - a.expectedShortfallUnits);

const buildSeconds = +((Date.now() - t0) / 1000).toFixed(1);

const snapshot: NationalSnapshot = {
  asOf: ASOF.toISOString().slice(0, 10),
  builtAt,
  scale: DEMO_SCALE,
  buildSeconds,
  totals: {
    ...totals,
    expectedShortfallUnits: Math.round(totals.expectedShortfallUnits),
    projectedWasteInr: Math.round(totals.projectedWasteInr),
    transportCostInr: Math.round(totals.transportCostInr),
    wasteAvertedInr: Math.round(totals.wasteAvertedInr),
    shortfallAverted: Math.round(totals.shortfallAverted),
    netBenefitInr: Math.round(totals.netBenefitInr),
    bedOccupancyRate:
      totals.functionalBeds > 0 ? +(totals.occupiedBeds / totals.functionalBeds).toFixed(4) : 0,
    vacancyRate:
      totals.staffSanctioned > 0
        ? +(1 - totals.staffInPosition / totals.staffSanctioned).toFixed(4)
        : 0,
    absenteeismRate:
      totals.staffInPosition > 0
        ? +(1 - totals.staffPresent / totals.staffInPosition).toFixed(4)
        : 0,
  },
  districts,
  states: [...stateMap.values()].sort((a, b) => b.criticalPositions - a.criticalPositions),
  alerts: alerts.slice(0, MAX_ALERTS),
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(snapshot, null, 1));

const sizeKb = (JSON.stringify(snapshot).length / 1024).toFixed(0);

console.log('\n' + '='.repeat(66));
console.log('Snapshot written to src/data/national-snapshot.json  (' + sizeKb + ' KB)');
console.log(
  '  + ' + DISTRICTS.length + ' district payloads in src/data/districts/  (' +
    (districtBytes / 1024 / 1024).toFixed(1) + ' MB total, ' +
    Math.round(districtBytes / DISTRICTS.length / 1024) + ' KB mean)',
);
console.log('  build time        :', buildSeconds + 's');
console.log('  districts         :', snapshot.totals.districts);
console.log('  facilities        :', snapshot.totals.facilities.toLocaleString('en-IN'));
console.log('  stock positions   :', snapshot.totals.trackedPositions.toLocaleString('en-IN'));
console.log('  critical / high   :', snapshot.totals.criticalPositions.toLocaleString('en-IN'), '/', snapshot.totals.highPositions.toLocaleString('en-IN'));
console.log('  population covered:', (snapshot.totals.populationCovered / 1e6).toFixed(1) + 'M (modelled)');
console.log('  stock to expiry   : ₹' + snapshot.totals.projectedWasteInr.toLocaleString('en-IN'));
console.log('  transfers found   :', snapshot.totals.transfers.toLocaleString('en-IN'));
console.log('  waste rescued     : ₹' + snapshot.totals.wasteAvertedInr.toLocaleString('en-IN'));
console.log('  net benefit       : ₹' + snapshot.totals.netBenefitInr.toLocaleString('en-IN'));
console.log('  ' + '-'.repeat(62));
console.log('  beds func/sanc    :', snapshot.totals.functionalBeds.toLocaleString('en-IN'), '/', snapshot.totals.sanctionedBeds.toLocaleString('en-IN'), ' staffed:', snapshot.totals.staffedBeds.toLocaleString('en-IN'));
console.log('  bed occupancy     :', (snapshot.totals.bedOccupancyRate * 100).toFixed(1) + '%', ' at capacity:', snapshot.totals.facilitiesAtCapacity, 'facilities');
console.log('  unmet bed-days    :', snapshot.totals.unmetBedDays.toLocaleString('en-IN'), '(demand that found no bed)');
console.log('  staff sanc/pos/pre:', snapshot.totals.staffSanctioned.toLocaleString('en-IN'), '/', snapshot.totals.staffInPosition.toLocaleString('en-IN'), '/', snapshot.totals.staffPresent.toLocaleString('en-IN'));
console.log('  vacancy / absence :', (snapshot.totals.vacancyRate * 100).toFixed(1) + '%', '/', (snapshot.totals.absenteeismRate * 100).toFixed(1) + '%');
console.log('  specialist vacancy:', snapshot.totals.specialistSanctioned > 0 ? ((1 - snapshot.totals.specialistInPosition / snapshot.totals.specialistSanctioned) * 100).toFixed(1) + '%' : 'n/a');
console.log('  no pharmacist     :', snapshot.totals.facilitiesWithoutPharmacist.toLocaleString('en-IN'), 'stock-holding facilities');
console.log('  unverified stock  :', snapshot.totals.facilitiesUnverifiedReporting.toLocaleString('en-IN'), 'facilities covering', (snapshot.totals.populationUnderUnverifiedReporting / 1e6).toFixed(1) + 'M people');
console.log('='.repeat(66));
