/**
 * EVERY DISTRICT IN INDIA -- fetched, parsed, located and written as one registry.
 *
 * Run:  npx tsx scripts/fetch-districts.mts
 * Out:  src/data/india-districts.json
 *
 * WHAT THIS REPLACES
 * ------------------
 * The grid used to model 128 districts whose names and coordinates were typed
 * into `src/lib/domain/geo.ts` by hand, with populations fetched separately by
 * `scripts/fetch-census.mts`. Two things were wrong with that beyond the size:
 *
 *   1. **The coordinates had no source.** "Approximate district headquarters" is
 *      a description of a number somebody typed, not of where it came from.
 *   2. **Four Chhattisgarh populations were another district's.** The source
 *      table's code cell carries footnotes like "Kondagaon district was created
 *      in 2012 after bifurcation of [[Bastar district]]", and the old parser took
 *      the FIRST wikilink in a row as the district. Kondagaon's row was therefore
 *      read as Bastar's and overwrote it: the README's own worked example, "our
 *      Bastar is 578,326", was Kondagaon's population. Bastar today is 834,873,
 *      which is undivided 2011 Bastar (1,413,199) less Kondagaon, to the person.
 *      The same trap moved Dantewada, Bilaspur and Raipur. The cross-check could
 *      not see it, because a wrong number smaller than the undivided parent
 *      passed the only test it faced.
 *
 * This script reads every row by COLUMN POSITION, from the table's own header,
 * with footnotes stripped before a link is looked for. `verify-census.mts`
 * now checks the populations against a second publisher over hundreds of
 * districts rather than a hand-picked twenty.
 *
 * THE SOURCES, IN ORDER OF AUTHORITY FOR EACH FIELD
 * -------------------------------------------------
 *   districts, headquarters, population   English Wikipedia, `List of districts
 *                                          in India`, pinned to the revision this
 *                                          run read. Secondary: the Local
 *                                          Government Directory is authoritative
 *                                          but sits behind a captcha, so it cannot
 *                                          be fetched reproducibly.
 *   coordinates                            the district article's own coordinates
 *                                          (Wikipedia `prop=coordinates`), else
 *                                          Wikidata P625, else the headquarters
 *                                          town's article. Which one was used is
 *                                          recorded per district.
 *   LGD district code                      Wikidata P12746, where Wikidata has it.
 *                                          It is carried, never required: Wikidata
 *                                          is missing codes for districts LGD
 *                                          certainly lists (New Delhi, Chandigarh).
 *   state code                             the LGD / Census state code, as every
 *                                          other file in this project already uses.
 *
 * Everything is fetched as structured data through public APIs, so the parse is
 * deterministic and nothing is read off a rendered page.
 *
 * POPULATION VINTAGE IS RECORDED, NOT ASSUMED
 * -------------------------------------------
 * The table's population column is headed "(2011)" for 35 states and UTs and
 * "(2021)" for Andhra Pradesh, whose figures are the state's own round
 * estimates -- there was no 2021 census. The old file called all of them Census
 * 2011. Each district now carries `populationVintage`:
 *
 *   census-2011     a 2011 Census figure apportioned to current boundaries
 *   state-2021      Andhra Pradesh's 2021 estimate, as the table labels it
 *   estimate        a round figure in a column headed 2011 (a district newer than
 *                   the census, given an approximate population by its editors)
 *
 * A district with NO population figure is kept in the registry and marked
 * `modelled: false`. It is never given an invented one: facility counts and the
 * risk score's exposure term are both scaled by population, so a made-up figure
 * would propagate into every number the district produces.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const UA = 'aarogya-grid/1.0 (hackathon research; https://github.com/samarthputhraya/aarogya-grid)';
const PAGE = 'List_of_districts_in_India';
const OUT = resolve(process.cwd(), 'src/data/india-districts.json');

// ------------------------------------------------------------------ the states

/**
 * The 36 states and union territories: LGD / Census code, the name this product
 * shows, a two-letter abbreviation for dense axes, and the heading the source
 * table files them under.
 *
 * The codes are the ones Wikidata carries as LGD State Code (P12747) for each
 * state -- checked by this script at run time rather than trusted.
 */
interface StateRow {
  code: string;
  name: string;
  abbr: string;
  heading: string;
  wikidata: string;
}

