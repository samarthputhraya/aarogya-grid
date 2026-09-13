/**
 * THE LIVE-LOOP REHEARSAL.
 *
 * Run:  npm run rehearse:live                       (against a local server)
 *       npm run rehearse:live -- https://host       (against a deployment)
 *
 * Expects a server already running at the target. Locally:
 *   npm run build && npm start
 *
 * WHAT THIS EXERCISES, AND WHY A UNIT TEST CANNOT
 * -----------------------------------------------
 * WS2's acceptance test is "commit a report -> a number changes on /console
 * within 2 s without a page reload, in a second tab -- and it SURVIVES a
 * reload". Every part of that is an integration property:
 *
 *   POST /api/commit -> resolveDrug -> Tier-1 recompute -> overlay store
 *     -> GET /api/events (SSE, through whatever proxies sit in front)
 *     -> EventSource in a real browser -> React state -> the rendered cell
 *     -> F5 -> prerendered HTML + GET /api/overlay on mount -> the same cell
 *
 * THE TRAP THIS EXISTS TO CATCH
 * -----------------------------
 * `/console` is prerendered at BUILD time. A committed report can therefore
 * never be in the HTML the server returns. Subscribe to SSE and the demo works
 * beautifully -- the number changes in front of you -- and then somebody
 * reloads and every change vanishes, because the reload serves the build's HTML
 * and the stream only carries what happens NEXT.
 *
 * So step 4 below is the whole point. It is easy to skip, it passes trivially
 * while broken if you only look at step 3, and it is the difference between a
 * demo that survives a judge pressing F5 and one that does not.
 *
 * Two more things it checks that only appear over real HTTP: that the SSE
 * response is not buffered by a proxy (a buffered stream delivers nothing until
 * it closes), and that a second tab -- a second EventSource on the same
 * instance -- receives the same event.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The artefact the console was built from, so the target is one it renders. */
const SNAPSHOT = JSON.parse(
  readFileSync(resolve(HERE, '../src/data/national-snapshot.json'), 'utf8'),
);

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const DELTA_BUDGET_MS = 2000;

/*
 * THE ARTEFACT, written only by a run that passed.
 *
 * This rehearsal used to print its figures and forget them, and the same
 * measurement was then published as 326 ms in one place and 178 ms in another,
 * both credited to the live deployment, with nothing to say which run either
 * came from. Now a passing run writes what it measured to docs/live-gate.json,
 * under a key for the environment, and check-claims reads the surfaces against
 * it. A FAILED run writes nothing: a quota blip must not overwrite a good
 * measurement and take the claims down with it.
 */
const GATE_PATH = resolve(HERE, '../docs/live-gate.json');
const ENVIRONMENT = BASE.includes('localhost') || BASE.includes('127.0.0.1') ? 'local' : 'cloudRun';
const measured = { base: BASE, at: new Date().toISOString() };

const fail = (msg) => {
  console.error('\n  FAIL  ' + msg);
  process.exitCode = 1;
};
const ok = (msg) => console.log('  ok    ' + msg);

console.log('Live-loop rehearsal against ' + BASE);
if (!BASE.includes('localhost')) {
  console.log('  ! this is not localhost: it will commit to that service and restore afterwards');
}
console.log();

// ---- 0. Find a position that is actually rendered on the board -------------
//
// Committing against a position the board does not show would "pass" without
// proving anything a viewer could see.
const overlayProbe = await fetch(BASE + '/api/overlay', { cache: 'no-store' }).catch(() => null);
if (!overlayProbe || !overlayProbe.ok) {
  fail('GET /api/overlay did not respond. Is the server running at ' + BASE + '?');
  process.exit(1);
}
const startingSeq = (await overlayProbe.json()).seq;
ok('GET /api/overlay responds (seq ' + startingSeq + ')');

const browser = await chromium.launch();
const context = await browser.newContext();

