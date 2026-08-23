/**
 * Measures how badly censored demand biases forecasting, and how much the
 * censoring-aware estimator recovers.
 *
 * Run with:  npx tsx scripts/eval-censoring.ts
 *
 * This is the evaluation a real deployment can never run on itself, because it
 * requires knowing the demand that was turned away. The simulator knows it, so
 * we can quantify the effect here and carry the number into the design.
 */
import { generateNetwork, DEMO_SCALE } from '../src/lib/sim/facilities';
import { simulateInventory, districtReliability } from '../src/lib/sim/inventory';
import { fitDemand, fitDemandCensored } from '../src/lib/forecast/croston';
import { formularyFor } from '../src/lib/domain/drugs';
import { createRng } from '../src/lib/rng';

const ASOF = new Date(Date.UTC(2026, 8, 30)); // 30 Sep 2026
const HISTORY_DAYS = 365;
const SAMPLE_PAIRS = 4000;

type Tier = 'disrupted' | 'strained' | 'functioning';

function tierOf(reliability: number): Tier {
  if (reliability < 0.62) return 'disrupted';
  if (reliability < 0.8) return 'strained';
  return 'functioning';
}

interface Bucket {
  n: number;
  naiveBiasSum: number;
  correctedBiasSum: number;
  stockoutDaySum: number;
  unmetSum: number;
  trueDemandSum: number;
}

function emptyBucket(): Bucket {
  return { n: 0, naiveBiasSum: 0, correctedBiasSum: 0, stockoutDaySum: 0, unmetSum: 0, trueDemandSum: 0 };
}

console.log('Aarogya Grid -- censored demand evaluation');
console.log('as-of', ASOF.toISOString().slice(0, 10), '| history', HISTORY_DAYS, 'days');

const t0 = Date.now();
const network = generateNetwork(DEMO_SCALE);
console.log('network:', network.length.toLocaleString(), 'facilities across',
  new Set(network.map((f) => f.districtCode)).size, 'districts');

// Sample facility x drug pairs, skipping warehouses (they are stocking points,
// not dispensing points, so censoring does not apply the same way).
const dispensing = network.filter((f) => f.type !== 'DW');
const rng = createRng(7);
const buckets: Record<Tier, Bucket> = {
  disrupted: emptyBucket(),
  strained: emptyBucket(),
  functioning: emptyBucket(),
};

let evaluated = 0;
let skippedTooSparse = 0;

for (let i = 0; i < SAMPLE_PAIRS; i++) {
  const facility = rng.pick(dispensing);
  const formulary = formularyFor(facility.type);
  const drug = rng.pick(formulary);

  const sim = simulateInventory(facility, drug, {
    asOf: ASOF,
    historyDays: HISTORY_DAYS,
    seed: 20260930,
  });

  const trueMean = sim.trueSeries.reduce((a, b) => a + b, 0) / HISTORY_DAYS;
  // Very rare items give unstable percentage errors; require a meaningful base.
  if (trueMean < 0.05) {
    skippedTooSparse++;
    continue;
  }

  /**
   * BASELINE: the SAME estimator run on UNCENSORED data.
   *
   * Comparing against the flat annual mean of `trueSeries` would be wrong, and
   * an earlier version of this script did exactly that. Croston/SBA/SES are
   * recency-weighted, so on a drug peaking in September they legitimately sit
   * above the annual average -- that gap is seasonality doing its job, not
   * censoring bias. Holding the estimator fixed and varying only whether its
   * input is censored isolates the effect we actually want to measure.
   */
  const groundTruth = fitDemand(sim.trueSeries).meanDemand;
  if (groundTruth < 0.05) {
    skippedTooSparse++;
    continue;
  }

  const naive = fitDemand(sim.recordedSeries);
  const corrected = fitDemandCensored(sim.recordedSeries, sim.censoredMask);

  const naiveBias = (naive.meanDemand - groundTruth) / groundTruth;
  const correctedBias = (corrected.meanDemand - groundTruth) / groundTruth;

  const tier = tierOf(districtReliability(facility.districtCode));
  const b = buckets[tier];
  b.n++;
  b.naiveBiasSum += naiveBias;
  b.correctedBiasSum += correctedBias;
  b.stockoutDaySum += sim.stockoutDays;
  b.unmetSum += sim.unmetUnits;
  b.trueDemandSum += sim.trueSeries.reduce((a, b2) => a + b2, 0);
  evaluated++;
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

function pct(x: number): string {
  const s = (x * 100).toFixed(1);
  return (x >= 0 ? '+' : '') + s + '%';
}

console.log('\nEvaluated', evaluated.toLocaleString(), 'facility x drug pairs in', elapsed + 's');
console.log('(skipped', skippedTooSparse.toLocaleString(), 'pairs with demand too sparse for a stable percentage)\n');

const header = ['district tier', 'pairs', 'stockout days/yr', 'unmet demand', 'naive bias', 'corrected bias'];
console.log(header.map((h, i) => h.padEnd([16, 8, 18, 14, 12, 15][i])).join(''));
console.log('-'.repeat(83));

const order: Tier[] = ['functioning', 'strained', 'disrupted'];
for (const tier of order) {
  const b = buckets[tier];
  if (b.n === 0) continue;
  const unmetShare = b.unmetSum / (b.trueDemandSum || 1);
  const row = [
    tier.padEnd(16),
    String(b.n).padEnd(8),
    (b.stockoutDaySum / b.n).toFixed(1).padEnd(18),
    pct(unmetShare).padEnd(14),
    pct(b.naiveBiasSum / b.n).padEnd(12),
    pct(b.correctedBiasSum / b.n).padEnd(15),
  ];
  console.log(row.join(''));
}

const all = order.reduce(
  (acc, t) => {
    const b = buckets[t];
    acc.n += b.n;
    acc.naive += b.naiveBiasSum;
    acc.corrected += b.correctedBiasSum;
    return acc;
  },
  { n: 0, naive: 0, corrected: 0 },
);

const naiveAvg = all.naive / all.n;
const corrAvg = all.corrected / all.n;

console.log('-'.repeat(83));
console.log('OVERALL         naive bias', pct(naiveAvg), '| corrected bias', pct(corrAvg));

// Report the change in ABSOLUTE bias. Reporting a "percent of bias removed"
// is meaningless when the two biases have opposite signs, and would overstate
// the result -- so we state both numbers and let the direction speak.
const improvedAbs = Math.abs(naiveAvg) - Math.abs(corrAvg);
if (improvedAbs > 0) {
  console.log('Correction reduces absolute bias by', (improvedAbs * 100).toFixed(1), 'percentage points.');
} else {
  console.log('Correction does NOT improve the overall average (it moves absolute bias by',
    (improvedAbs * 100).toFixed(1), 'pp) -- see the per-tier rows, where it matters most.');
}

const dis = buckets.disrupted;
if (dis.n > 0) {
  const dn = dis.naiveBiasSum / dis.n;
  const dc = dis.correctedBiasSum / dis.n;
  console.log('In DISRUPTED districts specifically: naive', pct(dn), '-> corrected', pct(dc),
    '(' + ((Math.abs(dn) - Math.abs(dc)) * 100).toFixed(1) + ' pp absolute change)');
}

console.log('\nReading: a negative bias means the forecast UNDERSTATES real demand --');
console.log('the facility gets allocated less than it needs, so it stocks out again.');
console.log('Baseline is the same estimator run on uncensored demand, so seasonality');
console.log('and recency weighting cancel out and only the censoring effect remains.');
