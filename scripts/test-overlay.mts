/**
 * The live-loop tests: overlay store, Tier-1 recompute, and the commit budget.
 *
 * Run with:  npx tsx scripts/test-overlay.mts   (part of `npm test`)
 *
 * Offline. The HTTP round trip -- commit, SSE, reload -- is exercised against a
 * real running server by `scripts/rehearse-live.mjs`, because the things that
 * break there (proxy buffering, prerendered HTML, `Last-Event-ID`) cannot be
 * reproduced by calling functions.
 *
 * WHAT THIS FILE IS ACTUALLY DEFENDING
 * ------------------------------------
 * WS2's acceptance number is that a committed report changes a risk row
 * server-side in under 100 ms. That is easy to satisfy by accident and easy to
 * lose by accident -- the recompute simulates every carrier of a drug in a
 * district to rebuild the forecast share, so one careless widening of that loop
 * (every drug instead of one, say) turns 60 ms into 3 seconds and nothing else
 * in the suite would notice.
 */
import {
  recordStockEvent,
  overlayFor,
  overlayLookup,
  eventsSince,
  overlaySnapshot,
  currentSeq,
  resetOverlay,
  hydrate,
  markDurability,
  durabilitySince,
  durabilityMap,
  restoreReport,
  noteRestoreFailure,
  applyForeignStockEvent,
  supersedes,
  type OverlayRisk,
  type StockEvent,
} from '../src/lib/overlay/store';
import { applyBusMessage } from '../src/lib/live/apply';
import { INSTANCE_ID, splitScoped } from '../src/lib/live/instance';
import { resetTickets, getTicket, putTicket, nextTicketSeq } from '../src/lib/dispatch/store';
import type { DispatchTicket } from '../src/lib/dispatch/ticket';
import {
  recomputePosition,
  UnknownFacilityError,
  UnstockedDrugError,
} from '../src/lib/overlay/recompute';
import { DISTRICTS } from '../src/lib/domain/geo';
import { generateNetwork, DEMO_SCALE } from '../src/lib/sim/facilities';
import { asForecastCache, asForecastMethod } from '../src/lib/forecast/timesfm';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The same cache and gate the route injects.
 *
 * Read from disk rather than imported: `runtime-forecast.ts` is `server-only`,
 * which throws outside a bundler, and the point of injecting the cache is that
 * this file can exercise the real code path without one.
 */
const cachePath = resolve(process.cwd(), 'src/data/forecast-cache.json');
const methodPath = resolve(process.cwd(), 'src/data/forecast-method.json');
const SETUP = {
  cache: existsSync(cachePath)
    ? asForecastCache(JSON.parse(readFileSync(cachePath, 'utf8')))
    : null,
  method: existsSync(methodPath)
    ? asForecastMethod(JSON.parse(readFileSync(methodPath, 'utf8')))
    : null,
};

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  -- ' + detail : ''));
  }
}

const dummyRisk = (onHand: number): OverlayRisk => ({
  onHand,
  previousOnHand: 0,
  stockoutProbability: 0.1,
  previousStockoutProbability: 0.9,
  riskScore: 10,
  previousRiskScore: 90,
  severity: 'low',
  previousSeverity: 'critical',
  daysOfCover: 30,
  reorderPoint: 100,
  expectedShortfallUnits: 0,
  forecastSource: 'croston',
});

const emit = (facilityId: string, drugId: string, onHand: number) =>
  recordStockEvent({
    facilityId,
    facilityName: 'Test facility',
    districtCode: 'DST-10-PURNIA',
    drugId,
    drugName: 'Test drug',
    onHand,
    source: 'typed',
    durability: 'pending',
    recomputeMs: 1,
    risk: dummyRisk(onHand),
  });

