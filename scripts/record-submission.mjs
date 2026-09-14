/**
 * THE SUBMISSION VIDEO: every part of the product, in one narrated take.
 *
 * Run:  npm run record:submission -- https://host
 *       npm run record:submission                 (against localhost:3000)
 *
 * Needs ffmpeg/ffprobe on PATH (or FFMPEG/FFPROBE), Playwright's Chromium, and
 * gcloud credentials that can use Text-to-Speech and read the session secret.
 *
 * Output: docs/demo/aarogya-grid-demo-<stamp>.mp4   the film, voice and all
 *         docs/demo/aarogya-grid-demo-<stamp>.srt   its subtitles, as a file
 *         docs/demo-script.md                       every line, with the time it
 *                                                   starts in this take
 *
 * WHAT IT COVERS, IN ORDER
 * ------------------------
 * The landing page; the national console (the country's KPIs, the flows map,
 * beds and staff); Google sign-in; a Hindi voice report read by Gemini, checked,
 * committed; a photographed register page with a row that does not add up; the
 * report arriving live on the console; the grid assistant with its audit trail;
 * TimesFM forecasting and the early-warning rule; Kerala's real IDSP bulletins; a
 * district's dispatch order through inter-state agreement, a four-eyes refusal,
 * approval, dispatch and a short receipt; federated modelling across 36 state
 * nodes; the deployment (scale-out, durability, the nightly batch); the ask.
 *
 * The owner's note on the first cut was that a judge marks what they are shown,
 * and that take never showed the homepage or sign-in. Everything the product
 * does now has a moment on screen.
 *
 * ONE CONTINUOUS TAKE, NARRATED AFTER THE FACT
 * -------------------------------------------
 * Nothing in the picture is staged or cut. The narration is synthesized before
 * the browser starts (`scripts/lib/narration.mjs`), so the recording knows how
 * long every line is and paces its clicks to it; each scene's real start time on
 * the recording is noted, and the clips are mixed in at exactly those times. The
 * Hindi report the app hears is mixed in too, at the moment the microphone opens
 * -- the viewer hears what Gemini heard.
 *
 * WHAT IS A SAMPLE, AND SAID SO
 * -----------------------------
 * The Hindi report is a recorded sample (`fixtures/hindi-stock-report.mp3`) and
 * the register page is drawn (`scripts/make-register-fixture.mjs`); the narration
 * calls both samples. Sign-in is shown up to Google's own screen, because Google
 * refuses to complete a sign-in inside an automated browser; from there each role
 * is an operator session, labelled "operator · role" on screen and on the audit
 * trail, and the narration says that too.
 *
 * THE PROTAGONIST IS SELECTED, NEVER INVENTED
 * -------------------------------------------
 * The order the video follows is queried out of the shipped district payload:
 * crossing a boundary, a Vital drug, a real batch, a large fall in stock-out
 * risk, and the cheaper movement first. The lines about it are built from that
 * object, including which rung of the approval ladder it needs.
 *
 * IT SPENDS MONEY: three Gemini calls in asia-south1 (voice, register,
 * assistant) and, only for lines that changed, Gemini text-to-speech.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintOperatorToken, operatorCookie, sessionSecretFor } from './lib/operator-session.mjs';
import { synthesize, durationOf, mux, srt } from './lib/narration.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FIXTURE = resolve(HERE, 'fixtures/hindi-stock-report.mp3');
const REGISTER = resolve(HERE, 'fixtures/register-page-sample.jpg');
const DECK = resolve(ROOT, 'docs/pitch-deck.html');
const OUT_DIR = resolve(ROOT, 'docs/demo');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'project-b3549f11-8db5-4ca2-9e4';

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
/*
 * ONE DISTRICT FOR THE WHOLE STORY: one of the four the capture page can speak
 * from, so the ANM's report and the dispatch order are about the same place.
 */
const DISTRICT = process.env.AAROGYA_DEMO_DISTRICT ?? 'DST-22-BASTAR';
/** Long enough for the 14.4 s Hindi fixture to finish. */
const RECORD_MS = 15_000;
/** Units deliberately lost in transit, so the variance beat is real. */
const SHORTFALL = 3;
/** Breath between one line ending and the next beginning. */
const GAP_MS = 350;

