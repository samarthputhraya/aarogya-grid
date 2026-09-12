/**
 * THE CROSS-BROWSER PASS.
 *
 * Run with:  node scripts/rehearse-browsers.mjs [baseUrl]
 *
 * Every other rehearsal in this repository drives Chromium, because that is what
 * Playwright installs first and what the demo will be recorded in. A judge opens
 * whatever is on their machine. This one loads the four routes a reviewer
 * actually reaches in **Chromium, Firefox and WebKit**, and on an iPhone-sized
 * viewport, and fails on any console error, any failed request, and any page
 * that renders without the element that proves it rendered.
 *
 * WHY IT CHECKS THE CONSOLE AND NOT JUST THE STATUS CODE
 * ------------------------------------------------------
 * A 200 proves the server is alive. It does not prove the map drew, the
 * assistant mounted, or that Safari did not throw on a regular expression
 * Chromium was happy with -- and a blank panel with a clean network tab is
 * exactly the failure that survives every check somebody thought to write.
 * So the run listens for `pageerror` and for responses of 400 and above, and
 * reports the first of each verbatim.
 *
 * WebKit here is not Safari. It is the same engine, which catches the class of
 * problem that matters (unsupported syntax, layout that only Blink forgives)
 * and not the ones specific to Apple's shell. Stated so nobody reads more into
 * a green run than it earns.
 */
import { chromium, firefox, webkit, devices } from 'playwright';

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');

/** The four routes a reviewer's ten minutes pass through, and what proves each drew. */
const ROUTES = [
  ['/', 'h1', 'the landing page headline'],
  ['/console', 'svg', 'the national map'],
  ['/district/DST-10-PURNIA', 'table', 'the stock position table'],
  ['/capture', 'button', 'the capture controls'],
];

const ENGINES = [
  ['chromium', chromium, {}],
  ['firefox', firefox, {}],
  ['webkit', webkit, {}],
  ['iphone-webkit', webkit, devices['iPhone 13']],
];

let failures = 0;
const check = (ok, what, detail) => {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '   ' + what + (ok || !detail ? '' : '\n         ' + detail));
};

console.log('\nCross-browser pass against ' + BASE);

for (const [label, engine, deviceOpts] of ENGINES) {
  console.log('\n' + label);
  let browser;
  try {
    browser = await engine.launch();
  } catch (e) {
    check(false, label + ' launches', e instanceof Error ? e.message.split('\n')[0] : String(e));
    continue;
  }
  const ctx = await browser.newContext(deviceOpts);
  const page = await ctx.newPage();

  const errors = [];
  const badResponses = [];
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
  page.on('response', (r) => {
    // Favicon and the odd prefetch are noise; anything the page needs is not.
    if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) {
      badResponses.push(r.status() + ' ' + r.url().replace(BASE, ''));
    }
  });

  for (const [route, proof, what] of ROUTES) {
    errors.length = 0;
    badResponses.length = 0;
    try {
      const res = await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const status = res?.status() ?? 0;
      await page.waitForSelector(proof, { timeout: 30_000 });
      // Let hydration and the mount-time overlay fetch settle, so a client-side
      // throw has happened by the time the errors are read.
      await page.waitForTimeout(2500);
      check(status === 200, `${route} → ${status}`);
      check(true, `${route} drew ${what}`);
      check(errors.length === 0, `${route} raised no page error`, errors[0]);
      check(badResponses.length === 0, `${route} made no failing request`, badResponses[0]);
    } catch (e) {
      check(false, `${route} loaded and drew ${what}`, e instanceof Error ? e.message.split('\n')[0] : String(e));
    }
  }

  await browser.close();
}

console.log('');
console.log(
  failures === 0
    ? 'PASS  every route drew in every engine, with a clean console'
    : `FAIL  ${failures} checks`,
);
process.exit(failures === 0 ? 0 : 1);