console.log('\noverlay store');
resetOverlay();
{
  check('starts empty', currentSeq() === 0 && overlaySnapshot().entries.length === 0);
  const a = emit('F1', 'ORS-SACHET', 50);
  const b = emit('F2', 'ORS-SACHET', 20);
  check('sequence is monotonic from 1', a.seq === 1 && b.seq === 2, a.seq + ',' + b.seq);
  check('a position reads back its correction', overlayFor('F1', 'ORS-SACHET')?.onHand === 50);
  check('an uncorrected position reads back nothing', overlayFor('F9', 'ORS-SACHET') === undefined);

  // A second report for the same shelf replaces the first: a stock-take is a
  // position, not a delta, so the newest is simply the truth.
  const c = emit('F1', 'ORS-SACHET', 75);
  check('a later report supersedes an earlier one', overlayFor('F1', 'ORS-SACHET')?.onHand === 75);
  check('and still advances the sequence', c.seq === 3);
  check('but does not duplicate the position', overlaySnapshot().entries.length === 2);
}
{
  const lookup = overlayLookup();
  check('the pipeline lookup returns the override', lookup('F1', 'ORS-SACHET').onHand === 75);
  check('and an empty object for anything else', lookup('F3', 'ORS-SACHET').onHand === undefined);
}
{
  const since1 = eventsSince(1);
  check('replay from a cursor returns only what follows', since1.events.length === 2, String(since1.events.length));
  check('replay reports no gap when history is intact', since1.gap === false);
  check('replay from the head returns nothing', eventsSince(currentSeq()).events.length === 0);
  check('replay from 0 returns everything', eventsSince(0).events.length === 3);
}
{
  // The ring buffer is bounded, and a client whose cursor has fallen off it must
  // be TOLD. Replaying only what survives would leave it quietly incomplete.
  resetOverlay();
  for (let i = 0; i < 260; i++) emit('F' + i, 'ORS-SACHET', i);
  const stale = eventsSince(5);
  check('the buffer is capped', overlaySnapshot().events.length <= 200, String(overlaySnapshot().events.length));
  check('a cursor older than the buffer reports a gap', stale.gap === true);
  check('every correction survives even when its event does not', overlaySnapshot().entries.length === 260);
  check('a fresh cursor still reports no gap', eventsSince(currentSeq() - 1).gap === false);
}

console.log('\ndurability: what a commit may claim, and when');
resetOverlay();
{
  const e = emit('F1', 'ORS-SACHET', 40);
  check('an event leaves the commit route as pending', e.durability === 'pending');
  check('and is not yet published', e.published === false);

  const update = markDurability(e.seq, 'durable', { published: true });
  check('marking it durable produces an update to stream', update?.seq === e.seq);
  check('the update carries its own cursor', (update?.id ?? 0) > 0);
  check('the stored event is updated in place', overlaySnapshot().events[0].durability === 'durable');

  const since = durabilitySince(0);
  check('the durability cursor replays from 0', since.updates.length === 1);
  check('and returns nothing from the head', durabilitySince(since.id).updates.length === 0);

  // The durability cursor must NOT be the stock cursor: an SSE client resumes
  // from `Last-Event-ID`, and a durability change that consumed a seq would
  // make that cursor point at an event that never existed.
  check('durability does not advance the stock sequence', currentSeq() === 1);

  const opening = durabilityMap();
  check('a stream opening is told the state of every retained event', opening.updates.length === 1);
  check('including whether it was published', opening.updates[0].published === true);

  const failed = markDurability(e.seq, 'failed', { detail: 'quota exceeded' });
  check('a failed append is recorded with its reason', failed?.detail === 'quota exceeded');
  check('an update for an unknown event is not invented', markDurability(9999, 'durable') === undefined);
}

