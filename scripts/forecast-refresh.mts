/**
 * Refreshes the committed TimesFM forecast cache.
 *
 * Run with:  npm run forecast:refresh
 * Reads:     src/data/demand-district-daily.json
 * Writes:    src/data/forecast-cache.json
 *
 * THIS IS THE ONLY PLACE THE PROJECT TALKS TO BIGQUERY.
 *
 * The snapshot build, the site, and every request path read the committed cache
 * and never call an API. That is deliberate and it is the difference between a
 * demo and something a district officer could rely on: a judge cloning this repo
 * with no Google Cloud account still gets the real TimesFM numbers, the build
 * cannot fail because a quota moved, and the forecast behind any published
 * figure is pinned in git rather than regenerated on every deploy.
 *
 * BATCHING: THREE QUERIES, CONCURRENTLY, AND BOTH HALVES OF THAT MATTER
 * ---------------------------------------------------------------------
 * The WS1 acceptance test is a full refresh in <=3 queries and <=180 s.
 *
 *   - Three, not four. 6,016 series at the ladder's round 2,000 is four batches
 *     and fails the gate by one. The batch size is therefore derived --
 *     ceil(seriesCount / MAX_QUERIES) -- which gives 2,006 series and a 595 KB
 *     statement, comfortably inside the 1,024 K limit. Measured, not assumed.
 *   - Concurrently, not in sequence. The runtime ladder measured a 2,000-series
 *     forecast at 74.3-98.2 s across two runs, so three of them back to back is
 *     224-295 s -- over budget at BOTH ends of the band. Run together they
 *     overlap into roughly one batch's wall clock. A sequential refresh was only
 *     ever going to pass on a good day.
 *
 * NO TIMESTAMP IN THE OUTPUT. The cache records what was forecast, not when, so
 * a re-run that produces the same numbers produces the same bytes and a diff
 * means the forecast moved. Timings go to stdout, where they belong.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildForecastSql,
  chunkSeries,
  compactIds,
  restoreIds,
  decodeForecastRows,
  DEFAULT_MODEL,
  type DemandSeries,
  type ForecastRow,
} from '../src/lib/bq/series';
import { runQuery, bigQueryEnabled } from '../src/lib/bq/client';
import { FORECAST_HORIZON_DAYS, FORECAST_CONTEXT_DAYS, CONFIDENCE_LEVEL } from '../src/lib/forecast/timesfm';

const DEMAND = resolve(import.meta.dirname, '../src/data/demand-district-daily.json');
const OUT = resolve(import.meta.dirname, '../src/data/forecast-cache.json');

/** The WS1 gate: a full refresh must fit in this many statements. */
const MAX_QUERIES = 3;

/**
 * Decimal places kept per value.
 *
 * Two. District daily demand runs to the hundreds, so the second decimal is
 * already far below anything the Monte Carlo can resolve -- but rounding is what
 * keeps the committed file stable and roughly a third smaller than the raw
 * doubles BigQuery returns.
 */
const DP = 2;

interface DemandArtefact {
  asOf: string;
  startDate: string;
  lastDate: string;
  days: number;
  series: { sid: string; values: number[] }[];
}

const artefact: DemandArtefact = JSON.parse(readFileSync(DEMAND, 'utf8'));

if (!bigQueryEnabled()) {
  console.error('AAROGYA_NO_BQ=1 is set. This script exists to call BigQuery; unset it.');
  process.exit(1);
}

const from = artefact.days - FORECAST_CONTEXT_DAYS;
if (from < 0) {
  console.error(
    'Demand artefact holds ' + artefact.days + ' days, need ' + FORECAST_CONTEXT_DAYS + '.',
  );
  process.exit(1);
}

const contextStart = new Date(artefact.startDate + 'T00:00:00Z');
contextStart.setUTCDate(contextStart.getUTCDate() + from);
const contextStartIso = contextStart.toISOString().slice(0, 10);

const series: DemandSeries[] = artefact.series.map((s) => ({
  sid: s.sid,
  values: s.values.slice(from),
}));

const sqlOpts = {
  startDate: contextStartIso,
  horizon: FORECAST_HORIZON_DAYS,
  confidenceLevel: CONFIDENCE_LEVEL,
  model: DEFAULT_MODEL,
};

const { wire, toOriginal } = compactIds(series);
const perBatch = Math.ceil(wire.length / MAX_QUERIES);
const batches = chunkSeries(wire, { ...sqlOpts, maxSeries: perBatch });
const statements = batches.map((b) => buildForecastSql(b, sqlOpts));

