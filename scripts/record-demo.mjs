/**
 * THE INSURANCE CUT: the whole loop, in one take, recorded.
 *
 * Run:  npm run record:demo                      (against a local server)
 *       npm run record:demo -- https://host       (against the deployment)
 *
 * Expects a server already running at the target. Locally:
 *   npm run build && npm start
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT
 * ----------------------------------
 * The final demo video is a single day at the very end of the calendar, and it
 * is the one artefact that cannot be recovered if that day goes wrong: a broken
 * build can be reverted, a missing slide can be written in an hour, a video
 * cannot be conjured. So a usable cut exists from day 10 onwards, and it is
 * re-made by running this.
 *
 * It is NOT the submission video. There is no narration, no cutting and no
 * titles -- what it records is the product doing the thing, continuously, with
 * no edit that could be hiding a reload. That is also its one real advantage
 * over a hand-recorded take: a viewer can see there is no cut.
 *
 * WHAT IT DRIVES, IN ORDER
 * ------------------------
 *   1. the national board, so the scale is established before anything moves
 *   2. field capture -- Hindi speech, through the real microphone path, into a
 *      draft a human reviews, and COMMITTED
 *   3. the board again, with the report on it and the risk moved
 *   4. a district, where a cross-district order is approved, dispatched, and
 *      received SHORT -- with the partial recovery visible
 *
 * THE MICROPHONE IS THE ONLY THING SUBSTITUTED
 * --------------------------------------------
 * `getUserMedia` is overridden to return a MediaStream carrying a committed
 * 14.3 s Hindi fixture played through Web Audio, exactly as `rehearse-voice`
 * does. Everything downstream of the microphone -- MediaRecorder, the codec,
 * base64, the 6 MB proxy ceiling, Gemini, Zod, the drug resolver, the commit,
 * the recompute, the stream -- is the real path. Chromium's
 * `--use-file-for-fake-audio-capture` flag was tried first and fed its default
 * BEEP rather than the file, in both plain and `%noloop` forms; do not re-try it.
 *
 * IT SPENDS MONEY. One Gemini call per run, on flash. Single-digit rupees.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FIXTURE = resolve(HERE, 'fixtures/hindi-stock-report.mp3');
const OUT_DIR = resolve(ROOT, 'docs/demo');

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const DISTRICT = process.env.AAROGYA_DEMO_DISTRICT ?? 'DST-10-PURNIA';
/** Long enough for the 14.3 s fixture to finish. */
const RECORD_MS = 17_000;
/** Units deliberately lost in transit, so the variance beat is real. */
const SHORTFALL = 3;

/**
 * How long the camera lingers on something worth reading.
 *
 * A screen recording that moves at the speed the machine can click is
 * unwatchable: the viewer never gets to the number the click was about. These
 * are the pauses a narrator would fill.
 */
const BEAT = 2200;
const LONG_BEAT = 4000;

if (!existsSync(FIXTURE)) {
  console.error('Missing fixture: ' + FIXTURE);
  process.exit(1);
}

const log = (m) => console.log('  ' + m);
let warnings = 0;
const warn = (m) => {
  warnings++;
  console.warn('  ! ' + m);
};

mkdirSync(OUT_DIR, { recursive: true });
// Playwright names the file after the page's guid, so the directory is cleared
// first and the single video renamed afterwards. Otherwise a re-run leaves a
// pile of near-identical takes and no way to tell which is current.
for (const f of readdirSync(OUT_DIR)) {
  if (f.endsWith('.webm')) rmSync(join(OUT_DIR, f));
}

const audioB64 = readFileSync(FIXTURE).toString('base64');

console.log('\nRecording the insurance cut against ' + BASE);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  permissions: ['microphone'],
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } },
  // A demo recorded at a hairdresser's screen resolution looks like a demo.
  deviceScaleFactor: 1,
});

await ctx.addInitScript((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  navigator.mediaDevices.getUserMedia = async () => {
    const ac = new AudioContext();
    const buf = await ac.decodeAudioData(bytes.buffer.slice(0));
    const dest = ac.createMediaStreamDestination();
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    src.start();
    return dest.stream;
  };
}, audioB64);

const page = await ctx.newPage();
let restoreTo = null;

