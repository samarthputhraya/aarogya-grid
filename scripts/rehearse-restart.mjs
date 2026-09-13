/**
 * THE DAY-8 GATE: a committed report survives the container being replaced.
 *
 * Run:  npm run rehearse:restart
 *         -- builds nothing; expects `npm run build` to have been run, then
 *            starts a production server, commits, KILLS IT, starts another,
 *            and checks the report came back.
 *
 *       npm run rehearse:restart -- --base https://host --restart-cmd "gcloud ..."
 *         -- the same thing against a deployment, where the restart is whatever
 *            command actually replaces the container.
 *
 * WHY THIS CANNOT BE A UNIT TEST
 * ------------------------------
 * The property under test is the absence of state. `hydrate()` can be tested in
 * process and is; what cannot be tested in process is that NOTHING ELSE was
 * keeping the answer alive -- a module-scope cache, a warm Next.js route, a
 * browser that never dropped its EventSource. The only honest way to check that
 * a number outlived a process is to end the process.
 *
 * WHAT "SURVIVES" HAS TO MEAN, OR THE TEST IS THEATRE
 * ---------------------------------------------------
 * Four separate things, and the first three can all pass while the fourth fails:
 *
 *   1. the durable append is acknowledged     (the row reached BigQuery)
 *   2. the restore reads it back             (the query and the decode work)
 *   3. the overlay holds it again            (the entry is in force)
 *   4. a browser SEES it                     (prerendered HTML + mount fetch)
 *
 * Step 4 is the one a judge performs. `/console` renders the batch run, not the
 * live overlay, so the restored value can only reach the page through the mount-time
 * `/api/overlay` fetch -- which is exactly the seam that looks solved and is
 * not. So this rehearsal opens a real browser against the RESTARTED server and
 * reads the number off the rendered page.
 *
 * IT ALSO PUTS THE BOARD BACK
 * ---------------------------
 * A rehearsal that can be pointed at production must not leave a test number on
 * the live board -- and now that commits are durable, "it will go away on the
 * next deploy" is no longer true. The ledger value is committed back at the end
 * and the restore is itself waited for.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleAuth } from 'google-auth-library';
import { randomBytes } from 'node:crypto';
import { operatorCookie, sessionSecretFor } from './lib/operator-session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SNAPSHOT = JSON.parse(readFileSync(resolve(ROOT, 'src/data/national-snapshot.json'), 'utf8'));

// ------------------------------------------------------------------ options

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(opt('port', '3111'));
const BASE = (opt('base', 'http://localhost:' + PORT)).replace(/\/$/, '');
const RESTART_CMD = opt('restart-cmd', null);
const LOCAL = BASE.includes('localhost') || BASE.includes('127.0.0.1');
/** How long a durable append may take before the gate calls it failed. */
const DURABLE_BUDGET_MS = 15_000;
/** How long a restarted service may take to answer again. */
const RESTART_BUDGET_MS = LOCAL ? 90_000 : 900_000;

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('  FAIL  ' + msg);
};
const ok = (msg) => console.log('  ok    ' + msg);
const note = (msg) => console.log('        ' + msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stops the run without exiting inside the `finally` that is killing servers. */
class Halt extends Error {}
const halt = (msg) => {
  fail(msg);
  throw new Halt(msg);
};

// ------------------------------------------------------------- server control

let server = null;

/*
 * A commit needs a signed-in actor. For a local run this script owns both
 * servers, so it hands them one secret and mints the session with it; for a
 * deployment the secret is read from Secret Manager.
 */
const SESSION_SECRET = LOCAL
  ? process.env.AAROGYA_SESSION_SECRET?.trim() || randomBytes(32).toString('base64')
  : sessionSecretFor(BASE);
const COOKIE = SESSION_SECRET ? operatorCookie(SESSION_SECRET, 'rehearsal restart', 1800) : null;

function startServer() {
  // Spawned as node + next's own entry rather than through npm, so there is one
  // pid to kill. An `npm start` on Windows leaves the real server orphaned
  // behind a cmd shim, and the "restart" would then be a second server racing
  // the first for the port -- a green run that proved nothing.
  const child = spawn(
    process.execPath,
    [resolve(ROOT, 'node_modules/next/dist/bin/next'), 'start', '-p', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AAROGYA_SESSION_SECRET: SESSION_SECRET ?? '' } },
  );
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => {
    const s = String(d);
    if (s.toLowerCase().includes('error')) process.stderr.write('        [server] ' + s);
  });
  return child;
}