console.log('Refreshing the TimesFM forecast cache');
console.log('  model      :', DEFAULT_MODEL);
console.log('  series     :', series.length.toLocaleString('en-IN'), 'district x drug');
console.log('  context    :', FORECAST_CONTEXT_DAYS + ' days from ' + contextStartIso);
console.log('  horizon    :', FORECAST_HORIZON_DAYS + ' days from ' + artefact.asOf);
console.log(
  '  batches    :',
  statements.length + ' x <= ' + perBatch + ' series, largest ' +
    Math.round(Math.max(...statements.map((s) => s.length)) / 1024) + ' KB, run concurrently',
);
console.log();

if (statements.length > MAX_QUERIES) {
  console.error(
    'Refusing to run: ' + statements.length + ' statements exceeds the ' + MAX_QUERIES +
      '-query budget. The character budget, not the series cap, split these.',
  );
  process.exit(1);
}

const t0 = Date.now();
const settled = await Promise.all(
  statements.map(async (sql, i) => {
    const res = await runQuery<ForecastRow>(sql, { jobLabel: 'forecast-refresh' });
    console.log(
      '  batch ' + (i + 1) + '/' + statements.length + ' returned ' +
        res.rows.length.toLocaleString('en-IN') + ' rows in ' +
        (res.stats.elapsedMs / 1000).toFixed(1) + 's',
    );
    return res;
  }),
);
const wallClockMs = Date.now() - t0;

const rows = settled.flatMap((r) => restoreIds(r.rows, toOriginal));
const decoded = decodeForecastRows(rows);

const round = (v: number) => +v.toFixed(DP);

const forecasts: Record<string, { m: number[]; lo: number[]; hi: number[] }> = {};
const declined: string[] = [];
let short = 0;

// Sorted, so the committed file is stable whatever order the batches returned in.
for (const sid of [...decoded.keys()].sort()) {
  const f = decoded.get(sid)!;
  if (f.status) declined.push(sid);
  if (f.mean.length !== FORECAST_HORIZON_DAYS) {
    short++;
    continue;
  }
  forecasts[sid] = {
    m: f.mean.map(round),
    lo: f.lower.map(round),
    hi: f.upper.map(round),
  };
}

const missing = series.filter((s) => !(s.sid in forecasts)).map((s) => s.sid);

const cache = {
  model: DEFAULT_MODEL,
  horizon: FORECAST_HORIZON_DAYS,
  contextDays: FORECAST_CONTEXT_DAYS,
  confidenceLevel: CONFIDENCE_LEVEL,
  contextStart: contextStartIso,
  contextEnd: artefact.lastDate,
  /** First forecast day. Must equal the snapshot's as-of date. */
  forecastStart: artefact.asOf,
  seriesRequested: series.length,
  seriesForecast: Object.keys(forecasts).length,
  /** Series TimesFM returned but flagged via `ai_forecast_status`. */
  seriesDeclined: declined,
  /** Series that came back with no usable horizon. These fall back to Croston. */
  seriesMissing: missing,
  forecasts,
};

writeFileSync(OUT, JSON.stringify(cache) + '\n');

const sizeKb = Math.round(JSON.stringify(cache).length / 1024);
const coverage = cache.seriesForecast / cache.seriesRequested;
const slotMs = settled.reduce((a, r) => a + r.stats.totalSlotMs, 0);
const bytes = settled.reduce((a, r) => a + r.stats.totalBytesProcessed, 0);

console.log();
console.log('='.repeat(66));
console.log('Written to src/data/forecast-cache.json  (' + sizeKb.toLocaleString('en-IN') + ' KB)');
console.log('  queries           :', statements.length, 'of a', MAX_QUERIES, 'budget');
console.log('  wall clock        :', (wallClockMs / 1000).toFixed(1) + 's of a 180s budget');
console.log('  slot time         :', (slotMs / 1000).toFixed(1) + 's');
console.log('  bytes processed   :', bytes);
console.log(
  '  coverage          :',
  cache.seriesForecast.toLocaleString('en-IN') + '/' + cache.seriesRequested.toLocaleString('en-IN'),
  '(' + (coverage * 100).toFixed(2) + '%)',
);
console.log('  declined by model :', declined.length, declined.length ? '-- ' + declined.slice(0, 3).join(', ') : '');
console.log('  short horizons    :', short);
console.log('  missing entirely  :', missing.length);

// The three WS1 acceptance numbers, checked here rather than by eye.
const gates = [
  ['<= ' + MAX_QUERIES + ' queries', statements.length <= MAX_QUERIES, statements.length + ' queries'],
  ['<= 180 s wall clock', wallClockMs <= 180_000, (wallClockMs / 1000).toFixed(1) + 's'],
  ['>= 95% coverage', coverage >= 0.95, (coverage * 100).toFixed(2) + '%'],
] as const;

console.log();
for (const [name, pass, detail] of gates) {
  console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + name + '  (' + detail + ')');
}
process.exitCode = gates.every(([, pass]) => pass) ? 0 : 1;
