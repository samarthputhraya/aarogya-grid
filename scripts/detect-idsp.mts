/**
 * The same detector, pointed at observed disease counts.
 *
 * Run:  npx tsx scripts/detect-idsp.mts        (after `npm run idsp:fetch`)
 * Writes: src/data/idsp-anomalies.json, docs/idsp-detection.json
 *
 * Every district × syndrome series read out of Kerala's IDSP bulletins goes
 * through `AI.DETECT_ANOMALIES` exactly as the simulated consumption series do:
 * the same inline subquery, the same 0.95 threshold, the last 28 days scored
 * against everything before them, in asia-south1, with no table scanned.
 *
 * THE DAYS A BULLETIN IS MISSING
 * ------------------------------
 * The detector needs one value per day, and some days have no bulletin. A
 * missing day is filled with the mean of the nearest reported days either side
 * -- so the series stays a series -- and is recorded as imputed. An imputed day
 * can shape the model's sense of normal but can never itself be a warning day:
 * `export-indicators.mts` drops flagged points that fall on one. A warning
 * resting on a number nobody published would not be an observed signal.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runQuery, bigQueryEnabled } from '../src/lib/bq/client';
import {
  buildAnomalySql,
  chunkAnomalySeries,
  compactIds,
  decodeAnomalyRows,
  splitDirection,
  DEFAULT_ANOMALY_THRESHOLD,
  type AnomalyRow,
} from '../src/lib/bq/anomalies';
import type { DemandSeries } from '../src/lib/bq/series';
import { SYNDROMES, syndromeCount, type Syndrome } from '../src/lib/idsp/bulletin';

const ROOT = process.cwd();
const TARGET_DAYS = 28;

interface IdspFile {
  districts: { abbr: string; code: string; name: string; population: number }[];
  coverage: { first: string; last: string };
  days: { date: string; values: Record<string, (number | null)[]> }[];
}

const idsp = JSON.parse(readFileSync(resolve(ROOT, 'src/data/idsp-kerala.json'), 'utf8')) as IdspFile;
if (!bigQueryEnabled()) {
  console.error('AAROGYA_NO_BQ=1: the detector runs in BigQuery. Unset it to run.');
  process.exit(1);
}

const addDays = (s: string, n: number) => {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const calendar: string[] = [];
for (let d = idsp.coverage.first; d <= idsp.coverage.last; d = addDays(d, 1)) calendar.push(d);
const byDate = new Map(idsp.days.map((d) => [d.date, d]));

const series: DemandSeries[] = [];
const imputed: Record<string, string[]> = {};

for (const district of idsp.districts) {
  for (const syndrome of Object.keys(SYNDROMES) as Syndrome[]) {
    const raw = calendar.map((date) => {
      const row = byDate.get(date)?.values[district.abbr];
      return row ? syndromeCount(row, syndrome) : null;
    });
    const sid = district.code + '|idsp:' + syndrome;
    const filled: number[] = [];
    const gaps: string[] = [];
    raw.forEach((v, i) => {
      if (v !== null) {
        filled.push(v);
        return;
      }
      let before: number | null = null;
      let after: number | null = null;
      for (let j = i - 1; j >= 0 && before === null; j--) before = raw[j];
      for (let j = i + 1; j < raw.length && after === null; j++) after = raw[j];
      const neighbours = [before, after].filter((x): x is number => x !== null);
      filled.push(neighbours.length ? Math.round(neighbours.reduce((a, b) => a + b, 0) / neighbours.length) : 0);
      gaps.push(calendar[i]);
    });
    // A series that never records a single case has nothing to be anomalous
    // against, and sending it would only cost characters in the statement.
    if (filled.every((v) => v === 0)) continue;
    series.push({ sid, values: filled });
    if (gaps.length) imputed[sid] = gaps;
  }
}

console.log('IDSP detection: ' + series.length + ' district x syndrome series, ' + calendar[0] + ' to ' + calendar.at(-1));
const { wire, toOriginal } = compactIds(series);
const opts = { startDate: calendar[0], targetLastNPoints: TARGET_DAYS, threshold: DEFAULT_ANOMALY_THRESHOLD };
const batches = chunkAnomalySeries(wire, { ...opts, maxSeries: 1200 });
const started = Date.now();
const results = await Promise.all(
  batches.map((batch) => runQuery<AnomalyRow>(buildAnomalySql(batch, opts), { jobLabel: 'anomalies_idsp', useQueryCache: false })),
);
const rows = results.flatMap((r) => r.rows);
const decoded = decodeAnomalyRows(rows);

const findings: { sid: string; points: { d: string; v: number; lo: number; hi: number; p: number; dir: 'high' | 'low' }[]; status: string }[] = [];
let declined = 0;
for (const [wireSid, a] of decoded) {
  const sid = toOriginal.get(wireSid) ?? wireSid;
  if (a.status) declined++;
  const { high, low } = splitDirection(a);
  if (high.length === 0 && low.length === 0) continue;
  const points = [...high.map((i) => ({ i, dir: 'high' as const })), ...low.map((i) => ({ i, dir: 'low' as const }))]
    .map(({ i, dir }) => ({ d: a.dates[i], v: Math.round(a.values[i]), lo: +a.lower[i].toFixed(1), hi: +a.upper[i].toFixed(1), p: +a.probability[i].toFixed(4), dir }))
    .sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
  findings.push({ sid, points, status: a.status });
}

const stats = {
  at: new Date().toISOString(),
  window: { start: calendar[0], end: calendar.at(-1), days: calendar.length },
  scoredDays: TARGET_DAYS,
  threshold: DEFAULT_ANOMALY_THRESHOLD,
  series: series.length,
  statements: batches.length,
  elapsedMs: Date.now() - started,
  bytesProcessed: results.reduce((a, r) => a + r.stats.totalBytesProcessed, 0),
  flaggedSeries: findings.length,
  flaggedPointsHigh: findings.reduce((a, f) => a + f.points.filter((p) => p.dir === 'high').length, 0),
  declined,
  imputedDays: Object.values(imputed).reduce((a, g) => Math.max(a, g.length), 0),
};

const out = resolve(ROOT, 'src/data/idsp-anomalies.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({
    asOf: calendar.at(-1),
    startDate: calendar[0],
    scoredDays: TARGET_DAYS,
    threshold: DEFAULT_ANOMALY_THRESHOLD,
    model: 'BigQuery AI.DETECT_ANOMALIES',
    imputed,
    findings,
  }) + '\n',
);
writeFileSync(resolve(ROOT, 'docs/idsp-detection.json'), JSON.stringify(stats, null, 2) + '\n');
console.log(
  '  ' + stats.statements + ' statement(s), ' + (stats.elapsedMs / 1000).toFixed(1) + ' s, ' + stats.bytesProcessed +
    ' bytes; ' + stats.flaggedSeries + ' series flagged (' + stats.flaggedPointsHigh + ' high points), ' + declined + ' declined',
);