for (const f of [FIXTURE, REGISTER, DECK]) {
  if (!existsSync(f)) {
    console.error('Missing: ' + f);
    process.exit(1);
  }
}

const log = (m) => console.log('  ' + m);
let warnings = 0;
const warn = (m) => {
  warnings++;
  console.warn('  ! ' + m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (v) => Math.round(v).toLocaleString('en-IN');
/**
 * A figure the way a person says it aloud: "nearly seventeen thousand", not every
 * digit of 16,772. The subtitle keeps the exact number; reading five-digit and
 * lakh figures in full made the two most important lines the slowest and the
 * most robotic in the film.
 */
const aloud = (v) => {
  if (v >= 1_00_000) {
    const lakh = Math.floor(v / 1_00_000);
    const rest = v - lakh * 1_00_000;
    if (rest < 6_000) return lakh + ' lakh';
    if (Math.abs(rest - 50_000) < 6_000) return lakh + ' and a half lakh';
    return lakh + ' lakh ' + Math.round(rest / 1000) + ' thousand';
  }
  if (v >= 1000) {
    const k = Math.floor(v / 1000);
    const rest = v - k * 1000;
    if (rest < 150) return k + ' thousand';
    if (rest >= 700) return 'nearly ' + (k + 1) + ' thousand';
    return 'over ' + k + ' thousand';
  }
  return String(Math.round(v));
};

// --------------------------------------------------------------- the figures
const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'src/data/national-snapshot.json'), 'utf8'));
const t = snapshot.totals;
const fed = JSON.parse(readFileSync(resolve(ROOT, 'src/data/federated-summary.json'), 'utf8'));
const warning = JSON.parse(readFileSync(resolve(ROOT, 'src/data/warning-rule.json'), 'utf8'));
const plan = JSON.parse(readFileSync(resolve(ROOT, 'src/data/districts', DISTRICT + '.json'), 'utf8'));

// The protagonist: ranked, not taken in array order (see the header).
const rank = (o) => [
  o.crossDistrict ? 1 : 0,
  o.ved === 'V' ? 1 : 0,
  o.riskReduction >= 0.5 ? 1 : 0,
  -o.estimatedCostInr,
  o.receiverStockoutProbBefore,
  o.riskReduction,
];
const byRank = (a, b) => {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (rb[i] !== ra[i]) return rb[i] - ra[i];
  return 0;
};
const existing = await (await fetch(BASE + '/api/dispatch?districtCode=' + DISTRICT)).json();
const taken = new Set(existing.tickets.map((x) => x.orderId));
const rendered = (o) => plan.positions.some((p) => p.facilityId === o.to.id && p.drugId === o.drugId);
const order = [...plan.orders].filter((o) => o.quantity > SHORTFALL && !taken.has(o.id) && rendered(o)).sort(byRank)[0];
if (!order) {
  console.error('Every usable order in ' + DISTRICT + ' already has a ticket -- run `npm run overlay:purge -- --all` first.');
  process.exit(1);
}
const donorState = snapshot.districts.find((d) => d.districtCode === order.from.districtCode)?.stateName;
const interState = order.admissibility === 'requires_inter_state_agreement';
const countersign = order.admissibility === 'requires_district_countersign';

// Read from the deployment: the nightly batch may have ingested newer bulletins.
const observedFeed = await (await fetch(BASE + '/api/indicators?provenance=observed')).json().catch(() => null);
const observedSource = observedFeed?.sources?.find((x) => x.provenance === 'observed');
const bulletins = observedSource?.description.match(/read from (\d[\d,]*)/)?.[1];
const topSignal = [...(observedFeed?.signals ?? [])].sort((a, b) => b.observedValue - a.observedValue)[0];

// ---------------------------------------------------------------- the script
/*
 * Each scene: what the subtitle says, what the voice says (the same words,
 * written for the ear where digits or symbols would be read badly), and how it
 * should be said. Written to be spoken: short sentences, contractions, one idea
 * at a time -- and every figure the claims check guards is in a caption verbatim.
 */
const S = {};
const scene = (id, caption, direction, speech = caption) => {
  S[id] = {
    id,
    caption,
    direction,
    speech: speech
      .replace(/ × /g, ' by ')
      .replace(/₹([\d,]+)/g, (_, v) => v + ' rupees')
      .replace(/asia-south1/g, 'Asia South One'),
  };
};

