/**
 * Renders the pitch deck to PDF.
 * Run with:  npx tsx scripts/export-deck.mts
 * In:        docs/pitch-deck.html
 * Out:       docs/pitch-deck.pdf   (12 slides, one per page, 16:9 landscape)
 *
 * The submission requires a 10-12 slide deck, and "a deck" in every reviewing
 * context means a PDF -- an HTML file is something a judge has to be persuaded
 * to open. This keeps the HTML as the single source of truth and treats the PDF
 * as a build artefact, so the two can never disagree: re-run this after any
 * edit rather than maintaining a second copy in a slide editor.
 *
 * WHY PLAYWRIGHT AND NOT A PDF LIBRARY
 * ------------------------------------
 * The deck is CSS Grid, `aspect-ratio`, custom properties and web fonts. A PDF
 * library would re-implement the layout and get it subtly wrong; Chromium
 * already renders this exact file correctly, and `page.pdf()` prints what it
 * renders. Playwright is already a devDependency for screenshotting the app.
 *
 * PAGE GEOMETRY
 * -------------
 * 13.333in x 7.5in is 1280x720 at 96dpi -- the same 16:9 the slides declare, so
 * each slide fills its page exactly with no letterboxing and no scaling blur.
 * The screen layout (a scrolling column of cards with gaps, rounded corners and
 * a page background) is print-irrelevant, so it is neutralised below rather
 * than fought with margins.
 */
import { chromium } from 'playwright';
import { resolve, extname, join, normalize } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const DOCS = resolve(process.cwd(), 'docs');
const IN = resolve(DOCS, 'pitch-deck.html');
const OUT = resolve(DOCS, 'pitch-deck.pdf');

if (!existsSync(IN)) {
  console.error('Deck source not found:', IN);
  process.exit(1);
}

/**
 * Print overrides.
 *
 * `aspect-ratio` is left alone -- the page box is already 16:9, so forcing an
 * explicit height as well would risk a rounding difference producing a stray
 * blank page after every slide. Setting only the width and letting the declared
 * ratio do the rest is what keeps it at exactly 12 pages.
 */
const PRINT_CSS = `
  @page { size: 13.333in 7.5in; margin: 0; }
  html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; }
  .deck { max-width: none !important; margin: 0 !important; padding: 0 !important; gap: 0 !important; }
  .slide {
    width: 100% !important;
    border: none !important;
    border-radius: 0 !important;
    break-inside: avoid;
    break-after: page;
  }
  .slide:last-child { break-after: auto; }
`;

/**
 * Serve `docs/` over loopback rather than opening the file directly.
 *
 * A `file://` page cannot load the Google Fonts stylesheet -- Chromium's Opaque
 * Response Blocking rejects it (`ERR_BLOCKED_BY_ORB`) because a file origin is
 * opaque. The export still "succeeds", silently, in fallback fonts: every
 * heading reflows, and the PDF handed to a judge is set in different type from
 * the HTML it was built from. An http:// origin has a real origin, so the
 * stylesheet loads and the printed artefact matches the source.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  // Contain the path to `docs/`. This server is loopback-only and lives for a
  // few seconds, but a static handler that will serve `../../` on request is
  // not a thing to write down even once.
  const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(DOCS, rel === '/' || rel === '\\' ? 'pitch-deck.html' : rel);
  if (!file.startsWith(DOCS) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;

/**
 * Fetch the deck's web fonts in Node and inline them as data URIs.
 *
 * The deck links Google Fonts from a CDN, which is correct for an HTML file a
 * human opens in a browser. Chromium under Playwright will not load it here --
 * the request is refused with ERR_BLOCKED_BY_ORB -- and the export then
 * "succeeds" in the fallback stack, producing a plausible 12-page PDF set in
 * entirely the wrong type. Node's fetch reaches the same URL without trouble,
 * so the stylesheet is retrieved here, every `url(...)` inside it is fetched
 * and base64'd, and the result is injected into the page.
 *
 * The upshot is that the PDF no longer depends on what the browser is allowed
 * to reach: same bytes in, same typography out, on any machine.
 *
 * The User-Agent matters. Google Fonts content-negotiates on it and serves
 * TTF to a UA it does not recognise; asking as a current Chrome is what gets
 * woff2 back, which is a quarter of the size.
 */
/**
 * Read the font URL out of the deck rather than restating it here.
 *
 * A hand-copied Google Fonts URL is a trap: the axis syntax
 * (`ital,opsz,wght@0,6..72,300;0,400;...`) is easy to transcribe wrongly, and
 * the API answers a malformed one with a 400 and an HTML error body rather
 * than a redirect -- so the exporter silently falls back and prints a PDF in
 * the wrong type. Taking the href from the source means the exporter cannot
 * drift from the deck, and editing the deck's fonts needs no change here.
 */
