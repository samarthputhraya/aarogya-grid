/**
 * The sample stock-register page the demo video photographs.
 *
 * Run:     node scripts/make-register-fixture.mjs
 * Output:  scripts/fixtures/register-page-sample.jpg
 *
 * A SAMPLE, AND SAID TO BE ONE. The capture page reads a photographed register
 * with Gemini, and a video that shows that path needs a page to photograph. No
 * real facility's register is in this repository, so this draws one: ruled
 * ledger paper, the columns an Indian stock register actually has, figures in a
 * handwriting face and blue ink, photographed slightly off-square. The narration
 * calls it a sample page, exactly as the Hindi voice fixture is a recorded
 * sample rather than a person.
 *
 * ONE ROW IS WRONG ON PURPOSE. Amoxicillin: 120 opening + 0 received - 45 issued
 * is 75, and the closing column says 85. The register path transcribes numbers as
 * written and a separate check does the arithmetic, so the draft must flag that
 * row as not balancing by +10 rather than quietly "fixing" it. That flag is what
 * the video shows.
 *
 * Deterministic: the per-cell jitter comes from a fixed seed, so a re-run draws
 * the same page.
 */
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'fixtures/register-page-sample.jpg');

const ROWS = [
  ['1', 'Paracetamol 500 mg tab', 'B011-HC004', '03/2028', '480', '200', '310', '370'],
  ['2', 'Amoxicillin 500 mg cap', 'B010-HC002', '11/2027', '120', '0', '45', '85'],
  ['3', 'ORS sachet', 'B012-HC001', '06/2028', '90', '100', '150', '40'],
  ['4', 'Zinc Sulphate (disp.) tab', 'B009-HC003', '01/2028', '57', '0', '0', '57'],
  ['5', 'Metronidazole 400 mg tab', 'B013-HC002', '12/2026', '140', '0', '60', '80'],
];

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;

const cell = (text, cls = '') =>
  `<td class="${cls}"><span style="display:inline-block;transform:translateY(${(rand() * 3).toFixed(1)}px) rotate(${(rand() * 2.4).toFixed(2)}deg);font-size:${(27 + rand() * 3).toFixed(1)}px">${text}</span></td>`;

const html = `<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Kalam:wght@400;700&family=Caveat:wght@500&display=block" rel="stylesheet">
<style>
  html,body{margin:0;background:#3b3128}
  .desk{width:1600px;height:1200px;display:grid;place-items:center;
    background:radial-gradient(circle at 30% 20%,#5a4a3b,#2c241d 70%)}
  .page{width:1380px;height:1000px;transform:rotate(-1.3deg) perspective(1600px) rotateX(2deg);
    background:
      linear-gradient(90deg,transparent 118px,rgba(200,60,60,.45) 118px,rgba(200,60,60,.45) 121px,transparent 121px),
      repeating-linear-gradient(180deg,transparent 0 63px,rgba(70,110,170,.28) 63px 65px),
      radial-gradient(circle at 70% 30%,#fbf6e6,#efe4c6 80%);
    box-shadow:0 30px 60px rgba(0,0,0,.55),inset 0 0 80px rgba(120,90,40,.25);
    border-radius:6px;padding:40px 56px;box-sizing:border-box;color:#1d3f8f;font-family:Kalam,Caveat,cursive}
  h1{font-weight:700;font-size:40px;margin:0 0 4px 70px;letter-spacing:.5px}
  .meta{margin:0 0 18px 70px;font-size:26px;color:#284f9e}
  table{border-collapse:collapse;width:100%;margin-left:0}
  th{font-family:Kalam;font-weight:700;font-size:22px;color:#28303a;border-bottom:2px solid rgba(40,48,58,.6);
    padding:6px 8px;text-align:left}
  td{height:63px;padding:0 8px;border-right:1px solid rgba(40,48,58,.25);white-space:nowrap}
  th:not(:last-child){border-right:1px solid rgba(40,48,58,.35)}
  td.n{text-align:right}
  .sig{margin:26px 60px 0 auto;width:360px;text-align:center;font-size:26px}
  .smudge{position:absolute;width:160px;height:90px;border-radius:50%;background:rgba(40,60,120,.07);filter:blur(8px)}
</style></head><body><div class="desk"><div class="page" style="position:relative">
  <div class="smudge" style="left:780px;top:520px"></div>
  <h1>Stock Register — CHC Bastar-01</h1>
  <div class="meta">Month: September 2026 &nbsp;&nbsp; Date: 28/09/2026</div>
  <table>
    <tr><th>S.No</th><th>Medicine</th><th>Batch No.</th><th>Expiry</th><th>Opening</th><th>Received</th><th>Issued</th><th>Closing</th></tr>
    ${ROWS.map((r) => '<tr>' + cell(r[0]) + cell(r[1]) + cell(r[2]) + cell(r[3]) + cell(r[4], 'n') + cell(r[5], 'n') + cell(r[6], 'n') + cell(r[7], 'n') + '</tr>').join('\n')}
    <tr>${cell('')}${cell('')}${cell('')}${cell('')}${cell('', 'n')}${cell('', 'n')}${cell('', 'n')}${cell('', 'n')}</tr>
  </table>
  <div class="sig">Pharmacist / MO i/c<br><span style="font-family:Caveat;font-size:40px">R. Netam</span></div>
</div></div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: OUT, type: 'jpeg', quality: 86 });
await browser.close();
console.log('wrote ' + OUT);