scene(
  'intro',
  'Somewhere in India, in the middle of the monsoon, a health centre runs out of anti-snake venom. And here’s what hurts: the vials exist. They’re ninety minutes away, in a store that will throw them out.',
  'quiet and a little heavy, like telling a true story that still bothers you. Let a real ache come through on "here’s what hurts".',
);
scene(
  'intro2',
  'Nobody knew, because both shelves are still counted on paper. This is Aarogya Grid, and I’ll show you all of it, live.',
  'sincere and understated, turning from heavy to quietly determined. Say "Aarogya Grid" clearly, like the name of something you made, not a product launch.',
);
scene(
  'console',
  `This is the whole country. ${n(t.facilities)} facilities. ${n(t.districts)} districts, ${n(t.states)} states. Tonight ${n(t.criticalPositions)} stock positions are critical, and ${n(t.zeroStockPositions)} positions are already at zero.`,
  'brisk and clear through the numbers, like reading a dashboard to a colleague, then genuinely concerned on "Tonight". Do not linger.',
  `This is the whole country. ${aloud(t.facilities)} facilities. ${n(t.districts)} districts, ${n(t.states)} states. Tonight, ${aloud(t.criticalPositions)} stock positions are critical, and ${aloud(t.zeroStockPositions)} are already at zero.`,
);
scene(
  'map',
  'Every arc is medicine already in the system, moving from where it’ll expire to where it’s about to run out. And it tracks beds and staff, not just medicine.',
  'genuinely fascinated, talking to a friend beside you at the screen, not selling anything.',
);
scene(
  'signin',
  'Anyone can read this board. To change a number, you sign in with Google.',
  'plain-spoken and reassuring.',
);
scene(
  'signin2',
  'That’s Google’s sign-in for our app. For this film, each role is signed in by the operator, and labelled on screen.',
  'upfront and matter-of-fact, like being honest about how the film was made.',
);
scene(
  'voice1',
  'Here’s a stock report from a health centre in Bastar, spoken in Hindi. It’s a recorded sample.',
  'warm and affectionate, then soften, as if stepping aside to let her speak.',
);
scene(
  'voice2',
  'Gemini transcribes it and matches each medicine to the national catalogue. Nothing’s saved yet, and where it isn’t sure, it asks instead of guessing.',
  'impressed, then protective and firm on "it asks instead of guessing".',
);
scene(
  'commit',
  'She confirms. It’s re-scored, logged, and on every open screen.',
  'quick and satisfied, a little proud.',
);
scene(
  'register1',
  'Or she can just photograph her register. This is a sample page.',
  'light and friendly, a little playful.',
);
scene(
  'register2',
  'The rows are copied exactly as written, and the maths is checked separately. Amoxicillin is off by ten, so it’s flagged, not quietly fixed.',
  'a small knowing smile on "off by ten", then principled on the last clause.',
);
scene(
  'live',
  'Back on the national console, her report is already live.',
  'quiet pride, like saying "look" to a friend.',
);
scene(
  'ask1',
  'Nobody reads a table this size at eight in the morning. So you just ask.',
  'relatable and a little wry, a gentle smile in the voice.',
);
scene(
  'ask2',
  'Gemini decides which tools to run. Every row it read is right there in the audit trail, and it never makes up a number.',
  'sincere and matter-of-fact, like explaining why you trust it; lean on "never", without sounding like a slogan.',
);
scene(
  'forecast',
  `Demand for all ${n(snapshot.forecast.seriesForecast)} district × drug series is forecast by Google’s TimesFM in BigQuery. It holds ${n(snapshot.forecast.timesfmPositions)} of ${n(t.trackedPositions)} positions, where a backtest shows it wins.`,
  'explain it like you would to a smart friend: clear and lively, with natural rises and falls, keeping a brisk pace through the numbers.',
  `Demand for all ${aloud(snapshot.forecast.seriesForecast)} district-by-drug series is forecast by Google’s Times F M in BigQuery. It holds ${aloud(snapshot.forecast.timesfmPositions)} of the ${aloud(t.trackedPositions)} positions, wherever a backtest shows it wins.`,
);
scene(
  'warning',
  `And when an outbreak starts, a doubled surge is flagged a median ${warning.measured.medianLeadDays} days before the first shelf empties, at ${(warning.measured.precision * 100).toFixed(0)}% precision, and we publish that number.`,
  'alert and serious, with urgency on "when an outbreak starts", then candid and a little self-aware on the last clause.',
  `And when an outbreak starts, a doubled surge is flagged about ${warning.measured.medianLeadDays >= 4.25 && warning.measured.medianLeadDays < 4.75 ? 'four and a half' : Math.round(warning.measured.medianLeadDays)} days before the first shelf empties, at ${(warning.measured.precision * 100).toFixed(0)} percent precision, and we publish that number.`,
);
scene(
  'idsp',
  bulletins && topSignal
    ? `And this is real data, ${bulletins} Kerala disease bulletins. The detector flags ${topSignal.area.name}: ${n(topSignal.observedValue)} ${/^fever/i.test(topSignal.hazardLabel) ? 'fever consultations' : topSignal.hazardLabel.replace(/ above the expected range$/, '').toLowerCase() + ' cases'}, against an expected ${n(Math.round(topSignal.expectedUpperBound))}.`
    : 'And one source is real data: Kerala’s daily disease bulletins, through the same detector.',
  'earnest and grounded, quietly proud that this one is real.',
);
scene(
  'district',
  `Now the plan. ${order.to.name} is almost out of ${order.drugName}. There’s a batch ${Math.round(order.distanceKm)} km away${interState && donorState ? `, across the state line in ${donorState}` : order.crossDistrict ? ', in the next district' : ''}, and the trip costs ₹${n(order.estimatedCostInr)}.`,
  'energised and concrete, like someone who knows the route.',
  `Now the plan. ${order.to.name.replace(/^CHC /, 'The community health centre in ').replace(/-0?(\d+)$/, '')} is almost out of ${order.drugName.replace(/^Td Vaccine \(Tetanus \+ Diphtheria\)$/, 'tetanus-diphtheria vaccine')}. There’s a batch ${Math.round(order.distanceKm)} kilometres away${interState && donorState ? `, across the state line in ${donorState}` : order.crossDistrict ? ', in the next district' : ''}, and the trip costs ₹${n(order.estimatedCostInr)}.`,
);
scene(
  'agree',
  interState
    ? 'A state line needs an inter-state agreement. The state officer records it, and then tries to approve it too.'
    : countersign
      ? 'A district line needs the donor district to countersign. Its officer does, and then tries to approve it too.'
      : 'This order stays inside the district, so a district officer can approve it directly.',
  'calm and measured, then slow down a touch with playful suspense on "and then tries to approve it too".',
);
scene(
  'refused',
  'Refused. Whoever agrees can’t also sign off. The receiving officer approves instead.',
  'a small satisfied smile on "Refused", then matter-of-fact.',
);
scene(
  'ship',
  `${n(order.quantity)} ${order.unit}s go out, and the stock at the other end drops. Only ${n(order.quantity - SHORTFALL)} arrive, and the missing ${SHORTFALL} stay on the record.`,
  'brisk, then honest and a little sober on "Only".',
);
scene(
  'federated',
  `${fed.nodes.length} state nodes learn together without pooling raw data: only ${n(fed.shared.numbers)} numbers crossed a state line. A new state forecasts ${(fed.headline.improvementOverLocal * 100).toFixed(1)}% closer than it could on its own.`,
  'thoughtful and quietly impressed; finish the last sentence fully and clearly.',
  `${fed.nodes.length} state nodes learn together without pooling raw data: fewer than ${Math.ceil(fed.shared.numbers / 1000)} thousand numbers ever crossed a state line. A new state forecasts ${Math.round(fed.headline.improvementOverLocal * 100)} percent closer than it could on its own.`,
);
scene(
  'scale',
  'It’s built to run for real. Cloud Run scales out over Pub/Sub, BigQuery keeps every change through a restart, and every night a job rebuilds all 769 district plans. All in asia-south1.',
  'brisk and confident, builder energy.',
);
scene(
  'close',
  'Facility stock here is simulated, and labelled, because that missing data is the problem. Give us one state for eight weeks, and measure the stock-outs we prevent. This is Aarogya Grid.',
  'warm, earnest and a little emotional. Slow down for the last sentence and say the name clearly and warmly: Aarogya, then Grid, as in a power grid.',
);

