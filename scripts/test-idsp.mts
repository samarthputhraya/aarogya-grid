/**
 * The IDSP bulletin reader, against real bulletins.
 *
 * Run with:  npx tsx scripts/test-idsp.mts   (part of `npm test`)
 *
 * Offline. Three of Kerala's daily bulletins are committed as fixtures, chosen
 * for the variations the parser has to survive:
 *
 *   02.01.2026  a day-first title with a superscript ordinal ("2nd January"),
 *               a dotted table date, and rows with BLANK cells -- a blank is
 *               simply absent from the text layer, so only position says which
 *               column is empty;
 *   15.03.2026  a four-digit year in the table header;
 *   11.09.2026  the current layout, and a source typo (two rows numbered 9).
 *
 * Every expected number below was read off the rendered PDF by eye, not taken
 * from the parser's own output. And each fixture's parse must equal the day the
 * repository commits for it, so the committed series is what this parser
 * produces from the documents the manifest names.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { textItems } from '../src/lib/idsp/pdf';
import { parseBulletin, titleDate, syndromeCount, COLUMNS, DISTRICT_ABBREVIATIONS, type ParsedBulletin } from '../src/lib/idsp/bulletin';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks++;
  if (ok) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  -- ' + detail : ''));
  }
}

const ROOT = process.cwd();
const col = (name: (typeof COLUMNS)[number]) => COLUMNS.indexOf(name);
const committed = JSON.parse(readFileSync(resolve(ROOT, 'src/data/idsp-kerala.json'), 'utf8')) as {
  days: { date: string; values: Record<string, (number | null)[]>; total: (number | null)[] | null; checks: ParsedBulletin['checks'] }[];
  coverage: { bulletins: number; first: string; last: string };
};
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'data/idsp/manifest.json'), 'utf8')) as {
  entries: { date: string; status: string; url: string | null; bytes: number | null; sha256: string | null }[];
};

async function fixture(date: string): Promise<{ parsed: ParsedBulletin; bytes: Buffer }> {
  const [y, m, d] = date.split('-');
  const bytes = readFileSync(resolve(ROOT, 'scripts/fixtures/idsp/IDSP-Daily-Report-' + d + '.' + m + '.' + y + '.pdf'));
  return { parsed: parseBulletin(await textItems(new Uint8Array(bytes))), bytes };
}

function matchesCommitted(date: string, parsed: ParsedBulletin, bytes: Buffer): void {
  const day = committed.days.find((x) => x.date === date);
  check(date + ': the committed day is exactly this parse',
    JSON.stringify(day?.values) === JSON.stringify(Object.fromEntries(DISTRICT_ABBREVIATIONS.map((a) => [a, parsed.districts[a]]))));
  const entry = manifest.entries.find((e) => e.date === date);
  check(date + ': the manifest names this very document (bytes and SHA-256)',
    entry?.bytes === bytes.length && entry.sha256 === createHash('sha256').update(bytes).digest('hex'));
  check(date + ': from an official URL', /^https:\/\/dhs\.kerala\.gov\.in\/wp-content\/uploads\/\d{4}\/\d{2}\/IDSP-Daily-Report-/.test(entry?.url ?? ''));
}

console.log('\ntitles');
check('month first', titleDate('Communicable Diseases - Daily Report on September 11, 2026') === '2026-09-11');
check('day first, with an ordinal', titleDate('Communicable Diseases - Daily Report on 2 nd January, 2026') === '2026-01-02');
check('not a report', titleDate('Treatment guidelines for leptospirosis') === null);

console.log('\n11 September 2026: the current layout');
{
  const { parsed, bytes } = await fixture('2026-09-11');
  check('the date is read from the title', parsed.date === '2026-09-11');
  check('all fourteen districts are read, including the second "9"', DISTRICT_ABBREVIATIONS.every((a) => parsed.districts[a].length === 29));
  check('Thiruvananthapuram fever outpatients: 735', parsed.districts.TVM[col('feverOutpatients')] === 735);
  check('Malappuram fever outpatients: 1,962', parsed.districts.MPM[col('feverOutpatients')] === 1962);
  check('Thiruvananthapuram dengue: 19 suspected, 15 confirmed',
    parsed.districts.TVM[col('dengueSuspected')] === 19 && parsed.districts.TVM[col('dengueConfirmed')] === 15);
  check('Ernakulam influenza: 24', parsed.districts.EKM[col('influenza')] === 24);
  check('the state total: 10,387 fever outpatients, 1,481 diarrhoeal disease',
    parsed.total?.[col('feverOutpatients')] === 10387 && parsed.total?.[col('acuteDiarrhoealDisease')] === 1481);
  check('every column adds up to the printed total', parsed.checks.columnsFailingTotal.length === 0);
  check('and the table date agrees with the title', parsed.checks.headerDateAgrees);
  check('dengue for Thiruvananthapuram counts suspected and confirmed', syndromeCount(parsed.districts.TVM, 'dengue') === 34);
  check('malaria sums all six species columns', syndromeCount(parsed.total!, 'malaria') === 3);
  matchesCommitted('2026-09-11', parsed, bytes);
}

console.log('\n2 January 2026: blank cells and a day-first title');
{
  const { parsed, bytes } = await fixture('2026-01-02');
  check('the date is read from a day-first title', parsed.date === '2026-01-02');
  check('rows with blank cells are placed by position, not by count', parsed.checks.completeRows < 14);
  check('every column still adds up to the printed total', parsed.checks.columnsFailingTotal.length === 0);
  check('so the blanks are zeros, and are counted as reconciled', parsed.checks.blankCellsReconciled > 0);
  check('Kasaragod influenza, a blank cell, reads 0', parsed.districts.KSD[col('influenza')] === 0);
  check('the state total: 6,996 fever outpatients', parsed.total?.[col('feverOutpatients')] === 6996);
  check('a dotted table date agrees with the title', parsed.checks.headerDateAgrees);
  matchesCommitted('2026-01-02', parsed, bytes);
}

console.log('\n15 March 2026: a four-digit year in the table');
{
  const { parsed, bytes } = await fixture('2026-03-15');
  check('the table date agrees with the title', parsed.checks.headerDateAgrees);
  check('the state total: 2,745 fever outpatients (a Sunday)', parsed.total?.[col('feverOutpatients')] === 2745);
  check('every column adds up', parsed.checks.columnsFailingTotal.length === 0);
  matchesCommitted('2026-03-15', parsed, bytes);
}

console.log('\nthe committed series');
{
  const ok = manifest.entries.filter((e) => e.status === 'ok');
  check('every committed day has a manifest entry with a SHA-256', committed.days.every((d) => ok.some((e) => e.date === d.date && /^[0-9a-f]{64}$/.test(e.sha256 ?? ''))));
  check('and the coverage block counts them', committed.coverage.bulletins === committed.days.length);
  const failing = committed.days.filter((d) => d.checks.columnsFailingTotal.length > 0).length;
  check('no committed day has a column failing its own total', failing === 0, failing + ' day(s)');
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + '  ' + (checks - failures) + '/' + checks + ' checks');
process.exit(failures === 0 ? 0 : 1);