console.log('\nrestore: the overlay after a container restart');
{
  // What a restarted container reads back out of BigQuery. The point of the
  // gate is that this is indistinguishable, to every consumer, from the state
  // the process had before it died.
  const restored: StockEvent[] = [
    {
      seq: 7, eventId: 'rev-a:7', origin: 'rev-a', at: '2026-09-19T09:00:00.000Z', facilityId: 'F1',
      facilityName: 'PHC One', districtCode: 'DST-10-PURNIA', drugId: 'ORS-SACHET', drugName: 'ORS', onHand: 12,
      source: 'voice', durability: 'durable', published: false, restored: true,
      recomputeMs: 14, risk: dummyRisk(12),
    },
    {
      seq: 9, eventId: 'rev-b:9', origin: 'rev-b', at: '2026-09-19T09:05:00.000Z', facilityId: 'F2',
      facilityName: 'PHC Two', districtCode: 'DST-10-PURNIA', drugId: 'ORS-SACHET', drugName: 'ORS', onHand: 80,
      source: 'photo', durability: 'durable', published: false, restored: true,
      recomputeMs: 16, risk: dummyRisk(80),
    },
  ];

  resetOverlay();
  const report = hydrate(restored, { elapsedMs: 1234 });
  check('both corrections are back in force', report.entries === 2);
  check('both events are back in the replay buffer', report.events === 2);
  check('a restored position reads back its value', overlayFor('F1', 'ORS-SACHET')?.onHand === 12);
  check('the pipeline lookup sees it too', overlayLookup()('F2', 'ORS-SACHET').onHand === 80);
  check('the elapsed time is reported, not averaged away', report.elapsedMs === 1234);
  check('the report is readable afterwards', restoreReport().ok === true);

  // THE CURSOR BELONGS TO THE INSTANCE. A restarted container is a new one, and
  // two instances wrote seq 7 and seq 9 above, so the restored events are
  // renumbered locally in the order they happened -- and keep their identity.
  check('restored events are numbered on this instance, in time order',
    overlaySnapshot().events.map((e) => e.seq).reverse().join(',') === '1,2');
  check('and keep the identity every instance agrees on',
    overlaySnapshot().events.some((e) => e.eventId === 'rev-b:9'));
  const next = emit('F3', 'ORS-SACHET', 5);
  check('the next commit continues the local sequence', next.seq === 3);
  check('and is identified by this instance', next.eventId === INSTANCE_ID + ':3' && next.origin === INSTANCE_ID);
  check('a client resuming from 2 gets only what followed', eventsSince(2).events.length === 1);
  check('a restored event is flagged as restored', overlaySnapshot().events.some((ev) => ev.restored === true));
  check('the snapshot names the instance its cursor belongs to', overlaySnapshot().instanceId === INSTANCE_ID);

  // A retried append can leave the same event in the log twice. Restoring it
  // twice would show one report as two.
  resetOverlay();
  const doubled = hydrate([...restored, { ...restored[0] }]);
  check('a row repeating an event id is dropped', doubled.events === 2, String(doubled.events));
  check('and counted', doubled.duplicates === 1, String(doubled.duplicates));
  check('a clean log reports no duplicates', (resetOverlay(), hydrate(restored)).duplicates === 0);

  resetOverlay();
  const failure = noteRestoreFailure('403 Permission denied', 88);
  check('a failed restore is recorded rather than swallowed', failure.ok === false);
  check('with the reason kept', failure.error === '403 Permission denied');
  check('and the overlay left empty rather than half-filled', overlaySnapshot().entries.length === 0);
}

console.log('\nfan-out: reports committed on another instance');
{
  const foreign = (over: Partial<StockEvent>): StockEvent => ({
    seq: 41, eventId: 'rev-x:41', origin: 'rev-x', at: '2026-09-20T10:00:00.000Z', facilityId: 'F7',
    facilityName: 'SC Seven', districtCode: 'DST-10-PURNIA', drugId: 'ORS-SACHET', drugName: 'ORS', onHand: 30,
    source: 'voice', durability: 'durable', published: true, recomputeMs: 12, risk: dummyRisk(30),
    ...over,
  });

  resetOverlay();
  emit('F1', 'ORS-SACHET', 10);
  const first = applyForeignStockEvent(foreign({}));
  check('a foreign report is recorded', !first.duplicate && overlayFor('F7', 'ORS-SACHET')?.onHand === 30);
  check('on THIS instance\'s cursor, not the origin\'s', first.event?.seq === 2, String(first.event?.seq));
  check('keeping the origin\'s identity', first.event?.eventId === 'rev-x:41');
  check('and streams like any other event', eventsSince(1).events.length === 1);

  // Pub/Sub is at-least-once.
  const again = applyForeignStockEvent(foreign({}));
  check('a redelivered message is not recorded twice', again.duplicate && currentSeq() === 2);

  // The origin publishes after its append settles, and a copy can be the one
  // that says the append failed.
  applyForeignStockEvent(foreign({ eventId: 'rev-x:42', seq: 42, facilityId: 'F8', durability: 'pending' }));
  const news = applyForeignStockEvent(foreign({ eventId: 'rev-x:42', seq: 42, facilityId: 'F8', durability: 'failed', durabilityDetail: 'quota' }));
  check('but a duplicate carrying durability news updates the held event',
    news.duplicate && overlaySnapshot().events.find((e) => e.eventId === 'rev-x:42')?.durability === 'failed');

  // Two reports for one shelf on two instances, delivered in the wrong order.
  const later = applyForeignStockEvent(foreign({ eventId: 'rev-y:5', seq: 5, facilityId: 'F9', at: '2026-09-20T10:00:05.000Z', onHand: 99 }));
  const earlier = applyForeignStockEvent(foreign({ eventId: 'rev-z:3', seq: 3, facilityId: 'F9', at: '2026-09-20T10:00:01.000Z', onHand: 11 }));
  check('a report that arrives late but was taken earlier does not win', overlayFor('F9', 'ORS-SACHET')?.onHand === 99);
  check('it is still recorded, and marked as superseded', earlier.superseded === true && later.superseded === false);
  check('a tie on time is broken by event id, the same on every instance',
    supersedes({ at: 't', eventId: 'b:1' }, { at: 't', eventId: 'a:9' }) && !supersedes({ at: 't', eventId: 'a:9' }, { at: 't', eventId: 'b:1' }));
}