// ---------------------------------------------------------------- the voice
mkdirSync(OUT_DIR, { recursive: true });
const CACHE = resolve(OUT_DIR, 'voice-cache');
console.log('\nSynthesizing ' + Object.keys(S).length + ' lines (cached lines are free)');
{
  const queue = Object.values(S);
  await Promise.all(
    Array.from({ length: 1 }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        s.file = await synthesize(s, { cacheDir: CACHE, project: PROJECT });
        s.ms = Math.round(durationOf(s.file) * 1000);
      }
    }),
  );
}
const spoken = Object.values(S).reduce((a, s) => a + s.ms, 0);
log('narration: ' + (spoken / 1000).toFixed(1) + ' s across ' + Object.keys(S).length + ' lines');
if (process.argv.includes('--voice-only')) {
  // Synthesize and report, touch nothing: the way to hear a changed line, and
  // to check the film fits the brief's five minutes, before a take writes to
  // the live board.
  for (const s of Object.values(S)) log(s.id.padEnd(10) + (s.ms / 1000).toFixed(1).padStart(6) + ' s  ' + s.file);
  // For scripts/check-narration.mts, which listens to each clip against its line.
  writeFileSync(
    resolve(CACHE, 'lines.json'),
    JSON.stringify({ lines: Object.values(S).map((s) => ({ id: s.id, file: s.file, speech: s.speech, ms: s.ms })) }, null, 2),
  );
  log('lines: ' + resolve(CACHE, 'lines.json'));
  process.exit(0);
}

