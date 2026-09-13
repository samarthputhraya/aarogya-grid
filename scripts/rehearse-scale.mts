/**
 * THE SCALE-OUT GATE: two instances, one board.
 *
 * Run:  npm run build && npm run rehearse:scale
 *
 * Starts TWO production servers from the same build on two ports, pointed at
 * the real project -- the same BigQuery log, the same Pub/Sub topic, the same
 * ticket bucket -- and does to them what a load balancer does to Cloud Run
 * instances: sends one request here and the next one there.
 *
 * WHY TWO LOCAL PROCESSES AND NOT THE DEPLOYMENT
 * ----------------------------------------------
 * Cloud Run decides which instance serves a request, and it will not be told.
 * Against the deployed service a two-instance check can only ever pass by luck
 * or fail by luck, because nothing guarantees the two requests landed on
 * different containers. Two processes with two instance ids are the only way to
 * make "a commit on A reaches a console on B" a measurement rather than a hope.
 * Everything between them is the real cloud.
 *
 * WHAT IT CHECKS
 * --------------
 *   1. Both instances subscribe to the fan-out, with different instance ids.
 *   2. A report committed on A arrives on a stream held open on B. Timed.
 *   3. Two reports for the same shelf, one on each instance, settle to the same
 *      correction on both -- the newer one -- whatever order they arrived in.
 *   4. The same order approved on A and on B at the same moment is approved
 *      ONCE: one 200, one 409.
 *   5. The ticket moves on across instances: dispatched on one, received on the
 *      other, and both end up showing it received.
 *
 * It puts every shelf back afterwards, and deletes the two subscriptions and
 * the ticket it created. The transition rows stay in the audit log, as audit
 * rows should; `npm run overlay:purge -- --all --recreate` clears them.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { googleRequest, resolveProjectId } from '../src/lib/gcp/request';

const ROOT = process.cwd();
const PORTS = [3121, 3122];
const BASES = PORTS.map((p) => 'http://localhost:' + p);
const BUCKET = process.env.AAROGYA_STATE_BUCKET?.trim() || process.env.AAROGYA_RUN_BUCKET?.trim();
/** A district with in-district orders, so the race is about concurrency and not about a countersign. */
const DISTRICT = process.env.AAROGYA_REHEARSE_DISTRICT ?? 'DST-10-PURNIA';
/** Reports timed across instances. The first pays for a cold token and connection. */
const SAMPLES = 5;
const FANOUT_BUDGET_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.error('  FAIL  ' + m);
};
const ok = (m: string) => console.log('  ok    ' + m);
const note = (m: string) => console.log('        ' + m);
class Halt extends Error {}
const halt = (m: string): never => {
  fail(m);
  throw new Halt(m);
};

if (!BUCKET) {
  console.error('Set AAROGYA_STATE_BUCKET to the ticket bucket (npm run provision:cloud creates it).');
  process.exit(1);
}
if (process.env.AAROGYA_NO_BQ === '1') {
  console.error('AAROGYA_NO_BQ=1 is set: there is no fan-out without the cloud. Unset it.');
  process.exit(1);
}

// ------------------------------------------------------------------ servers

function start(port: number): ChildProcess {
  const child = spawn(process.execPath, [resolve(ROOT, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, AAROGYA_MAX_INSTANCES: '2', AAROGYA_STATE_BUCKET: BUCKET },
  });
  child.stderr?.on('data', (d) => {
    const s = String(d);
    if (/error/i.test(s)) process.stderr.write('        [' + port + '] ' + s);
  });
  return child;
}

function kill(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null) return done();
    child.once('exit', () => done());
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
    setTimeout(done, 8000);
  });
}

interface Overlay {
  instanceId: string;
  seq: number;
  entries: { facilityId: string; drugId: string; onHand: number; at: string }[];
  events: { eventId: string; seq: number; durability: string }[];
  tickets: { ticketId: string; orderId: string; state: string }[];
  durability: { enabled: boolean; ticketAuthority: string; fanout: { state: string; subscription: string | null; instanceId: string; error: string | null } };
}

async function overlay(base: string): Promise<Overlay> {
  const res = await fetch(base + '/api/overlay', { cache: 'no-store' });
  if (!res.ok) throw new Error('GET /api/overlay ' + res.status);
  return (await res.json()) as Overlay;
}