const STATE_TABLE: StateRow[] = [
  { code: '01', name: 'Jammu and Kashmir', abbr: 'JK', heading: 'Jammu and Kashmir', wikidata: 'Q66278313' },
  { code: '02', name: 'Himachal Pradesh', abbr: 'HP', heading: 'Himachal Pradesh', wikidata: 'Q1177' },
  { code: '03', name: 'Punjab', abbr: 'PB', heading: 'Punjab', wikidata: 'Q22424' },
  { code: '04', name: 'Chandigarh', abbr: 'CH', heading: 'Chandigarh', wikidata: 'Q120971341' },
  { code: '05', name: 'Uttarakhand', abbr: 'UK', heading: 'Uttarakhand', wikidata: 'Q1499' },
  { code: '06', name: 'Haryana', abbr: 'HR', heading: 'Haryana', wikidata: 'Q1174' },
  { code: '07', name: 'Delhi', abbr: 'DL', heading: 'National Capital Territory of Delhi', wikidata: 'Q9357528' },
  { code: '08', name: 'Rajasthan', abbr: 'RJ', heading: 'Rajasthan', wikidata: 'Q1437' },
  { code: '09', name: 'Uttar Pradesh', abbr: 'UP', heading: 'Uttar Pradesh', wikidata: 'Q1498' },
  { code: '10', name: 'Bihar', abbr: 'BR', heading: 'Bihar', wikidata: 'Q1165' },
  { code: '11', name: 'Sikkim', abbr: 'SK', heading: 'Sikkim', wikidata: 'Q1505' },
  { code: '12', name: 'Arunachal Pradesh', abbr: 'AR', heading: 'Arunachal Pradesh', wikidata: 'Q1162' },
  { code: '13', name: 'Nagaland', abbr: 'NL', heading: 'Nagaland', wikidata: 'Q1599' },
  { code: '14', name: 'Manipur', abbr: 'MN', heading: 'Manipur', wikidata: 'Q1193' },
  { code: '15', name: 'Mizoram', abbr: 'MZ', heading: 'Mizoram', wikidata: 'Q1502' },
  { code: '16', name: 'Tripura', abbr: 'TR', heading: 'Tripura', wikidata: 'Q1363' },
  { code: '17', name: 'Meghalaya', abbr: 'ML', heading: 'Meghalaya', wikidata: 'Q1195' },
  { code: '18', name: 'Assam', abbr: 'AS', heading: 'Assam', wikidata: 'Q1164' },
  { code: '19', name: 'West Bengal', abbr: 'WB', heading: 'West Bengal', wikidata: 'Q1356' },
  { code: '20', name: 'Jharkhand', abbr: 'JH', heading: 'Jharkhand', wikidata: 'Q1184' },
  { code: '21', name: 'Odisha', abbr: 'OD', heading: 'Odisha', wikidata: 'Q22048' },
  { code: '22', name: 'Chhattisgarh', abbr: 'CG', heading: 'Chhattisgarh', wikidata: 'Q1168' },
  { code: '23', name: 'Madhya Pradesh', abbr: 'MP', heading: 'Madhya Pradesh', wikidata: 'Q1188' },
  { code: '24', name: 'Gujarat', abbr: 'GJ', heading: 'Gujarat', wikidata: 'Q1061' },
  { code: '27', name: 'Maharashtra', abbr: 'MH', heading: 'Maharashtra', wikidata: 'Q1191' },
  { code: '28', name: 'Andhra Pradesh', abbr: 'AP', heading: 'Andhra Pradesh', wikidata: 'Q1159' },
  { code: '29', name: 'Karnataka', abbr: 'KA', heading: 'Karnataka', wikidata: 'Q1185' },
  { code: '30', name: 'Goa', abbr: 'GA', heading: 'Goa', wikidata: 'Q1171' },
  { code: '31', name: 'Lakshadweep', abbr: 'LD', heading: 'Lakshadweep', wikidata: 'Q26927' },
  { code: '32', name: 'Kerala', abbr: 'KL', heading: 'Kerala', wikidata: 'Q1186' },
  { code: '33', name: 'Tamil Nadu', abbr: 'TN', heading: 'Tamil Nadu', wikidata: 'Q1445' },
  { code: '34', name: 'Puducherry', abbr: 'PY', heading: 'Puducherry', wikidata: 'Q66743' },
  { code: '35', name: 'Andaman and Nicobar Islands', abbr: 'AN', heading: 'Andaman and Nicobar', wikidata: 'Q40888' },
  { code: '36', name: 'Telangana', abbr: 'TG', heading: 'Telangana', wikidata: 'Q677037' },
  { code: '37', name: 'Ladakh', abbr: 'LA', heading: 'Ladakh', wikidata: 'Q200667' },
  {
    code: '38',
    name: 'Dadra and Nagar Haveli and Daman and Diu',
    abbr: 'DD',
    heading: 'Dadra and Nagar Haveli and Daman and Diu',
    wikidata: 'Q77997266',
  },
];

// ---------------------------------------------------- the 128 existing districts

/**
 * The districts the grid modelled before this registry, under the name and code
 * they already carry.
 *
 * Their codes are referenced by tests, rehearsals, the capture page and the
 * durable log, so they are kept exactly. Where the source table spells a
 * district differently, the table's name is given here so the row can be found;
 * the product keeps the current official name.
 */
const LEGACY_NAMES: Record<string, string[]> = {
  '08': ['Jaipur', 'Jodhpur', 'Udaipur', 'Kota', 'Bikaner', 'Ajmer', 'Barmer', 'Alwar'],
  '09': ['Lucknow', 'Kanpur Nagar', 'Varanasi', 'Gorakhpur', 'Prayagraj', 'Agra', 'Bareilly', 'Jhansi'],
  '10': ['Patna', 'Gaya', 'Muzaffarpur', 'Bhagalpur', 'Darbhanga', 'Purnia', 'Saran', 'West Champaran'],
  '18': ['Kamrup Metropolitan', 'Dibrugarh', 'Jorhat', 'Cachar', 'Nagaon', 'Barpeta', 'Sonitpur', 'Dhubri'],
  '19': ['Kolkata', 'Murshidabad', 'Purba Bardhaman', 'Darjeeling', 'Malda', 'Nadia', 'Purulia', 'South 24 Parganas'],
  '20': ['Ranchi', 'Dhanbad', 'East Singhbhum', 'Bokaro', 'Hazaribagh', 'Palamu', 'Dumka', 'Gumla'],
  '21': ['Khordha', 'Cuttack', 'Ganjam', 'Sundargarh', 'Mayurbhanj', 'Koraput', 'Kalahandi', 'Balasore'],
  '22': ['Raipur', 'Bilaspur', 'Durg', 'Bastar', 'Surguja', 'Raigarh', 'Dantewada', 'Korba'],
  '23': ['Bhopal', 'Indore', 'Jabalpur', 'Gwalior', 'Rewa', 'Sagar', 'Chhindwara', 'Mandla'],
  '24': ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Bhavnagar', 'Dahod', 'Kachchh', 'Valsad'],
  '27': ['Pune', 'Nagpur', 'Nashik', 'Chhatrapati Sambhajinagar', 'Gadchiroli', 'Nandurbar', 'Solapur', 'Amravati'],
  '28': ['Visakhapatnam', 'Guntur', 'Kurnool', 'Kakinada', 'Chittoor', 'Anantapur', 'Srikakulam', 'Prakasam'],
  '29': ['Bengaluru Urban', 'Mysuru', 'Belagavi', 'Kalaburagi', 'Raichur', 'Dakshina Kannada', 'Ballari', 'Vijayapura'],
  '32': ['Thiruvananthapuram', 'Ernakulam', 'Kozhikode', 'Thrissur', 'Malappuram', 'Wayanad', 'Palakkad', 'Idukki'],
  '33': ['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem', 'Thoothukudi', 'Vellore', 'Nilgiris'],
  '36': ['Hyderabad', 'Warangal', 'Karimnagar', 'Khammam', 'Nizamabad', 'Adilabad', 'Nalgonda', 'Mahabubnagar'],
};

