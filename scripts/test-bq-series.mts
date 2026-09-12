/**
 * Offline tests for the BigQuery series encoder and the client's guards.
 *
 * Run with:  npx tsx scripts/test-bq-series.mts   (part of `npm test`)
 *
 * DELIBERATELY OFFLINE. `npm test` runs in CI and on a laptop with no ADC, so
 * nothing here touches the network. What it pins down is the half that has to be
 * right BEFORE a request is sent: that a batch cannot silently exceed BigQuery's
 * character limit, that the chunker's arithmetic matches what the builder
 * actually emits, and that a series id can never break out of its SQL literal.
 *
 * The live half -- that `AI.FORECAST` accepts this SQL and returns a horizon per
 * series -- is measured by `scripts/forecast-ladder.mts` against the real API,
 * and its numbers are committed in `docs/forecast-runtime.json`.
 */
import {
  buildAnomalySql,
  chunkAnomalySeries,
  decodeAnomalyRows,
  splitDirection,
} from '../src/lib/bq/anomalies';
import {
  buildForecastSql,
  chunkSeries,
  compactIds,
  restoreIds,
  decodeForecastRows,
  estimateSeriesChars,
  sqlOverheadChars,
  DEFAULT_MAX_SERIES_PER_QUERY,
  type DemandSeries,
  type ForecastRow,
} from '../src/lib/bq/series';
import {
  sqlLength,
  bigQueryEnabled,
  QueryTooLongError,
  BigQueryDisabledError,
  runQuery,
  MAX_QUERY_CHARS,
} from '../src/lib/bq/client';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  -- ' + detail : ''));
  }
}

async function expectThrow(name: string, fn: () => unknown, match: RegExp | (new (...a: never[]) => Error)): Promise<void> {
  checks++;
  try {
    await fn();
    failures++;
    console.log('  FAIL ' + name + '  -- expected a throw, got none');
  } catch (e) {
    const ok = typeof match === 'function' && 'prototype' in match && match.prototype instanceof Error
      ? e instanceof (match as new (...a: never[]) => Error)
      : (match as RegExp).test((e as Error).message);
    if (ok) console.log('  ok   ' + name);
    else {
      failures++;
      console.log('  FAIL ' + name + '  -- wrong error: ' + (e as Error).message);
    }
  }
}

const OPTS = { startDate: '2026-07-03', horizon: 14, confidenceLevel: 0.9 };

function makeSeries(n: number, days = 90, base = 7): DemandSeries[] {
  return Array.from({ length: n }, (_, i) => ({
    sid: 'DST-29-DISTR' + String(i).padStart(3, '0') + '|PARA-500-TAB',
    values: Array.from({ length: days }, (_, d) => (d % 5 === 0 ? 0 : base + ((i + d) % 13))),
  }));
}

console.log('\nencoder');
{
  const sql = buildForecastSql(makeSeries(3), OPTS);
  // The STRUCT type is written once, on the first element only -- that is what
  // saves ~40 characters per series, so a regression here is a silent 30% cost.
  const typeCount = sql.split('STRUCT<sid STRING, vals ARRAY<INT64>>').length - 1;
  check('STRUCT type appears exactly once', typeCount === 1, 'found ' + typeCount);
  check('every series is present', ['000', '001', '002'].every((s) => sql.includes(s)));
  check('horizon is passed through', sql.includes('horizon => 14'));
  check('confidence is passed through', sql.includes('confidence_level => 0.9'));
  check('start date is passed through', sql.includes("DATE '2026-07-03'"));
  check('values cast to FLOAT64 after UNNEST', sql.includes('CAST(v AS FLOAT64)'));
  check('id column is declared', sql.includes("id_cols => ['sid']"));
}
{
  // Integers only: a fractional value from the unconstraining ratio must not
  // reach the wire as `3.0000000000000004` and cost 18 characters per day.
  const sql = buildForecastSql([{ sid: 'a', values: [1.4, 2.6, 0, -3] }], OPTS);
  check('values are rounded to integers', /\[1,3,0,0\]/.test(sql), sql.slice(sql.indexOf('[1')));
}
await expectThrow(
  'ragged batch is rejected',
  () => buildForecastSql([{ sid: 'a', values: [1, 2, 3] }, { sid: 'b', values: [1, 2] }], OPTS),
  /must share one calendar/,
);
await expectThrow('empty batch is rejected', () => buildForecastSql([], OPTS), /empty batch/);
{
  const sql = buildForecastSql([{ sid: "O'Brien\\x", values: [1] }], OPTS);
  check('single quote in an id is escaped', sql.includes("'O\\'Brien\\\\x'"), sql.slice(0, 400));
}

