/**
 * Kerala's IDSP daily bulletins: fetch, verify, parse.
 *
 * Run:  npm run idsp:fetch                 new bulletins since the last run
 *       npm run idsp:fetch -- --from 2026-01-01 --to 2026-09-11
 *       npm run idsp:verify               re-download EVERY bulletin in the manifest
 *                                          and check it byte for byte, then re-parse it
 *                                          and check it against the committed numbers
 *
 * Writes:
 *   data/idsp/manifest.json      one entry per day: URL, bytes, SHA-256, parse outcome
 *   src/data/idsp-kerala.json    the district-wise table for every day, as numbers
 *
 * WHAT IS COMMITTED, AND WHY NOT THE PDFS
 * --------------------------------------
 * The bulletins are the Kerala government's documents, and a year of them is a
 * hundred megabytes that every clone would carry. So the repository holds the
 * numbers read from them and, for each one, where it came from and its SHA-256
 * -- enough for anyone to fetch the same document and prove it is the same one
 * (`--verify` does exactly that). Three bulletins are committed as parser
 * fixtures under scripts/fixtures/idsp/, chosen for the format variations the
 * parser has to handle.
 *
 * BE A GOOD CITIZEN OF A GOVERNMENT WEBSITE
 * -----------------------------------------
 * One request at a time, a pause between them, an identifying User-Agent, and a
 * local cache so a re-run downloads nothing it already has.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { textItems } from '../src/lib/idsp/pdf';
import { parseBulletin, COLUMNS, DISTRICT_ABBREVIATIONS, BulletinFormatError, type ParsedBulletin } from '../src/lib/idsp/bulletin';
import { DISTRICTS, districtPopulation } from '../src/lib/domain/geo';

const ROOT = process.cwd();
const MANIFEST = resolve(ROOT, 'data/idsp/manifest.json');
const OUT = resolve(ROOT, 'src/data/idsp-kerala.json');
const CACHE = resolve(ROOT, '.cache/idsp');
const BASE = 'https://dhs.kerala.gov.in/wp-content/uploads/';
const USER_AGENT = 'aarogya-grid/1.0 (+https://github.com/samarthputhraya/aarogya-grid; IDSP bulletin reader)';
/** The first day read. The format has been stable since at least then. */
const DEFAULT_FROM = '2026-01-01';
/** A day that was missing is looked for again for this long: bulletins appear two or three days late. */
const RETRY_MISSING_DAYS = 10;

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const verify = argv.includes('--verify');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The abbreviations the format prints, against this project's district codes. */
const ABBR_NAME: Record<(typeof DISTRICT_ABBREVIATIONS)[number], string> = {
  TVM: 'Thiruvananthapuram', KLM: 'Kollam', PTA: 'Pathanamthitta', IDK: 'Idukki', KTM: 'Kottayam',
  ALP: 'Alappuzha', EKM: 'Ernakulam', TSR: 'Thrissur', PKD: 'Palakkad', MPM: 'Malappuram',
  KKD: 'Kozhikode', WYD: 'Wayanad', KNR: 'Kannur', KSD: 'Kasaragod',
};

interface ManifestEntry {
  date: string;
  status: 'ok' | 'missing' | 'unparseable';
  url: string | null;
  bytes: number | null;
  sha256: string | null;
  fetchedAt: string;
  error?: string;
}

interface Manifest {
  source: string;
  publisher: string;
  entries: ManifestEntry[];
}

interface StoredDay {
  date: string;
  values: Record<string, (number | null)[]>;
  total: (number | null)[] | null;
  checks: ParsedBulletin['checks'];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** The upload folders a bulletin for this day can be in: its month, then the next, then the one before. */
function candidates(date: string): string[] {
  const [y, m, d] = date.split('-');
  const name = 'IDSP-Daily-Report-' + d + '.' + m + '.' + y + '.pdf';
  const month = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return [0, 1, -1].map((shift) => {
    const t = new Date(month);
    t.setUTCMonth(t.getUTCMonth() + shift);
    return BASE + t.getUTCFullYear() + '/' + String(t.getUTCMonth() + 1).padStart(2, '0') + '/' + name;
  });
}

async function download(url: string): Promise<Uint8Array | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('pdf')) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(2_000 * (attempt + 1));
    }
  }
  return null;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function fetchDay(date: string, known?: ManifestEntry): Promise<{ entry: ManifestEntry; bytes: Uint8Array | null }> {
  const cachePath = resolve(CACHE, date + '.pdf');
  if (!verify && existsSync(cachePath) && known?.sha256) {
    const cached = new Uint8Array(readFileSync(cachePath));
    if (sha256(cached) === known.sha256) return { entry: known, bytes: cached };
  }
  const urls = known?.url ? [known.url] : candidates(date);
  for (const url of urls) {
    const bytes = await download(url);
    await sleep(400);
    if (!bytes) continue;
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cachePath, bytes);
    return {
      entry: { date, status: 'ok', url, bytes: bytes.length, sha256: sha256(bytes), fetchedAt: new Date().toISOString() },
      bytes,
    };
  }
  return { entry: { date, status: 'missing', url: null, bytes: null, sha256: null, fetchedAt: new Date().toISOString() }, bytes: null };
}