/**
 * Where the table's name differs from the name the product uses. Spellings and
 * official renames only -- the territory is the same. Keyed `state|product name`.
 */
const TABLE_NAME_FOR: Record<string, string> = {
  '18|Kamrup Metropolitan': 'Kamrup Metropolitan',
  '19|Malda': 'Maldah',
  '24|Kachchh': 'Kutch',
  '28|Anantapur': 'Ananthapuramu',
  '29|Bengaluru Urban': 'Bangalore Urban',
  '29|Mysuru': 'Mysore',
  '29|Vijayapura': 'Bijapur',
  '27|Chhatrapati Sambhajinagar': 'Aurangabad',
  '36|Warangal': 'Warangal',
};

/**
 * Official renames the source table has not caught up with, applied to NEW
 * districts' display names so that one state is not shown half in old spellings.
 * Karnataka renamed these in 2014 (Gazette notification, 1 Nov 2014); the
 * product already shows Bengaluru Urban, Mysuru and Vijayapura.
 */
const DISPLAY_RENAME: Record<string, string> = {
  '29|Bangalore Rural': 'Bengaluru Rural',
  '29|Chikmagalur': 'Chikkamagaluru',
  '29|Shimoga': 'Shivamogga',
  '29|Belgaum': 'Belagavi',
  '29|Bellary': 'Ballari',
  '29|Gulbarga': 'Kalaburagi',
  '29|Tumkur': 'Tumakuru',
};

// ----------------------------------------------------------------- utilities

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET/POST with pacing and backoff. Wikimedia rate-limits by agent, politely. */
async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let lastError = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text) as T;
      } catch {
        lastError = 'unparseable body: ' + text.slice(0, 80);
      }
    } else {
      lastError = res.status + ' ' + text.slice(0, 80);
    }
    await sleep(4000 * (attempt + 1));
  }
  throw new Error('fetch failed after retries: ' + url.slice(0, 120) + ' -- ' + lastError);
}

/** Remove `{{…}}` templates (balanced, so nested cite templates go too) and refs. */
function stripMarkup(s: string): string {
  let out = s.replace(/<ref[^>]*\/>/g, '').replace(/<ref[\s\S]*?<\/ref>/g, '');
  // formatnum carries a value; keep the value.
  out = out.replace(/\{\{\s*formatnum:\s*([\d.,]+)\s*\}\}/gi, '$1');
  // Balanced removal of the remaining templates.
  for (;;) {
    const i = out.lastIndexOf('{{');
    if (i < 0) break;
    const j = out.indexOf('}}', i);
    if (j < 0) break;
    out = out.slice(0, i) + out.slice(j + 2);
  }
  return out.replace(/<br\s*\/?>/gi, ' ').trim();
}

/** Cells of one row, tolerating both `| a || b` and one-cell-per-line styles. */
function cells(row: string): string[] {
  const lines = row.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|-') && !l.startsWith('|}'));
  const out: string[] = [];
  for (const line of lines) {
    for (const c of line.slice(1).split('||')) out.push(c.trim());
  }
  return out;
}

function headerCells(section: string): string[] {
  const head = section.split(/\n\|-/)[1] ?? '';
  const out: string[] = [];
  for (const line of head.split('\n')) {
    if (!line.startsWith('!')) continue;
    for (const c of line.slice(1).split('!!')) out.push(stripMarkup(c).toLowerCase());
  }
  return out;
}

const linkOf = (cell: string): { title: string; text: string } | null => {
  const m = stripMarkup(cell).match(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/);
  return m ? { title: m[1].trim(), text: (m[2] ?? m[1]).trim() } : null;
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\bdistrict\b/g, '')
    .replace(/[^a-z0-9]+/g, '');

function slug(name: string): string {
  return name.toUpperCase().normalize('NFKD').replace(/[^A-Z0-9]+/g, '').slice(0, 8);
}

// ------------------------------------------------------------ 1. the table

interface TableRow {
  stateCode: string;
  tableName: string;
  title: string;
  headquarters: string | null;
  headquartersTitle: string | null;
  population: number | null;
  vintage: 'census-2011' | 'state-2021' | 'estimate' | null;
}

