/**
 * The screenshots the README, the deck and the submission page show.
 *
 * Run with:  node scripts/capture-screens.mjs [baseUrl]
 * Output:    public/screens/*.png  (served, so the README can link them raw
 *            from GitHub and the deck can <img> them without a build step)
 *
 * WHY A SCRIPT RATHER THAN A SCREENSHOT SOMEBODY TOOK
 * ---------------------------------------------------
 * A screenshot is a claim about what the product looks like, and it is the one
 * claim in a submission that nothing checks. The deck's dispatch-order slide
 * quoted an order that no longer existed in the shipped plan and nobody noticed
 * for weeks; a hand-taken screenshot of a console whose numbers have since moved
 * is the same failure with no `check-claims` to catch it. Regenerating them from
 * the running build is the only way a picture stays as true as the payload.
 *
 * It also fixes the viewport, the device scale and the theme, so a re-run
 * produces a comparable image rather than one that happens to be whatever size
 * the window was.
 *
 * WHAT IS CAPTURED AND WHY THOSE
 * ------------------------------
 * The three screens a reviewer's ten minutes actually pass through -- the
 * landing page's first screen, the national console above the fold, and one
 * district's dispatch orders -- plus the assistant mid-answer, because the
 * tool-call trace beside the answer is the thing that distinguishes this from a
 * chatbot bolted to a dashboard and it is invisible in any static shot of the
 * console.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'public/screens');
const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const DISTRICT = process.env.AAROGYA_SHOT_DISTRICT ?? 'DST-10-PURNIA';

mkdirSync(OUT, { recursive: true });

const log = (m) => console.log('  ' + m);
let failures = 0;

console.log('\nCapturing screens against ' + BASE);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  // 2 so the image is legible when GitHub scales it into a README column.
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
const page = await ctx.newPage();

/** Wait for the network to go quiet AND for one element that proves the page rendered. */
async function ready(url, proof) {
  await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForSelector(proof, { timeout: 30_000 });
  // The landing page animates in on scroll; give the reveal a beat so the
  // screenshot is not of a half-faded hero.
  await page.waitForTimeout(900);
}

async function shot(name, url, proof, opts = {}) {
  try {
    await ready(url, proof);
    if (opts.before) await opts.before();
    const file = resolve(OUT, name + '.png');
    await page.screenshot({ path: file, fullPage: Boolean(opts.fullPage) });
    log(name + '.png  <- ' + url);
  } catch (e) {
    failures++;
    console.error('  ! ' + name + ' failed: ' + (e instanceof Error ? e.message : e));
  }
}

await shot('landing', '/', 'h1');
await shot('console', '/console', 'header h1');
await shot('district', '/district/' + DISTRICT, 'h1');

/*
 * The assistant, mid-evidence.
 *
 * Asked a real question against the real model, so the trace in the picture is
 * a trace of tools that actually ran. If no API key is configured the shot is
 * skipped rather than faked -- a screenshot of an assistant that did not answer
 * would be the exact dishonesty this script exists to prevent.
 */
try {
  await ready('/console', 'header h1');
  const box = page.locator('textarea').first();
  await box.waitFor({ timeout: 15_000 });
  await box.fill('Which facilities are about to run out of a vital medicine, and what should I move?');
  // Clicking the button, not pressing Enter: Enter in a textarea is a newline,
  // and the first version of this script screenshotted the form it had just
  // filled in and called it an answer.
  /*
   * Wait for the RESPONSE, not for a rendered string.
   *
   * Two earlier versions waited on text: "grounded in:", which renders only
   * when the model cited something by name, and the audit trail's "n/n calls",
   * which is assembled from nested spans and did not match. Both produced a
   * screenshot of the form rather than of an answer. The POST completing is the
   * fact the picture depends on, and it is the one thing here that cannot be
   * true for the wrong reason.
   */
  const answered = page.waitForResponse(
    (r) => r.url().includes('/api/ask') && r.request().method() === 'POST',
    { timeout: 90_000 },
  );
  await page.getByRole('button', { name: /Ask the grid/i }).click();
  const res = await answered;
  if (!res.ok()) throw new Error('/api/ask answered ' + res.status());
  // React renders the answer, the Markdown and the trace after the promise
  // resolves; this is the paint, not the request.
  await page.waitForTimeout(2500);
  const assistant = page.locator('section').filter({ hasText: 'GRID ASSISTANT' }).first();
  const target = (await assistant.count()) > 0 ? assistant : page;
  await target.screenshot({ path: resolve(OUT, 'assistant.png') });
  log('assistant.png <- /console (live answer with its tool trace)');
} catch (e) {
  console.warn('  ! assistant shot skipped: ' + (e instanceof Error ? e.message.split('\n')[0] : e));
}

await browser.close();

console.log('');
if (!existsSync(resolve(OUT, 'console.png'))) {
  console.error('  the console screenshot is the one the README cannot do without');
  failures++;
}
console.log(failures === 0 ? '  screens written to public/screens/' : `  ${failures} screens FAILED`);
process.exit(failures === 0 ? 0 : 1);