// ---------------------------------------------------------------------- run

const manifest: Manifest = existsSync(MANIFEST)
  ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
  : {
      source: 'Communicable Diseases - Daily Report (IDSP district-wise daily reporting format), Kerala',
      publisher: 'State Surveillance Unit, Directorate of Health Services, Government of Kerala',
      entries: [],
    };
const stored: { days: StoredDay[] } = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { days: [] };
const byDate = new Map(manifest.entries.map((e) => [e.date, e]));
const dayByDate = new Map(stored.days.map((d) => [d.date, d]));

const today = iso(new Date());
const from = opt('from') ?? DEFAULT_FROM;
const to = opt('to') ?? addDays(today, -1);

let fetched = 0;
let verified = 0;
const problems: string[] = [];

console.log((verify ? 'Verifying' : 'Fetching') + ' Kerala IDSP bulletins, ' + from + ' to ' + to);

for (let date = from; date <= to; date = addDays(date, 1)) {
  const known = byDate.get(date);
  const recent = date >= addDays(today, -RETRY_MISSING_DAYS);
  if (!verify && known?.status === 'ok' && dayByDate.has(date)) continue;
  if (!verify && known?.status === 'missing' && !recent) continue;
  if (verify && known?.status !== 'ok') continue;

  const { entry, bytes } = await fetchDay(date, verify ? known : known?.status === 'ok' ? known : undefined);

  if (verify && known) {
    if (!bytes) {
      problems.push(date + ': no longer downloadable from ' + known.url);
      continue;
    }
    if (entry.sha256 !== known.sha256 || entry.bytes !== known.bytes) {
      problems.push(date + ': the document at ' + known.url + ' has CHANGED (sha256 ' + entry.sha256 + ', recorded ' + known.sha256 + ')');
      continue;
    }
  }

  if (!bytes) {
    byDate.set(date, entry);
    continue;
  }
  try {
    const parsed = parseBulletin(await textItems(bytes));
    if (parsed.date !== date) throw new BulletinFormatError('the bulletin reports on ' + parsed.date + ', not ' + date);
    const day: StoredDay = {
      date,
      values: Object.fromEntries(DISTRICT_ABBREVIATIONS.map((a) => [a, parsed.districts[a]])),
      total: parsed.total,
      checks: parsed.checks,
    };
    if (verify) {
      const before = dayByDate.get(date);
      if (JSON.stringify(before) !== JSON.stringify(day)) problems.push(date + ': re-parsing gives different numbers from the committed ones');
      else verified++;
    } else {
      dayByDate.set(date, day);
      byDate.set(date, entry);
      fetched++;
      if (parsed.checks.columnsFailingTotal.length > 0) {
        console.log('  ' + date + ': ' + parsed.checks.columnsFailingTotal.length + ' column(s) do not add up to the printed total');
      }
    }
  } catch (e) {
    const message = (e as Error).message;
    byDate.set(date, { ...entry, status: 'unparseable', error: message });
    problems.push(date + ': ' + message);
  }
  if ((fetched + verified) % 20 === 0 && fetched + verified > 0) console.log('  ... ' + date);
}

if (verify) {
  console.log('\n' + verified + ' bulletins re-downloaded, byte-identical, and re-parsed to the committed numbers');
  for (const p of problems) console.log('  PROBLEM ' + p);
  process.exit(problems.length === 0 ? 0 : 1);
}

const entries = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
const days = [...dayByDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
const districts = DISTRICT_ABBREVIATIONS.map((abbr) => {
  const d = DISTRICTS.find((x) => x.stateCode === '32' && x.name === ABBR_NAME[abbr]);
  if (!d) throw new Error('no registry district for ' + abbr);
  return { abbr, code: d.code, name: d.name, population: districtPopulation(d.code) };
});

mkdirSync(dirname(MANIFEST), { recursive: true });
writeFileSync(MANIFEST, JSON.stringify({ ...manifest, entries }, null, 2) + '\n');
writeFileSync(
  OUT,
  JSON.stringify(
    {
      source: {
        title: manifest.source,
        publisher: manifest.publisher,
        manifest: 'data/idsp/manifest.json',
        note:
          'Numbers read from the text layer of each bulletin by src/lib/idsp/bulletin.ts, checked against the ' +
          "bulletin's own TOTAL row. Blank cells are zero only where their column adds up to the printed total.",
      },
      columns: COLUMNS,
      districts,
      coverage: {
        first: days[0]?.date ?? null,
        last: days.at(-1)?.date ?? null,
        bulletins: days.length,
        missingDays: entries.filter((e) => e.status === 'missing' && e.date >= (days[0]?.date ?? '')).map((e) => e.date),
        unparseable: entries.filter((e) => e.status === 'unparseable').map((e) => e.date),
        daysWithColumnsFailingTotal: days.filter((d) => d.checks.columnsFailingTotal.length > 0).length,
      },
      days: days.map((d) => ({ ...d, values: d.values })),
    },
  ) + '\n',
);
console.log('\n' + fetched + ' new bulletin(s); ' + days.length + ' days on file, ' + days[0]?.date + ' to ' + days.at(-1)?.date);
for (const p of problems) console.log('  PROBLEM ' + p);