try {
  // ---- 1. The national board ----------------------------------------------
  await page.goto(BASE + '/console', { waitUntil: 'networkidle' });
  await page.waitForTimeout(LONG_BEAT);
  // Scroll past the map to the alert board: the scale first, then the shelves.
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(BEAT);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(BEAT);
  log('national board');

  // ---- 2. Field capture, in Hindi -----------------------------------------
  await page.goto(BASE + '/capture', { waitUntil: 'networkidle' });
  await page.waitForTimeout(BEAT);

  const facility = await page.locator('select').first().inputValue();
  await page.getByRole('button', { name: 'Speak' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /Start recording/ }).click();
  log('speaking Hindi as ' + facility + ' (' + RECORD_MS / 1000 + 's)');
  await page.waitForTimeout(RECORD_MS);

  const captured = page.waitForResponse(
    (r) => r.url().endsWith('/api/capture') && r.request().method() === 'POST',
    { timeout: 120_000 },
  );
  await page.getByRole('button', { name: /Stop and extract/ }).click();
  const captureRes = await captured.catch(() => null);
  if (!captureRes || captureRes.status() !== 200) {
    warn('capture returned ' + (captureRes ? captureRes.status() : 'nothing') + ' -- the take will be short of its best beat');
  }
  await page.waitForTimeout(LONG_BEAT);

  // The draft, with its flags. This is the part of the argument that says a
  // model which is unsure must say so rather than write into a national ledger.
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(LONG_BEAT);
  log('draft on screen');

  // ---- 3. Commit ----------------------------------------------------------
  const commitBtn = page.getByRole('button', { name: /^Commit / });
  if ((await commitBtn.count()) > 0 && (await commitBtn.first().isEnabled())) {
    const committed = page.waitForResponse(
      (r) => r.url().endsWith('/api/commit') && r.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await commitBtn.first().click();
    const res = await committed.catch(() => null);
    const body = res ? await res.json().catch(() => null) : null;
    if (body?.committed?.length) {
      log('committed ' + body.committed.length + ' position(s) in ' + body.recomputeMs + ' ms');
      // Where to put the shelf back afterwards.
      restoreTo = body.committed.map((e) => ({
        facilityId: e.facilityId,
        drugName: e.drugName,
        onHand: e.risk.previousOnHand,
      }));
    } else {
      warn('the commit returned nothing to show');
    }
    // Long enough for the durability chip to go from "queued" to "durable" on
    // camera -- which is the whole day-8 claim, visible.
    await page.waitForTimeout(LONG_BEAT + 2000);
  } else {
    warn('no enabled commit button -- every entry must have been flagged');
  }

  // ---- 4. The board, changed ----------------------------------------------
  await page.goto(BASE + '/console', { waitUntil: 'networkidle' });
  await page.waitForTimeout(BEAT);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(LONG_BEAT);
  log('back on the board, with the field report on it');

  // ---- 5. A district, and the dispatch loop -------------------------------
  const plan = JSON.parse(
    readFileSync(resolve(ROOT, 'src/data/districts', DISTRICT + '.json'), 'utf8'),
  );
  const existing = await (await fetch(BASE + '/api/dispatch?districtCode=' + DISTRICT)).json();
  const taken = new Set(existing.tickets.map((t) => t.orderId));
  const rendered = (o) =>
    plan.positions.some((pos) => pos.facilityId === o.to.id && pos.drugId === o.drugId);
  const usable = (o) => !taken.has(o.id) && o.quantity > SHORTFALL && rendered(o);
  const order = plan.orders.find((o) => o.crossDistrict && usable(o)) ?? plan.orders.find(usable);

  await page.goto(BASE + '/district/' + DISTRICT, { waitUntil: 'networkidle' });
  await page.waitForTimeout(LONG_BEAT);

  if (!order) {
    warn('every order here already has a ticket -- run `npm run overlay:purge -- --all` first');
  } else {
    const index = plan.orders.indexOf(order) + 1;
    const card = page.locator('[aria-label^="Dispatch order ' + index + ':"]').first();
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(LONG_BEAT);
    log('order ' + index + ': ' + order.from.name + ' -> ' + order.to.name);

    const click = async (name) => {
      const button = card.getByRole('button', { name });
      await button.waitFor({ state: 'visible', timeout: 10_000 });
      await button.click();
    };

    await click('Approve');
    await page.waitForTimeout(LONG_BEAT);
    log('approved -- both ends re-scored, as a projection');

    await click('Dispatch');
    await page.waitForTimeout(LONG_BEAT);
    log('dispatched -- the donor shelf actually falls');

    // The receipt is SHORT, typed in, because that is the normal case in a real
    // supply chain and the recovery being partial is the honest beat.
    const received = card.getByLabel('Units received');
    await received.waitFor({ state: 'visible', timeout: 10_000 });
    await received.fill(String(order.quantity - SHORTFALL));
    await page.waitForTimeout(BEAT);
    await click('Confirm receipt');
    await page.waitForTimeout(LONG_BEAT + 1500);
    log('received short -- the variance is on the card');
  }

  // ---- 6. The CSV a storekeeper would import ------------------------------
  await page.goto(
    BASE + '/api/dispatch/export?districtCode=' + DISTRICT,
    { waitUntil: 'domcontentloaded' },
  ).catch(() => {
    // A download navigation can abort; the file is the point, not the page.
  });
  await page.waitForTimeout(BEAT);
} catch (e) {
  warn('the take was cut short: ' + (e?.message ?? String(e)));
} finally {
  // Put the shelves back before the recording is closed, so a re-run starts
  // from the same place and no judge finds a facility drawn down by a rehearsal.
  if (restoreTo) {
    for (const r of restoreTo) {
      await fetch(BASE + '/api/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId: r.facilityId,
          source: 'typed',
          entries: [{ drugName: r.drugName, onHand: r.onHand }],
        }),
      }).catch(() => {});
    }
    log('committed positions restored');
  }

  const video = page.video();
  await ctx.close();
  await browser.close();

  if (video) {
    const raw = await video.path();
    const stamped = resolve(
      OUT_DIR,
      'aarogya-loop-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '') + '.webm',
    );
    renameSync(raw, stamped);
    console.log('\n  wrote ' + stamped);
  }
}

console.log(
  warnings === 0
    ? '\nPASS  a clean one-take recording of the whole loop'
    : '\nDONE  with ' + warnings + ' warning(s) -- watch the take before relying on it',
);