async function waitForServer(budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/overlay', { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch {
      // Not up yet.
    }
    await sleep(400);
  }
  return null;
}

function killServer(child) {
  return new Promise((done) => {
    if (!child || child.exitCode !== null) return done();
    child.once('exit', () => done());
    if (process.platform === 'win32') {
      // SIGTERM on Windows does not reliably take a node child's own children
      // with it; taskkill /T does, and this must be a real death.
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
    setTimeout(done, 8000);
  });
}

// -------------------------------------------------------------------- helpers

async function overlay() {
  const res = await fetch(BASE + '/api/overlay', { cache: 'no-store' });
  if (!res.ok) throw new Error('GET /api/overlay -> ' + res.status);
  return res.json();
}

async function commit(facilityId, drugName, onHand) {
  const res = await fetch(BASE + '/api/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
    body: JSON.stringify({ facilityId, source: 'typed', entries: [{ drugName, onHand }] }),
  });
  return { status: res.status, body: await res.json() };
}

/** Wait until the event with this seq reports itself durable. */
async function waitForDurable(seq) {
  const started = Date.now();
  while (Date.now() - started < DURABLE_BUDGET_MS) {
    const snap = await overlay();
    const event = snap.events.find((e) => e.seq === seq);
    if (event && event.durability !== 'pending') {
      return { durability: event.durability, detail: event.durabilityDetail, published: event.published, ms: Date.now() - started };
    }
    await sleep(250);
  }
  return { durability: 'pending', ms: Date.now() - started };
}

// ------------------------------------------------------------------ artefact

/**
 * Both runs, not the last one.
 *
 * The gate is run twice -- against a killed local process and against a real
 * Cloud Run revision -- and the two are different measurements, not repeats of
 * one. A file that held only the most recent would quietly replace the
 * deployment figure with a laptop figure the next time somebody checked their
 * work locally, which is how a README ends up describing a machine nobody is
 * judging.
 */
function persist(m) {
  const key = m.base.includes('localhost') || m.base.includes('127.0.0.1') ? 'local' : 'cloudRun';
  let all = {};
  try {
    all = JSON.parse(readFileSync('docs/restart-gate.json', 'utf8'));
  } catch {
    // First run.
  }
  all[key] = m;
  writeFileSync('docs/restart-gate.json', JSON.stringify(all, null, 2) + '\n');
  writeFileSync('docs/restart-gate.md', report(all));
  return key;
}

function rows(m) {
  if (!m) return ['_not yet run._', ''];
  return [
    'Run ' + m.at + ' against `' + m.base + '`.',
    '',
    '| What | Measured |',
    '|---|---|',
    '| Target position | ' + m.target.facility + ' / ' + m.target.drug + ' |',
    '| BigQuery acknowledged the append | ' + m.durableAppendMs + ' ms |',
    '| Published to Pub/Sub | ' + (m.published ? 'yes' : 'no') + ' |',
    '| Restore query after restart | ' + m.restoreMs + ' ms |',
    '| Positions restored | ' + m.restoredEntries + ' |',
    '| Events restored into the replay buffer | ' + m.restoredEvents + ' |',
    // Rows added with the multi-instance fan-out. A run recorded before it says so
    // rather than being shown as a failure it never had the chance to pass.
    '| The report came back under the same event id | ' +
      (m.eventId === undefined ? 'not measured (run predates event ids)' : m.eventIdAfterRestart === m.eventId ? 'yes (' + m.eventId + ')' : 'no') + ' |',
    '| A stream cursor from the old container was resynchronised, not replayed | ' +
      (m.oldCursorReset === undefined ? 'not measured (run predates scoped cursors)' : m.oldCursorReset ? 'yes' : 'no') + ' |',
    '| Instance before / after | ' + m.instanceBefore + ' / ' + m.instanceAfter + ' |',
    '| A reloaded `/console` rendered the restored value | ' + (m.browserSawRestoredValue ? 'yes' : 'no') + ' |',
    '',
  ];
}

