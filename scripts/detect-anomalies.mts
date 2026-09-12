/**
 * Runs `AI.DETECT_ANOMALIES` over both district series and caches the result.
 *
 * Run with:  npx tsx scripts/detect-anomalies.mts
 *            npx tsx scripts/detect-anomalies.mts --footfall-only
 * Output:    src/data/anomalies.json          (the cache the site reads)
 *            docs/anomaly-runtime.json        (what it cost, for the README)
 *
 * TWO SERIES, DIFFERENT JOBS
 * --------------------------
 *   OPD footfall, per district (128 series)
 *       The leading edge. People walk in before anything is dispensed, so this
 *       is where a surge is visible first -- and it is the series a warning
 *       should be built on if the claim is "days early".
 *
 *   Drug consumption, per district x drug (6,016 series)
 *       The lagging, actionable one. An anomaly here is already a supply
 *       problem; it is watched because it is what the planner can act on, and
 *       because agreement between the two is what distinguishes an outbreak
 *       from a counting error at one facility.
 *
 * ONLY THE CENSORED SERIES IS EVER SENT. The footfall artefact carries a
 * `demand` series -- everyone who presented, including those turned away --
 * which only a simulation can know. It is not read here. A detector that saw it
 * would be measuring its own author's cleverness.
 *
 * THE BILL
 * --------
 * Inline subqueries, so BigQuery scans no table: every job in this script
 * dry-runs and bills at 0 bytes, the same as the forecast path. The only cost
 * is wall clock.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
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

const footfallOnly = process.argv.includes('--footfall-only');

/**
 * Days scored at the end of each series.
 *
 * Four weeks: long enough that a sustained rise has room to be sustained, short
 * enough that the model still has 150 days of context to decide what normal
 * looks like. The WARNING rule that sits on top of these points -- how many
 * consecutive days, and how far above the band -- is tuned separately, on
 * purpose: moving two dials at once makes neither measurable.
 */
const TARGET_DAYS = 28;

/**
 * Series per statement.
 *
 * Lower than the forecast's 2,006 because these carry 180 days rather than 90,
 * so each series costs roughly twice the characters. The chunker measures the
 * real budget either way; this is the cap that keeps a single job's wall clock
 * reasonable.
 */
const MAX_SERIES = 1200;

interface FootfallArtefact {
  startDate: string;
  lastDate: string;
  days: number;
  districts: {
    code: string;
    name: string;
    stateCode: string;
    population: number;
    attended: number[];
  }[];
}

interface DemandArtefact {
  startDate: string;
  lastDate: string;
  days: number;
  series: { sid: string; districtCode: string; drugId: string; values: number[] }[];
}

const root = process.cwd();
const footfall = JSON.parse(
  readFileSync(resolve(root, 'src/data/footfall-district-daily.json'), 'utf8'),
) as FootfallArtefact;
const demand = JSON.parse(
  readFileSync(resolve(root, 'src/data/demand-district-daily.json'), 'utf8'),
) as DemandArtefact;

if (footfall.startDate !== demand.startDate || footfall.lastDate !== demand.lastDate) {
  // A lead time measured across two different calendars is not a lead time.
  console.error(
    'Calendars disagree: footfall ' + footfall.startDate + '..' + footfall.lastDate +
      ', demand ' + demand.startDate + '..' + demand.lastDate + '. Re-run both exporters.',
  );
  process.exit(1);
}

if (!bigQueryEnabled()) {
  console.error('AAROGYA_NO_BQ=1: nothing to detect against. Unset it to run.');
  process.exit(1);
}

console.log('Anomaly detection over the district series');
console.log('  window     :', footfall.startDate, '->', footfall.lastDate, '(' + footfall.days + ' days)');
console.log('  scored     : last', TARGET_DAYS, 'days');
console.log('  threshold  :', DEFAULT_ANOMALY_THRESHOLD);
console.log('');

interface RunStats {
  label: string;
  series: number;
  batches: number;
  elapsedMs: number;
  bytesProcessed: number;
  bytesBilled: number;
  rows: number;
  flaggedSeries: number;
  flaggedPointsHigh: number;
  flaggedPointsLow: number;
  declined: number;
}

