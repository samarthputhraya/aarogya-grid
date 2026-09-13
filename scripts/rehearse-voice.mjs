/**
 * THE HINDI VOICE REHEARSAL.
 *
 * Run:  npm run rehearse:voice            (against the live deployment)
 *       npm run rehearse:voice -- http://localhost:3000/capture
 *
 * WHAT THIS EXERCISES
 * -------------------
 * The whole last-mile path, on the REAL page, in a REAL browser:
 *
 *   getUserMedia -> MediaRecorder -> onstop -> toBase64 -> fetch
 *     -> src/proxy.ts (rate limit + 6 MB Content-Length ceiling)
 *     -> /api/capture -> Gemini (audio in, structured JSON out)
 *     -> Zod -> resolveDrug -> the rendered draft on screen
 *
 * Nine systems. The plan calls this the demo's highest-stakes thirty seconds,
 * and it is the one path where a unit test proves almost nothing.
 *
 * THE ONLY THING SUBSTITUTED IS THE MICROPHONE HARDWARE.
 * `navigator.mediaDevices.getUserMedia` is overridden to return a MediaStream
 * carrying `fixtures/hindi-stock-report.mp3` played through Web Audio. Every
 * line of the application's own code runs untouched.
 *
 * WHY THE FIXTURE IS COMMITTED
 * ----------------------------
 * 113 KB of Hindi speech, synthesised once with Google Cloud Text-to-Speech
 * (hi-IN-Wavenet-A, 14.3 s). Committing it means this rehearsal is reproducible
 * by anyone who clones the repo, with no TTS credentials and no microphone --
 * including a judge who wants to check the claim rather than believe it.
 *
 * THE BUG THIS GUARDS
 * -------------------
 * `[M]` Until 12 Sep the audio path did
 * `btoa(String.fromCharCode(...new Uint8Array(buf)))`, which throws RangeError
 * past ~100 KB -- about NINE SECONDS of Opus -- inside `MediaRecorder.onstop`,
 * where nothing awaits it. No request, no error, no spinner. The printed Hindi
 * sample takes twelve seconds to read, so the flagship demo failed silently for
 * anyone who spoke a full sentence and passed every test that spoke one word.
 * `scripts/test-base64.mts` covers the encoder offline. THIS covers the path.
 *
 * The assertion below is therefore not just "it worked": the request body must
 * exceed OLD_CEILING_BYTES, or the run proves nothing about the bug it exists
 * to catch.
 *
 * WHAT IT DOES NOT TEST
 * ---------------------
 * A real microphone, a real room, a real voice, or a phone browser. Rehearse on
 * the demo machine before recording the video -- this is insurance, not a
 * substitute.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintOperatorToken, sessionSecretFor } from './lib/operator-session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, 'fixtures/hindi-stock-report.mp3');
const URL =
  process.argv[2] ?? 'https://aarogya-grid-215071922486.asia-south1.run.app/capture';

/** Recording window. Comfortably longer than the 14.3 s fixture. */
const RECORD_MS = 16_000;

/**
 * The base64 payload size past which the old encoder threw.
 *
 * ~125 KB of binary was the observed RangeError threshold; base64 inflates by
 * 4/3, so a body over ~170 KB could not have been produced by the old code at
 * all. 200 KB is that with margin.
 */
const OLD_CEILING_BYTES = 200_000;

/** What the fixture says, and what the resolver must make of it. */
const EXPECTED = [
  { drug: 'Paracetamol', quantity: 50 },
  { drug: 'Oral Rehydration Salts (WHO formula)', quantity: 100 },
  // "लाल गोली" -- red pill. A vernacular name, not a catalogue one.
  { drug: 'Iron + Folic Acid', quantity: 200 },
  // "बिल्कुल खत्म" -- completely finished. An implicit zero, not a missing row.
  { drug: 'Anti-Snake Venom (polyvalent)', quantity: 0 },
];