function deckFontUrl(): string | null {
  const html = readFileSync(IN, 'utf8');
  const m = html.match(/href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"/);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

async function inlinedFontCss(): Promise<string | null> {
  const url = deckFontUrl();
  if (!url) {
    console.error('  no Google Fonts <link> found in the deck -- skipping font inlining');
    return null;
  }
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      console.error('  font stylesheet fetch failed:', res.status, url.slice(0, 90));
      return null;
    }
    let css = await res.text();

    const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1]))];
    const encoded = await Promise.all(
      urls.map(async (u) => {
        const f = await fetch(u, { headers: { 'User-Agent': UA } });
        if (!f.ok) throw new Error(u + ' -> ' + f.status);
        const buf = Buffer.from(await f.arrayBuffer());
        const mime = u.endsWith('.woff2') ? 'font/woff2' : u.endsWith('.woff') ? 'font/woff' : 'font/ttf';
        return [u, `data:${mime};base64,${buf.toString('base64')}`] as const;
      }),
    );
    for (const [u, data] of encoded) css = css.split(u).join(data);
    return css;
  } catch (e) {
    console.error('  font inlining failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

const fontCss = await inlinedFontCss();

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => {
    // Fonts are the only external request the deck makes; a failed one changes
    // the metrics silently, which is exactly the kind of defect that only shows
    // up in the printed artefact.
    failures.push('requestfailed: ' + r.url().slice(0, 120) + ' -- ' + (r.failure()?.errorText ?? '?'));
  });

  await page.goto(origin + '/pitch-deck.html', { waitUntil: 'domcontentloaded' });
  if (fontCss) await page.addStyleTag({ content: fontCss });
  await page.addStyleTag({ content: PRINT_CSS });
  await page.emulateMedia({ media: 'print' });
  // Web fonts resolve after load; printing before they settle silently
  // reflows every heading in the PDF and nowhere else.
  await page.evaluate(() => document.fonts.ready);

  const slides = await page.locator('.slide').count();

  /**
   * Which faces genuinely resolved to a real @font-face.
   *
   * NOT `document.fonts.check()`: that answers "can this be rendered", and a
   * family with no matching @font-face rule answers YES, because the system
   * will happily substitute. It returns true in precisely the case this needs
   * to catch.
   *
   * Nor is it enough to enumerate `document.fonts` and read `.status` -- an
   * @font-face rule sits at `unloaded` until something on the page actually
   * needs that weight, so a correctly-injected face reads as missing.
   *
   * `document.fonts.load()` asks the question that was meant: it resolves with
   * the FontFace objects that MATCHED the request and finished loading. An
   * empty array means nothing matched and the text is being set in fallback.
   */
  const fontProbe = await page.evaluate(async () => {
    const want = ['Public Sans', 'Newsreader', 'IBM Plex Mono'];
    const out: Record<string, number> = {};
    for (const family of want) {
      const matched = await document.fonts.load(`400 16px "${family}"`);
      out[family] = matched.length;
    }
    return out;
  });
  const fonts = {
    sans: (fontProbe['Public Sans'] ?? 0) > 0,
    serif: (fontProbe['Newsreader'] ?? 0) > 0,
    mono: (fontProbe['IBM Plex Mono'] ?? 0) > 0,
  };

  await page.pdf({
    path: OUT,
    printBackground: true,
    width: '13.333in',
    height: '7.5in',
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
    preferCSSPageSize: true,
  });

  const bytes = statSync(OUT).size;
  console.log('Aarogya Grid -- deck export');
  console.log('  in     :', IN);
  console.log('  out    :', OUT);
  console.log('  slides :', slides);
  console.log('  size   :', (bytes / 1024).toFixed(0) + ' KB');
  console.log('  fonts  :', Object.entries(fonts).map(([k, v]) => k + (v ? ' ok' : ' MISSING')).join(' · '));

  if (failures.length > 0) {
    console.log('\n  render warnings:');
    for (const f of failures.slice(0, 10)) console.log('   -', f);
  }

  // The submission asks for 10-12 slides. A deck that silently exported 3
  // because a selector changed, or 12 in the wrong typeface because a
  // stylesheet 404'd, is worse than one that failed loudly.
  const checks: [string, boolean][] = [
    ['slide count is within the 10-12 the brief asks for', slides >= 10 && slides <= 12],
    ['the PDF is not trivially small', bytes > 20_000],
    ['Public Sans loaded', fonts.sans],
    ['Newsreader loaded', fonts.serif],
    ['IBM Plex Mono loaded', fonts.mono],
  ];

  console.log('\n--- checks ---');
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
    if (!ok) failed++;
  }
  console.log(failed === 0 ? '\nDeck exported.' : '\n' + failed + ' check(s) FAILED.');
  process.exit(failed === 0 ? 0 : 1);
} finally {
  await browser.close();
  server.close();
}
