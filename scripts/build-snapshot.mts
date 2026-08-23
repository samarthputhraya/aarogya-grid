/**
 * Builds the precomputed national snapshot the dashboard reads.
 *
 * Run with:  npx tsx scripts/build-snapshot.ts
 * Output:    src/data/national-snapshot.json
 *
 * This is the batch job. Against real data it would run nightly off a DVDMS /
 * HMIS extract; here it runs off the simulator. Either way the app reads the
 * same artefact, which is the point -- the UI has no idea where the numbers
 * came from.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { buildDistrictState, toTransferContexts, summariseDistrict } from '../src/lib/pipeline';
import { planRedistribution } from '../src/lib/optimize/redistribute';
import { DISTRICTS, STATES, STATES_BY_CODE, districtPopulation } from '../src/lib/domain/geo';
import { districtReliability, districtPullFraction } from '../src/lib/sim/inventory';
import { DEMO_SCALE } from '../src/lib/sim/facilities';
import type {
  NationalSnapshot,
  DistrictSnapshot,
  StateSnapshot,
  AlertRow,
  NationalTotals,
} from '../src/lib/snapshot-types';

const ASOF = new Date(Date.UTC(2026, 8, 30));
const SIMULATIONS = 600; // lower than the interactive path -- this runs 128x
const MAX_ALERTS = 250;

const outPath = resolve(process.cwd(), 'src/data/national-snapshot.json');

console.log('Building national snapshot');
console.log('  as-of      :', ASOF.toISOString().slice(0, 10));
console.log('  districts  :', DISTRICTS.length);
console.log('  scale      :', JSON.stringify(DEMO_SCALE));
console.log();

const t0 = Date.now();
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
};

for (let i = 0; i < DISTRICTS.length; i++) {
  const d = DISTRICTS[i];
  const states = buildDistrictState(d.code, { asOf: ASOF, simulations: SIMULATIONS });
  const summary = summariseDistrict(states);
  const plan = planRedistribution(toTransferContexts(states), { asOf: ASOF, simulations: 500 });

  const population = districtPopulation(d.code);

  districts.push({
    ...summary,
    reliability: +districtReliability(d.code).toFixed(3),
    pullFraction: +districtPullFraction(d.code).toFixed(3),
    population,
    transfers: plan.transfers.length,
    transportCostInr: Math.round(plan.totalCostInr),
    wasteAvertedInr: Math.round(plan.totalWasteAvertedInr),
    shortfallAverted: Math.round(plan.totalShortfallAverted),
    netBenefitInr: Math.round(plan.netBenefitInr),
  });

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
}
for (const s of stateMap.values()) {
  s.meanRiskScore = s.population > 0 ? +(s.meanRiskScore / s.population).toFixed(1) : 0;
  s.zeroStockShare = s.trackedPositions > 0 ? +(s.zeroStockShare / s.trackedPositions).toFixed(4) : 0;
}

alerts.sort((a, b) => b.riskScore - a.riskScore || b.expectedShortfallUnits - a.expectedShortfallUnits);

const buildSeconds = +((Date.now() - t0) / 1000).toFixed(1);

const snapshot: NationalSnapshot = {
  asOf: ASOF.toISOString().slice(0, 10),
  // Stamped from the build clock, not from inside the deterministic pipeline.
  builtAt: new Date().toISOString(),
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
console.log('='.repeat(66));
