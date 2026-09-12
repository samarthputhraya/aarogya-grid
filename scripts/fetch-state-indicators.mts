/**
 * REAL PER-STATE HEALTH-SYSTEM INDICATORS.
 *
 * Run:  npx tsx scripts/fetch-state-indicators.mts
 * Out:  src/data/state-indicators.json
 *
 * WHAT THIS REPLACES
 * ------------------
 * `districtReliability` was a HASH OF THE DISTRICT CODE. It produced the
 * spatial clustering the map needs, and it ranked Kerala below Chhattisgarh,
 * because a hash has no opinion about Kerala. Supply reliability feeds stock-out
 * risk, so that arbitrary number propagated into every ranking the console
 * shows and every dispatch the optimiser proposes.
 *
 * THE INDICATOR, AND WHY THIS ONE
 * -------------------------------
 * Institutional delivery rate by state, NFHS-5 (2019-21), as released by the
 * Union Health Ministry. It is a measurement of whether a state's public health
 * system actually reaches people: it depends on facilities being open, staffed,
 * stocked and trusted enough to use. Tamil Nadu and Kerala are at the top; the
 * states with the weakest primary care are at the bottom.
 *
 * IT IS A PROXY AND IS LABELLED AS ONE
 * ------------------------------------
 * It is NOT a measurement of consignment reliability. Nobody publishes that --
 * its absence is the problem this whole product exists to address. What the
 * change buys is that the ranking stops being arbitrary: a district in a state
 * whose health system demonstrably functions no longer scores worse than one in
 * a state whose demonstrably does not, on the strength of a hash.
 *
 * The honest form of the claim, which every surface carries: "modelled, anchored
 * to a real published state indicator" -- not "measured".
 *
 * The ideal replacement is the Data Trust Score in the plan (reporting
 * timeliness plus ledger-versus-physical-count variance, which CAG found at
 * 83.42% mismatch in Himachal). That needs data a state would have to export.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATES } from '../src/lib/domain/geo';

const PAGE = 'Indian_states_ranking_by_institutional_delivery';
const API =
  'https://en.wikipedia.org/w/api.php?action=parse&page=' +
  PAGE +
  '&prop=wikitext&format=json&formatversion=2';

const res = await fetch(API, { headers: { 'User-Agent': 'aarogya-grid/1.0 (research)' } });
if (!res.ok) {
  console.error('Wikipedia API returned ' + res.status);
  process.exit(1);
}
const wikitext = ((await res.json()) as { parse?: { wikitext?: string } }).parse?.wikitext ?? '';

/**
 * Rows look like `| '''2'''|| [[Kerala]] || 99.8 <ref .../>`.
 * The value is the first bare number after the state link; `<ref>` blocks and
 * bold markup are stripped first so a citation cannot be read as data.
 */
const values = new Map<string, number>();
for (const row of wikitext.split(/\n\|-/)) {
  const clean = row
    .replace(/<ref[^>]*\/>/g, '')
    .replace(/<ref[\s\S]*?<\/ref>/g, '')
    .replace(/'''/g, '');
  const link = clean.match(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
  if (!link) continue;
  const after = clean.slice(clean.indexOf(link[0]) + link[0].length);
  const num = after.match(/\|\|\s*([\d.]+)/);
  if (!num) continue;
  const v = Number(num[1]);
  if (!Number.isFinite(v) || v <= 0 || v > 100) continue;
  values.set(link[1].trim(), v);
}
console.log('parsed ' + values.size + ' state rows');

const missing: string[] = [];
const out: Record<string, { institutionalDeliveryPct: number }> = {};
for (const s of STATES) {
  const v = values.get(s.name);
  if (v === undefined) {
    missing.push(s.name);
    continue;
  }
  out[s.code] = { institutionalDeliveryPct: v };
}

if (missing.length) {
  console.error('\nMISSING from the source table: ' + missing.join(', '));
  process.exit(1);
}

const vals = Object.values(out).map((v) => v.institutionalDeliveryPct);
const payload = {
  source: 'https://en.wikipedia.org/wiki/' + PAGE,
  sourceNote:
    'Institutional delivery rate by state, NFHS-5 (2019-21), as released by the Union Health ' +
    'Ministry (PIB PRID 1774533). Fetched as raw wikitext through the MediaWiki API. ' +
    'Re-run with: npx tsx scripts/fetch-state-indicators.mts',
  indicator: 'institutional delivery (%), NFHS-5',
  isProxy: true,
  proxyNote:
    'Used as the anchor for modelled supply reliability. It measures whether a state health ' +
    'system reaches people, not whether consignments arrive complete and on time -- nobody ' +
    'publishes the latter, which is the problem this product addresses. Labelled as modelled ' +
    'on every surface that shows it.',
  retrievedAt: new Date().toISOString().slice(0, 10),
  states: Object.keys(out).length,
  range: { min: Math.min(...vals), max: Math.max(...vals) },
  indicators: out,
};

writeFileSync(resolve(process.cwd(), 'src/data/state-indicators.json'), JSON.stringify(payload, null, 1));

console.log('\nwrote src/data/state-indicators.json');
console.log('  states : ' + Object.keys(out).length);
console.log('  range  : ' + payload.range.min + '% … ' + payload.range.max + '%');
const ranked = Object.entries(out)
  .map(([code, v]) => [STATES.find((s) => s.code === code)!.name, v.institutionalDeliveryPct] as const)
  .sort((a, b) => b[1] - a[1]);
console.log('  best   : ' + ranked.slice(0, 3).map((r) => r[0] + ' ' + r[1] + '%').join(', '));
console.log('  worst  : ' + ranked.slice(-3).map((r) => r[0] + ' ' + r[1] + '%').join(', '));
