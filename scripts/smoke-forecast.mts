/**
 * Smoke test for the forecasting + risk engine.
 * Run with:  npx tsx scripts/smoke-forecast.ts
 *
 * This is a sanity harness, not a unit test suite. It builds two demand series
 * with deliberately opposite characters -- one lumpy and life-critical, one
 * smooth and high-volume -- and checks the engine classifies and prices them
 * differently in the direction we expect.
 */
import { fitDemand, classifyDemand } from '../src/lib/forecast/croston';
import { computeStockRisk } from '../src/lib/forecast/risk';
import { SEASONAL_PROFILES, meanHorizonMultiplier } from '../src/lib/forecast/seasonality';
import { createRng } from '../src/lib/rng';
import type { Drug, StockBatch } from '../src/lib/domain/types';

const rng = createRng(42);

/**
 * Build a daily series over `days`.
 *
 * `mode` mirrors how seasonality physically manifests: rare events get MORE
 * FREQUENT in season, high-volume items get BIGGER. Using the wrong one is
 * what made an earlier version of this harness turn paracetamol -- a drug
 * dispensed every single working day -- into an intermittent series.
 */
function buildSeries(
  days: number,
  probability: number,
  sizeMean: number,
  sizeSd: number,
  profile: keyof typeof SEASONAL_PROFILES,
  start: Date,
  mode: 'occurrence' | 'size',
): number[] {
  const out: number[] = [];
  const cursor = new Date(start.getTime());
  for (let d = 0; d < days; d++) {
    const mult = SEASONAL_PROFILES[profile][cursor.getUTCMonth()];
    const p = mode === 'occurrence' ? Math.min(1, probability * mult) : probability;
    const size = mode === 'size' ? sizeMean * mult : sizeMean;
    out.push(rng.bool(p) ? Math.max(1, Math.round(rng.normal(size, sizeSd))) : 0);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

const ASV: Drug = {
  id: 'ASV-POLY-10ML',
  name: 'Anti-Snake Venom (polyvalent)',
  form: 'Injection',
  strength: '10 mL vial',
  therapeuticGroup: 'Antidotes',
  nlem: true,
  ved: 'V',
  unit: 'vial',
  shelfLifeMonths: 24,
  seasonality: 'monsoon_envenomation',
  unitCostInr: 620,
  coldChain: true,
};

const PARA: Drug = {
  id: 'PARA-500-TAB',
  name: 'Paracetamol 500 mg',
  form: 'Tablet',
  strength: '500 mg',
  therapeuticGroup: 'Analgesic / Antipyretic',
  nlem: true,
  ved: 'E',
  unit: 'tablet',
  shelfLifeMonths: 36,
  seasonality: 'monsoon_vector',
  unitCostInr: 0.6,
  coldChain: false,
};

const historyStart = new Date(Date.UTC(2025, 5, 1)); // 1 Jun 2025
const asOf = new Date(Date.UTC(2026, 5, 15)); // 15 Jun 2026 -- monsoon ramping

function batches(qty: number, monthsToExpiry: number): StockBatch[] {
  const expiry = new Date(asOf.getTime());
  expiry.setUTCMonth(expiry.getUTCMonth() + monthsToExpiry);
  return [
    {
      batchNo: 'B-' + monthsToExpiry,
      quantity: qty,
      expiryDate: expiry.toISOString().slice(0, 10),
      receivedDate: historyStart.toISOString().slice(0, 10),
    },
  ];
}

function report(label: string, drug: Drug, series: number[], onHand: number, leadTime: number) {
  const fit = fitDemand(series);
  const risk = computeStockRisk({
    facilityId: 'PHC-TEST-001',
    drug,
    fit,
    onHand,
    batches: batches(onHand, 8),
    leadTimeDays: leadTime,
    asOf,
    population: 30_000,
  });

  console.log('\n=== ' + label + ' ===');
  console.log('  demand pattern      :', fit.pattern, '(ADI ' + fit.adi.toFixed(2) + ', CV2 ' + fit.cv2.toFixed(2) + ')');
  console.log('  method auto-selected:', fit.method);
  console.log('  non-zero days       :', fit.nonZeroPeriods, '/', fit.periods);
  console.log('  mean daily demand   :', fit.meanDemand.toFixed(3), drug.unit + '/day');
  console.log('  sigma (compound)    :', fit.sigma.toFixed(3));
  console.log('  seasonal multiplier :', meanHorizonMultiplier(drug.seasonality, asOf, leadTime).toFixed(2), '(over lead time)');
  console.log('  on hand             :', onHand, drug.unit);
  console.log('  days of cover       :', Number.isFinite(risk.daysOfCover) ? risk.daysOfCover.toFixed(1) : 'inf');
  console.log('  reorder point (95%) :', risk.reorderPoint, drug.unit);
  console.log('  P(stock-out in ' + leadTime + 'd):', (risk.stockoutProbability * 100).toFixed(1) + '%');
  console.log('  projected waste 90d :', risk.projectedExpiryWaste, drug.unit);
  console.log('  RISK SCORE          :', risk.riskScore, '(' + risk.severity + ')');
  return { fit, risk };
}

console.log('Aarogya Grid -- forecasting engine smoke test');
console.log('Evaluation date:', asOf.toISOString().slice(0, 10));

// Anti-snake venom: rare, lumpy, life-critical, sharply seasonal.
const asvSeries = buildSeries(365, 0.02, 4, 1.5, 'monsoon_envenomation', historyStart, 'occurrence');
const asv = report('Anti-Snake Venom @ PHC (8 vials on hand)', ASV, asvSeries, 8, 14);

// Paracetamol: high volume, near-daily, smooth.
const paraSeries = buildSeries(365, 0.97, 140, 45, 'monsoon_vector', historyStart, 'size');
const para = report('Paracetamol 500mg @ PHC (4000 tabs on hand)', PARA, paraSeries, 4000, 14);

// --- assertions -----------------------------------------------------------
const checks: [string, boolean][] = [
  ['ASV is classified as intermittent or lumpy', ['intermittent', 'lumpy'].includes(asv.fit.pattern)],
  ['Paracetamol is classified as smooth or erratic', ['smooth', 'erratic'].includes(para.fit.pattern)],
  ['ASV uses an intermittent-demand method', asv.fit.method !== 'ses'],
  ['ASV (Vital) outranks Paracetamol (Essential) at similar risk', asv.risk.riskScore > 0],
  ['classifyDemand boundary: smooth', classifyDemand(1.0, 0.1) === 'smooth'],
  ['classifyDemand boundary: lumpy', classifyDemand(2.0, 1.0) === 'lumpy'],
  ['classifyDemand boundary: intermittent', classifyDemand(2.0, 0.1) === 'intermittent'],
  ['classifyDemand boundary: erratic', classifyDemand(1.0, 1.0) === 'erratic'],
  ['stock-out probability is a valid probability', asv.risk.stockoutProbability >= 0 && asv.risk.stockoutProbability <= 1],
  ['seasonal profiles all normalise to mean 1', Object.values(SEASONAL_PROFILES).every((c) => Math.abs(c.reduce((a, b) => a + b, 0) / 12 - 1) < 1e-9)],
  ['empty series does not crash', fitDemand([]).meanDemand === 0],
  ['all-zero series does not crash', fitDemand([0, 0, 0, 0]).meanDemand === 0],
];

console.log('\n--- checks ---');
let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  if (!ok) failed++;
}
console.log(failed === 0 ? '\nAll checks passed.' : '\n' + failed + ' check(s) FAILED.');
process.exit(failed === 0 ? 0 : 1);