console.log('fetching ' + PAGE + ' …');
const page = await fetchJson<{ parse: { wikitext: string; revid: number } }>(
  'https://en.wikipedia.org/w/api.php?action=parse&page=' +
    PAGE +
    '&prop=wikitext|revid&format=json&formatversion=2',
);
const wikitext = page.parse.wikitext;
const revision = page.parse.revid;
if (wikitext.length < 50_000) throw new Error('source page looks truncated');

const rows: TableRow[] = [];
const byHeading = new Map(STATE_TABLE.map((s) => [s.heading, s]));
for (const sec of wikitext.split(/\n===\s*/)) {
  const head = sec.match(/^([^=(]+?)\s*\(([A-Z]{2})\)\s*===/);
  if (!head) continue;
  const state = byHeading.get(head[1].trim());
  if (!state) throw new Error('unrecognised state heading: ' + head[1]);

  const header = headerCells(sec);
  const districtCol = header.findIndex((h) => h.startsWith('district'));
  const hqCol = header.findIndex((h) => h.startsWith('headquarter'));
  const popCol = header.findIndex((h) => h.startsWith('population'));
  if (districtCol < 0 || popCol < 0) throw new Error('no district/population column in ' + state.name);
  const columnYear = header[popCol].match(/(\d{4})/)?.[1];

  for (const row of sec.split(/\n\|-/).slice(2)) {
    // Templates and refs go BEFORE the row is split: a footnote can span lines and
    // carry pipes and wikilinks of its own, which is exactly how Kondagaon's row
    // came to be read as Bastar's.
    const cs = cells(stripMarkup(row));
    if (cs.length < header.length - 1) continue;
    const link = linkOf(cs[districtCol] ?? '');
    if (!link) continue;
    const hq = hqCol >= 0 ? linkOf(cs[hqCol] ?? '') : null;
    const rawPop = stripMarkup(cs[popCol] ?? '').replace(/[\s,]/g, '');
    const population = /^\d{3,}$/.test(rawPop) ? Number(rawPop) : null;
    let vintage: TableRow['vintage'] = null;
    if (population !== null) {
      if (columnYear === '2021') vintage = 'state-2021';
      else if (population % 1000 === 0) vintage = 'estimate';
      else vintage = 'census-2011';
    }
    rows.push({
      stateCode: state.code,
      tableName: DISPLAY_RENAME[state.code + '|' + link.text] ?? link.text,
      title: link.title,
      headquarters: hq?.text ?? null,
      headquartersTitle: hq?.title ?? null,
      population,
      vintage,
    });
  }
}
console.log('  revision ' + revision + ': ' + rows.length + ' rows across ' + new Set(rows.map((r) => r.stateCode)).size + ' states/UTs');

const seenTitles = new Map<string, TableRow>();
for (const r of rows) {
  const k = r.stateCode + '|' + r.title;
  if (seenTitles.has(k)) throw new Error('duplicate row for ' + k + ' -- the column parse is wrong');
  seenTitles.set(k, r);
}

// ------------------------------------------ 2. coordinates and Wikidata items

interface PageInfo {
  qid?: string;
  coord?: [number, number];
}

async function pageInfo(titles: string[]): Promise<Map<string, PageInfo>> {
  const out = new Map<string, PageInfo>();
  const unique = [...new Set(titles)];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1' +
      '&prop=coordinates|pageprops&ppprop=wikibase_item&colimit=max&coprimary=primary&titles=' +
      encodeURIComponent(batch.join('|'));
    const j = await fetchJson<{
      query: {
        normalized?: { from: string; to: string }[];
        redirects?: { from: string; to: string }[];
        pages: { title: string; missing?: boolean; pageprops?: { wikibase_item?: string }; coordinates?: { lat: number; lon: number }[] }[];
      };
    }>(url);
    // Walk normalisation and redirects back to the title we asked for.
    const back = new Map<string, string>();
    for (const n of j.query.normalized ?? []) back.set(n.to, n.from);
    for (const r of j.query.redirects ?? []) back.set(r.to, back.get(r.from) ?? r.from);
    for (const p of j.query.pages) {
      const asked = back.get(p.title) ?? p.title;
      out.set(asked, {
        qid: p.pageprops?.wikibase_item,
        coord: p.coordinates?.[0] ? [p.coordinates[0].lat, p.coordinates[0].lon] : undefined,
      });
    }
    await sleep(1200);
  }
  return out;
}

console.log('resolving ' + rows.length + ' district articles …');
const districtPages = await pageInfo(rows.map((r) => r.title));
const hqPages = await pageInfo(rows.map((r) => r.headquartersTitle).filter((t): t is string => Boolean(t)));

interface WikidataFacts {
  lgd?: string;
  coord?: [number, number];
  /** P625 of the item's capital (P36) -- the headquarters, when the table does not link it. */
  capitalCoord?: [number, number];
  dissolved?: string;
  population2011?: number;
}

const pointOf = (wkt: string): [number, number] | undefined => {
  const m = wkt.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
  return m ? [Number(m[2]), Number(m[1])] : undefined;
};