function report(all) {
  return [
    '# Restart-survival gate (WS2 durability)',
    '',
    '*Generated by `npm run rehearse:restart`. Do not edit by hand.*',
    '',
    'The claim is that a committed stock report outlives the process that accepted',
    'it. The only honest way to check that is to end the process, so this gate does',
    '-- locally by killing a production server, and on Cloud Run by replacing the',
    'revision. Both are recorded, because a laptop and a container in asia-south1',
    'are different measurements.',
    '',
    '## Local: a production build, killed and restarted',
    '',
    ...rows(all.local),
    '## Cloud Run: a revision replaced by a real deployment',
    '',
    ...rows(all.cloudRun),
    'The last row of each table is the one that matters. `/console` renders the batch',
    'run, not the live overlay, so the restored number can only reach the page through',
    'the mount-time `/api/overlay` fetch. Every other row can be green while it is red.',
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ the run

console.log('Restart-survival rehearsal against ' + BASE);
console.log();

const target = SNAPSHOT.alerts[0];
const TEST_VALUE = 4242;

/**
 * Everything this run measured, written out so it can be quoted.
 *
 * The project rule is that no figure reaches a surface unless it was read
 * from a re-run script or a shipped payload. A gate whose numbers live only in
 * a terminal that has since scrolled away cannot be quoted in a README without
 * breaking that rule, so it writes them down.
 */
const measured = {
  at: new Date().toISOString(),
  base: BASE,
  target: { facility: target.facilityName, drug: target.drugName },
  durableAppendMs: null,
  published: null,
  restoreMs: null,
  restoredEntries: null,
  restoredEvents: null,
  eventId: null,
  eventIdAfterRestart: null,
  oldCursorReset: false,
  browserSawRestoredValue: false,
  instanceBefore: null,
  instanceAfter: null,
};

try {
  // ---- 0. Bring the first server up ---------------------------------------
  if (LOCAL) {
    const squatter = await fetch(BASE + '/api/overlay', { cache: 'no-store' }).catch(() => null);
    if (squatter && squatter.ok) {
      halt(
        'something is already listening on port ' + PORT + '. This rehearsal must own the process it kills -- stop that server first. (An earlier run of this gate passed its start-up step against a stale server from a previous session, serving an older build.)',
      );
    }
    server = startServer();
    const up = await waitForServer(60_000);
    if (!up) {
      halt('the server did not start on port ' + PORT + '. Has `npm run build` been run?');
    }
    ok('server up on port ' + PORT);
  }

  const before = await overlay();
  if (!before.durability?.enabled) {
    halt(
      'durability is disabled on this target (AAROGYA_NO_BQ / AAROGYA_NO_DURABLE). ' +
        'There is nothing for a restart to restore from.',
    );
  }
  ok(
    'durable sink configured: ' +
      before.durability.dataset + '.' + before.durability.table +
      ' -> topic ' + before.durability.topic,
  );
  note('instance ' + before.durability.instanceId + ', seq ' + before.seq);
  if (before.restore.attempted && !before.restore.ok) {
    // Reported here as well as after the restart, because a restore that is
    // broken on BOTH instances would otherwise only surface at the end -- and
    // the earlier it is named, the less of this run is wasted proving it again.
    halt('the restore is already failing on this instance: ' + before.restore.error);
  }
  if (before.restore.attempted) {
    note(
      'this instance restored ' + before.restore.entries + ' position(s) / ' +
        before.restore.events + ' event(s) in ' + before.restore.elapsedMs + ' ms',
    );
  }

  // ---- 1. Commit something a viewer can see -------------------------------
  //
  // The top row of the shipped board, so the value is on screen rather than
  // merely in a payload.
  const { status, body } = await commit(target.facilityId, target.drugName, TEST_VALUE);
  if (status !== 200 || (body.committed ?? []).length === 0) {
    halt('commit failed: ' + status + ' ' + JSON.stringify(body).slice(0, 300));
  }
  const event = body.committed[0];
  const ledgerValue = event.risk.previousOnHand;
  ok(
    'committed ' + event.facilityName + ' / ' + event.drugName + ' = ' + event.onHand +
      ' (seq ' + event.seq + ', recompute ' + body.recomputeMs + ' ms)',
  );
  if (event.durability !== 'pending') {
    fail('the commit claimed durability "' + event.durability + '" before the append finished');
  } else {
    ok('the response says "pending", not "durable" -- the claim waits for the append');
  }

  // ---- 2. The append lands -------------------------------------------------
  const durable = await waitForDurable(event.seq);
  if (durable.durability !== 'durable') {
    halt(
      'the append did not become durable within ' + DURABLE_BUDGET_MS + ' ms (state "' +
        durable.durability + '"' + (durable.detail ? ': ' + durable.detail : '') + ')',
    );
  }
  ok('BigQuery acknowledged the row in ' + durable.ms + ' ms');
  measured.durableAppendMs = durable.ms;
  measured.published = Boolean(durable.published);
  measured.instanceBefore = before.durability.instanceId;
  if (durable.published) ok('and it was published to Pub/Sub');
  else note('Pub/Sub publish did not succeed -- durability is unaffected, but check the topic IAM');

  const afterCommit = await overlay();
  measured.eventId = event.eventId;
  const oldCursor = afterCommit.instanceId + ':' + afterCommit.seq;

  // ---- 3. END THE PROCESS --------------------------------------------------
  if (LOCAL) {
    await killServer(server);
    server = null;
    // Make sure it is actually gone: a "restart" that was really the same
    // process answering would pass this gate without proving anything.
    const stillThere = await fetch(BASE + '/api/overlay', { cache: 'no-store' }).catch(() => null);
    if (stillThere && stillThere.ok) {
      halt('the old server is still answering -- the restart was not a restart');
      }
    ok('server killed; the port stops answering (RAM is gone)');

    server = startServer();
    const up = await waitForServer(RESTART_BUDGET_MS);
    if (!up) {
      halt('the replacement server did not come up');
      }
  } else {
    if (RESTART_CMD) {
      note('restarting with: ' + RESTART_CMD);
      await new Promise((done, reject) => {
        const p = spawn(RESTART_CMD, { cwd: ROOT, shell: true, stdio: 'inherit' });
        p.on('exit', (code) => (code === 0 ? done() : reject(new Error('restart command exited ' + code))));
      });
    } else {
      note('restart the service now (this waits up to ' + RESTART_BUDGET_MS / 1000 + ' s)');
    }
    // A deployment is only a restart when the instance identity changes. Polling
    // for a 200 would be satisfied by the OLD container, which is still serving.
    const deadline = Date.now() + RESTART_BUDGET_MS;
    let changed = false;
    while (Date.now() < deadline) {
      const snap = await overlay().catch(() => null);
      if (snap?.durability?.instanceId && snap.durability.instanceId !== before.durability.instanceId) {
        changed = true;
        break;
      }
      await sleep(3000);
    }
    if (!changed) {
      halt('the instance id never changed -- no restart was observed');
      }
    ok('a different container is now serving');
  }

  // ---- 4. The four things "survives" has to mean ---------------------------
  const after = await overlay();
  note('new instance ' + after.durability.instanceId);

  if (!after.restore.attempted || !after.restore.ok) {
    halt('the restore did not succeed: ' + (after.restore.error ?? 'not attempted'));
  } else {
    ok(
      'restore read back ' + after.restore.entries + ' position(s) / ' +
        after.restore.events + ' event(s) in ' + after.restore.elapsedMs + ' ms',
    );
    measured.restoreMs = after.restore.elapsedMs;
    measured.restoredEntries = after.restore.entries;
    measured.restoredEvents = after.restore.events;
    measured.instanceAfter = after.durability.instanceId;
  }
  if (after.restore.duplicates > 0) {
    // Not a failure: insertAll de-duplicates on a best-effort basis, so a retried
    // append can leave a row twice. Worth seeing, and the restore dropped them.
    note('the restore dropped ' + after.restore.duplicates + ' duplicate row(s) from the log');
  }

  const entry = after.entries.find(
    (e) => e.facilityId === event.facilityId && e.drugId === event.drugId,
  );
  if (entry?.onHand === TEST_VALUE) ok('the corrected position is in force again (' + entry.onHand + ')');
  else fail('the position came back as ' + JSON.stringify(entry) + ', expected ' + TEST_VALUE);

  // The identity survives; the cursor deliberately does not. A new container is
  // a new instance, and a stream cursor issued by the old one names nothing here.
  const restoredEvent = after.events.find((e) => e.eventId === event.eventId);
  if (restoredEvent) {
    measured.eventIdAfterRestart = restoredEvent.eventId;
    ok('the report came back under its own event id (' + event.eventId + ')');
  } else {
    fail('no restored event carries the id ' + event.eventId);
  }
  try {
    const ctrl = new AbortController();
    const stream = await fetch(BASE + '/api/events', {
      headers: { 'Last-Event-ID': oldCursor, Accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    const reader = stream.body.getReader();
    let text = '';
    const until = Date.now() + 10_000;
    while (Date.now() < until && !/event: hello/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    ctrl.abort();
    measured.oldCursorReset = /event: reset/.test(text) && text.includes(after.durability.instanceId + ':');
    if (measured.oldCursorReset) ok('a stream resumed with the old container\'s cursor (' + oldCursor + ') is sent a reset, not a replay');
    else fail('a stream resumed with the old cursor was not reset: ' + text.slice(0, 200));
  } catch (e) {
    fail('could not open the stream with the old cursor: ' + (e && e.message));
  }

  // ---- 5. A BROWSER SEES IT ------------------------------------------------
  //
  // The part a judge performs. `/console` is prerendered, so this can only work
  // through the mount-time overlay fetch.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(BASE + '/console', { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForFunction(
        (n) => document.body.innerText.includes(n),
        TEST_VALUE.toLocaleString('en-IN'),
        { timeout: 15_000 },
      );
      ok('a freshly loaded /console renders the restored number on the RESTARTED server');
      measured.browserSawRestoredValue = true;
    } catch {
      fail(
        'the restored number is not on the page. The overlay has it, so the mount-time ' +
          '/api/overlay fetch is the suspect.',
      );
    }
  } catch (e) {
  if (!(e instanceof Halt)) {
    fail((e && e.stack) || String(e));
  }
} finally {
    await browser.close();
  }

  // ---- 6. Put the board back ----------------------------------------------
  const restore = await commit(target.facilityId, target.drugName, ledgerValue);
  if (restore.status === 200 && (restore.body.committed ?? []).length > 0) {
    const back = await waitForDurable(restore.body.committed[0].seq);
    ok(
      'board restored to the ledger position (' + ledgerValue + '), durable in ' + back.ms + ' ms',
    );
  } else {
    halt('could not restore the board to ' + ledgerValue + ' -- fix it by hand before any demo');
  }
} finally {
  if (server) await killServer(server);
  // A killed local process never runs its SIGTERM handler, so its fan-out
  // subscription would sit in the project for a day. Only a local run owns the
  // processes it killed; a deployment's instances clean up after themselves.
  if (LOCAL) {
    const ids = [measured.instanceBefore, measured.instanceAfter].filter(Boolean);
    try {
      const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
      const client = await auth.getClient();
      const project = process.env.GOOGLE_CLOUD_PROJECT || (await auth.getProjectId());
      for (const id of ids) {
        const sub = 'aarogya-live-' + String(id).toLowerCase().replace(/[^a-z0-9-]/g, '-');
        await client
          .request({ url: 'https://pubsub.googleapis.com/v1/projects/' + project + '/subscriptions/' + sub, method: 'DELETE' })
          .catch(() => undefined);
      }
      if (ids.length > 0) note('deleted the fan-out subscriptions of the killed local processes');
    } catch {
      note('could not delete the local fan-out subscriptions; they expire after a day unused');
    }
  }
}

if (failures === 0) {
  const key = persist(measured);
  console.log();
  console.log('  wrote docs/restart-gate.json (' + key + ') and docs/restart-gate.md');
}

console.log();
console.log(failures === 0 ? 'PASS  the live loop survives a container restart' : 'FAIL  ' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