console.log('\nfan-out: what a message means');
{
  resetOverlay();
  resetTickets();
  const event = {
    seq: 3, eventId: 'rev-q:3', origin: 'rev-q', at: '2026-09-20T11:00:00.000Z', facilityId: 'F1',
    facilityName: 'PHC One', districtCode: 'DST-10-PURNIA', drugId: 'ORS-SACHET', drugName: 'ORS', onHand: 44,
    source: 'typed', durability: 'durable', published: true, recomputeMs: 9, risk: dummyRisk(44),
  };
  const own = applyBusMessage({ type: 'stock.committed', instanceId: INSTANCE_ID }, { type: 'stock.committed', event });
  check('this instance\'s own echo is never applied', own.kind === 'own' && overlayFor('F1', 'ORS-SACHET') === undefined);
  const theirs = applyBusMessage({ type: 'stock.committed', instanceId: 'rev-q' }, { type: 'stock.committed', event });
  check('another instance\'s report is', theirs.kind === 'stock' && theirs.applied && overlayFor('F1', 'ORS-SACHET')?.onHand === 44);
  check('a body that is not a report is refused, not thrown on',
    applyBusMessage({ type: 'stock.committed', instanceId: 'rev-q' }, { type: 'stock.committed', event: { onHand: 1 } }).kind === 'malformed');
  check('an unknown message type is ignored', applyBusMessage({ type: 'something.new', instanceId: 'rev-q' }, {}).kind === 'ignored');

  const base = (history: DispatchTicket['history'], durability?: DispatchTicket['durability']) =>
    ({
      ticketId: 'DST-10-PURNIA:ORD-9', districtCode: 'DST-10-PURNIA', orderId: 'ORD-9', state: 'approved',
      from: { facilityId: 'A', facilityName: 'A', facilityType: 'SC', districtCode: 'DST-10-PURNIA', districtName: 'Purnia' },
      to: { facilityId: 'B', facilityName: 'B', facilityType: 'SC', districtCode: 'DST-10-PURNIA', districtName: 'Purnia' },
      drugId: 'ORS-SACHET', drugName: 'ORS', unit: 'sachet', plannedUnits: 10, dispatchedUnits: null,
      receivedUnits: null, varianceUnits: null, crossDistrict: false, admissibility: 'permitted', escalateTo: null,
      admissibilityNote: '', history, effects: [], createdAt: 't', updatedAt: 't', seq: 77, durability,
    }) as DispatchTicket;
  const h = (action: string) => ({ at: 't', action, from: 'proposed', to: 'approved', actor: 'x' }) as DispatchTicket['history'][number];

  const two = base([h('propose'), h('approve')], 'pending');
  const r1 = applyBusMessage({ type: 'dispatch.approve', instanceId: 'rev-q' }, { type: 'dispatch.approve', ticket: two });
  check('a foreign ticket transition is applied', r1.kind === 'ticket' && r1.applied && getTicket(two.ticketId)?.history.length === 2);
  check('and re-stamped on this instance\'s ticket cursor', getTicket(two.ticketId)?.seq !== 77);
  const one = base([h('propose')]);
  const stale = applyBusMessage({ type: 'dispatch.propose', instanceId: 'rev-q' }, { type: 'dispatch.propose', ticket: one });
  check('an older copy delivered after a newer one is ignored', !stale.applied && getTicket(two.ticketId)?.history.length === 2);
  const settled = applyBusMessage({ type: 'dispatch.approve', instanceId: 'rev-q' }, { type: 'dispatch.approve', ticket: base([h('propose'), h('approve')], 'durable') });
  check('the same version with durability news is applied', settled.applied && getTicket(two.ticketId)?.durability === 'durable');

  let published = '';
  const batch = applyBusMessage({ type: 'batch.published', instanceId: 'job' }, { type: 'batch.published', runId: 'run-7' }, (id) => (published = id));
  check('a published batch run is handed to the run store', batch.kind === 'batch' && published === 'run-7');

  check('a scoped cursor splits into its instance and seq',
    splitScoped('rev-a-xyz:41').instance === 'rev-a-xyz' && splitScoped('rev-a-xyz:41').seq === 41);
  check('an unscoped cursor has no instance', splitScoped('41').instance === null && splitScoped('41').seq === 41);
  void putTicket;
  void nextTicketSeq;
}