async function wikidata(qids: string[]): Promise<Map<string, WikidataFacts>> {
  const out = new Map<string, WikidataFacts>();
  for (let i = 0; i < qids.length; i += 200) {
    const values = qids.slice(i, i + 200).map((q) => 'wd:' + q).join(' ');
    const query =
      'SELECT ?d ?lgd ?coord ?capCoord ?end ?pop WHERE { VALUES ?d { ' + values + ' } ' +
      'OPTIONAL { ?d wdt:P12746 ?lgd } OPTIONAL { ?d wdt:P625 ?coord } OPTIONAL { ?d wdt:P576 ?end } ' +
      'OPTIONAL { ?d wdt:P36 ?cap . ?cap wdt:P625 ?capCoord } ' +
      'OPTIONAL { ?d p:P1082 ?ps . ?ps ps:P1082 ?pop . ?ps pq:P585 ?t . FILTER(YEAR(?t) = 2011) } }';
    const j = await fetchJson<{ results: { bindings: Record<string, { value: string }>[] } }>(
      'https://query.wikidata.org/sparql',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
        body: 'query=' + encodeURIComponent(query),
      },
    );
    for (const b of j.results.bindings) {
      const id = b.d.value.split('/').pop()!;
      const f = out.get(id) ?? {};
      if (b.lgd && !f.lgd) f.lgd = b.lgd.value;
      if (b.coord && !f.coord) f.coord = pointOf(b.coord.value);
      if (b.capCoord && !f.capitalCoord) f.capitalCoord = pointOf(b.capCoord.value);
      if (b.end) f.dissolved = b.end.value.slice(0, 10);
      if (b.pop) f.population2011 = Math.max(f.population2011 ?? 0, Number(b.pop.value));
      out.set(id, f);
    }
    await sleep(1500);
  }
  return out;
}

const qids = [...new Set(rows.map((r) => districtPages.get(r.title)?.qid).filter((q): q is string => Boolean(q)))];
console.log('reading ' + qids.length + ' Wikidata items …');
const facts = await wikidata(qids);

// The state codes, checked against Wikidata's LGD State Code rather than trusted,
// and each state's 2011 Census total, which `verify-census.mts` adds its
// districts up against.
const statePopulation2011 = new Map<string, number>();
{
  const values = STATE_TABLE.map((s) => 'wd:' + s.wikidata).join(' ');
  const j = await fetchJson<{ results: { bindings: Record<string, { value: string }>[] } }>(
    'https://query.wikidata.org/sparql',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
      body:
        'query=' +
        encodeURIComponent(
          'SELECT ?s ?code ?pop WHERE { VALUES ?s { ' + values + ' } ?s wdt:P12747 ?code . ' +
            'OPTIONAL { ?s p:P1082 ?ps . ?ps ps:P1082 ?pop . ?ps pq:P585 ?t . FILTER(YEAR(?t) = 2011) } }',
        ),
    },
  );
  const got = new Map(j.results.bindings.map((b) => [b.s.value.split('/').pop()!, b.code.value]));
  for (const b of j.results.bindings) {
    if (b.pop) {
      const id = b.s.value.split('/').pop()!;
      statePopulation2011.set(id, Math.max(statePopulation2011.get(id) ?? 0, Number(b.pop.value)));
    }
  }
  for (const s of STATE_TABLE) {
    if (Number(got.get(s.wikidata)) !== Number(s.code)) {
      throw new Error('state code for ' + s.name + ' is ' + got.get(s.wikidata) + ' on Wikidata, not ' + s.code);
    }
  }
  console.log('  all 36 state codes agree with Wikidata P12747; ' + statePopulation2011.size + ' carry a 2011 total');
}

// ----------------------------------------------- 3. inside the country, or not

interface Outline {
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
}
const outline = JSON.parse(readFileSync(resolve(process.cwd(), 'src/data/india-outline.json'), 'utf8')) as Outline;

function insideRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function insideIndia(lat: number, lon: number): boolean {
  return outline.geometry.coordinates.some((poly) => insideRing(lon, lat, poly[0]));
}
/** Distance to the outline in km, for points just outside a simplified coastline. */
function kmToOutline(lat: number, lon: number): number {
  let best = Infinity;
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  for (const poly of outline.geometry.coordinates) {
    for (const [x, y] of poly[0]) {
      const d = Math.hypot((x - lon) * kx, (y - lat) * 110.57);
      if (d < best) best = d;
    }
  }
  return best;
}

// ------------------------------------------------------------- 4. assemble

/**
 * Island territories whose districts lie beyond the simplified national outline,
 * which keeps the mainland coast and drops small islands. Everywhere else a point
 * more than 40 km outside the outline is a wrong article, not a coastline.
 */
const OFFSHORE_TOLERANCE_KM: Record<string, number> = { '31': 450, '35': 350 };

type CoordinateSource = 'wikipedia-article' | 'wikidata' | 'headquarters-article' | 'wikidata-capital';

interface RegistryDistrict {
  code: string;
  name: string;
  stateCode: string;
  lat: number | null;
  lon: number | null;
  coordinateSource: CoordinateSource | null;
  /** Why a district is not at its first admissible source (a shared headquarters town). */
  coordinateNote?: string;
  /** Set when the district article's own point is far from the chosen location. */
  articleCoordinateKmAway?: number;
  /** Candidate coordinates that were rejected as outside India, and why. */
  rejectedCoordinates?: string[];
  headquarters: string | null;
  population: number | null;
  populationVintage: TableRow['vintage'];
  /** Wikidata's 2011 figure for the same item, where it has one. A cross-check, never used. */
  wikidata2011: number | null;
  lgdDistrictCode: string | null;
  wikidata: string | null;
  wikipedia: string;
  modelled: boolean;
  /** Why a listed district is not modelled. Absent when it is. */
  notModelledReason?: string;
}

const problems: string[] = [];
const legacyByState = new Map(Object.entries(LEGACY_NAMES));
const usedLegacy = new Set<string>();
const districts: RegistryDistrict[] = [];
const pending: Pending[] = [];

