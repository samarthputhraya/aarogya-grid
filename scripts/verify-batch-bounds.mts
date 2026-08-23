/** THROWAWAY verification of PART B item 4. Delete after running. */
import { buildDistrictState, toTransferContexts } from '../src/lib/pipeline';
import { planRedistribution } from '../src/lib/optimize/redistribute';
import { DISTRICTS } from '../src/lib/domain/geo';

const ASOF = new Date(Date.UTC(2026, 8, 30));
const SIMULATIONS = Number(process.env.SIMS ?? 1200);
const codes = (process.argv[2] ? [process.argv[2]] : DISTRICTS.slice(0, 6).map((d) => d.code));

let orders = 0, lines = 0, failSum = 0, failBatch = 0, failAgg = 0, failMissing = 0;
let multiBatch = 0, maxOver = 0;

for (const code of codes) {
  const states = buildDistrictState(code, { asOf: ASOF, simulations: SIMULATIONS });
  const plan = planRedistribution(toTransferContexts(states), { asOf: ASOF, simulations: 500 });

  // batch quantity lookup: facilityId|drugId|batchNo -> quantity
  const batchQty = new Map<string, number>();
  for (const s of states) {
    for (const b of s.sim.batches) batchQty.set(s.facility.id + '|' + s.drug.id + '|' + b.batchNo, b.quantity);
  }
  const promised = new Map<string, number>();

  for (const t of plan.transfers) {
    orders++;
    if (!t.lines || t.lines.length === 0) { failMissing++; continue; }
    if (t.lines.length > 1) multiBatch++;
    lines += t.lines.length;
    const sum = t.lines.reduce((a, l) => a + l.quantity, 0);
    if (sum !== t.quantity) {
      failSum++;
      if (failSum <= 3) console.log('SUM MISMATCH', code, t.fromFacilityId, t.drugId, 'qty', t.quantity, 'lines', sum);
    }
    if (t.batchNo !== t.lines[0].batchNo) console.log('batchNo != lines[0]', code, t.fromFacilityId, t.drugId);
    for (const l of t.lines) {
      const key = t.fromFacilityId + '|' + t.drugId + '|' + l.batchNo;
      const held = batchQty.get(key);
      if (held === undefined) {
        failBatch++;
        console.log('UNKNOWN BATCH', code, key);
        continue;
      }
      if (l.quantity > Math.floor(held)) {
        failBatch++;
        maxOver = Math.max(maxOver, l.quantity - held);
        if (failBatch <= 3) console.log('LINE > BATCH', code, key, 'line', l.quantity, 'batch', held);
      }
      promised.set(key, (promised.get(key) ?? 0) + l.quantity);
    }
  }
  for (const [key, q] of promised) {
    const held = Math.floor(batchQty.get(key) ?? 0);
    if (q > held) {
      failAgg++;
      maxOver = Math.max(maxOver, q - held);
      if (failAgg <= 5) console.log('AGGREGATE OVER-PROMISE', code, key, 'promised', q, 'held', held);
    }
  }
  console.log(code.padEnd(22), 'transfers', String(plan.transfers.length).padStart(4),
    'unserved', String(plan.unservedReceivers).padStart(5),
    'unserved.length', String(plan.unserved.length).padStart(5),
    'histSum', Object.values(plan.unservedByReason).reduce((a, b) => a + b, 0));
}

console.log('\n--- TOTALS ---');
console.log('districts checked        :', codes.length);
console.log('orders                   :', orders);
console.log('lines                    :', lines, '(multi-batch orders:', multiBatch + ')');
console.log('orders with no lines     :', failMissing);
console.log('sum(lines) != quantity   :', failSum);
console.log('line > its batch qty     :', failBatch);
console.log('batch over-promised agg  :', failAgg);
console.log('max over-promise units   :', maxOver);
process.exit(failSum + failBatch + failAgg + failMissing === 0 ? 0 : 1);