console.log('\nTier-1 recompute');
resetOverlay();
// A real facility from the shipped network, so this exercises the same code the
// batch runs rather than a fixture that cannot drift with it.
const purnia = DISTRICTS.find((d) => d.code === 'DST-10-PURNIA')!;
const facility = generateNetwork(DEMO_SCALE, [purnia], 20260930).find((f) => f.type === 'CHC')!;
{
  const zero = recomputePosition(facility.id, 'ORS-SACHET', 0, SETUP);
  const plenty = recomputePosition(facility.id, 'ORS-SACHET', 100000, SETUP);
  check('an empty shelf is near-certain to stock out', zero.risk.stockoutProbability > 0.9, String(zero.risk.stockoutProbability));
  check('a full shelf is not', plenty.risk.stockoutProbability < 0.05, String(plenty.risk.stockoutProbability));
  check('the risk score follows', zero.risk.riskScore > plenty.risk.riskScore);
  check('the previous risk is reported alongside', typeof zero.previousRisk.stockoutProbability === 'number');
  check('the ledger position is reported', typeof zero.previousOnHand === 'number');
  check('the forecast source is recorded', zero.forecastSource === 'timesfm' || zero.forecastSource === 'croston');

  // Determinism: the same inputs must give the same answer, or the console
  // would flicker on every commit for reasons unrelated to the report.
  const again = recomputePosition(facility.id, 'ORS-SACHET', 0, SETUP);
  check(
    'the recompute is deterministic',
    again.risk.stockoutProbability === zero.risk.stockoutProbability &&
      again.risk.riskScore === zero.risk.riskScore,
  );
}
{
  let threw = '';
  try {
    recomputePosition('NOT-A-FACILITY', 'ORS-SACHET', 10, SETUP);
  } catch (e) {
    threw = e instanceof UnknownFacilityError ? 'unknown-facility' : 'wrong';
  }
  check('an unknown facility throws a typed error', threw === 'unknown-facility', threw);

  const sc = generateNetwork(DEMO_SCALE, [purnia], 20260930).find((f) => f.type === 'SC')!;
  let threw2 = '';
  try {
    // A sub-centre has an ANM-level formulary; anti-snake venom is not on it.
    recomputePosition(sc.id, 'ASV-POLY-10ML', 10, SETUP);
  } catch (e) {
    threw2 = e instanceof UnstockedDrugError ? 'unstocked' : 'wrong: ' + (e as Error).message;
  }
  check('a drug the tier does not stock is refused', threw2 === 'unstocked', threw2);

  // An id that is not in the catalogue AT ALL must also be a typed refusal.
  // `getDrug` throws on an unknown id, so naming the drug in the error message
  // was itself a route-level 500 waiting to happen.
  let threw3 = '';
  try {
    recomputePosition(sc.id, 'NOT-A-DRUG-AT-ALL', 10, SETUP);
  } catch (e) {
    threw3 = e instanceof UnstockedDrugError ? 'unstocked' : 'wrong: ' + (e as Error).message;
  }
  check('an unknown drug id is refused, not thrown raw', threw3 === 'unstocked', threw3);
}

console.log('\nthe WS2 budget: a commit re-scores a position in under 100 ms');
{
  // Warm once -- the first call in a process pays for module init and JIT, which
  // is not what the budget is about.
  recomputePosition(facility.id, 'ORS-SACHET', 10, SETUP);
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    recomputePosition(facility.id, 'ORS-SACHET', 10 + i, SETUP);
    runs.push(Date.now() - t);
  }
  const worst = Math.max(...runs);
  const median = [...runs].sort((a, b) => a - b)[2];
  check(
    'worst of five recomputes is under 100 ms',
    worst < 100,
    'runs ' + runs.join('/') + ' ms, median ' + median + ' ms',
  );
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + '  ' + (checks - failures) + '/' + checks + ' checks');
process.exit(failures === 0 ? 0 : 1);
