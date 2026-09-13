/**
 * Every dispatch order is one a storekeeper can actually pick and a ticket can
 * actually track. Part of `npm test`.
 *
 * Two halves, because they catch different things:
 *
 *   1. THE PLANNER, run fresh on a few districts: order quantities equal the sum
 *      of their pick lines, no line asks a batch for more than it holds, and no
 *      batch is promised twice across the plan.
 *   2. THE SHIPPED PAYLOADS, all of them: what a judge opens. Whole-unit
 *      quantities (19 shipped orders once carried 25.799999999999997 vials and
 *      could not be dispatched by either route), one order per donor x receiver x
 *      drug (seven ids once collided, and the second order of each pair could
 *      never be issued), and a rationale that does not claim a stock-out risk
 *      was cut when the card beside it shows it was not (340 orders once did).
 *
 * The planner half runs on standalone district plans; the shipped half is the
 * only place the national shared planner state is exercised, which is where the
 * fractional and duplicate defects actually lived.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDistrictState, toTransferContexts } from '../src/lib/pipeline';
import { planRedistribution } from '../src/lib/optimize/redistribute';
import { DISTRICTS } from '../src/lib/domain/geo';

const ASOF = new Date(Date.UTC(2026, 8, 30));
const SIMULATIONS = Number(process.env.SIMS ?? 1200);
const codes = (process.argv[2] ? [process.argv[2]] : DISTRICTS.slice(0, 6).map((d) => d.code));

let failures = 0;
let checks = 0;
function check(name: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) console.log('  ok   ' + name + (detail ? '  -- ' + detail : ''));
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  -- ' + detail : ''));
  }
}

console.log('\nthe planner, fresh');
let orders = 0, lines = 0, failSum = 0, failBatch = 0, failAgg = 0, failMissing = 0, failHead = 0;
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
      if (failSum <= 3) console.log('       SUM MISMATCH', code, t.fromFacilityId, t.drugId, 'qty', t.quantity, 'lines', sum);
    }
    if (t.batchNo !== t.lines[0].batchNo) {
      failHead++;
      if (failHead <= 3) console.log('       batchNo != lines[0]', code, t.fromFacilityId, t.drugId);
    }
    for (const l of t.lines) {
      const key = t.fromFacilityId + '|' + t.drugId + '|' + l.batchNo;
      const held = batchQty.get(key);
      if (held === undefined) {
        failBatch++;
        console.log('       UNKNOWN BATCH', code, key);
        continue;
      }
      if (l.quantity > Math.floor(held)) {
        failBatch++;
        maxOver = Math.max(maxOver, l.quantity - held);
        if (failBatch <= 3) console.log('       LINE > BATCH', code, key, 'line', l.quantity, 'batch', held);
      }
      promised.set(key, (promised.get(key) ?? 0) + l.quantity);
    }
  }
  for (const [key, q] of promised) {
    const held = Math.floor(batchQty.get(key) ?? 0);
    if (q > held) {
      failAgg++;
      maxOver = Math.max(maxOver, q - held);
      if (failAgg <= 5) console.log('       AGGREGATE OVER-PROMISE', code, key, 'promised', q, 'held', held);
    }
  }
  console.log('       ' + code.padEnd(22), 'transfers', String(plan.transfers.length).padStart(4),
    'unserved', String(plan.unservedReceivers).padStart(5));
}

// A planner that produces nothing passes every per-order check vacuously.
check('the planner produced orders to check', orders > 0, orders + ' orders, ' + lines + ' lines, ' + multiBatch + ' multi-batch');
check('every order has pick lines', failMissing === 0, failMissing + ' without');
check('sum(lines) equals the order quantity', failSum === 0, failSum + ' mismatched');
check('batchNo names the first pick line', failHead === 0, failHead + ' mismatched');
check('no line asks a batch for more than it holds', failBatch === 0, failBatch + ' over, worst by ' + maxOver);
check('no batch is promised twice across the plan', failAgg === 0, failAgg + ' over-promised');

console.log('\nthe shipped payloads');
{
  interface ShippedOrder {
    id: string;
    quantity: number;
    lines: { quantity: number }[];
    riskReduction: number;
    receiverStockoutProbBefore: number;
    rationale: string;
  }
  const dir = resolve(process.cwd(), 'src/data/districts');
  let shipped = 0;
  const fractional: string[] = [];
  const duplicate: string[] = [];
  const falseCut: string[] = [];
  let files = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    files++;
    const payload = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as { orders: ShippedOrder[] };
    const ids = new Set<string>();
    for (const o of payload.orders) {
      shipped++;
      const whole = (x: number) => Number.isInteger(x) && x > 0;
      if (!whole(o.quantity) || !o.lines.every((l) => whole(l.quantity))) {
        fractional.push(f + ' ' + o.id + ' q=' + o.quantity);
      }
      if (ids.has(o.id)) duplicate.push(f + ' ' + o.id);
      ids.add(o.id);
      // "cutting stock-out risk [from X%] to Y%" must mean Y < X.
      const m = /cutting stock-out risk (?:from (\d+)% )?to (\d+)%/.exec(o.rationale);
      if (m) {
        const before = m[1] !== undefined ? Number(m[1]) : null;
        const after = Number(m[2]);
        const beforeOnCard = /against a (\d+)% chance/.exec(o.rationale);
        const b = before ?? (beforeOnCard ? Number(beforeOnCard[1]) : null);
        if (b !== null && after >= b) falseCut.push(f + ' ' + o.id + ' ' + b + '% -> ' + after + '%');
      }
    }
  }
  check('every district payload is present', files === DISTRICTS.length, files + ' of ' + DISTRICTS.length);
  check('the shipped plan has orders to check', shipped > 0, shipped + ' orders');
  check('every shipped quantity is a whole number of units', fractional.length === 0,
    fractional.length + ' fractional' + (fractional.length ? ': ' + fractional.slice(0, 3).join('; ') : ''));
  check('every shipped order id is unique within its district', duplicate.length === 0,
    duplicate.length + ' duplicated' + (duplicate.length ? ': ' + duplicate.slice(0, 3).join('; ') : ''));
  check('no rationale claims a risk cut the numbers do not show', falseCut.length === 0,
    falseCut.length + ' false' + (falseCut.length ? ': ' + falseCut.slice(0, 3).join('; ') : ''));
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + '  ' + (checks - failures) + '/' + checks + ' checks');
process.exit(failures === 0 ? 0 : 1);