try {
  // ---- 1. Two tabs on the console ------------------------------------------
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await tabA.goto(BASE + '/console', { waitUntil: 'domcontentloaded' });
  await tabB.goto(BASE + '/console', { waitUntil: 'domcontentloaded' });

  ok('two tabs open on /console');

  // ---- 2. Commit a report over real HTTP -----------------------------------
  //
  // The drug is sent as a NAME and resolved server-side, exactly as the console
  // does -- there is no drugId shortcut, and a rehearsal that used one would
  // skip the resolver the real path depends on.
  /*
   * TARGET THE TOP ROW OF THE BOARD, read from the shipped snapshot.
   *
   * The alert board is a national TOP-40. Committing against an arbitrary
   * facility proves the API works and proves nothing about what a viewer sees --
   * the first run of this rehearsal did exactly that, committed against a
   * position ranked outside the 250 the snapshot even carries, and reported a
   * failure that was really a badly chosen target. `alerts[0]` is by definition
   * on screen.
   */
  const target = SNAPSHOT.alerts[0];
  const chosen = process.env.AAROGYA_REHEARSE_FACILITY_ID ?? target.facilityId;
  const drugName = process.env.AAROGYA_REHEARSE_DRUG ?? target.drugName;
  const newOnHand = 4242;
  ok('target is the top board row: ' + target.facilityName + ' / ' + target.drugName);

  const postCommit = async (onHand) => {
    const res = await fetch(BASE + '/api/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        facilityId: chosen,
        source: 'typed',
        entries: [{ drugName, onHand }],
      }),
    });
    return { res, body: await res.json() };
  };

  /*
   * COLD FIRST, THEN MEASURED -- and both are reported.
   *
   * The first commit a fresh container sees pays for module initialisation
   * (parsing a 2.5 MB forecast cache) and JIT warm-up on top of the actual
   * recompute. Measured against a just-deployed Cloud Run revision that is
   * 116 ms; the same instance then answers in the teens. Asserting on the cold
   * figure would make the budget a measure of container start-up, and quietly
   * dropping it would hide a real number a judge could hit by being the first
   * visitor after a scale-to-zero. So the budget is checked on the warm path
   * and the cold figure is printed either way.
   */
  const warmUp = await postCommit(newOnHand - 1);
  if (!warmUp.res.ok) {
    fail('warm-up commit failed: ' + warmUp.res.status + ' ' + JSON.stringify(warmUp.body).slice(0, 200));
    throw new Error('commit failed');
  }
  ok('cold-start commit (module init + JIT): ' + warmUp.body.recomputeMs + ' ms');
  measured.coldRecomputeMs = warmUp.body.recomputeMs;
  // The REAL ledger value, read off the first commit. The measured commit's own
  // `previousOnHand` is the warm-up's number, and restoring to that used to
  // leave the rehearsal's 4,241 on the board -- on a live deployment, in front
  // of whoever opened it next.
  const ledgerOnHand = warmUp.body.committed?.[0]?.risk?.previousOnHand;

  const t0 = Date.now();
  const { res: commit, body: commitBody } = await postCommit(newOnHand);
  if (!commit.ok || (commitBody.committed ?? []).length === 0) {
    fail(
      'POST /api/commit did not commit: ' + commit.status + ' ' +
        JSON.stringify(commitBody).slice(0, 300),
    );
    throw new Error('commit failed');
  }
  const event = commitBody.committed[0];
  ok(
    'commit accepted: ' + event.facilityName + ' / ' + event.drugName +
      ' -> ' + event.onHand + ' (server recompute ' + commitBody.recomputeMs + ' ms)',
  );
  if (commitBody.recomputeMs >= 100) {
    fail(
      'warm server recompute took ' + commitBody.recomputeMs +
        ' ms, over the 100 ms WS2 budget',
    );
  } else {
    ok('warm server recompute ' + commitBody.recomputeMs + ' ms, inside the 100 ms budget');
    measured.warmRecomputeMs = commitBody.recomputeMs;
  }
  // Against the ledger, not against the warm-up commit a moment ago.
  const fromLedger = warmUp.body.committed?.[0]?.risk ?? event.risk;
  ok(
    'risk moved from the ledger: P(out) ' + fromLedger.previousStockoutProbability + ' -> ' +
      event.risk.stockoutProbability + ', score ' + fromLedger.previousRiskScore + ' -> ' +
      event.risk.riskScore,
  );

  // ---- 3. Both tabs see it, without a reload -------------------------------
  const sawIt = (page) =>
    page.waitForFunction(
      (n) => document.body.innerText.includes(n),
      newOnHand.toLocaleString('en-IN'),
      { timeout: DELTA_BUDGET_MS },
    );

  try {
    await Promise.all([sawIt(tabA), sawIt(tabB)]);
    const delta = Date.now() - t0;
    ok('both tabs showed the new number in ' + delta + ' ms (budget ' + DELTA_BUDGET_MS + ' ms)');
    measured.twoTabsMs = delta;
  } catch {
    fail(
      'the committed number did not reach both tabs within ' + DELTA_BUDGET_MS + ' ms. ' +
        'Check SSE is not being buffered (X-Accel-Buffering) and that the console subscribes.',
    );
  }

  // The board row itself must carry the `live` marker, or a viewer cannot tell
  // a field report from last night's batch.
  const marked = await tabA.evaluate(
    (name) =>
      [...document.querySelectorAll('tbody tr')].some(
        (r) =>
          (r.textContent ?? '').includes(name) &&
          (r.textContent ?? '').toLowerCase().includes('live'),
      ),
    target.facilityName,
  );
  if (marked) ok('the board row is marked as live, not as batch output');
  else fail('the updated row carries no live marker');

  // Case-insensitive on purpose: `.panel-head` is CSS-uppercased and Chrome's
  // `innerText` returns text AS RENDERED, so a case-sensitive match here fails
  // against a feed that is on screen and correct. That cost a debugging round.
  const inFeed = await tabA.evaluate(
    (name) => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('live field reports') && text.includes(name.toLowerCase());
    },
    target.facilityName,
  );
  if (inFeed) ok('the report also appears in the live field-reports feed');
  else fail('the live field-reports feed did not show the commit');

  // ---- 4. THE ONE THAT MATTERS: it survives a reload -----------------------
  await tabA.reload({ waitUntil: 'domcontentloaded' });
  try {
    await sawIt(tabA);
    ok('the change SURVIVED a reload -- the mount-time /api/overlay fetch works');
    measured.survivedReload = true;
  } catch {
    fail(
      'the change vanished on reload. /console is prerendered, so SSE alone cannot ' +
        'restore it: the console must ALSO fetch /api/overlay on mount.',
    );
  }

  // ---- 4b. Put the board back ----------------------------------------------
  //
  // A rehearsal that can be pointed at production must not LEAVE anything
  // there. The overlay is in-process, so this would otherwise sit on the live
  // board until the next deploy, showing a judge a number that came from a test
  // rather than from a field report. Committing the ledger value back restores
  // the row; the field-reports feed still shows that it happened, which is
  // correct -- those commits really did occur.
  if (typeof ledgerOnHand !== 'number') {
    fail('the warm-up commit did not report the ledger value -- restore the board by hand');
  } else {
    const restored = await postCommit(ledgerOnHand);
    if (restored.res.ok && (restored.body.committed ?? []).length > 0) {
      ok('board restored to the ledger position (' + ledgerOnHand + ')');
    } else {
      fail('could not restore the board to ' + ledgerOnHand + ' -- check it by hand');
    }
  }

  // ---- 5. The stream is not buffered ---------------------------------------
  const streamRes = await fetch(BASE + '/api/events?since=0', {
    headers: { Accept: 'text/event-stream' },
  });
  const buffering = streamRes.headers.get('x-accel-buffering');
  const ctype = streamRes.headers.get('content-type') ?? '';
  if (!ctype.includes('text/event-stream')) fail('SSE content-type is ' + ctype);
  else ok('SSE content-type is text/event-stream');
  if (buffering !== 'no') fail('X-Accel-Buffering is ' + buffering + ', expected "no"');
  else ok('X-Accel-Buffering: no is set');

  // Read the first frames to prove bytes arrive before the stream closes.
  const reader = streamRes.body.getReader();
  const firstChunk = await Promise.race([
    reader.read().then((r) => new TextDecoder().decode(r.value ?? new Uint8Array())),
    new Promise((r) => setTimeout(() => r(''), 3000)),
  ]);
  await reader.cancel();
  if (firstChunk.includes('retry:')) {
    ok('the stream flushes its first frame immediately');
    measured.firstFrameImmediate = true;
    measured.unbuffered = buffering === 'no';
  }
  else fail('no bytes arrived from /api/events within 3 s -- something is buffering it');
} finally {
  await browser.close();
}

console.log();
if (!process.exitCode) {
  const gate = existsSync(GATE_PATH) ? JSON.parse(readFileSync(GATE_PATH, 'utf8')) : {};
  gate[ENVIRONMENT] = { ...measured, budgets: { recomputeMs: 100, twoTabsMs: DELTA_BUDGET_MS }, passed: true };
  writeFileSync(GATE_PATH, JSON.stringify(gate, null, 1) + '\n');
  console.log('  wrote docs/live-gate.json (' + ENVIRONMENT + ')');
}
console.log(process.exitCode ? 'REHEARSAL FAILED' : 'REHEARSAL PASSED');