async function waitUp(base: string, budgetMs: number): Promise<Overlay | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      return await overlay(base);
    } catch {
      await sleep(500);
    }
  }
  return null;
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A stream held open on one instance, recording every frame with the time it arrived. */
function watch(base: string, since: number, instance: string) {
  const frames: { event: string; data: unknown; at: number }[] = [];
  const ctrl = new AbortController();
  void (async () => {
    try {
      const res = await fetch(base + '/api/events?since=' + since + '&instance=' + encodeURIComponent(instance), {
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data), at: Date.now() });
        }
      }
    } catch {
      // Aborted at the end of the run.
    }
  })();
  return { frames, close: () => ctrl.abort() };
}

async function until<T>(budgetMs: number, probe: () => Promise<T | null | undefined> | T | null | undefined): Promise<T | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const v = await probe();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

// ---------------------------------------------------------------------- run

const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'src/data/national-snapshot.json'), 'utf8'));
const target = snapshot.alerts[0] as { facilityId: string; drugId: string; drugName: string; facilityName: string };
const plan = JSON.parse(readFileSync(resolve(ROOT, 'src/data/districts', DISTRICT + '.json'), 'utf8'));

const measured: Record<string, unknown> = { at: new Date().toISOString(), instances: 2, bucket: BUCKET, district: DISTRICT };
const servers: ChildProcess[] = [];
const subscriptions: string[] = [];
let ticketToDelete: string | null = null;
const shelves: { facilityId: string; drugName: string; onHand: number }[] = [];

console.log('Scale-out rehearsal: two production servers, one project\n');

