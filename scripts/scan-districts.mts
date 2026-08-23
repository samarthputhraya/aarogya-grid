/**
 * Scans districts and ranks them, so we can (a) sanity-check that the pipeline
 * behaves sensibly across the whole country rather than in one hand-picked
 * place, and (b) choose a demo district that actually exhibits the failure the
 * product addresses.
 *
 * Run with:  npx tsx scripts/scan-districts.ts [count]
 */
import { buildDistrictState, toTransferContexts, summariseDistrict } from '../src/lib/pipeline';
import { planRedistribution } from '../src/lib/optimize/redistribute';
import { DISTRICTS } from '../src/lib/domain/geo';
import { districtReliability, districtPullFraction } from '../src/lib/sim/inventory';

const ASOF = new Date(Date.UTC(2026, 8, 30));
const count = Number(process.argv[2] ?? 40);

// Take a spread across states rather than the first N, which would all be Rajasthan.
const sample = DISTRICTS.filter((_, i) => i % Math.max(1, Math.floor(DISTRICTS.length / count)) === 0)
  .slice(0, count);

console.log('Scanning', sample.length, 'districts as of', ASOF.toISOString().slice(0, 10));
console.log();

interface Row {
  code: string;
  label: string;
  reliability: number;
  pull: number;
  critical: number;
  zeroPct: number;
  wasteInr: number;
  transfers: number;
  wasteRescuedInr: number;
  shortfallAverted: number;
  netBenefit: number;
}

const rows: Row[] = [];
const t0 = Date.now();

for (const d of sample) {
  const states = buildDistrictState(d.code, { asOf: ASOF, simulations: 600 });
  const summary = summariseDistrict(states);
  const plan = planRedistribution(toTransferContexts(states), { asOf: ASOF, simulations: 500 });

  rows.push({
    code: d.code,
    label: d.name + ', ' + d.stateName,
    reliability: districtReliability(d.code),
    pull: districtPullFraction(d.code),
    critical: summary.criticalPositions,
    zeroPct: summary.zeroStockShare * 100,
    wasteInr: summary.projectedWasteInr,
    transfers: plan.transfers.length,
    wasteRescuedInr: plan.totalWasteAvertedInr,
    shortfallAverted: plan.totalShortfallAverted,
    netBenefit: plan.netBenefitInr,
  });
  process.stdout.write('.');
}

console.log('\n\nscanned in', ((Date.now() - t0) / 1000).toFixed(1) + 's\n');

const hdr =
  'district'.padEnd(30) +
  'rel'.padEnd(6) +
  'pull'.padEnd(7) +
  'crit'.padEnd(6) +
  'zero%'.padEnd(7) +
  'waste ₹'.padEnd(11) +
  'txfr'.padEnd(6) +
  'rescued ₹'.padEnd(12) +
  'net ₹';
console.log(hdr);
console.log('-'.repeat(hdr.length + 4));

const sorted = [...rows].sort((a, b) => b.wasteRescuedInr - a.wasteRescuedInr);
for (const r of sorted) {
  console.log(
    r.label.slice(0, 29).padEnd(30) +
      r.reliability.toFixed(2).padEnd(6) +
      r.pull.toFixed(2).padEnd(7) +
      String(r.critical).padEnd(6) +
      r.zeroPct.toFixed(1).padEnd(7) +
      Math.round(r.wasteInr).toLocaleString('en-IN').padEnd(11) +
      String(r.transfers).padEnd(6) +
      Math.round(r.wasteRescuedInr).toLocaleString('en-IN').padEnd(12) +
      Math.round(r.netBenefit).toLocaleString('en-IN'),
  );
}

const totalWaste = rows.reduce((a, b) => a + b.wasteInr, 0);
const totalRescued = rows.reduce((a, b) => a + b.wasteRescuedInr, 0);
const totalNet = rows.reduce((a, b) => a + b.netBenefit, 0);

console.log('-'.repeat(hdr.length + 4));
console.log('TOTALS across', rows.length, 'districts:');
console.log('  stock heading to expiry :', '₹' + Math.round(totalWaste).toLocaleString('en-IN'));
console.log('  rescued by redistribution:', '₹' + Math.round(totalRescued).toLocaleString('en-IN'),
  '(' + ((totalRescued / (totalWaste || 1)) * 100).toFixed(1) + '% of it)');
console.log('  net objective value     :', '₹' + Math.round(totalNet).toLocaleString('en-IN'));

console.log('\nBest demo candidates (high rescued waste + high criticals):');
const best = [...rows]
  .sort((a, b) => b.wasteRescuedInr + b.critical * 1000 - (a.wasteRescuedInr + a.critical * 1000))
  .slice(0, 5);
for (const r of best) {
  console.log('  ' + r.code.padEnd(22) + r.label.padEnd(30) +
    'crit ' + String(r.critical).padEnd(5) + 'rescued ₹' + Math.round(r.wasteRescuedInr).toLocaleString('en-IN'));
}
