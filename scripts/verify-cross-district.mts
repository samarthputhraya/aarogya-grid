/**
 * Invariants for corridor consolidation and cross-district redistribution.
 * Run with:  npx tsx scripts/verify-cross-district.mts [districts]
 *
 * This is the safety net for the largest change ever made to the optimiser, and
 * it is deliberately paranoid. Three things happened at once: orders between
 * the same two facilities started sharing one vehicle, needs the benefit/cost
 * gate had declined started riding vehicles already going, and the planner
 * started being handed several districts at a time. Each of those is a way to
 * promise the same stock twice, or to bill a trip that never happens, or to
 * quietly let a neighbouring district's need be solved out of a district it was
 * not planning.
 *
 * `scripts/verify-batch-bounds.mts` still covers the pick-list arithmetic on
 * single-district plans. This covers the cluster.
 *
 * THE INVARIANT THAT MATTERS MOST is determinism under clustering: a district's
 * facilities, ledger and risk must be byte-identical whether that district is
 * simulated alone or inside a cluster. If it were not, then adding a neighbour
 * would silently move every number on that district's page, and no figure in
 * the deck could be reproduced. Everything else here is arithmetic; this one is
 * the load-bearing architectural claim.
 */
import { generateNetwork, DEMO_SCALE } from '../src/lib/sim/facilities';
import { DISTRICTS, DISTRICTS_BY_CODE, districtNeighbours } from '../src/lib/domain/geo';
import { buildStates, toTransferContexts, buildDistrictState } from '../src/lib/pipeline';
import {
  planRedistribution,
  newPlannerState,
  donatableUnits,
  type TransferContext,
} from '../src/lib/optimize/redistribute';

const ASOF = new Date(Date.UTC(2026, 8, 30));
const SEED = 20260930;
const SIMULATIONS = 600;
const PLAN_SIMS = 500;
const RADIUS_KM = 250;
const MAX_NEIGHBOURS = 4;

const sampleSize = Math.max(1, Number.parseInt(process.argv[2] ?? '6', 10));
const stride = Math.max(1, Math.floor(DISTRICTS.length / sampleSize));
const sample = Array.from({ length: sampleSize }, (_, i) => DISTRICTS[(i * stride) % DISTRICTS.length]);

const checks: [string, boolean][] = [];
function check(name: string, ok: boolean) {
  checks.push([name, ok]);
}

console.log('Aarogya Grid -- cross-district and consolidation invariants');
console.log('  sample :', sample.map((d) => d.name).join(', '));
console.log();

// ---------------------------------------------------------------------------
// 1. DETERMINISM UNDER CLUSTERING
// ---------------------------------------------------------------------------
{
  const d = sample[0];
  const nb = districtNeighbours(d.code, RADIUS_KM, MAX_NEIGHBOURS);
  const solo = generateNetwork(DEMO_SCALE, [d], SEED);
  const cluster = generateNetwork(DEMO_SCALE, [d, ...nb.map((n) => DISTRICTS_BY_CODE[n.code])], SEED);
  const clusterOwn = cluster.filter((f) => f.districtCode === d.code);
  check(
    'a district\'s facilities are identical alone and inside a cluster',
    JSON.stringify(solo) === JSON.stringify(clusterOwn),
  );

  const soloStates = buildStates(solo, { asOf: ASOF, seed: SEED, simulations: SIMULATIONS });
  const clusterStates = buildStates(cluster, { asOf: ASOF, seed: SEED, simulations: SIMULATIONS }).filter(
    (s) => s.facility.districtCode === d.code,
  );
  check(
    'a district\'s risk is identical alone and inside a cluster',
    JSON.stringify(soloStates.map((s) => s.risk)) === JSON.stringify(clusterStates.map((s) => s.risk)),
  );
  check(
    'a district\'s demand fit is identical alone and inside a cluster',
    JSON.stringify(soloStates.map((s) => s.fit)) === JSON.stringify(clusterStates.map((s) => s.fit)),
  );
}

// ---------------------------------------------------------------------------
// 2. PLAN INVARIANTS, over a sample of clusters sharing one planner state
// ---------------------------------------------------------------------------
let anyCrossDistrictOrder = false;
let anyRideAlong = false;
let totalOrders = 0;
let totalTrips = 0;

// One state for the whole sweep, exactly as the batch job does it, so that
// over-promising ACROSS districts would show up here too.
const shared = newPlannerState();
const originalDonatable = new Map<string, number>();