for (const r of rows) {
  const info = districtPages.get(r.title);
  const f = info?.qid ? facts.get(info.qid) : undefined;
  /*
   * A dissolution date on Wikidata is reported, never acted on. The item for
   * "Karbi Anglong district" carries one from 2016, when West Karbi Anglong was
   * carved out of it -- and Karbi Anglong, headquartered at Diphu, is still a
   * district. Dropping the row would delete a real district on the strength of
   * how one Wikidata item models a bifurcation.
   */
  if (f?.dissolved) {
    console.log('  note: ' + r.tableName + ' (' + r.stateCode + ') carries a Wikidata dissolution date ' + f.dissolved + '; kept, the table lists it as current');
  }

  // Legacy match: the product's own name, looked up under the table's spelling.
  let name = r.tableName;
  let code: string | null = null;
  for (const legacy of legacyByState.get(r.stateCode) ?? []) {
    const tableSpelling = TABLE_NAME_FOR[r.stateCode + '|' + legacy] ?? legacy;
    if (norm(tableSpelling) === norm(r.tableName) || norm(tableSpelling) === norm(r.title.replace(/,.*$/, ''))) {
      name = legacy;
      code = 'DST-' + r.stateCode + '-' + slug(legacy);
      usedLegacy.add(r.stateCode + '|' + legacy);
      break;
    }
  }

  /*
   * Coordinates: the HEADQUARTERS TOWN first, because that is what the model
   * means by a district's location -- the district warehouse and the district
   * hospital are placed there, and every facility scatters around it.
   *
   * The district article comes after it, not before, and that order was forced
   * by the data. Taken first, the article coordinates put Purnia on top of
   * Deoghar, 150 km away in another state, and Gaya, Jehanabad and Nawada on one
   * identical point. Patiala's article returns a point in Beijing, and Bidar's
   * has its longitude wrong by sixty degrees. Every candidate must also fall
   * inside India, and a rejected candidate is recorded on the district so the
   * choice can be audited rather than trusted.
   */
  const candidates: [CoordinateSource, [number, number] | undefined][] = [
    ['headquarters-article', r.headquartersTitle ? hqPages.get(r.headquartersTitle)?.coord : undefined],
    ['wikidata-capital', f?.capitalCoord],
    ['wikipedia-article', info?.coord],
    ['wikidata', f?.coord],
  ];
  const tolerance = OFFSHORE_TOLERANCE_KM[r.stateCode] ?? 40;
  const rejected: string[] = [];
  const admissible: [CoordinateSource, [number, number]][] = [];
  for (const [source, c] of candidates) {
    if (!c) continue;
    const outside = insideIndia(c[0], c[1]) ? 0 : kmToOutline(c[0], c[1]);
    if (outside > tolerance) {
      rejected.push(source + ' ' + c.join(',') + ' is ' + Math.round(outside) + ' km outside India');
      continue;
    }
    admissible.push([source, c]);
  }
  pending.push({ r, info, f, name, code, rejected, admissible });
}

/*
 * Districts that name the same headquarters town.
 *
 * Bengaluru Urban and Bengaluru Rural both list Bangalore; Hyderabad and
 * Ranga Reddy both list Hyderabad. Placed at one point they are zero kilometres
 * apart -- a neighbour the planner would treat as free to reach -- and their
 * markers stack. The most populous district of the group keeps the town -- the
 * city district, in every case the table produces -- and the others move to
 * their own next admissible source, and say so.
 */
interface Pending {
  r: TableRow;
  info: PageInfo | undefined;
  f: WikidataFacts | undefined;
  name: string;
  code: string | null;
  rejected: string[];
  admissible: [CoordinateSource, [number, number]][];
}
const kmBetween = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * 110.57, (a[1] - b[1]) * 111.32 * Math.cos((a[0] * Math.PI) / 180));

const choice = new Map<Pending, { source: CoordinateSource; coord: [number, number]; note?: string }>();
for (const p of pending) {
  if (p.admissible.length) choice.set(p, { source: p.admissible[0][0], coord: p.admissible[0][1] });
}
const byPoint = new Map<string, Pending[]>();
for (const [p, c] of choice) {
  const k = c.coord.join(',');
  byPoint.set(k, [...(byPoint.get(k) ?? []), p]);
}
for (const group of byPoint.values()) {
  if (group.length < 2) continue;
  const here = choice.get(group[0])!.coord;
  const owner = [...group].sort(
    (a, b) => (b.r.population ?? 0) - (a.r.population ?? 0) || a.name.localeCompare(b.name),
  )[0];
  for (const p of group) {
    if (p === owner) continue;
    const alt = p.admissible.find(([, c]) => kmBetween(c, here) > 3);
    if (alt) {
      choice.set(p, {
        source: alt[0],
        coord: alt[1],
        note: 'shares a location with ' + owner.name + '; placed at its own ' + alt[0] + ' coordinates',
      });
    }
  }
}

for (const p of pending) {
  const { r, info, f, name, code, rejected } = p;
  const c = choice.get(p);
  const article = info?.coord;
  const reasons: string[] = [];
  if (r.population === null) reasons.push('the source table gives no population figure');
  if (!c) reasons.push('no source places it inside India');
  // Recorded, not acted on: a headquarters far from the article point is either a
  // large district or a wrong article, and the headquarters is the model's anchor.
  const drift = c && article ? kmBetween(c.coord, article) : 0;

  districts.push({
    code: code ?? '',
    name,
    stateCode: r.stateCode,
    lat: c ? +c.coord[0].toFixed(4) : null,
    lon: c ? +c.coord[1].toFixed(4) : null,
    coordinateSource: c?.source ?? null,
    ...(c?.note ? { coordinateNote: c.note } : {}),
    ...(drift > 120 ? { articleCoordinateKmAway: Math.round(drift) } : {}),
    ...(rejected.length ? { rejectedCoordinates: rejected } : {}),
    headquarters: r.headquarters,
    population: r.population,
    populationVintage: r.vintage,
    wikidata2011: f?.population2011 ?? null,
    lgdDistrictCode: f?.lgd ?? null,
    wikidata: info?.qid ?? null,
    wikipedia: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(r.title.replace(/ /g, '_')),
    modelled: reasons.length === 0,
    ...(reasons.length ? { notModelledReason: reasons.join('; ') } : {}),
  });
}