async function detect(
  label: string,
  series: DemandSeries[],
): Promise<{ stats: RunStats; findings: Finding[] }> {
  const { wire, toOriginal } = compactIds(series);
  const opts = {
    startDate: footfall.startDate,
    targetLastNPoints: TARGET_DAYS,
    threshold: DEFAULT_ANOMALY_THRESHOLD,
  };
  const batches = chunkAnomalySeries(wire, { ...opts, maxSeries: MAX_SERIES });

  console.log('  ' + label + ': ' + series.length + ' series in ' + batches.length + ' statement(s)');
  const started = Date.now();

  // Concurrently, for the same reason the forecast refresh is: three sequential
  // jobs of eighty seconds is four minutes, and the same three together is
  // eighty seconds. BigQuery is doing the work either way.
  const results = await Promise.all(
    batches.map((batch, i) =>
      runQuery<AnomalyRow>(buildAnomalySql(batch, opts), {
        jobLabel: 'anomalies_' + label.replace(/[^a-z0-9]+/gi, '_').toLowerCase(),
        // A repeat run of an identical statement would otherwise be served from
        // BigQuery's result cache in a second or two, and the runtime artefact
        // would then be a measurement of the cache rather than of the model.
        // The forecast ladder learned this the same way: two runs of one rung
        // came back at 78 s and 2 s, and only one of them was a forecast.
        useQueryCache: false,
      }).then((r) => {
        console.log(
          '    batch ' + (i + 1) + '/' + batches.length + ': ' + batch.length + ' series, ' +
            r.stats.rowCount.toLocaleString('en-IN') + ' rows, ' +
            (r.stats.elapsedMs / 1000).toFixed(1) + 's, ' +
            r.stats.totalBytesProcessed + ' bytes',
        );
        return r;
      }),
    ),
  );

  const rows = results.flatMap((r) => r.rows);
  const decoded = decodeAnomalyRows(rows);

  const findings: Finding[] = [];
  let flaggedSeries = 0;
  let high = 0;
  let low = 0;
  let declined = 0;

  for (const [wireSid, a] of decoded) {
    const sid = toOriginal.get(wireSid) ?? wireSid;
    if (a.status) declined++;
    const { high: hi, low: lo } = splitDirection(a);
    high += hi.length;
    low += lo.length;
    if (hi.length === 0 && lo.length === 0) continue;
    flaggedSeries++;
    const points: AnomalyPoint[] = [];
    for (const i of hi) {
      points.push({
        d: a.dates[i],
        v: Math.round(a.values[i]),
        lo: +a.lower[i].toFixed(1),
        hi: +a.upper[i].toFixed(1),
        p: +a.probability[i].toFixed(4),
        dir: 'high',
      });
    }
    for (const i of lo) {
      points.push({
        d: a.dates[i],
        v: Math.round(a.values[i]),
        lo: +a.lower[i].toFixed(1),
        hi: +a.upper[i].toFixed(1),
        p: +a.probability[i].toFixed(4),
        dir: 'low',
      });
    }
    points.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
    findings.push({ sid, points, status: a.status });
  }

  return {
    stats: {
      label,
      series: series.length,
      batches: batches.length,
      elapsedMs: Date.now() - started,
      bytesProcessed: results.reduce((a, r) => a + r.stats.totalBytesProcessed, 0),
      bytesBilled: 0,
      rows: rows.length,
      flaggedSeries,
      flaggedPointsHigh: high,
      flaggedPointsLow: low,
      declined,
    },
    findings,
  };
}

/**
 * One flagged day.
 *
 * ONLY THE FLAGGED DAYS ARE KEPT, and the reason is arithmetic. Writing all 28
 * scored points for all 6,144 series -- the value, the band, the probability --
 * produced a 9 MB artefact, most of it days on which nothing happened. The
 * points that were inside the band are recoverable by re-running the detector
 * and are never read by anything; the points outside it are the entire output.
 *
 * The band is kept per point rather than dropped, because "142 against an
 * expected 60-95" is a finding and "142 was unusual" is an assertion.
 */
interface AnomalyPoint {
  /** ISO date. */
  d: string;
  /** The recorded value. */
  v: number;
  /** Expected band from the model. */
  lo: number;
  hi: number;
  /** Anomaly probability, as the model reported it. */
  p: number;
  dir: 'high' | 'low';
}

interface Finding {
  sid: string;
  points: AnomalyPoint[];
  /** Non-empty when the model could not fit this series. */
  status: string;
}

// ---------------------------------------------------------------- footfall

const footfallSeries: DemandSeries[] = footfall.districts.map((d) => ({
  sid: d.code,
  values: d.attended,
}));
const footfallRun = await detect('footfall', footfallSeries);

// ------------------------------------------------------------ consumption

let consumptionRun: { stats: RunStats; findings: Finding[] } | null = null;
if (!footfallOnly) {
  const consumptionSeries: DemandSeries[] = demand.series.map((s) => ({
    sid: s.sid,
    values: s.values,
  }));
  consumptionRun = await detect('consumption', consumptionSeries);
}

// ------------------------------------------------------------------ output

const runs = [footfallRun.stats, ...(consumptionRun ? [consumptionRun.stats] : [])];

console.log('');
for (const r of runs) {
  console.log(
    '  ' + r.label.padEnd(12) +
      r.series.toString().padStart(5) + ' series · ' +
      (r.elapsedMs / 1000).toFixed(1).padStart(6) + 's · ' +
      r.rows.toLocaleString('en-IN').padStart(9) + ' rows · ' +
      r.flaggedSeries.toString().padStart(4) + ' flagged (' +
      r.flaggedPointsHigh + ' high, ' + r.flaggedPointsLow + ' low) · ' +
      r.declined + ' declined · ' + r.bytesProcessed + ' bytes',
  );
}

const cache = {
  asOf: footfall.lastDate,
  startDate: footfall.startDate,
  scoredDays: TARGET_DAYS,
  threshold: DEFAULT_ANOMALY_THRESHOLD,
  model: 'BigQuery AI.DETECT_ANOMALIES',
  footfall: footfallRun.findings,
  consumption: consumptionRun?.findings ?? [],
};
const cachePath = resolve(root, 'src/data/anomalies.json');
mkdirSync(dirname(cachePath), { recursive: true });
writeFileSync(cachePath, JSON.stringify(cache) + '\n');

const runtimePath = resolve(root, 'docs/anomaly-runtime.json');
writeFileSync(
  runtimePath,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      window: { start: footfall.startDate, end: footfall.lastDate, days: footfall.days },
      scoredDays: TARGET_DAYS,
      threshold: DEFAULT_ANOMALY_THRESHOLD,
      maxSeriesPerStatement: MAX_SERIES,
      runs,
    },
    null,
    2,
  ) + '\n',
);

console.log('');
console.log('  wrote ' + cachePath);
console.log('  wrote ' + runtimePath);