for (const d of sample) {
  const nb = districtNeighbours(d.code, RADIUS_KM, MAX_NEIGHBOURS).map((n) => n.code);
  const own = buildDistrictState(d.code, { asOf: ASOF, simulations: SIMULATIONS });
  const neighbours = nb.flatMap((code) => buildDistrictState(code, { asOf: ASOF, simulations: SIMULATIONS }));
  const contexts = toTransferContexts([...own, ...neighbours]);

  const ctxByKey = new Map<string, TransferContext>();
  for (const c of contexts) {
    const k = c.facility.id + '|' + c.drug.id;
    ctxByKey.set(k, c);
    if (!originalDonatable.has(k)) originalDonatable.set(k, donatableUnits(c));
  }

  const plan = planRedistribution(
    contexts,
    { asOf: ASOF, simulations: PLAN_SIMS, eligibleReceiver: (c) => c.facility.districtCode === d.code },
    shared,
  );

  totalOrders += plan.transfers.length;
  totalTrips += plan.trips.length;

  // -- receivers are scoped -------------------------------------------------
  const foreignReceiver = plan.transfers.filter((t) => {
    const to = contexts.find((c) => c.facility.id === t.toFacilityId);
    return to && to.facility.districtCode !== d.code;
  });
  check(`${d.name}: every order delivers into the district being planned`, foreignReceiver.length === 0);

  // -- the bill equals the trips --------------------------------------------
  const shareSum = plan.transfers.reduce((a, t) => a + t.estimatedCostInr, 0);
  const tripSum = plan.trips.reduce((a, t) => a + t.totalCostInr, 0);
  check(`${d.name}: per-order costs sum exactly to the transport budget`, shareSum === tripSum);
  check(`${d.name}: totalCostInr is the trip total`, Math.round(plan.totalCostInr) === Math.round(tripSum));

  // -- consolidation can only reduce the bill -------------------------------
  const standalone = plan.transfers.reduce((a, t) => a + t.standaloneCostInr, 0);
  check(`${d.name}: consolidated cost never exceeds one-vehicle-per-order`, tripSum <= standalone);

  // -- one trip per corridor, and every order is on one -----------------------
  const corridorIds = new Set(plan.transfers.map((t) => t.corridorId));
  check(`${d.name}: exactly one trip per corridor`, plan.trips.length === corridorIds.size);
  const tripIds = new Set(plan.trips.map((t) => t.id));
  check(`${d.name}: every order rides a trip that exists`, plan.transfers.every((t) => tripIds.has(t.corridorId)));
  check(
    `${d.name}: trip order counts match the orders on them`,
    plan.trips.every((tr) => tr.orders === plan.transfers.filter((t) => t.corridorId === tr.id).length),
  );

  // -- ride-alongs are never the reason a vehicle exists ---------------------
  for (const trip of plan.trips) {
    const on = plan.transfers.filter((t) => t.corridorId === trip.id);
    if (on.every((t) => t.rideAlong)) {
      check(`${d.name}: no trip consists only of ride-alongs`, false);
      break;
    }
  }
  check(
    `${d.name}: every ride-along is charged handling plus only the upgrade it forced`,
    plan.transfers.filter((t) => t.rideAlong).every((t) => t.estimatedCostInr === 60 + t.coldUpgradeInr),
  );
  check(
    `${d.name}: every ride-along was cheaper than its own vehicle`,
    plan.transfers.filter((t) => t.rideAlong).every((t) => t.estimatedCostInr < t.standaloneCostInr),
  );
  // An anchor never pays a cold-chain upgrade: it is charged to the rider that
  // forced it. A non-zero value here would mean the gate and the bill had
  // drifted apart again.
  check(
    `${d.name}: no anchor order carries a cold-chain upgrade`,
    plan.transfers.filter((t) => !t.rideAlong).every((t) => t.coldUpgradeInr === 0),
  );
  // The upgrade prices the whole vehicle, so a trip can only ever be sold one.
  check(
    `${d.name}: no trip is charged the cold-chain upgrade twice`,
    plan.trips.every(
      (trip) =>
        plan.transfers.filter((t) => t.corridorId === trip.id && t.coldUpgradeInr > 0).length <= 1,
    ),
  );
  // A trip that nobody upgraded must already have been cold, or must be ambient.
  // This is what catches the first-order-wins bug that let pass 3 quote an
  // upgrade against a run that was refrigerated all along.
  check(
    `${d.name}: an upgrade is only ever charged on a trip that is now cold`,
    plan.transfers
      .filter((t) => t.coldUpgradeInr > 0)
      .every((t) => plan.trips.find((trip) => trip.id === t.corridorId)?.coldChain === true),
  );

  // -- the unserved bookkeeping still agrees with itself ---------------------
  const histSum = Object.values(plan.unservedByReason).reduce((a, b) => a + b, 0);
  check(`${d.name}: unservedReceivers equals unserved.length`, plan.unservedReceivers === plan.unserved.length);
  check(`${d.name}: the reason histogram sums to the unserved count`, histSum === plan.unserved.length);
  check(
    `${d.name}: no reason count went negative when ride-alongs were subtracted`,
    Object.values(plan.unservedByReason).every((v) => v >= 0),
  );

  // -- rationales are complete ----------------------------------------------
  check(
    `${d.name}: no rationale has an unsubstituted cost placeholder`,
    plan.transfers.every((t) => !t.rationale.includes('{{COST}}')),
  );
  check(
    `${d.name}: every order quotes the cost it is actually charged`,
    plan.transfers.every((t) => t.rationale.includes('₹' + t.estimatedCostInr.toLocaleString('en-IN'))),
  );

  // -- pick lists still sum, and no batch is over-promised --------------------
  check(
    `${d.name}: every order's lines sum to its quantity`,
    plan.transfers.every((t) => t.lines.reduce((a, l) => a + l.quantity, 0) === t.quantity),
  );

  if (plan.transfers.some((t) => t.rideAlong)) anyRideAlong = true;
  if (plan.crossDistrictTrips > 0) anyCrossDistrictOrder = true;
}