{
  const seen = new Map<string, string>();
  for (const d of districts) {
    if (!d.modelled) continue;
    const k = d.lat + ',' + d.lon;
    if (seen.has(k)) problems.push(d.name + ' and ' + seen.get(k) + ' share one location ' + k);
    seen.set(k, d.name);
  }
}

// A legacy district that is not modelled would break every consumer that
// already references its code, so that is a failure rather than a note.
for (const d of districts) {
  if (d.code && !d.modelled) problems.push('legacy district ' + d.name + ' is not modelled: ' + d.notModelledReason);
}

for (const [state, names] of legacyByState) {
  for (const n of names) {
    if (!usedLegacy.has(state + '|' + n)) problems.push('legacy district ' + n + ' (' + state + ') matched no row');
  }
}

// Codes for new districts: the first eight letters, and on a collision the
// initials of the leading words plus the last word -- deterministic, and
// asserted unique rather than hoped to be.
const taken = new Set(districts.filter((d) => d.code).map((d) => d.code));
const ordered = [...districts].sort(
  (a, b) => Number(a.stateCode) - Number(b.stateCode) || a.name.localeCompare(b.name),
);
for (const d of ordered) {
  if (d.code) continue;
  let candidate = 'DST-' + d.stateCode + '-' + slug(d.name);
  if (taken.has(candidate)) {
    const words = d.name.toUpperCase().normalize('NFKD').replace(/[^A-Z0-9 ]+/g, ' ').trim().split(/\s+/);
    const initials = words.slice(0, -1).map((w) => w[0]).join('');
    candidate = 'DST-' + d.stateCode + '-' + (initials + words[words.length - 1]).slice(0, 8);
  }
  let n = 2;
  const base = candidate;
  while (taken.has(candidate)) candidate = base.slice(0, base.length - 1) + String(n++);
  d.code = candidate;
  taken.add(candidate);
}
if (new Set(ordered.map((d) => d.code)).size !== ordered.length) problems.push('district codes are not unique');

// --------------------------------------- 5. districts that add up to the state

/*
 * THE SOURCE TABLE DOUBLE-COUNTS, AND THIS IS WHERE THAT IS MADE GOOD.
 *
 * When a district is carved out after 2011, the table adds a row for the new
 * district and does not always subtract it from its parent. Dantewada still
 * carries the 250,159 people who became Sukma in 2012; Leh and Kargil still
 * carry everyone the five districts announced in 2024 were given. Added up,
 * Nagaland's districts come to 131% of Nagaland's 2011 Census total, Ladakh's to
 * 152%, Punjab's and Gujarat's to about 112%. Summed across India the grid would
 * have covered more people than the 2011 Census counted in the country.
 *
 * Which parent kept which child is not in any machine-readable source for most
 * states (Wikidata's "separated from" links six districts), so the correction is
 * made at the level that IS published: each state's 2011 Census total. Where a
 * state's census-vintage districts exceed it by more than 1%, every district in
 * that state is scaled so the state adds up to its census total. Each district
 * keeps the table's figure and the factor, so the correction is visible and
 * reversible. A state that adds up to LESS is left alone -- a missing figure is
 * not evidence of anyone's size -- and Andhra Pradesh, whose table gives 2021
 * estimates rather than census counts, is not held to a 2011 total.
 */
