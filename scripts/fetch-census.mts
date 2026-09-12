/**
 * CENSUS 2011 DISTRICT POPULATIONS — fetched, parsed, and written as an artefact.
 *
 * Run:  npx tsx scripts/fetch-census.mts
 * Out:  src/data/census-2011.json
 *
 * WHY A SCRIPT AND NOT A TYPED TABLE
 * ----------------------------------
 * The project's first guardrail is that no figure is published unless it comes
 * from a re-run script or a shipped payload. 128 population figures typed in by
 * hand would be 128 unverifiable claims. This is one command anyone can re-run,
 * and it records, per district, exactly which source row it matched.
 *
 * THE SOURCE, AND ITS LIMITS, STATED UP FRONT
 * -------------------------------------------
 * The per-state district tables on the English Wikipedia's `List of districts in
 * India`, fetched as raw wikitext through the MediaWiki API so the parse is
 * deterministic rather than a model reading a rendered page. Each state table's
 * column is headed `Population (2011)` and cites `censusdist2011`.
 *
 * Wikipedia is a SECONDARY source. It is used because the Census's own district
 * tables are XLS behind a portal that cannot be fetched reproducibly. A sample
 * is cross-checked against primary figures by `scripts/verify-census.mts`, which
 * fails `npm test` on a mismatch. The number's job here is to stop the map being
 * obviously wrong — Surat was modelled at 779k against ~6M real.
 *
 * TWO PARSING TRAPS, BOTH HIT ON THE FIRST ATTEMPT
 * ------------------------------------------------
 * 1. **District names are not unique across India.** Aurangabad is a district in
 *    both Bihar (2.5M) and Maharashtra (3.7M); Bijapur is in both Chhattisgarh
 *    (0.23M) and Karnataka (2.2M); we model Bilaspur in Chhattisgarh and Himachal
 *    has one too. A national name->population map silently assigns the wrong
 *    figure. Rows are therefore keyed by (state, district), parsed from the
 *    per-state sections.
 * 2. **Rows use two different cell separators.** Most are `| a || b || c`, but
 *    some — Thiruvananthapuram among them — put each cell on its own line. A
 *    parser that only split on `||` dropped them silently, which is the worst
 *    kind of failure: a missing district, not an error.
 *
 * THE BOUNDARY QUESTION
 * ---------------------
 * India has created and renamed many districts since 2011. The source's figures
 * are the 2011 census population apportioned to CURRENT district boundaries —
 * verified here by an arithmetic check: Purba Bardhaman (4,835,532) and Paschim
 * Bardhaman (2,882,031) sum exactly to undivided Bardhaman's 2011 total of
 * 7,717,563. That is the number we want, since we model today's districts.
 *
 * Where our name differs from the source's, the alias and the reason are
 * recorded per district and carried into the payload, so a reader can check any
 * row rather than trust the mapping.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DISTRICTS } from '../src/lib/domain/geo';

const PAGE = 'List_of_districts_in_India';
const API =
  'https://en.wikipedia.org/w/api.php?action=parse&page=' +
  PAGE +
  '&prop=wikitext&format=json&formatversion=2';

/** Our state names, as they appear in the source's `=== State (XX) ===` headings. */
const STATE_HEADING: Record<string, string> = {
  Bihar: 'Bihar',
  Assam: 'Assam',
  'West Bengal': 'West Bengal',
  Jharkhand: 'Jharkhand',
  Odisha: 'Odisha',
  Chhattisgarh: 'Chhattisgarh',
  'Madhya Pradesh': 'Madhya Pradesh',
  Gujarat: 'Gujarat',
  Maharashtra: 'Maharashtra',
  'Andhra Pradesh': 'Andhra Pradesh',
  Karnataka: 'Karnataka',
  Kerala: 'Kerala',
  'Tamil Nadu': 'Tamil Nadu',
  Telangana: 'Telangana',
  Rajasthan: 'Rajasthan',
  'Uttar Pradesh': 'Uttar Pradesh',
};

/**
 * Districts whose 2011 census name differs from the name we model them under.
 * Spelling variants and renames only — the territory is the same.
 */
const ALIASES: Record<string, { census: string; note: string }> = {
  'DST-19-MALDA': { census: 'Maldah', note: 'spelled Maldah in the census' },
  'DST-20-HAZARIBA': { census: 'Hazaribag', note: 'spelled Hazaribag in the census' },
  'DST-24-KACHCHH': { census: 'Kutch', note: 'spelled Kutch in the census' },
  'DST-28-ANANTAPU': { census: 'Ananthapuramu', note: 'renamed Ananthapuramu' },
  'DST-29-BENGALUR': { census: 'Bangalore Urban', note: 'Bangalore Urban, renamed 2014' },
  'DST-29-MYSURU': { census: 'Mysore', note: 'Mysore, renamed 2014' },
  'DST-29-VIJAYAPU': { census: 'Bijapur', note: 'Bijapur (Karnataka), renamed 2014' },
  'DST-36-MAHABUBN': { census: 'Mahbubnagar', note: 'spelled Mahbubnagar in the census' },
  'DST-27-CHHATRAP': { census: 'Aurangabad', note: 'Aurangabad (Maharashtra), renamed 2023' },
};

interface Row {
  district: string;
  population: number;
}

/**
 * Cells of one wikitable row, tolerating both separator styles.
 * `| a || b` and a row with each cell on its own `|` line both come out the same.
 */