console.log('\nchunker');
{
  const series = makeSeries(4500);
  const batches = chunkSeries(series, OPTS);
  const total = batches.reduce((a, b) => a + b.length, 0);
  check('every series lands in exactly one batch', total === series.length, total + ' vs ' + series.length);
  check('order is preserved', batches[0][0].sid === series[0].sid);
  check(
    'no batch exceeds the series cap',
    batches.every((b) => b.length <= DEFAULT_MAX_SERIES_PER_QUERY),
    batches.map((b) => b.length).join(','),
  );
  // The real contract: what the builder EMITS must fit, not what the chunker
  // estimated. These two drifting apart is the failure this test exists for.
  const oversize = batches.filter((b) => sqlLength(buildForecastSql(b, OPTS)) > MAX_QUERY_CHARS);
  check('every emitted statement is under the hard limit', oversize.length === 0, oversize.length + ' over');
}
{
  const series = makeSeries(100);
  const batches = chunkSeries(series, { ...OPTS, maxSeries: 30 });
  check('maxSeries is honoured', batches.length === 4 && batches[0].length === 30, batches.map((b) => b.length).join(','));
}
{
  // Tighten the character budget until it, rather than maxSeries, is what binds.
  const series = makeSeries(200);
  const perSeries = estimateSeriesChars(series[0]);
  const budget = sqlOverheadChars(OPTS) + perSeries * 10 + 40;
  const batches = chunkSeries(series, { ...OPTS, maxChars: budget });
  check('character budget binds before the series cap', batches.length > 1 && batches[0].length <= 11, batches[0].length + ' in first batch');
  check(
    'character-bound batches still emit valid-length SQL',
    batches.every((b) => sqlLength(buildForecastSql(b, OPTS)) <= budget + 64),
  );
}
await expectThrow(
  'a single oversized series is rejected, not silently split',
  () => chunkSeries(makeSeries(1, 90, 7), { ...OPTS, maxChars: 200 }),
  /alone needs/,
);

console.log('\ncompact ids');
{
  const series = makeSeries(50);
  const { wire, toOriginal } = compactIds(series);
  const natural = series.reduce((a, s) => a + estimateSeriesChars(s), 0);
  const short = wire.reduce((a, s) => a + estimateSeriesChars(s), 0);
  check('compact ids are shorter', short < natural, short + ' vs ' + natural);
  const rows: ForecastRow[] = wire.map((s) => ({
    sid: s.sid, forecast_timestamp: '2026-09-30T00:00:00.000Z',
    forecast_value: 1, lo: 0, hi: 2, ai_forecast_status: '',
  }));
  const restored = restoreIds(rows, toOriginal);
  check('ids round-trip exactly', restored.every((r, i) => r.sid === series[i].sid));
}

console.log('\ndecoder');
{
  const rows: ForecastRow[] = [
    { sid: 'b', forecast_timestamp: '2026-10-02T00:00:00.000Z', forecast_value: 5, lo: -1, hi: 9, ai_forecast_status: '' },
    { sid: 'a', forecast_timestamp: '2026-10-02T00:00:00.000Z', forecast_value: 3, lo: 1, hi: 7, ai_forecast_status: '' },
    { sid: 'a', forecast_timestamp: '2026-10-01T00:00:00.000Z', forecast_value: -2, lo: -5, hi: 4, ai_forecast_status: '' },
    { sid: 'c', forecast_timestamp: '2026-10-01T00:00:00.000Z', forecast_value: 0, lo: 0, hi: 0, ai_forecast_status: 'TOO_FEW_POINTS' },
  ];
  const out = decodeForecastRows(rows);
  check('one entry per series', out.size === 3, String(out.size));
  check('days are sorted ascending', out.get('a')!.dates.join(',') === '2026-10-01,2026-10-02');
  // TimesFM can return a small negative mean on a mostly-zero series. Negative
  // demand is not a thing, and a clamp here saves every consumer remembering it.
  check('negative means are clamped to zero', out.get('a')!.mean[0] === 0, String(out.get('a')!.mean[0]));
  check('negative bounds are clamped to zero', out.get('a')!.lower[0] === 0);
  check('mean is otherwise untouched', out.get('a')!.mean[1] === 3);
  // A series TimesFM declined must stay visibly declined -- treating it as zero
  // would understate risk at exactly the facilities with the thinnest history.
  check('status is carried through, not dropped', out.get('c')!.status === 'TOO_FEW_POINTS');
}