const STATE_POP_PAGE = 'List_of_states_and_union_territories_of_India_by_population';
const statePage = await fetchJson<{ parse: { wikitext: string; revid: number } }>(
  'https://en.wikipedia.org/w/api.php?action=parse&page=' + STATE_POP_PAGE + '&prop=wikitext|revid&format=json&formatversion=2',
);
const censusTotal = new Map<string, number>();
{
  const byName = new Map(STATE_TABLE.map((s) => [norm(s.name), s.code]));
  const aliases: Record<string, string> = {
    [norm('Jammu and Kashmir (union territory)')]: '01',
    [norm('Delhi')]: '07',
    [norm('National Capital Territory of Delhi')]: '07',
    [norm('Andaman and Nicobar Islands')]: '35',
    [norm('Dadra and Nagar Haveli and Daman and Diu')]: '38',
  };
  /*
   * By column, from the header, never "the first number that looks right": an
   * earlier version took the first {{nts}} template in each row and read Bihar's
   * RURAL population as its total, because that row writes its census figure
   * without the template.
   */
  const table = statePage.parse.wikitext.slice(statePage.parse.wikitext.indexOf('{|'));
  const parts = table.split(/\n\|-/);
  const headerText = parts[0];
  const headers: string[] = [];
  for (const line of headerText.split('\n')) {
    if (line.startsWith('!')) headers.push(stripMarkup(line.slice(1).replace(/^[^|]*\|(?!\|)/, (m) => (/=/.test(m) ? '' : m))).toLowerCase());
  }
  const censusCol = headers.findIndex((h) => h.includes('2011 census population'));
  if (censusCol < 0) throw new Error('no "2011 Census Population" column in ' + STATE_POP_PAGE);
  for (const row of parts.slice(1)) {
    const cs = cells(row).map((c) => c.replace(/\{\{\s*nts\s*\|\s*([\d,]+)\s*\}\}/gi, '$1'));
    const link = linkOf(cs[1] ?? '');
    if (!link) continue;
    const value = stripMarkup(cs[censusCol] ?? '').replace(/[',\s]/g, '');
    if (!/^\d{5,}$/.test(value)) continue;
    const key = norm(link.text.replace(/\s*\(.*\)$/, ''));
    const code = byName.get(key) ?? aliases[key] ?? aliases[norm(link.title)];
    if (code) censusTotal.set(code, Number(value));
  }
  // Cross-check against Wikidata's 2011 figure where it has one. Wikidata is not
  // always right either (it holds a non-census figure for Puducherry), so a
  // disagreement is reported and the census-titled column is used.
  for (const s of STATE_TABLE) {
    const t = censusTotal.get(s.code);
    const w = statePopulation2011.get(s.wikidata);
    if (!t) problems.push('no 2011 Census total for ' + s.name + ' in ' + STATE_POP_PAGE);
    else if (w && Math.abs(t - w) / t > 0.01) {
      console.log('  note: ' + s.name + ' 2011 total ' + t.toLocaleString('en-IN') + ' vs Wikidata ' + w.toLocaleString('en-IN'));
    }
  }
}

const stateScaling: { code: string; name: string; tableSum: number; census2011: number; factor: number }[] = [];
for (const s of STATE_TABLE) {
  const total = censusTotal.get(s.code);
  const inState = ordered.filter((d) => d.stateCode === s.code && d.modelled);
  if (!total || inState.some((d) => d.populationVintage === 'state-2021')) continue;
  const tableSum = inState.reduce((a, d) => a + (d.population ?? 0), 0);
  if (tableSum <= total * 1.01) continue;
  const factor = total / tableSum;
  for (const d of inState) {
    (d as RegistryDistrict & { tablePopulation?: number; scaledToStateTotal?: number }).tablePopulation = d.population!;
    (d as RegistryDistrict & { scaledToStateTotal?: number }).scaledToStateTotal = +factor.toFixed(5);
    d.population = Math.round(d.population! * factor);
  }
  stateScaling.push({ code: s.code, name: s.name, tableSum, census2011: total, factor: +factor.toFixed(5) });
}
if (stateScaling.length) {
  console.log('  scaled to the state census total: ' + stateScaling.map((x) => x.name + ' x' + x.factor.toFixed(3)).join(', '));
}

if (problems.length) {
  console.error('\nPROBLEMS -- nothing was written:');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

// ----------------------------------------------------------------- 6. write

const modelled = ordered.filter((d) => d.modelled);
const vintages = modelled.reduce<Record<string, number>>((a, d) => {
  a[d.populationVintage!] = (a[d.populationVintage!] ?? 0) + 1;
  return a;
}, {});
const coordSources = ordered.reduce<Record<string, number>>((a, d) => {
  const k = d.coordinateSource ?? 'none';
  a[k] = (a[k] ?? 0) + 1;
  return a;
}, {});

const payload = {
  source: {
    districts: 'https://en.wikipedia.org/w/index.php?title=' + PAGE + '&oldid=' + revision,
    coordinates: 'Wikipedia article coordinates (prop=coordinates), else Wikidata P625, else the headquarters article',
    lgdDistrictCode: 'Wikidata P12746 (LGD District Code), where present',
    stateCode: 'Local Government Directory / Census state code, checked against Wikidata P12747',
    licence: 'Wikipedia text CC BY-SA 4.0; Wikidata CC0',
  },
  revision,
  retrievedAt: new Date().toISOString().slice(0, 10),
  note:
    'Every district in the source table. A district is modelled when the table gives it a population; ' +
    'one without is listed here and never given an invented figure. Populations are the 2011 Census ' +
    'apportioned to current boundaries except where populationVintage says otherwise. Re-run with: ' +
    'npx tsx scripts/fetch-districts.mts',
  counts: {
    districts: ordered.length,
    modelled: modelled.length,
    notModelled: ordered.length - modelled.length,
    states: STATE_TABLE.length,
    byPopulationVintage: vintages,
    byCoordinateSource: coordSources,
    withLgdCode: ordered.filter((d) => d.lgdDistrictCode).length,
  },
  stateTotalsSource: 'https://en.wikipedia.org/w/index.php?title=' + STATE_POP_PAGE + '&oldid=' + statePage.parse.revid,
  stateScaling,
  states: STATE_TABLE.map(({ code, name, abbr, wikidata }) => ({
    code,
    name,
    abbr,
    wikidata,
    census2011: censusTotal.get(code) ?? null,
    wikidata2011: statePopulation2011.get(wikidata) ?? null,
  })),
  districts: ordered,
};

writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n');
console.log('\nwrote src/data/india-districts.json');
console.log('  districts : ' + ordered.length + ' (' + modelled.length + ' modelled, ' + (ordered.length - modelled.length) + ' without a population figure)');
console.log('  vintage   : ' + JSON.stringify(vintages));
console.log('  coords    : ' + JSON.stringify(coordSources));
console.log('  LGD codes : ' + payload.counts.withLgdCode);
const notModelled = ordered.filter((d) => !d.modelled);
if (notModelled.length) console.log('  not modelled: ' + notModelled.map((d) => d.name + ' (' + d.stateCode + ')').join(', '));