// ---------------------------------------------------------------------------
// 3. NOTHING WAS PROMISED TWICE, ACROSS THE WHOLE SWEEP
// ---------------------------------------------------------------------------
{
  // `capacity` is decremented as stock is committed and is shared across every
  // district in the sweep. A negative entry means some district gave away stock
  // another district had already been promised.
  const negative = [...shared.capacity.entries()].filter(([, v]) => v < 0);
  check('no donor was drawn below zero across the whole sweep', negative.length === 0);

  const overspent = [...shared.capacity.entries()].filter(
    ([k, v]) => v > (originalDonatable.get(k) ?? 0),
  );
  check('no donor ended with more capacity than it started with', overspent.length === 0);

  // `committed` counts units booked out of one specific batch, nationally.
  check('every batch commitment is positive', [...shared.committed.values()].every((v) => v > 0));
  check('no expiry-rescue budget went negative', [...shared.wasteBudget.values()].every((v) => v >= 0));
}

check('the sweep produced at least one cross-district trip', anyCrossDistrictOrder);
check('the sweep produced at least one ride-along order', anyRideAlong);
check('consolidation actually consolidates (fewer trips than orders)', totalTrips < totalOrders);

// ---------------------------------------------------------------------------
// 4. THE OPTIONS TRAP
// ---------------------------------------------------------------------------
{
  // `{ ...DEFAULTS, ...options }` does not drop an explicit undefined, and a
  // wrapper forwarding optional config is exactly the code that produces one.
  // Undefined caps used to mean "every donor on earth is in range" and
  // "nothing is ever accepted"; both failures look like a modelling result.
  const d = sample[0];
  const own = buildDistrictState(d.code, { asOf: ASOF, simulations: SIMULATIONS });
  const ctx = toTransferContexts(own);
  const withDefaults = planRedistribution(ctx, { asOf: ASOF, simulations: PLAN_SIMS }, newPlannerState());
  const withUndefined = planRedistribution(
    ctx,
    {
      asOf: ASOF,
      simulations: PLAN_SIMS,
      maxDistanceKm: undefined,
      minBenefitCostRatio: undefined,
      perLineHandlingInr: undefined,
    },
    newPlannerState(),
  );
  check(
    'an explicitly-undefined option falls back to the default rather than disabling the check',
    withUndefined.transfers.length === withDefaults.transfers.length,
  );
}

// ---------------------------------------------------------------------------

console.log('--- checks ---');
let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  if (!ok) failed++;
}
console.log(
  failed === 0
    ? '\nAll ' + checks.length + ' checks passed.  ' + totalOrders + ' orders on ' + totalTrips + ' trips.'
    : '\n' + failed + ' of ' + checks.length + ' check(s) FAILED.',
);
process.exit(failed === 0 ? 0 : 1);
