/**
 * Encoding demand history into an `AI.FORECAST` statement.
 *
 * THE ARCHITECTURE THIS FILE EXISTS TO SERVE
 * ------------------------------------------
 * `AI.FORECAST` accepts an inline subquery in place of a table. That one fact
 * removes the entire "stand up a BigQuery dataset, load it nightly, keep it in
 * sync with the simulator" half of the design: the history travels inside the
 * statement, the job dry-runs at 0 bytes processed because there is no table to
 * scan, and the project needs no dataset at all for forecasting.
 *
 * The price is that the statement has a hard size limit -- 1,024 K characters --
 * so the history has to be encoded compactly and split into batches that are
 * measured, not guessed.
 *
 * THE ENCODING
 * ------------
 * The obvious encoding, one `SELECT ... UNION ALL` row per (series, day), costs
 * a repeated column name and a repeated date literal on every single row. For
 * 2,000 series x 90 days that is 180,000 rows of boilerplate.
 *
 * Instead each series is one array, and the days are recovered with
 * `UNNEST(vals) WITH OFFSET`:
 *
 *     UNNEST([STRUCT<sid STRING, vals ARRAY<INT64>>('KA-BLR|PARA', [0,3,1,...]),
 *                                                  ('KA-BLR|ORS',  [2,0,0,...])])
 *       AS s, UNNEST(s.vals) AS v WITH OFFSET off
 *
 * Three things about that are deliberate:
 *
 *   - `ARRAY<INT64>`, not `ARRAY<FLOAT64>`. Daily issues are counts, so integer
 *     literals are the shortest possible spelling -- and an all-zero day costs
 *     two characters. BigQuery does NOT coerce `ARRAY<INT64>` to
 *     `ARRAY<FLOAT64>` (it rejects the struct outright), so the cast to the
 *     FLOAT64 that `AI.FORECAST` wants happens on the scalar, after UNNEST.
 *   - The STRUCT type is written out ONCE, on the first element. Every element
 *     after it is a bare tuple, which saves ~40 characters per series.
 *   - `WITH OFFSET` restarts at 0 for each series, so every series shares one
 *     start date and the timestamp column is arithmetic rather than data.
 *
 * WHAT IS BEING FORECAST, AND WHY IT IS NOT THE FACILITY
 * -----------------------------------------------------
 * There are some 81,000 facility x drug positions. At roughly 300 characters each
 * that is ~24 MB of SQL, so facility-level series are unreachable inline by a
 * factor of twenty-odd -- no batch size rescues that.
 *
 * They are also the wrong thing to hand TimesFM. A sub-centre dispensing
 * anti-snake venom four times a year is an intermittent series that is mostly
 * zeros, which is the regime a foundation model trained on continuous data is
 * worst at, and precisely the regime Croston was designed for.
 *
 * So the split is by strength: TimesFM forecasts the DISTRICT x drug daily
 * aggregate, which is smooth and seasonal; a per-facility share disaggregates
 * it; and the existing compound-Bernoulli Monte Carlo keeps the intermittency.
 * ~5,700 district x drug series is three batches, not twenty thousand.
 */

/** One series: a stable id and a daily history, oldest day first. */
export interface DemandSeries {
  /** Stable identifier. Round-tripped through BigQuery as the `sid` column. */
  sid: string;
  /** Daily values, oldest first, no gaps. Non-negative integers. */
  values: number[];
}

export interface ForecastSqlOptions {
  /** ISO date (YYYY-MM-DD) of `values[0]` for every series in the batch. */
  startDate: string;
  /** Days to forecast forward from the last observed day. */
  horizon: number;
  /** Prediction interval width. 0.9 gives the 5th/95th percentile bounds. */
  confidenceLevel?: number;
  /**
   * TimesFM version. Pinned rather than defaulted, so a silent server-side
   * model upgrade cannot change committed forecasts without the diff showing it.
   */
  model?: string;
}

/** The row shape `buildForecastSql` selects. */
export interface ForecastRow {
  sid: string;
  forecast_timestamp: string;
  forecast_value: number;
  lo: number;
  hi: number;
  ai_forecast_status: string;
}

export const DEFAULT_MODEL = 'TimesFM 2.0';

/**
 * Series per statement.
 *
 * 2,000 is a deliberate two-thirds of the ~3,200 the character limit allows, so
 * a district whose history is unusually wordy cannot push a batch over the edge.
 * `chunkSeries` measures anyway; this is the cap that keeps batches comparable.
 */
export const DEFAULT_MAX_SERIES_PER_QUERY = 2000;