try {
  for (const base of BASES) {
    const squatter = await overlay(base).catch(() => null);
    if (squatter) halt('something already answers on ' + base + '; this gate must own both processes');
  }
  for (const port of PORTS) servers.push(start(port));
  const [a0, b0] = await Promise.all(BASES.map((b) => waitUp(b, 120_000)));
  if (!a0 || !b0) halt('a server did not come up -- has `npm run build` been run?');
  const A = BASES[0];
  const B = BASES[1];

  // ---- 1. Both are listening, as different instances ----------------------
  const [a1, b1] = await Promise.all([
    until(20_000, async () => ((await overlay(A)).durability.fanout.state === 'listening' ? overlay(A) : null)),
    until(20_000, async () => ((await overlay(B)).durability.fanout.state === 'listening' ? overlay(B) : null)),
  ]);
  if (!a1 || !b1) {
    const why = [a0!, b0!].map((o) => o.durability.fanout.state + ' ' + (o.durability.fanout.error ?? '')).join(' / ');
    halt('the fan-out did not start on both instances: ' + why);
  }
  for (const o of [a1!, b1!]) if (o.durability.fanout.subscription) subscriptions.push(o.durability.fanout.subscription);
  if (a1!.instanceId === b1!.instanceId) halt('both servers report the same instance id');
  ok('two instances listening: ' + a1!.instanceId + ' and ' + b1!.instanceId);
  if (a1!.durability.ticketAuthority !== 'gcs' || b1!.durability.ticketAuthority !== 'gcs') {
    halt('the ticket authority is ' + a1!.durability.ticketAuthority + ' -- both must use the bucket');
  }
  ok('both decide ticket transitions against gs://' + BUCKET);
  measured.instanceIds = [a1!.instanceId, b1!.instanceId];

  // ---- 2. A commit on A reaches a stream on B -----------------------------
  const streamB = watch(B, b1!.seq, b1!.instanceId);
  await until(5_000, () => streamB.frames.find((f) => f.event === 'hello'));
  const lags: number[] = [];
  let durableOnArrival = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const value = 4301 + i;
    const sent = Date.now();
    const committed = await post(A, '/api/commit', {
      facilityId: target.facilityId,
      source: 'typed',
      entries: [{ drugName: target.drugName, onHand: value }],
    });
    const event = (committed.body.committed as { eventId: string; risk: { previousOnHand: number } }[] | undefined)?.[0];
    if (committed.status !== 200 || !event) halt('commit on A failed: ' + committed.status + ' ' + JSON.stringify(committed.body).slice(0, 200));
    if (i === 0) {
      shelves.push({ facilityId: target.facilityId, drugName: target.drugName, onHand: event!.risk.previousOnHand });
      ok('committing ' + target.facilityName + ' / ' + target.drugName + ' on A, ' + SAMPLES + ' times');
    }
    const arrived = await until(FANOUT_BUDGET_MS, () =>
      streamB.frames.find((f) => f.event === 'stock' && (f.data as { eventId: string }).eventId === event!.eventId),
    );
    if (!arrived) {
      fail('report ' + event!.eventId + ' did not reach the stream on B within ' + FANOUT_BUDGET_MS + ' ms');
      break;
    }
    lags.push(arrived.at - sent);
    if ((arrived.data as { durability: string }).durability === 'durable') durableOnArrival++;
  }
  if (lags.length === SAMPLES) {
    const sorted = [...lags].sort((x, y) => x - y);
    measured.crossInstanceMs = lags;
    measured.crossInstanceMedianMs = sorted[Math.floor(SAMPLES / 2)];
    measured.crossInstanceMaxMs = sorted[SAMPLES - 1];
    measured.arrivedDurable = durableOnArrival === SAMPLES;
    ok(
      'every report reached a console streaming from B: median ' + measured.crossInstanceMedianMs + ' ms, slowest ' +
        measured.crossInstanceMaxMs + ' ms (' + lags.join(', ') + ')',
    );
    if (measured.arrivedDurable) ok('each arrived already durable -- published only after its append settled');
    else fail(SAMPLES - durableOnArrival + ' report(s) arrived on B before they were durable');
  }
  const onB = (await overlay(B)).entries.find((e) => e.facilityId === target.facilityId && e.drugId === target.drugId);
  if (onB?.onHand === 4301 + SAMPLES - 1) ok("B's overlay has the latest correction in force, so a reload on B shows it");
  else fail("B's overlay shows " + JSON.stringify(onB));

  // ---- 3. Two reports for one shelf, one per instance ---------------------
  await post(B, '/api/commit', { facilityId: target.facilityId, source: 'typed', entries: [{ drugName: target.drugName, onHand: 4344 }] });
  const last = await post(A, '/api/commit', { facilityId: target.facilityId, source: 'typed', entries: [{ drugName: target.drugName, onHand: 4345 }] });
  const lastEvent = (last.body.committed as { eventId: string }[] | undefined)?.[0];
  const settled = await until(FANOUT_BUDGET_MS * 2, async () => {
    const [ea, eb] = await Promise.all([overlay(A), overlay(B)]).then((os) =>
      os.map((o) => o.entries.find((e) => e.facilityId === target.facilityId && e.drugId === target.drugId)),
    );
    return ea && eb && ea.onHand === eb.onHand && ea.onHand === 4345 ? [ea, eb] : null;
  });
  if (settled) {
    ok('reports on B then A settle to the same correction on both instances: 4,345, the newer');
    measured.converged = true;
  } else {
    fail('the two instances did not settle on the newer report ' + (lastEvent?.eventId ?? ''));
    measured.converged = false;
  }
  streamB.close();

  // ---- 4. The same order approved on both at once -------------------------
  const existing = (await overlay(A)).tickets.map((t) => t.orderId);
  const order = (plan.orders as { id: string; admissibility: string; quantity: number; drugName: string; from: { id: string; name: string }; to: { id: string; name: string } }[])
    .find((o) => o.admissibility === 'permitted' && o.quantity > 3 && !existing.includes(o.id));
  if (!order) halt('no untouched in-district order in ' + DISTRICT);
  ticketToDelete = DISTRICT + ':' + order!.id;
  note('order ' + order!.from.name + ' -> ' + order!.to.name + ', ' + order!.quantity + ' of ' + order!.drugName);

  const race = await Promise.all(
    BASES.map((base) => post(base, '/api/dispatch', { districtCode: DISTRICT, orderId: order!.id, action: 'approve', actor: 'rehearsal ' + base.slice(-4) })),
  );
  const statuses = race.map((r) => r.status).sort();
  measured.raceStatuses = statuses;
  if (statuses[0] === 200 && statuses[1] === 409) ok('approved on A and B at the same moment: one 200, one 409 -- approved once');
  else fail('the concurrent approvals answered ' + statuses.join(' and '));
  const winner = race.findIndex((r) => r.status === 200);
  const loser = winner === 0 ? 1 : 0;
  const approvedTicket = race[winner]?.body.ticket as { effects: { role: string; facilityId: string; onHandBefore: number }[] } | undefined;
  for (const e of approvedTicket?.effects ?? []) shelves.push({ facilityId: e.facilityId, drugName: order!.drugName, onHand: e.onHandBefore });

  // ---- 5. Dispatched on the loser, received on the winner -----------------
  const dispatched = await post(BASES[loser], '/api/dispatch', { districtCode: DISTRICT, orderId: order!.id, action: 'dispatch', actor: 'rehearsal' });
  if (dispatched.status === 200) ok('dispatched on the instance whose approval was refused -- it decides against the bucket, not its memory');
  else fail('dispatch on the other instance answered ' + dispatched.status + ' ' + JSON.stringify(dispatched.body).slice(0, 200));
  const received = await post(BASES[winner], '/api/dispatch', { districtCode: DISTRICT, orderId: order!.id, action: 'receive', actor: 'rehearsal', units: order!.quantity - 1 });
  if (received.status === 200) ok('received, one short, back on the first instance');
  else fail('receive answered ' + received.status + ' ' + JSON.stringify(received.body).slice(0, 200));

  const bothReceived = await until(FANOUT_BUDGET_MS * 2, async () => {
    const states = await Promise.all(BASES.map(async (b) => (await overlay(b)).tickets.find((t) => t.orderId === order!.id)?.state));
    return states.every((s) => s === 'received') ? states : null;
  });
  measured.ticketConverged = Boolean(bothReceived);
  if (bothReceived) ok('both instances show the ticket received');
  else fail('the instances disagree about the ticket after the fan-out budget');
} catch (e) {
  if (!(e instanceof Halt)) fail((e as Error).stack ?? String(e));
} finally {
  // ---- put everything back -------------------------------------------------
  if (servers.length > 0 && shelves.length > 0) {
    const seen = new Set<string>();
    for (const s of shelves) {
      if (seen.has(s.facilityId + s.drugName)) continue;
      seen.add(s.facilityId + s.drugName);
      const r = await post(BASES[0], '/api/commit', { facilityId: s.facilityId, source: 'typed', entries: [{ drugName: s.drugName, onHand: s.onHand }] }).catch(() => null);
      if (!r || r.status !== 200) fail('could not restore ' + s.facilityId + ' to ' + s.onHand + ' -- fix it by hand');
    }
    ok('every shelf this run touched is back at its pre-rehearsal position');
    await sleep(2_000);
  }
  for (const child of servers) await kill(child);
  const projectId = await resolveProjectId();
  for (const id of subscriptions) {
    await googleRequest('https://pubsub.googleapis.com/v1/projects/' + projectId + '/subscriptions/' + id, { method: 'DELETE', attempts: 2 }).catch(() => undefined);
  }
  if (subscriptions.length > 0) ok('deleted both fan-out subscriptions (a killed process cannot)');
  if (ticketToDelete) {
    await googleRequest(
      'https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o/' + encodeURIComponent('tickets/' + encodeURIComponent(ticketToDelete) + '.json'),
      { method: 'DELETE', attempts: 2 },
    ).catch(() => undefined);
    note('the rehearsal ticket is removed from the bucket; its transitions stay in the audit log');
  }
}