// ------------------------------------------------------------ the browser
const SECRET = sessionSecretFor(BASE);
if (!SECRET) {
  console.error('No session secret for ' + BASE + ': set AAROGYA_SESSION_SECRET, or have gcloud read aarogya-session-secret.');
  process.exit(1);
}

for (const f of readdirSync(OUT_DIR)) {
  if (/^aarogya-(submission|grid-demo)-.*\.(webm|mp4|srt)$/.test(f)) rmSync(join(OUT_DIR, f));
}

console.log('\nRecording against ' + BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({
  permissions: ['microphone'],
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } },
  deviceScaleFactor: 1,
});

/** The page, once it exists; `actAs` can run before it does. */
let stage = null;

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
  // The header badge asks who is signed in when the tab regains focus; without
  // this nudge the 14 Sep take ran the whole dispatch scene under a badge that
  // still read "ANM".
  if (stage && stage.url().startsWith(BASE)) {
    const badge = stage.waitForResponse((r) => r.url().includes('/api/auth/session'), { timeout: 10_000 }).catch(() => null);
    await stage.evaluate(() => window.dispatchEvent(new Event('focus'))).catch(() => {});
    await badge;
  }
}

const audioB64 = readFileSync(FIXTURE).toString('base64');
// The microphone is the only thing substituted: getUserMedia returns a stream
// carrying the Hindi sample. MediaRecorder, Gemini, the resolver, the commit and
// the stream are all real.
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

// The subtitle bar: fixed at the bottom, near-opaque, never over the number a
// line is about.
await ctx.addInitScript(() => {
  const install = () => {
    if (document.getElementById('__cap') || !document.body) return;
    const bar = document.createElement('div');
    bar.id = '__cap';
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
      'background:rgba(4,8,13,.97)', 'color:#E8EEF2', 'pointer-events:none',
      'font:500 18px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
      'padding:13px 30px 15px', 'border-top:2px solid #2DD4BF', 'min-height:30px',
      'letter-spacing:.01em', 'transition:opacity .25s', 'opacity:0',
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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
});

const page = await ctx.newPage();
stage = page;
/** The recording's clock: video frames start with the page. */
const videoT0 = Date.now();
const at = () => Date.now() - videoT0;

let currentCaption = '';
const cues = []; // { id, text, start, end } on the raw recording
const clips = []; // { file, at, gain? }

async function caption(text) {
  currentCaption = text;
  await page.evaluate((x) => window.__cap?.(x), text).catch(() => {});
}

async function go(url, opts = {}) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000, ...opts });
  if (currentCaption) await caption(currentCaption);
}