/**
 * Escape a series id for a single-quoted SQL literal.
 *
 * Ids here are built from district and drug codes, so nothing should ever need
 * escaping -- which is exactly why it is done anyway. This is the one place
 * where caller-supplied text enters a statement, and a single unescaped quote
 * would turn a forecast batch into a syntax error at best.
 */
function quoteSid(sid: string): string {
  return "'" + sid.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function assertSeries(s: DemandSeries, expectedLength: number): void {
  if (s.values.length !== expectedLength) {
    throw new Error(
      'Series ' + s.sid + ' has ' + s.values.length + ' values, expected ' + expectedLength +
        '. Every series in a batch must share one calendar.',
    );
  }
  for (const v of s.values) {
    if (!Number.isFinite(v)) {
      throw new Error('Series ' + s.sid + ' contains a non-finite value.');
    }
  }
}

/** Encode one series as a SQL tuple. `withType` writes the STRUCT type prefix. */
function encodeSeries(s: DemandSeries, withType: boolean): string {
  const head = withType ? 'STRUCT<sid STRING, vals ARRAY<INT64>>' : '';
  // Values are daily counts; rounding here rather than at the call site means a
  // fractional value from an unconstraining adjustment cannot emit `3.0000001`
  // and cost 8 characters per day across 5,700 series.
  const vals = s.values.map((v) => Math.max(0, Math.round(v)).toString()).join(',');
  return head + '(' + quoteSid(s.sid) + ',[' + vals + '])';
}

/** Characters this series will occupy inside the array literal, plus its comma. */
export function estimateSeriesChars(s: DemandSeries): number {
  return encodeSeries(s, false).length + 1;
}

/** The STRUCT type prefix, written once per batch on the first element. */
export const STRUCT_PREFIX = 'STRUCT<sid STRING, vals ARRAY<INT64>>';

/**
 * The inline subquery both AI functions take in place of a table.
 *
 * Shared rather than copied because `AI.FORECAST` and `AI.DETECT_ANOMALIES`
 * want exactly the same three columns, and a second encoder would be a second
 * place for the `ARRAY<INT64>` cast to go wrong -- BigQuery rejects the struct
 * outright if the cast moves, and the error names neither the cast nor the
 * struct.
 */
export function buildSeriesSubquery(batch: DemandSeries[], startDate: string): string {
  if (batch.length === 0) throw new Error('buildSeriesSubquery: empty batch');
  const historyDays = batch[0].values.length;
  if (historyDays === 0) throw new Error('buildSeriesSubquery: series have no history');
  for (const item of batch) assertSeries(item, historyDays);

  const elements = batch.map((item, i) => encodeSeries(item, i === 0)).join(',');
  return (
    '  SELECT s.sid AS sid,\n' +
    "         DATE_ADD(DATE '" + startDate + "', INTERVAL off DAY) AS ts,\n" +
    '         CAST(v AS FLOAT64) AS y\n' +
    '  FROM UNNEST([' + elements + ']) AS s,\n' +
    '       UNNEST(s.vals) AS v WITH OFFSET off\n'
  );
}

/**
 * Build the `AI.FORECAST` statement for one batch.
 *
 * Column names are aliased short (`lo`/`hi`) because the result set is paged
 * back over REST and `prediction_interval_lower_bound` would otherwise be
 * repeated in the schema of every page.
 */
export function buildForecastSql(batch: DemandSeries[], opts: ForecastSqlOptions): string {
  const confidence = opts.confidenceLevel ?? 0.9;
  const model = opts.model ?? DEFAULT_MODEL;

  return (
    'SELECT sid, forecast_timestamp, forecast_value,\n' +
    '       prediction_interval_lower_bound AS lo,\n' +
    '       prediction_interval_upper_bound AS hi,\n' +
    '       ai_forecast_status\n' +
    'FROM AI.FORECAST((\n' +
    buildSeriesSubquery(batch, opts.startDate) +
    "), data_col => 'y', timestamp_col => 'ts', id_cols => ['sid']," +
    ' horizon => ' + opts.horizon + ',' +
    ' confidence_level => ' + confidence + ',' +
    " model => '" + model + "')"
  );
}

/** Characters of scaffolding around the array literal, measured not guessed. */
export function sqlOverheadChars(opts: ForecastSqlOptions): number {
  const probe = buildForecastSql([{ sid: 'x', values: [0] }], opts);
  return probe.length - encodeSeries({ sid: 'x', values: [0] }, true).length;
}

export interface ChunkOptions extends ForecastSqlOptions {
  /** Hard cap on series per statement. Default 2,000. */
  maxSeries?: number;
  /**
   * Character budget for the whole statement. Defaults to 90% of BigQuery's
   * 1,024 K limit -- the 10% is headroom for the STRUCT type prefix landing on
   * a longer id than the one measured, and for a future column being added to
   * the SELECT list without anyone re-deriving this number.
   */
  maxChars?: number;
}

/**
 * Split series into batches that each fit inside one statement.
 *
 * Greedy and order-preserving, so a given input always produces the same
 * batches -- which is what makes a forecast refresh reproducible and a rerun
 * comparable to the run before it.
 */
export function chunkSeries(series: DemandSeries[], opts: ChunkOptions): DemandSeries[][] {
  const maxSeries = opts.maxSeries ?? DEFAULT_MAX_SERIES_PER_QUERY;
  const maxChars = opts.maxChars ?? Math.floor(1024 * 1024 * 0.9);
  const overhead = sqlOverheadChars(opts);
  // The STRUCT type prefix is written once per batch, on the first element.
  const typePrefix = STRUCT_PREFIX.length;
  const budget = maxChars - overhead - typePrefix;

  const batches: DemandSeries[][] = [];
  let current: DemandSeries[] = [];
  let used = 0;

  for (const s of series) {
    const cost = estimateSeriesChars(s);
    if (cost > budget) {
      throw new Error(
        'Series ' + s.sid + ' alone needs ' + cost.toLocaleString('en-IN') +
          ' characters, over the ' + budget.toLocaleString('en-IN') +
          ' character budget. Shorten the history window.',
      );
    }
    if (current.length > 0 && (current.length >= maxSeries || used + cost > budget)) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(s);
    used += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Swap descriptive ids for positional ones on the wire.
 *
 * A natural series id here is `DST-29-BANGALOR|HYDROCORT-100-INJ` -- 33
 * characters, repeated once per series. At 2,000 series that is 66 KB of the
 * character budget spent on text the server only ever echoes back, and the
 * budget is the thing that decides how many series fit in one statement.
 *
 * `s0`, `s1`, ... costs 2-5 characters instead, and the mapping is held here in
 * memory for the round trip. Nothing lossy happens: the caller gets its own ids
 * back from `restoreIds`, and the committed cache is keyed by the real ones.
 */
export function compactIds(series: DemandSeries[]): {
  wire: DemandSeries[];
  toOriginal: Map<string, string>;
} {
  const toOriginal = new Map<string, string>();
  const wire = series.map((s, i) => {
    const short = 's' + i;
    toOriginal.set(short, s.sid);
    return { sid: short, values: s.values };
  });
  return { wire, toOriginal };
}

/** Put the caller's own ids back on decoded rows. */
export function restoreIds(rows: ForecastRow[], toOriginal: Map<string, string>): ForecastRow[] {
  return rows.map((r) => ({ ...r, sid: toOriginal.get(r.sid) ?? r.sid }));
}

/** A decoded forecast: the mean path and its interval, one entry per horizon day. */
export interface HorizonForecast {
  sid: string;
  /** ISO dates, one per horizon day, ascending. */
  dates: string[];
  mean: number[];
  lower: number[];
  upper: number[];
  /** Empty string when TimesFM returned a clean forecast for this series. */
  status: string;
}

/**
 * Turn the flat result rows back into one forecast per series.
 *
 * `ai_forecast_status` is carried through rather than dropped: it is how
 * TimesFM reports a series it could not model (too short, all-constant), and a
 * refresh that silently treated those as zeros would understate risk at exactly
 * the facilities with the thinnest history.
 */
export function decodeForecastRows(rows: ForecastRow[]): Map<string, HorizonForecast> {
  const bySid = new Map<string, ForecastRow[]>();
  for (const r of rows) {
    const list = bySid.get(r.sid);
    if (list) list.push(r);
    else bySid.set(r.sid, [r]);
  }

  const out = new Map<string, HorizonForecast>();
  for (const [sid, list] of bySid) {
    list.sort((a, b) => (a.forecast_timestamp < b.forecast_timestamp ? -1 : 1));
    out.set(sid, {
      sid,
      dates: list.map((r) => r.forecast_timestamp.slice(0, 10)),
      // TimesFM can return a small negative mean for a series that is mostly
      // zeros. Negative demand is not a thing; clamping here keeps every
      // downstream consumer from having to remember that.
      mean: list.map((r) => Math.max(0, r.forecast_value)),
      lower: list.map((r) => Math.max(0, r.lo)),
      upper: list.map((r) => Math.max(0, r.hi)),
      status: list[0]?.ai_forecast_status ?? '',
    });
  }
  return out;
}