function cells(row: string): string[] {
  return row
    .replace(/\n\s*\|/g, '||')
    .split('||')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function parseStateTable(section: string): Row[] {
  const out: Row[] = [];
  for (const row of section.split(/\n\|-/)) {
    const cs = cells(row);
    if (cs.length < 3) continue;
    /*
     * The district is the FIRST cell carrying a wikilink; the headquarters cell
     * always follows it. Matching on a `[[X district|X]]` pattern instead looks
     * tidier and silently drops rows: `[[South 24 Parganas]]` and
     * `[[Dakshina Kannada]]` have no "district" in the link at all, so they
     * vanished from the first version of this parser without an error.
     */
    let name: string | null = null;
    for (const c of cs) {
      const m = c.match(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/);
      if (m) {
        name = (m[2] ?? m[1]).replace(/\s+district.*$/i, '').trim();
        break;
      }
    }
    if (!name) continue;
    /*
     * The population is the first comma-grouped number of at least five digits,
     * after stripping formatting templates. West Champaran's cell is
     * `{{right}}3,935,042`, which a strict digits-only match rejects — again
     * silently, again losing a whole district rather than raising anything.
     */
    let pop: number | null = null;
    for (const raw of cs) {
      const c = raw.replace(/\{\{[^}]*\}\}/g, '').trim();
      const m = c.match(/^\s*([\d,]{5,})\s*$/);
      if (!m) continue;
      const v = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(v) && v >= 10_000) {
        pop = v;
        break;
      }
    }
    if (pop === null) continue;
    out.push({ district: name, population: pop });
  }
  return out;
}

const res = await fetch(API, { headers: { 'User-Agent': 'aarogya-grid/1.0 (research)' } });
if (!res.ok) {
  console.error('Wikipedia API returned ' + res.status);
  process.exit(1);
}
const wikitext = ((await res.json()) as { parse?: { wikitext?: string } }).parse?.wikitext ?? '';
if (wikitext.length < 50_000) {
  console.error('Source page looks truncated (' + wikitext.length + ' chars)');
  process.exit(1);
}

// Split into `=== State (XX) ===` sections and parse each table independently,
// so a name can never be matched against another state's district.
const byState = new Map<string, Map<string, number>>();
const sections = wikitext.split(/\n===\s*/);
for (const sec of sections) {
  const head = sec.match(/^([^=(]+?)\s*\([A-Z]{2}\)\s*===/);
  if (!head) continue;
  const state = head[1].trim();
  const rows = parseStateTable(sec);
  if (!rows.length) continue;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.district.toLowerCase(), r.population);
  byState.set(state, m);
}
console.log('parsed ' + byState.size + ' state tables');

// The arithmetic check that the column really is 2011-on-current-boundaries.
const wb = byState.get('West Bengal');
const purba = wb?.get('purba bardhaman');
const paschim = wb?.get('paschim bardhaman');
if (purba && paschim) {
  const sum = purba + paschim;
  const UNDIVIDED_BARDHAMAN_2011 = 7_717_563;
  const ok = sum === UNDIVIDED_BARDHAMAN_2011;
  console.log(
    (ok ? '  OK  ' : '  WARN') +
      '  Purba + Paschim Bardhaman = ' +
      sum.toLocaleString('en-IN') +
      ' vs undivided 2011 ' +
      UNDIVIDED_BARDHAMAN_2011.toLocaleString('en-IN'),
  );
  if (!ok) {
    console.error('  the source is not 2011-on-current-boundaries; do not ship this');
    process.exit(1);
  }
}

const out: Record<
  string,
  { population: number; censusName: string; state: string; note?: string }
> = {};
const unmatched: string[] = [];

for (const d of DISTRICTS) {
  const heading = STATE_HEADING[d.stateName];
  const table = heading ? byState.get(heading) : undefined;
  if (!table) {
    unmatched.push(`${d.code}  no table for state "${d.stateName}"`);
    continue;
  }
  const alias = ALIASES[d.code];
  const lookup = (alias?.census ?? d.name).toLowerCase();
  const pop = table.get(lookup);
  if (pop === undefined) {
    unmatched.push(`${d.code}  ${d.name} — no "${alias?.census ?? d.name}" in ${d.stateName}`);
    continue;
  }
  out[d.code] = {
    population: pop,
    censusName: alias?.census ?? d.name,
    state: d.stateName,
    ...(alias ? { note: alias.note } : {}),
  };
}

if (unmatched.length) {
  console.error('\nUNMATCHED — add an alias for each before this can be trusted:');
  for (const u of unmatched) console.error('  ' + u);
  process.exit(1);
}

const payload = {
  source: 'https://en.wikipedia.org/wiki/' + PAGE,
  sourceNote:
    'Per-state district tables, column "Population (2011)", citing the 2011 Census of India. ' +
    'Fetched as raw wikitext through the MediaWiki API so the parse is deterministic. ' +
    'Figures are the 2011 population apportioned to CURRENT district boundaries. ' +
    'Re-run with: npx tsx scripts/fetch-census.mts',
  census: 2011,
  retrievedAt: new Date().toISOString().slice(0, 10),
  districts: Object.keys(out).length,
  aliased: Object.values(out).filter((v) => v.note).length,
  populations: out,
};

const outPath = resolve(process.cwd(), 'src/data/census-2011.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload, null, 1));

const sorted = Object.entries(out).sort((a, b) => b[1].population - a[1].population);
const total = sorted.reduce((a, [, v]) => a + v.population, 0);
console.log('\nwrote src/data/census-2011.json');
console.log('  districts : ' + sorted.length + ' (' + payload.aliased + ' matched under another name)');
console.log('  total pop : ' + (total / 1e6).toFixed(1) + 'M');
console.log('  largest   : ' + sorted[0][1].censusName + ' ' + sorted[0][1].population.toLocaleString('en-IN'));
console.log('  smallest  : ' + sorted.at(-1)![1].censusName + ' ' + sorted.at(-1)![1].population.toLocaleString('en-IN'));