console.log('\nanomaly statement');
{
  const opts = { startDate: '2026-04-03', targetLastNPoints: 28, threshold: 0.95 };
  const batch = [
    { sid: 'DST-10-PURNIA', values: Array.from({ length: 180 }, (_, i) => 100 + (i % 11)) },
    { sid: 'DST-10-PATNA', values: Array.from({ length: 180 }, (_, i) => 300 + (i % 7)) },
  ];
  const sql = buildAnomalySql(batch, opts);

  check('it calls AI.DETECT_ANOMALIES', sql.includes('FROM AI.DETECT_ANOMALIES(('));
  // The function rejects a call with neither, verbatim: "expects one and only
  // one of the target_start_timestamp or target_last_n_points is provided".
  check('it names a target window', sql.includes('target_last_n_points => 28'));
  check('and only one', !sql.includes('target_start_timestamp'));
  check('it carries the threshold', sql.includes('anomaly_prob_threshold => 0.95'));
  check('it aliases the long column names', sql.includes('anomaly_probability AS p'));

  // The subquery is the SAME one the forecast builds. A second encoder would be
  // a second place for the ARRAY<INT64> cast to go wrong, and BigQuery reports
  // that as neither a cast error nor a struct error.
  check('the series encoding is shared with the forecast', sql.includes('CAST(v AS FLOAT64) AS y'));
  check('the STRUCT type is written once', (sql.match(/STRUCT<sid STRING/g) ?? []).length === 1);
  check('every series shares one start date', (sql.match(/DATE '2026-04-03'/g) ?? []).length === 1);

  let threw = false;
  try {
    buildAnomalySql([batch[0], { sid: 'short', values: [1, 2, 3] }], opts);
  } catch {
    threw = true;
  }
  check('series of unequal length are refused', threw);

  const chunks = chunkAnomalySeries(batch, opts);
  check('a small batch is one statement', chunks.length === 1 && chunks[0].length === 2);
}

console.log('\nanomaly decoding');
{
  const rows = [
    { sid: 's0', ts: '2026-09-20T00:00:00Z', y: 120, is_anomaly: false, lo: 100, hi: 140, p: 0.2, status: '' },
    { sid: 's0', ts: '2026-09-22T00:00:00Z', y: 210, is_anomaly: true, lo: 100, hi: 140, p: 0.99, status: '' },
    { sid: 's0', ts: '2026-09-21T00:00:00Z', y: 40, is_anomaly: true, lo: 100, hi: 140, p: 0.98, status: '' },
    { sid: 's1', ts: '2026-09-21T00:00:00Z', y: 5, is_anomaly: false, lo: 0, hi: 10, p: 0.1, status: 'too short' },
  ];
  const decoded = decodeAnomalyRows(rows);
  check('rows group by series', decoded.size === 2);
  const a = decoded.get('s0')!;
  check('and are sorted by date, not by arrival', a.dates.join(',') === '2026-09-20,2026-09-21,2026-09-22', a.dates.join(','));

  // Direction matters and the two are different warnings. A district whose OPD
  // COLLAPSED is usually a facility with nobody in it -- worth knowing, and not
  // a surge.
  const { high, low } = splitDirection(a);
  check('a point above the band is a high anomaly', high.length === 1 && a.values[high[0]] === 210);
  check('a point below it is a low one', low.length === 1 && a.values[low[0]] === 40);
  check('and a point inside the band is neither', high.length + low.length === 1 + 1);

  // A model that could not fit a series must not be silently read as "nothing
  // happened here" -- that would be quietest about the thinnest data.
  check('a declined series keeps its status', decoded.get('s1')!.status === 'too short');
}

console.log('\nclient guards (no network)');
{
  const huge = 'SELECT 1 -- ' + 'x'.repeat(MAX_QUERY_CHARS);
  await expectThrow('over-length SQL throws before sending', () => runQuery(huge), QueryTooLongError);
}
{
  const prior = process.env.AAROGYA_NO_BQ;
  process.env.AAROGYA_NO_BQ = '1';
  check('AAROGYA_NO_BQ=1 disables the path', !bigQueryEnabled());
  await expectThrow('disabled client throws a typed error', () => runQuery('SELECT 1'), BigQueryDisabledError);
  if (prior === undefined) delete process.env.AAROGYA_NO_BQ;
  else process.env.AAROGYA_NO_BQ = prior;
  check('flag is restored for the rest of the suite', bigQueryEnabled());
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + '  ' + (checks - failures) + '/' + checks + ' checks');
process.exit(failures === 0 ? 0 : 1);