if (failures === 0) {
  writeFileSync(resolve(ROOT, 'docs/scale-gate.json'), JSON.stringify(measured, null, 2) + '\n');
  writeFileSync(
    resolve(ROOT, 'docs/scale-gate.md'),
    [
      '# Scale-out gate: two instances, one board',
      '',
      '*Generated by `npm run rehearse:scale`. Do not edit by hand.*',
      '',
      'Run ' + measured.at + ': two production servers from one build, as instances `' +
        (measured.instanceIds as string[]).join('` and `') + '`, against the real BigQuery log, Pub/Sub topic and ticket bucket.',
      '',
      '| What | Measured |',
      '|---|---|',
      '| A report committed on one instance reached a stream on the other | median ' + measured.crossInstanceMedianMs +
        ' ms, slowest ' + measured.crossInstanceMaxMs + ' ms, over ' + SAMPLES + ' reports (' + (measured.crossInstanceMs as number[]).join(', ') + ' ms) |',
      '| Each arrived already durable | ' + (measured.arrivedDurable ? 'yes' : 'no') + ' |',
      '| Reports for one shelf on both instances settled to the newer on both | ' + (measured.converged ? 'yes' : 'no') + ' |',
      '| The same order approved on both instances at once | ' + (measured.raceStatuses as number[]).join(' and ') + ' |',
      '| Dispatched on one, received on the other; both show it received | ' + (measured.ticketConverged ? 'yes' : 'no') + ' |',
      '',
      'The cross-instance time includes the BigQuery append: a report is published only once it is durable,',
      "which is what lets a new instance's restore and its subscription cover every report between them.",
      'On the instance that took the commit, the change streams without waiting for it.',
      '',
    ].join('\n'),
  );
  console.log('\n  wrote docs/scale-gate.json and docs/scale-gate.md');
}
console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL (' + failures + ')'));
process.exit(failures === 0 ? 0 : 1);
