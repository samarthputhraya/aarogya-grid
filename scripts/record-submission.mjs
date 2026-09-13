/**
 * THE SUBMISSION VIDEO: the whole argument, in one take, captioned.
 *
 * Run:  npm run record:submission -- https://host
 *       npm run record:submission                 (against localhost:3000)
 *
 * Output: docs/demo/aarogya-submission-<stamp>.webm   the recording
 *         docs/demo-script.md                         the narration, with the
 *                                                     timings this run actually
 *                                                     produced
 *
 * WHY THIS IS A SCRIPT AND NOT A SCREEN RECORDING SOMEBODY MADE
 * -------------------------------------------------------------
 * Three reasons, and the third is the real one.
 *
 * It is reproducible: if a number moves, re-run it and the video moves with it,
 * rather than becoming the one artefact in the submission that quietly
 * disagrees with everything else. It is continuous: there is no cut anywhere in
 * it, so a viewer can see that nothing was hidden between two shots — which
 * matters most at the moment the console updates without a reload, the beat a
 * sceptical reviewer would most reasonably suspect of being faked.
 *
 * And it cannot lie about what happened. Every beat here is driven against a
 * running deployment: a real Gemini call transcribes real Hindi, a real commit
 * re-scores a real position, a real ticket moves through approve → dispatch →
 * receive. If one of them fails, the caption says so on camera and the run
 * reports it. `scripts/record-demo.mjs` is the 90-second insurance cut of the
 * same loop; this is the 3-to-5-minute version the brief asks for.
 *
 * CAPTIONS, NOT NARRATION
 * -----------------------
 * The narration is burned in as a caption bar rather than spoken. That is a
 * deliberate limitation and it is stated here rather than glossed: a voice-over
 * belongs to whoever is presenting. `docs/demo-script.md` is written with the
 * REAL elapsed time of every beat in this run, so a voice track can be laid
 * against it without guessing. Anyone recording narration should read that file,
 * not this one.
 *
 * THE PROTAGONIST IS SELECTED, NEVER INVENTED
 * -------------------------------------------
 * The order the video follows is queried out of the shipped district payload:
 * a Vital or Essential drug, crossing a district boundary, with a real batch and
 * a large fall in stock-out probability. Nothing is staged. If the pick changes
 * because the snapshot changed, the captions change with it, because they are
 * built from the same object.
 *
 * IT SPENDS MONEY. One Gemini call per run, on flash. Single-digit rupees.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintOperatorToken, operatorCookie, sessionSecretFor } from './lib/operator-session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FIXTURE = resolve(HERE, 'fixtures/hindi-stock-report.mp3');
const OUT_DIR = resolve(ROOT, 'docs/demo');

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
/*
 * ONE DISTRICT FOR THE WHOLE STORY.
 *
 * The first take set the scene in Purnia and then had the ANM speak from a
 * Bastar sub-centre, because `/capture` offers a fixed spread of four districts
 * and Purnia is not among them. Every figure in that take was true and the
 * story was still incoherent — which is the kind of mistake a viewer notices
 * immediately and a checker never does. The protagonist district is therefore
 * one of the four the capture page can actually speak from.
 */
const DISTRICT = process.env.AAROGYA_DEMO_DISTRICT ?? 'DST-22-BASTAR';
/** Long enough for the 14.3 s Hindi fixture to finish. */
const RECORD_MS = 17_000;
/** Units deliberately lost in transit, so the variance beat is real. */
const SHORTFALL = 3;

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

const n = (v) => Math.round(v).toLocaleString('en-IN');

// --------------------------------------------------------------- the figures
const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'src/data/national-snapshot.json'), 'utf8'));
const t = snapshot.totals;
const fed = JSON.parse(readFileSync(resolve(ROOT, 'src/data/federated-summary.json'), 'utf8'));
const warning = JSON.parse(readFileSync(resolve(ROOT, 'src/data/warning-rule.json'), 'utf8'));
const plan = JSON.parse(readFileSync(resolve(ROOT, 'src/data/districts', DISTRICT + '.json'), 'utf8'));