if (!existsSync(FIXTURE)) {
  console.error('Missing fixture: ' + FIXTURE);
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const audioB64 = readFileSync(FIXTURE).toString('base64');

const browser = await chromium.launch();
const ctx = await browser.newContext({ permissions: ['microphone'] });

// Reading a report with Gemini needs a signed-in actor: an operator session.
const SECRET = sessionSecretFor(URL);
if (!SECRET) {
  console.error('No session secret for ' + URL + ': set AAROGYA_SESSION_SECRET, or have gcloud read aarogya-session-secret.');
  process.exit(1);
}
await ctx.addCookies([
  { name: 'ag_session', value: mintOperatorToken(SECRET, 'rehearsal voice', 1800), url: new globalThis.URL(URL).origin, httpOnly: true, sameSite: 'Lax', secure: URL.startsWith('https') },
]);

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
    window.__micSeconds = buf.duration;
    return dest.stream;
  };
}, audioB64);

const page = await ctx.newPage();
let body = null;
let bytes = 0;
let status = null;
let ms = 0;
let t0 = 0;
const errors = [];

page.on('request', (r) => {
  if (r.url().endsWith('/api/capture') && r.method() === 'POST') {
    bytes = (r.postData() ?? '').length;
    t0 = Date.now();
  }
});
page.on('response', async (r) => {
  if (r.url().endsWith('/api/capture') && r.request().method() === 'POST') {
    status = r.status();
    ms = Date.now() - t0;
    body = await r.json().catch(() => null);
  }
});
page.on('pageerror', (e) => errors.push(e.message));

console.log('\nHindi voice rehearsal\n  ' + URL);
await page.goto(URL, { waitUntil: 'networkidle' });
const facility = await page.locator('select').first().inputValue();

await page.getByRole('button', { name: 'Speak' }).click();
await page.getByRole('button', { name: /Start recording/ }).click();
console.log('  recording ' + RECORD_MS / 1000 + 's as ' + facility + ' …');
await page.waitForTimeout(RECORD_MS);

const micSeconds = await page.evaluate(() => window.__micSeconds ?? 0);
const settled = page.waitForResponse(
  (r) => r.url().endsWith('/api/capture') && r.request().method() === 'POST',
  { timeout: 120_000 },
);
await page.getByRole('button', { name: /Stop and extract/ }).click();
await settled.catch(() => {});
await page.waitForTimeout(2500);

const entries = body?.draft?.entries ?? [];

console.log('');
check('the microphone played a recording longer than the old ~9 s ceiling', micSeconds > 9, micSeconds.toFixed(1) + 's');
check('a request was made at all', bytes > 0, bytes + ' bytes');
check(
  'the body exceeds what the old encoder could produce',
  bytes > OLD_CEILING_BYTES,
  bytes.toLocaleString('en-IN') + ' > ' + OLD_CEILING_BYTES.toLocaleString('en-IN'),
);
check('the proxy accepted it', status === 200, 'HTTP ' + status + ' in ' + (ms / 1000).toFixed(1) + 's');
check('no uncaught page error', errors.length === 0, errors.join(' | '));
check('Gemini detected Hindi', body?.draft?.language === 'Hindi', String(body?.draft?.language));
check('a transcript came back', Boolean(body?.draft?.transcript), (body?.draft?.transcript ?? '').slice(0, 60) + '…');

for (const want of EXPECTED) {
  const hit = entries.find((e) => e.drug?.name === want.drug);
  check(
    'resolved ' + want.drug + ' = ' + want.quantity,
    Boolean(hit) && hit.quantity === want.quantity,
    hit ? 'got ' + hit.quantity + ' [' + hit.status + ']' : 'not in the draft',
  );
}

// The monsoon remark is context, not stock. It must not become a quantity.
check(
  'the monsoon remark is filed as a note, not a stock figure',
  Boolean(body?.draft?.notes) && !entries.some((e) => /monsoon/i.test(e.spokenText ?? '')),
  body?.draft?.notes ?? '(no note)',
);

// The screen, not the payload. This project has shipped a correct array behind a
// wrong screen before.
const onScreen = await page.locator('text=EXTRACTED STOCK ENTRIES').count();
check('the draft is actually rendered on the page', onScreen > 0);

console.log(
  '\n' +
    (failures === 0
      ? `voice rehearsal: all checks passed  (${entries.length} entries, ${(ms / 1000).toFixed(1)}s round trip, ${body?.model})`
      : `voice rehearsal: ${failures} FAILED`),
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
