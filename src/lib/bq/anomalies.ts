import {
  buildSeriesSubquery,
  chunkSeries,
  compactIds,
  estimateSeriesChars,
  STRUCT_PREFIX,
  type DemandSeries,
} from './series';

/**
 * `AI.DETECT_ANOMALIES` over the same inline subqueries the forecast uses.
 *
 * WHAT IS BEING WATCHED, AND WHY IT IS TWO SERIES
 * ----------------------------------------------
 * A stock-out is a LAGGING indicator. By the time a block's anti-malarials are
 * running short, the malaria has been there a fortnight -- consumption only
 * moves after people have already walked in and been treated. So the district's
 * drug consumption is watched, because it is what the supply chain acts on, and
 * the district's OPD footfall is watched too, because it is where the same
 * event appears first. One is the signal the system must act on; the other is
 * the signal that buys the days.
 *
 * NO DATASET, AGAIN, AND NO BYTES
 * -------------------------------
 * The history travels inside the statement exactly as it does for the forecast:
 * measured at 0 bytes processed on a dry run, because there is no table to
 * scan. The encoder is shared with `series.ts` rather than copied -- both
 * functions want the same three columns, and a second copy of the
 * `ARRAY<INT64>` cast would be a second place for it to go wrong in a way
 * BigQuery reports as neither a cast error nor a struct error.
 *
 * THE ONE ARGUMENT THAT IS NOT OPTIONAL
 * -------------------------------------
 * `AI.DETECT_ANOMALIES` accepts exactly one of `target_last_n_points` or
 * `target_start_timestamp`, and rejects a call with neither -- verbatim:
 * "expects one and only one of the target_start_timestamp or
 * target_last_n_points is provided". Everything before the target window is
 * context the model fits on; everything inside it is scored. That split is the
 * whole design: fourteen days of context is not enough to know what normal
 * looks like, and scoring the context would flag the training data.
 */

/** Columns `AI.DETECT_ANOMALIES` returns, aliased short for the REST paging. */
export interface AnomalyRow {
  sid: string;
  ts: string;
  y: number;
  is_anomaly: boolean;
  lo: number;
  hi: number;
  p: number;
  status: string;
}

export interface AnomalySqlOptions {
  /** ISO date of the first value in every series. They share one calendar. */
  startDate: string;
  /**
   * How many trailing points to SCORE. Everything earlier is context.
   *
   * Not a tuning knob for sensitivity -- that is `threshold`. This decides how
   * far back the question reaches, and a run that scores 180 points on 180
   * points of history has no context left to be anomalous against.
   */
  targetLastNPoints: number;
  /**
   * Probability above which a point is called an anomaly. Default 0.95.
   *
   * BigQuery's own default is 0.95 and it is kept, deliberately: the rule that
   * turns points into a WARNING is tuned in `scripts/tune-warning.mts` on top
   * of this, and moving two dials at once makes neither measurable.
   */
  threshold?: number;
}

export const DEFAULT_ANOMALY_THRESHOLD = 0.95;

/** Build the statement for one batch of series. */
export function buildAnomalySql(batch: DemandSeries[], opts: AnomalySqlOptions): string {
  const threshold = opts.threshold ?? DEFAULT_ANOMALY_THRESHOLD;
  return (
    'SELECT sid, time_series_timestamp AS ts, time_series_data AS y,\n' +
    '       is_anomaly, lower_bound AS lo, upper_bound AS hi,\n' +
    '       anomaly_probability AS p, ai_detect_anomalies_status AS status\n' +
    'FROM AI.DETECT_ANOMALIES((\n' +
    buildSeriesSubquery(batch, opts.startDate) +
    "), data_col => 'y', timestamp_col => 'ts', id_cols => ['sid']," +
    ' anomaly_prob_threshold => ' + threshold + ',' +
    ' target_last_n_points => ' + opts.targetLastNPoints + ')'
  );
}

/** Characters of scaffolding around the array literal, measured not guessed. */
export function anomalySqlOverheadChars(opts: AnomalySqlOptions): number {
  const probe = buildAnomalySql([{ sid: 'x', values: [0] }], opts);
  return probe.length - STRUCT_PREFIX.length - estimateSeriesChars({ sid: 'x', values: [0] }) + 1;
}

/**
 * Split series into statements that fit.
 *
 * Delegates to the forecast chunker with a horizon of 1: the two statements
 * differ by a few dozen characters of scaffolding out of a million, so a
 * separate budget calculation would be two numbers that have to agree rather
 * than one that is measured. The forecast's own overhead is very slightly
 * larger, which makes this conservative in the safe direction.
 */
export function chunkAnomalySeries(
  series: DemandSeries[],
  opts: AnomalySqlOptions & { maxSeries?: number },
): DemandSeries[][] {
  return chunkSeries(series, {
    startDate: opts.startDate,
    horizon: 1,
    maxSeries: opts.maxSeries,
  });
}

export { compactIds };

/** One series' worth of scored points, ascending by date. */
export interface SeriesAnomalies {
  sid: string;
  dates: string[];
  values: number[];
  /** Expected band from the model, per scored point. */
  lower: number[];
  upper: number[];
  probability: number[];
  isAnomaly: boolean[];
  /** Empty when the model scored this series cleanly. */
  status: string;
}

/**
 * Turn flat rows into one record per series.
 *
 * `ai_detect_anomalies_status` is carried rather than dropped, for the same
 * reason the forecast carries its own: it is how the model reports a series it
 * could not fit, and a detector that silently treated those as "no anomalies"
 * would be quietest about exactly the districts with the thinnest data.
 */
export function decodeAnomalyRows(rows: AnomalyRow[]): Map<string, SeriesAnomalies> {
  const bySid = new Map<string, AnomalyRow[]>();
  for (const r of rows) {
    const list = bySid.get(r.sid);
    if (list) list.push(r);
    else bySid.set(r.sid, [r]);
  }

  const out = new Map<string, SeriesAnomalies>();
  for (const [sid, list] of bySid) {
    list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    out.set(sid, {
      sid,
      dates: list.map((r) => r.ts.slice(0, 10)),
      values: list.map((r) => r.y),
      lower: list.map((r) => r.lo),
      upper: list.map((r) => r.hi),
      probability: list.map((r) => r.p),
      isAnomaly: list.map((r) => Boolean(r.is_anomaly)),
      status: list.find((r) => r.status && r.status !== '')?.status ?? '',
    });
  }
  return out;
}

/**
 * Only the points that are BOTH anomalous and high.
 *
 * A two-sided detector flags a district whose OPD collapsed as loudly as one
 * whose OPD doubled, and both are worth knowing -- but they are different
 * warnings with different responses, and the surge rule needs the upper tail.
 * A collapse is kept under its own flag rather than discarded: an OPD that
 * stopped is usually a facility with nobody in it, which is the other thing
 * this project exists to make visible.
 */
export function splitDirection(a: SeriesAnomalies): {
  high: number[];
  low: number[];
} {
  const high: number[] = [];
  const low: number[] = [];
  for (let i = 0; i < a.isAnomaly.length; i++) {
    if (!a.isAnomaly[i]) continue;
    if (a.values[i] > a.upper[i]) high.push(i);
    else if (a.values[i] < a.lower[i]) low.push(i);
  }
  return { high, low };
}