mkdirSync(OUT_DIR, { recursive: true });
for (const f of readdirSync(OUT_DIR)) {
  if (f.startsWith('aarogya-submission') && f.endsWith('.webm')) rmSync(join(OUT_DIR, f));
}

const audioB64 = readFileSync(FIXTURE).toString('base64');

/*
 * WHO ACTS ON CAMERA. Writes need a signed-in actor, and a recording cannot sit
 * in Google's account chooser, so the operator mints a session per ROLE -- the
 * ANM, the donor district's officer, the receiving district's officer, the
 * storekeeper, the pharmacist -- and switches between them as the story moves.
 * Every one is marked "operator" on the audit trail and on the header badge, so
 * the take never passes a scripted action off as a person's.
 */
const SECRET = sessionSecretFor(BASE);
if (!SECRET) {
  console.error('No session secret for ' + BASE + ': set AAROGYA_SESSION_SECRET, or have gcloud read aarogya-session-secret.');
  process.exit(1);
}

console.log('\nRecording the submission cut against ' + BASE);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  permissions: ['microphone'],
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } },
  deviceScaleFactor: 1,
});

async function actAs(label) {
  await ctx.addCookies([
    {
      name: 'ag_session',
      value: mintOperatorToken(SECRET, label, 3600),
      url: BASE,
      httpOnly: true,
      sameSite: 'Lax',
      secure: BASE.startsWith('https'),
    },
  ]);
}
await actAs('ANM (recording)');

/*
 * The microphone is the only thing substituted, exactly as in the insurance
 * cut: `getUserMedia` returns a stream carrying the committed Hindi fixture.
 * Everything downstream -- MediaRecorder, the codec, base64, the proxy ceiling,
 * Gemini, Zod, the resolver, the commit, the recompute, the stream -- is real.
 */
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

/*
 * The caption bar, installed on every document.
 *
 * A fixed bar rather than an overlay in the middle of the screen: it must never
 * cover the number the caption is about, and a reviewer scrubbing the video
 * should always find it in the same place. The z-index is the maximum because
 * this page has a sticky header and a map that paints over most things.
 */
await ctx.addInitScript(() => {
  const install = () => {
    if (document.getElementById('__cap')) return;
    const bar = document.createElement('div');
    bar.id = '__cap';
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
      // Near-opaque, not translucent: at .93 the district page's action strip
      // read through the caption at exactly the beat where the caption is
      // telling you to look at that strip.
      'background:rgba(4,8,13,.985)', 'color:#E8EEF2', 'pointer-events:none',
      'font:500 19px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
      'padding:15px 28px 17px', 'border-top:2px solid #2DD4BF', 'min-height:34px',
      'text-shadow:0 1px 2px rgba(0,0,0,.6)', 'letter-spacing:.01em',
      'transition:opacity .25s', 'opacity:0',
    ].join(';');
    document.body.appendChild(bar);
  };
  window.__cap = (text) => {
    install();
    const bar = document.getElementById('__cap');
    if (!bar) return;
    bar.textContent = text;
    bar.style.opacity = text ? '1' : '0';
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
});

const page = await ctx.newPage();
let restoreTo = null;

/** The real timeline, recorded as it happens, for docs/demo-script.md. */
const started = Date.now();
const timeline = [];
const stamp = () => {
  const s = Math.round((Date.now() - started) / 1000);
  return String(Math.floor(s / 60)) + ':' + String(s % 60).padStart(2, '0');
};

/**
 * Navigate, and put the caption straight back.
 *
 * A new document wipes the bar, so the first beat of every page was played with
 * no caption on screen -- about fifteen seconds of the take across eight
 * navigations, always at the moment a viewer is orienting themselves on a new
 * page and most needs the line.
 */