/** Say one scene's line and resolve when it has finished (plus a breath). */
async function say(id) {
  const s = S[id];
  const start = at();
  cues.push({ id, text: s.caption, start, end: start + s.ms });
  clips.push({ file: s.file, at: start });
  await caption(s.caption);
  log(stampOf(start) + '  ' + s.caption.slice(0, 90));
  await sleep(s.ms + GAP_MS);
}

const stampOf = (ms) => {
  const sec = Math.round(ms / 1000);
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
};

async function scrollTo(locator, offset = 96) {
  if ((await locator.count()) === 0) return false;
  await locator.first().evaluate((el, off) => window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - off, behavior: 'smooth' }), offset);
  await sleep(700);
  return true;
}

/** Put one dispatch-order card whole on camera, actions included. */
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

let restoreTo = null;
let firstSceneAt = null;

try {
  // ---- the homepage ----------------------------------------------------------
  await go(BASE + '/');
  await sleep(900);
  firstSceneAt = at();
  await say('intro');
  const intro2 = say('intro2');
  await sleep(1800);
  await scrollTo(page.getByText('Try this in 60 seconds'), 180);
  await intro2;

  // ---- the country -----------------------------------------------------------
  await page.getByRole('link', { name: /Open the live console/ }).first().click();
  await page.waitForURL(/\/console/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await caption('');
  await sleep(500);
  await say('console');
  const map = say('map');
  await sleep(S.map.ms * 0.62);
  await scrollTo(page.locator('section.panel').filter({ hasText: /Beds and health workforce/i }));
  await map;

  // ---- sign-in -----------------------------------------------------------------
  await page.getByRole('link', { name: /Field capture/ }).first().click();
  await page.waitForURL(/\/capture/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await scrollTo(page.getByRole('link', { name: 'Sign in with Google' }), 260);
  const signin = say('signin');
  await sleep(S.signin.ms * 0.7);
  await page.getByRole('link', { name: 'Sign in with Google' }).first().click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await signin;
  await sleep(1200);
  const gsi = page.frameLocator('iframe[src*="accounts.google.com/gsi/button"]').locator('[role="button"]').first();
  try {
    await gsi.waitFor({ state: 'visible', timeout: 15_000 });
    await gsi.click();
    await page.waitForURL(/accounts\.google\.com/, { timeout: 20_000 });
    await page.waitForLoadState('domcontentloaded');
    await sleep(1800);
    await caption(S.signin2.caption);
  } catch (e) {
    warn('Google sign-in screen did not open: ' + (e?.message ?? e).split('\n')[0]);
  }
  await say('signin2');

  // ---- the ANM's voice report --------------------------------------------------
  await actAs('ANM (recording)');
  await go(BASE + '/capture');
  await sleep(800);
  await page.getByRole('button', { name: 'Speak' }).click();
  await sleep(500);
  await say('voice1');
  await page.getByRole('button', { name: /Start recording/ }).click();
  clips.push({ file: FIXTURE, at: at(), gain: 1.15 });
  cues.push({ id: 'hindi', text: '(a recorded sample report, spoken in Hindi)', start: at(), end: at() + 14_400 });
  await caption('(a recorded sample report, spoken in Hindi)');
  await sleep(RECORD_MS);
  const captured = page.waitForResponse((r) => r.url().endsWith('/api/capture') && r.request().method() === 'POST', {
    timeout: 120_000,
  });
  await page.getByRole('button', { name: /Stop and extract/ }).click();
  const voice2 = say('voice2');
  const captureRes = await captured.catch(() => null);
  if (!captureRes || captureRes.status() !== 200) warn('voice capture returned ' + (captureRes ? captureRes.status() : 'nothing'));
  await sleep(900);
  await scrollTo(page.locator('section.panel').filter({ hasText: /Extracted stock entries/i }), 90);
  await voice2;

  const commitBtn = page.getByRole('button', { name: /^Commit / });
  if ((await commitBtn.count()) > 0 && (await commitBtn.first().isEnabled())) {
    const committed = page.waitForResponse((r) => r.url().endsWith('/api/commit') && r.request().method() === 'POST', {
      timeout: 60_000,
    });
    const commitLine = say('commit');
    await sleep(700);
    await commitBtn.first().click();
    const res = await committed.catch(() => null);
    const body = res ? await res.json().catch(() => null) : null;
    if (body?.committed?.length) {
      restoreTo = body.committed.map((e) => ({ facilityId: e.facilityId, drugName: e.drugName, onHand: e.risk.previousOnHand }));
    } else {
      warn('the commit returned nothing');
    }
    await commitLine;
  } else {
    warn('no enabled commit button');
  }

  // ---- the photographed register -----------------------------------------------
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(600);
  await page.getByRole('button', { name: 'Register photo' }).click();
  const registered = page.waitForResponse((r) => r.url().endsWith('/api/capture') && r.request().method() === 'POST', {
    timeout: 120_000,
  });
  const reg1 = say('register1');
  await sleep(S.register1.ms * 0.55);
  await page.locator('input[type="file"]').first().setInputFiles(REGISTER);
  await reg1;
  const regRes = await registered.catch(() => null);
  if (!regRes || regRes.status() !== 200) warn('register capture returned ' + (regRes ? regRes.status() : 'nothing'));
  await sleep(800);
  const flag = page.getByText(/Register does not balance/).first();
  if (!(await scrollTo(flag, 330))) warn('the register arithmetic flag is not on the page');
  await say('register2');

  // ---- live on the console -----------------------------------------------------
  await go(BASE + '/console');
  await sleep(900);
  if (!(await scrollTo(page.locator('section.panel').filter({ hasText: /Live field reports/i })))) {
    warn('the live field-reports feed is not on the console');
  }
  await say('live');

  // ---- the assistant -------------------------------------------------------------
  await scrollTo(page.locator('section.panel').filter({ hasText: /Grid assistant/i }), 80);
  const asked = page.waitForResponse((r) => r.url().includes('/api/ask') && r.request().method() === 'POST', {
    timeout: 90_000,
  });
  const ask1 = say('ask1');
  await sleep(S.ask1.ms * 0.8);
  await page.getByRole('button', { name: 'Where is it worst tonight?' }).click();
  await ask1;
  const askRes = await asked.catch(() => null);
  if (!askRes || askRes.status() !== 200) warn('the assistant returned ' + (askRes ? askRes.status() : 'nothing'));
  await sleep(1500);
  // The answer and its audit trail side by side, the question still in view.
  // Scrolling to the text "Audit trail" matched the standfirst sentence as well
  // and carried the first narrated take past the trail it was talking about.
  await scrollTo(page.getByRole('button', { name: 'Ask the grid' }), 230);
  await say('ask2');

  // ---- forecasting and early warning ---------------------------------------------
  await scrollTo(page.locator('section.panel').filter({ hasText: /Priority stock alerts/i }));
  await say('forecast');
  await say('warning');
  if (!(await scrollTo(page.locator('section[aria-labelledby="observed-surveillance"]')))) {
    warn('the observed surveillance panel is not on the console');
  }
  await say('idsp');

  // ---- the dispatch loop ---------------------------------------------------------
  await go(BASE + '/district/' + DISTRICT);
  await sleep(1200);
  const card = await frameCard(plan.orders.indexOf(order) + 1);
  await sleep(600);
  await say('district');

  const click = async (name) => {
    const button = card.getByRole('button', { name });
    await button.waitFor({ state: 'visible', timeout: 10_000 });
    await button.click();
  };
  const counter = card.getByRole('button', { name: /Countersign|Record agreement/ });
  if ((await counter.count()) > 0) {
    const agree = say('agree');
    await actAs(interState ? 'donor state officer (recording)' : 'donor district officer (recording)');
    await sleep(S.agree.ms * 0.35);
    await counter.first().click();
    await sleep(S.agree.ms * 0.4);
    await click('Approve');
    await agree;
    const refused = say('refused');
    await sleep(S.refused.ms * 0.55);
    await actAs('receiving district officer (recording)');
    await click('Approve');
    await refused;
  } else {
    await say('agree');
    await actAs('district officer (recording)');
    await click('Approve');
  }

  const ship = say('ship');
  await actAs('donor storekeeper (recording)');
  await click('Dispatch');
  await sleep(S.ship.ms * 0.4);
  const received = card.getByLabel('Units received');
  await received.waitFor({ state: 'visible', timeout: 10_000 });
  await received.fill(String(order.quantity - SHORTFALL));
  await actAs('receiving pharmacist (recording)');
  await click('Confirm receipt');
  await ship;

  // ---- federated -------------------------------------------------------------------
  await go(BASE + '/console');
  await sleep(900);
  await scrollTo(page.locator('section').filter({ hasText: 'what crossed the state line' }));
  await say('federated');

  // ---- the deployment --------------------------------------------------------------
  await go('file:///' + DECK.replace(/\\/g, '/'), { waitUntil: 'load' });
  await sleep(600);
  await scrollTo(page.locator('section.slide').filter({ has: page.locator('.arch-h') }), 0);
  await say('scale');

  // ---- the ask ---------------------------------------------------------------------
  await go(BASE + '/');
  await sleep(700);
  await say('close');
  await caption('');
  await sleep(1400);
} catch (e) {
  warn('the take was cut short: ' + (e?.message ?? String(e)).split('\n')[0]);
} finally {
  if (restoreTo) {
    for (const r of restoreTo) {
      await fetch(BASE + '/api/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: operatorCookie(SECRET, 'recording restore', 600), Origin: BASE },
        body: JSON.stringify({ facilityId: r.facilityId, source: 'typed', entries: [{ drugName: r.drugName, onHand: r.onHand }] }),
      }).catch(() => {});
    }
    log('committed positions restored');
  }
}

const endMs = at();
const video = page.video();
await ctx.close();
await browser.close();

// ------------------------------------------------------------------ the mix
const stampName = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
const raw = video ? await video.path() : null;
if (!raw || cues.length === 0) {
  console.error('no recording to mix');
  process.exit(1);
}
const trimMs = Math.max(0, (firstSceneAt ?? 0) - 700);
const mp4 = resolve(OUT_DIR, 'aarogya-grid-demo-' + stampName + '.mp4');
console.log('\nMixing the narration under the picture');
mux({ video: raw, clips, trimMs, endMs, out: mp4 });
rmSync(raw, { force: true });
const runtime = Math.round((endMs - trimMs) / 1000);
const shifted = cues.map((c) => ({ ...c, start: c.start - trimMs, end: c.end - trimMs }));
writeFileSync(mp4.replace(/\.mp4$/, '.srt'), srt(shifted));
console.log('  wrote ' + mp4 + '  (' + Math.floor(runtime / 60) + 'm ' + (runtime % 60) + 's)');

/*
 * The script, with the times this take actually has. Written from the cues
 * the recording produced, so it describes the film rather than the intention.
 */
const doc =
  '# Demo video — the narration, with real timings\n\n' +
  '*Generated by `npm run record:submission`. Each line starts at the time shown in the film in\n' +
  '`docs/demo/`; the times are written as the take happens, not planned in advance.*\n\n' +
  'The video is **narrated**: every line below is spoken, in a Gemini text-to-speech voice directed scene\n' +
  'by scene, and shown as a subtitle.\n\n' +
  'The runtime of the take this file describes is **' + Math.floor(runtime / 60) + ' min ' + (runtime % 60) + ' s**.\n\n' +
  'Nothing in the picture is staged or cut. The Hindi report is a recorded sample played into a real\n' +
  'microphone stream, and it is audible in the film; the register page is a drawn sample with one row\n' +
  'that does not add up. Google sign-in is shown up to Google’s own screen — Google does not complete a\n' +
  'sign-in inside an automated browser — and each role after it is an operator session, labelled\n' +
  '“operator · role” on screen and on the audit trail. The Gemini calls, the commit, the ticket and the\n' +
  'receipt all happen against the running deployment while the camera is on.\n\n' +
  '| Time | Line |\n|---:|---|\n' +
  shifted.map((c) => '| ' + stampOf(c.start) + ' | ' + c.text.replace(/\|/g, '\\|') + ' |').join('\n') +
  '\n';
writeFileSync(resolve(ROOT, 'docs/demo-script.md'), doc);
console.log('  wrote docs/demo-script.md  (' + shifted.length + ' lines)');

console.log(
  warnings === 0
    ? '\nPASS  a narrated take of the whole product'
    : '\nDONE  with ' + warnings + ' warning(s) -- watch the take before relying on it',
);
