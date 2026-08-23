/**
 * End-to-end demonstration for a single district.
 *
 * Run with:  npx tsx scripts/demo-district.mts [districtCode]
 * Example:   npx tsx scripts/demo-district.mts DST-22-BASTAR
 *
 * Exercises the whole chain -- facility network, censored ledger, demand fit,
 * risk, and the redistribution plan -- and prints what a district officer would
 * actually be shown.
 */
import { buildDistrictState, toTransferContexts, summariseDistrict } from '../src/lib/pipeline';
import { planRedistribution } from '../src/lib/optimize/redistribute';
import { DISTRICTS_BY_CODE, DISTRICTS } from '../src/lib/domain/geo';
import { districtReliability } from '../src/lib/sim/inventory';

const districtCode = process.argv[2] ?? 'DST-22-BASTAR';
const district = DISTRICTS_BY_CODE[districtCode];
if (!district) {
  console.error('Unknown district:', districtCode);
  console.error('Try one of:', DISTRICTS.slice(0, 8).map((d) => d.code).join(', '), '...');
  process.exit(1);
}

const ASOF = new Date(Date.UTC(2026, 8, 30));
const INR = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

console.log('='.repeat(78));
console.log('AAROGYA GRID -- district control view');
console.log(district.name + ', ' + district.stateName + '   (' + districtCode + ')');
console.log('as-of ' + ASOF.toISOString().slice(0, 10));
console.log('='.repeat(78));

const t0 = Date.now();
const states = buildDistrictState(districtCode, { asOf: ASOF });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const summary = summariseDistrict(states);
const reliability = districtReliability(districtCode);

console.log('\nSUPPLY POSITION');
console.log('  facilities tracked      :', summary.facilities);
console.log('  stock positions tracked :', summary.trackedPositions.toLocaleString('en-IN'));
console.log('  positions at zero stock :', summary.criticalPositions >= 0
  ? (summary.zeroStockShare * 100).toFixed(1) + '%'
  : 'n/a');
console.log('  critical / high risk    :', summary.criticalPositions, '/', summary.highPositions);
console.log('  mean risk score         :', summary.meanRiskScore, '(population-weighted)');
console.log('  expected unmet demand   :', summary.expectedShortfallUnits.toLocaleString('en-IN'), 'units before next resupply');
console.log('  stock heading to expiry :', INR(summary.projectedWasteInr), 'over 90 days');
console.log('  district supply reliability (modelled):', (reliability * 100).toFixed(0) + '%');
console.log('  pipeline runtime        :', elapsed + 's');

// --- worst positions -------------------------------------------------------
const worst = [...states].sort((a, b) => b.risk.riskScore - a.risk.riskScore).slice(0, 10);

console.log('\nHIGHEST-RISK STOCK POSITIONS');
console.log(
  '  ' +
    'facility'.padEnd(26) +
    'drug'.padEnd(30) +
    'on hand'.padEnd(10) +
    'cover'.padEnd(9) +
    'P(out)'.padEnd(8) +
    'score',
);
console.log('  ' + '-'.repeat(90));
for (const s of worst) {
  const cover = Number.isFinite(s.risk.daysOfCover) ? s.risk.daysOfCover.toFixed(0) + 'd' : 'inf';
  console.log(
    '  ' +
      s.facility.name.slice(0, 25).padEnd(26) +
      (s.drug.name + ' ' + s.drug.strength).slice(0, 29).padEnd(30) +
      (s.risk.onHand + ' ' + s.drug.unit).slice(0, 9).padEnd(10) +
      cover.padEnd(9) +
      ((s.risk.stockoutProbability * 100).toFixed(0) + '%').padEnd(8) +
      s.risk.riskScore + ' [' + s.risk.severity + ']',
  );
}

// --- redistribution plan ---------------------------------------------------
console.log('\nREDISTRIBUTION PLAN');
const t1 = Date.now();
const plan = planRedistribution(toTransferContexts(states), { asOf: ASOF });
const planMs = Date.now() - t1;

console.log('  transfers recommended   :', plan.transfers.length);
console.log('  transport spend         :', INR(plan.totalCostInr));
console.log('  unmet demand averted    :', plan.totalShortfallAverted.toFixed(0), 'units');
console.log('  stock rescued from expiry:', plan.totalWasteAvertedUnits.toLocaleString('en-IN'),
  'units (' + INR(plan.totalWasteAvertedInr) + ')');
console.log('  net benefit (objective) :', INR(plan.netBenefitInr));
console.log('  receivers with no feasible donor:', plan.unservedReceivers);
console.log('  solver runtime          :', planMs + 'ms');

console.log('\nTOP DISPATCH ORDERS');
for (const t of plan.transfers.slice(0, 5)) {
  console.log('\n  * ' + t.rationale);
  console.log('    pick list: ' + t.lines.map((l) => `${l.batchNo} x ${l.quantity} (exp ${l.expiryDate})`).join('  |  '));
  console.log('    risk reduction: ' + (t.riskReduction * 100).toFixed(0) + ' pp' +
    ' | cost ' + INR(t.estimatedCostInr) +
    ' | waste averted ' + t.wasteAvertedUnits + ' units');
}

// --- what the plan could NOT do -------------------------------------------
// Printed with the same prominence as the orders on purpose. A planner that
// only reports its successes is reporting a numerator.
console.log('\nNEEDS WITH NO FEASIBLE DISPATCH');
const served = plan.transfers.length;
const denominator = served + plan.unservedReceivers;
console.log('  coverage: ' + served + ' of ' + denominator +
  (denominator > 0 ? ' (' + ((served / denominator) * 100).toFixed(0) + '%)' : ''));
for (const [reason, n] of Object.entries(plan.unservedByReason)) {
  if (n === 0) continue;
  const share = plan.unservedReceivers > 0 ? ((n / plan.unservedReceivers) * 100).toFixed(0) : '0';
  console.log('  ' + reason.padEnd(24) + String(n).padStart(5) + '  (' + share + '%)');
}
for (const u of plan.unserved.slice(0, 5)) {
  console.log('  - ' + (u.facilityName + ' / ' + u.drugName).slice(0, 46).padEnd(48) +
    '[' + u.ved + '] need ' + u.neededUnits + ' ' + u.unit + 's, short ' + u.expectedShortfallUnits.toFixed(1) +
    ' -> ' + u.reason +
    (u.bestBenefitCostRatio !== null ? ' (best B/C ' + u.bestBenefitCostRatio.toFixed(2) + ')' : '') +
    (u.nearestDonorKm !== null ? ', nearest donor ' + u.nearestDonorKm.toFixed(0) + ' km' : ''));
}

if (plan.transfers.length === 0) {
  console.log('  (no transfer cleared the benefit-cost threshold in this district)');
}

console.log('\n' + '='.repeat(78));
console.log('NOTE: facility-level stock and consumption figures are SIMULATED.');
console.log('Districts, coordinates and the facility tier structure are real.');
console.log('='.repeat(78));