let currentCaption = '';
async function go(url, opts = {}) {
  await page.goto(url, { waitUntil: 'networkidle', ...opts });
  if (currentCaption) await page.evaluate((t) => window.__cap?.(t), currentCaption).catch(() => {});
}

/**
 * Show a caption and hold it.
 *
 * `hold` is generous on purpose. A screen recording that moves at the speed the
 * machine can click is unwatchable: the viewer never reaches the number the
 * click was about. These are the pauses a narrator would fill, and they are
 * sized so the caption can be read at a comfortable pace.
 */
/**
 * Put one dispatch-order card WHOLE on camera, actions included.
 *
 * `scrollIntoViewIfNeeded` stops as soon as the card's top edge is visible.
 * The orders list is its own 720 px scroll box, so in the 13 Sep take the card
 * sat at the bottom of the viewport with its status line, its buttons and the
 * receipt field all underneath the caption bar: approve, dispatch and a short
 * receipt happened for real and a viewer saw none of them. So the card is
 * scrolled to the top of its list, and the list to just under the page's
 * sticky header and disclosure banner.
 */
async function frameCard(index) {
  const card = page.locator('[aria-label^="Dispatch order ' + index + ':"]').first();
  if ((await card.count()) === 0) {
    warn('dispatch order ' + index + ' is not rendered on this page');
    return card;
  }
  await card.scrollIntoViewIfNeeded();
  await card.evaluate((el) => {
    let box = el.parentElement;
    while (box && !['auto', 'scroll'].includes(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (box && box !== document.documentElement && box !== document.body) {
      box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
    }
    const anchor = box && box !== document.documentElement && box !== document.body ? box : el;
    window.scrollBy(0, anchor.getBoundingClientRect().top - 136);
  });
  return card;
}

async function say(text, hold = 5200) {
  timeline.push({ at: stamp(), text });
  currentCaption = text;
  await page.evaluate((t) => window.__cap?.(t), text).catch(() => {});
  log(stamp() + '  ' + text.slice(0, 92));
  await page.waitForTimeout(hold);
}

try {
  // ---- 0:00 the country ----------------------------------------------------
  await go(BASE + '/console');
  await page.waitForTimeout(1200);
  await say(
    `${n(t.facilities)} facilities. ${n(t.districts)} districts, ${n(t.states)} states. ` +
      // Two disjoint counts over different denominators, so they are two
      // clauses. "N critical, M of them at zero" once made the subset larger
      // than its superset in the first line of the video.
      `Tonight ${n(t.criticalPositions)} stock positions are critical, and ${n(t.zeroStockPositions)} positions are already at zero.`,
    6000,
  );
  await say(
    'Every bubble is a district. Every arc is medicine that is already in the country, ' +
      'moving from where it will expire to where it will run out.',
    6000,
  );

  // ---- the protagonist -----------------------------------------------------
  /*
   * Selected, never invented: crossing a district line, a Vital drug, a real
   * batch, and the receiver in the worst shape — ranked rather than taken in
   * array order, so the video follows the order that best carries the argument
   * and not whichever one the optimiser happened to emit first.
   */
  /*
   * "A large fall in stock-out probability" is part of the selection, not only
   * of this comment. The take of 13 Sep ranked on the receiver's risk BEFORE the
   * order alone, and so followed a Ceftriaxone order that averts 85 vials of
   * shortfall and leaves the receiver at 100% -- true, and the weakest possible
   * protagonist for a video whose argument is that moving stock prevents a
   * stock-out. An order that halves the risk or better is preferred first.
   *
   * Then the CHEAPER movement. The next take followed 10 co-packs over 129 km
   * for ₹2,777 -- admitted by the planner at the Vital shortage price, and a
   * line that invites "why spend that to move ten packs?" in the one minute a
   * judge gives the video. Among orders that do the job, the one that costs
   * least is the one that illustrates the argument rather than its edge case.
   */
  const rank = (o) => [
    o.crossDistrict ? 1 : 0,
    o.ved === 'V' ? 1 : 0,
    o.riskReduction >= 0.5 ? 1 : 0,
    -o.estimatedCostInr,
    o.receiverStockoutProbBefore,
    o.riskReduction,
  ];
  const hero =
    [...plan.orders]
      .filter((o) => o.quantity > SHORTFALL)
      .sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        for (let i = 0; i < ra.length; i++) if (rb[i] !== ra[i]) return rb[i] - ra[i];
        return 0;
      })[0] ?? plan.orders[0];
  const batch = hero.lines[0];

  await go(BASE + '/district/' + DISTRICT);
  await page.waitForTimeout(1500);
  // The caption names a card; the camera should be on it, not on the page header.
  await frameCard(plan.orders.indexOf(hero) + 1);
  await say(
    `${plan.district.districtName}, ${plan.district.stateName}. ` +
      `${hero.to.name} is short of ${hero.drugName} — a ${hero.ved === 'V' ? 'Vital' : 'Essential'} drug — ` +
      `with a ${Math.round(hero.receiverStockoutProbBefore * 100)}% chance of running out inside its resupply window.`,
    6500,
  );
  await say(
    `The stock exists. ${hero.from.name} is ${Math.round(hero.distanceKm)} km away in the next district, ` +
      `holding batch ${batch.batchNo}, which expires in ${batch.daysToExpiry} days.`,
    6500,
  );

  // ---- 0:25 the paper register --------------------------------------------
  await say(
    'But none of that is visible today, because the shelf is counted on paper. So we start there.',
    4800,
  );
  await go(BASE + '/capture');
  await page.waitForTimeout(1200);

  const facility = await page.locator('select').first().inputValue();
  await page.getByRole('button', { name: 'Speak' }).click();
  await page.waitForTimeout(700);
  await say(
    'An ANM speaks her stock report in Hindi. No form, no app training, no typing. ' +
      'This is a real microphone stream into a real Gemini call.',
    2500,
  );
  await page.getByRole('button', { name: /Start recording/ }).click();
  log('speaking Hindi as ' + facility);
  await page.waitForTimeout(RECORD_MS);

  const captured = page.waitForResponse(
    (r) => r.url().endsWith('/api/capture') && r.request().method() === 'POST',
    { timeout: 120_000 },
  );
  await page.getByRole('button', { name: /Stop and extract/ }).click();
  await say('Gemini transcribes it, translates it, and resolves each medicine against the catalogue.', 3000);
  const captureRes = await captured.catch(() => null);
  if (!captureRes || captureRes.status() !== 200) {
    warn('capture returned ' + (captureRes ? captureRes.status() : 'nothing'));
    await say('The capture call failed on this take. We are showing you that rather than cutting it.', 5000);
  }
  await page.waitForTimeout(1500);
  await page.mouse.wheel(0, 500);
  await say(
    'Nothing is written yet. The draft is hers to confirm, and anything the model was unsure of is flagged ' +
      'rather than quietly accepted — a language model may not write into a national stock ledger unreviewed.',
    7000,
  );

  // ---- commit --------------------------------------------------------------
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
      restoreTo = body.committed.map((e) => ({
        facilityId: e.facilityId,
        drugName: e.drugName,
        onHand: e.risk.previousOnHand,
      }));
      await say(
        `She confirms. The position is re-scored on the server in ${body.recomputeMs} milliseconds, ` +
          'appended to a durable log, and pushed to every open screen.',
        6000,
      );
    } else {
      warn('the commit returned nothing');
    }
    await page.waitForTimeout(2500);
  } else {
    warn('no enabled commit button');
  }

  // ---- the console moves ---------------------------------------------------
  await go(BASE + '/console');
  await page.waitForTimeout(1500);
  /*
   * A fixed 1,400 px wheel used to land this caption on the beds-and-workforce
   * panel, so "her report is on it" played over a screen that did not show it.
   * Scroll to the feed the caption is about.
   */
  const feed = page.locator('section.panel').filter({ hasText: /Live field reports/i }).first();
  if ((await feed.count()) > 0) {
    await feed.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 96));
  } else {
    warn('the live field-reports feed is not on the console');
  }
  await page.waitForTimeout(600);
  await say(
    'The national console. Her report is on it, marked as a live field report rather than as batch output, ' +
      'and it survives a reload — the page fetches the overlay on mount as well as subscribing to the stream.',
    7000,
  );

  // ---- the models ----------------------------------------------------------
  // Over the board those models scored, rather than wherever a fixed wheel lands.
  const board = page.locator('section.panel').filter({ hasText: /Priority stock alerts/i }).first();
  if ((await board.count()) > 0) {
    await board.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 96));
  }
  await say(
    `Demand for all ${n(snapshot.forecast.seriesForecast)} district × drug series is forecast by Google's TimesFM, ` +
      `through BigQuery AI.FORECAST, ${snapshot.forecast.horizonDays} days ahead from a ${snapshot.forecast.contextDays}-day context — ` +
      'in concurrent statements that process zero bytes.',
    7000,
  );
  await say(
    `It does not serve every position, and that is measured rather than claimed: a 28-day held-out backtest ` +
      `gives TimesFM the demand class it wins by more than 5%. It holds ${n(snapshot.forecast.timesfmPositions)} ` +
      `of ${n(t.trackedPositions)} positions. We publish where it loses.`,
    7500,
  );
  await say(
    `The same data carries the emergency signal. A tuned rule catches a doubled 14-day surge ` +
      `${Math.round(warning.measured.detectionRateAt2x * 100)}% of the time, a median ` +
      `${warning.measured.medianLeadDays} days before the first shelf empties — at ` +
      `${Math.round(warning.measured.precision * 100)}% precision, which we publish because it is not flattering.`,
    7500,
  );

  // ---- the one real source ---------------------------------------------------
  // Read from the deployment, not the repository: the nightly batch may have
  // ingested bulletins newer than the ones committed.
  const observedFeed = await (await fetch(BASE + '/api/indicators?provenance=observed')).json().catch(() => null);
  const observedSource = observedFeed?.sources?.find((x) => x.provenance === 'observed');
  const panelObserved = page.locator('section[aria-labelledby="observed-surveillance"]').first();
  if (observedSource && (await panelObserved.count()) > 0) {
    await panelObserved.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 96));
    await page.waitForTimeout(800);
    const top = [...(observedFeed.signals ?? [])].sort((a, b) => b.observedValue - a.observedValue)[0];
    await say(
      'And one source is real. Kerala publishes a district-wise disease bulletin every day; ' +
        `${observedSource.description.match(/read from (\d[\d,]*)/)?.[1] ?? 'its'} bulletins are read from their text layer, every column checked against its own total, ` +
        (top
          ? `and the same rule flags ${top.area.name}: ${top.hazardLabel.replace(/ above the expected range$/, '').toLowerCase()}, ${n(top.observedValue)} against at most ${n(Math.round(top.expectedUpperBound))} — linked to the bulletin it came from.`
          : 'and on the latest bulletins no district is above its expected range.'),
      8000,
    );
  } else {
    warn('the observed surveillance panel is not on the console');
  }

  // ---- the dispatch loop ---------------------------------------------------
  const existing = await (await fetch(BASE + '/api/dispatch?districtCode=' + DISTRICT)).json();
  const taken = new Set(existing.tickets.map((x) => x.orderId));
  const rendered = (o) => plan.positions.some((p) => p.facilityId === o.to.id && p.drugId === o.drugId);
  const usable = (o) => !taken.has(o.id) && o.quantity > SHORTFALL && rendered(o);
  // The same order the scene was set on, when nothing has claimed it yet.
  const order =
    (usable(hero) ? hero : null) ??
    plan.orders.find((o) => o.crossDistrict && usable(o)) ??
    plan.orders.find(usable);

  await go(BASE + '/district/' + DISTRICT);
  await page.waitForTimeout(1500);

  if (!order) {
    warn('every order here already has a ticket -- run `npm run overlay:purge -- --all` first');
  } else {
    const index = plan.orders.indexOf(order) + 1;
    const card = await frameCard(index);
    await page.waitForTimeout(1200);
    await say(
      `The recommendation is not an alert. It names a batch, an expiry date, a distance and a price: ` +
        `${n(order.quantity)} ${order.unit} of ${order.drugName} from ${order.from.name}, ` +
        `${Math.round(order.distanceKm)} km away, ` +
        // True either way. An order that shares a vehicle is charged its share;
        // one that does not carries the whole trip, and saying it shares when it
        // does not would be the exact kind of small lie this project refuses.
        (order.standaloneCostInr > order.estimatedCostInr
          ? `charged ₹${n(order.estimatedCostInr)} because it shares a vehicle rather than ₹${n(order.standaloneCostInr)} alone.`
          : `carrying the whole ₹${n(order.estimatedCostInr)} trip, because nothing else is going that way today.`),
      7500,
    );
    await say(
      'And it says who may issue it. This one crosses a district boundary, so the donor district has to ' +
        'countersign — the software refuses to let a district officer approve it alone.',
      6500,
    );

    const click = async (name) => {
      const button = card.getByRole('button', { name });
      await button.waitFor({ state: 'visible', timeout: 10_000 });
      await button.click();
    };

    const counter = card.getByRole('button', { name: /Countersign|Record agreement/ });
    if ((await counter.count()) > 0) {
      await actAs('donor district officer (recording)');
      await counter.first().click();
      await page.waitForTimeout(2000);
      // Four eyes, on camera: the officer who countersigned tries to approve.
      await click('Approve');
      await page.waitForTimeout(1500);
      await say(
        'Signed in as the officer who just countersigned, Approve is refused: the same person cannot agree to an ' +
          'order and then sign it off. An officer of the receiving district has to.',
        6500,
      );
      await actAs('receiving district officer (recording)');
    }
    await click('Approve');
    await say(
      'Approved. Both ends are re-scored — as a projection, because approval moves no stock: ' +
        'medicine leaves the donor when it is dispatched and arrives when it is received.',
      6500,
    );

    await actAs('donor storekeeper (recording)');
    await click('Dispatch');
    await say('Dispatched. Now the donor shelf actually falls — and no donor is ever taken past its own guardrail.', 5500);

    const received = card.getByLabel('Units received');
    await received.waitFor({ state: 'visible', timeout: 10_000 });
    await received.fill(String(order.quantity - SHORTFALL));
    await page.waitForTimeout(1500);
    await actAs('receiving pharmacist (recording)');
    await click('Confirm receipt');
    await say(
      `${n(order.quantity - SHORTFALL)} arrived of ${n(order.quantity)} sent. The difference is kept as a variance ` +
        'and the receiver recovers by what turned up, not by what was posted. Most systems of this shape cannot ' +
        'represent that at all.',
      7500,
    );
  }

  // ---- federated -----------------------------------------------------------
  await go(BASE + '/console');
  await page.waitForTimeout(1200);
  const panel = page.locator('section').filter({ hasText: 'what crossed the state line' }).first();
  await panel.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(1200);
  await say(
    `And the word the brief adds this year. ${fed.nodes.length} state nodes, each fitted on its own data. ` +
      `${n(fed.shared.numbers)} numbers crossed a state line — against ${n(fed.shared.rowsRetainedInStates)} ` +
      'consumption records that stayed where they were recorded.',
    7500,
  );
  await say(
    'Zero facility rows. Zero stock quantities. Zero patient records. Zero district identifiers. ' +
      `Every node is a URL you can fetch and hash for yourself, and the test suite sweeps all ${fed.nodes.length} files for leaks.`,
    7000,
  );
  await say(
    `It is worth something, measured leave-one-state-out: a state joining with ` +
      `${fed.headline.historyDays} days of its own history forecasts ` +
      `${(fed.headline.improvementOverLocal * 100).toFixed(1)}% closer to observed demand with the national prior than without it.`,
    7000,
  );

  // ---- provenance and the stack -------------------------------------------
  await go(BASE + '/api/federated/' + fed.nodes[1].stateCode, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);
  await say(
    'That is the artefact itself. Nothing here asks to be believed — it asks to be checked.',
    5000,
  );

  await go(BASE + '/console');
  await page.waitForTimeout(1200);
  await say(
    'Districts, coordinates, LGD codes, Census populations, the essential medicines list and the IPHS norms are real. ' +
      'Facility-level stock is simulated, and labelled as simulated on every surface — because the absence of that ' +
      'data is the problem this is built for.',
    7500,
  );
  await say(
    'Gemini on Vertex AI. TimesFM in BigQuery. Cloud Run. All of it in asia-south1, and the forecast queries process zero bytes.',
    6000,
  );
  await say(
    'One state, eight weeks, two metrics: stock-out days prevented, and time from alert to action. Aarogya Grid.',
    6000,
  );
  await say('', 1200);
} catch (e) {
  warn('the take was cut short: ' + (e?.message ?? String(e)));
} finally {
  if (restoreTo) {
    for (const r of restoreTo) {
      await fetch(BASE + '/api/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: operatorCookie(SECRET, 'recording restore', 600) },
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

  const runtime = Math.round((Date.now() - started) / 1000);

  if (video) {
    const raw = await video.path();
    const out = resolve(
      OUT_DIR,
      'aarogya-submission-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '') + '.webm',
    );
    renameSync(raw, out);
    console.log('\n  wrote ' + out + '  (' + Math.floor(runtime / 60) + 'm ' + (runtime % 60) + 's)');
  }

  /*
   * The script, with the timings this run actually produced.
   *
   * Written from `timeline`, not from the constants above, so it describes what
   * is on the recording rather than what was intended. A voice track laid
   * against these marks will land.
   */
  const doc =
    '# Demo video — the narration, with real timings\n\n' +
    '*Generated by `npm run record:submission`. The timings below are the ones the recording in\n' +
    '`docs/demo/` actually has; they are written as the run happens, not planned in advance.*\n\n' +
    'The video is **captioned, not narrated** — the caption bar carries these lines. A voice track is\n' +
    'the presenter\'s to record, and these marks are what it should be laid against. The runtime of\n' +
    'the take this file describes is **' + Math.floor(runtime / 60) + ' min ' + (runtime % 60) + ' s**.\n\n' +
    'Nothing in it is staged. The Hindi is a committed audio fixture played into a real microphone\n' +
    'stream; the Gemini call, the commit, the re-score, the ticket and the receipt all happen against\n' +
    'the running deployment while the camera is on. There is no cut anywhere in the take.\n\n' +
    '| Time | Line |\n|---:|---|\n' +
    timeline
      .filter((x) => x.text)
      .map((x) => '| ' + x.at + ' | ' + x.text.replace(/\|/g, '\\|') + ' |')
      .join('\n') +
    '\n';
  writeFileSync(resolve(ROOT, 'docs/demo-script.md'), doc);
  console.log('  wrote docs/demo-script.md  (' + timeline.filter((x) => x.text).length + ' captions)');
}

console.log(
  warnings === 0
    ? '\nPASS  a clean captioned take of the whole argument'
    : '\nDONE  with ' + warnings + ' warning(s) -- watch the take before relying on it',
);
