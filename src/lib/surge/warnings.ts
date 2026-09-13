/**
 * Applying the tuned rule to the detector's output.
 *
 * The detector returns POINTS. `scripts/tune-warning.mts` measured what turning
 * a point into a warning costs and chose a rule: k consecutive days flagged
 * high, each at least e above the model's own upper bound. This is the seventeen
 * lines that apply it.
 *
 * IT IS ITS OWN FILE, AND PURE, FOR THE SAME REASON THE TICKET FOLD IS
 * -------------------------------------------------------------------
 * The rule is the one piece of WS3 that an outside reader will want to check
 * line by line -- it is what stands between "an AI flagged something" and "a
 * district was told to move stock". Keeping it free of BigQuery, of `server-only`
 * and of the file system means a plain Node test can feed it a hand-built series
 * and assert what comes out.
 *
 * CONSECUTIVE MEANS CONSECUTIVE DATES
 * -----------------------------------
 * The cached findings hold only the flagged days, so "k in a row" has to be
 * decided from the dates rather than from array positions. Two flagged days
 * three days apart are not a sustained rise; they are two days. Reading the
 * array naively would treat them as one, which is precisely how a rule tuned at
 * 0.4 false alarms per district-week becomes a rule that fires constantly.
 */

/** One day the detector flagged, as cached by `scripts/detect-anomalies.mts`. */
export interface AnomalyPoint {
  /** ISO date. */
  d: string;
  /** The recorded value. */
  v: number;
  /** Expected band from the model. */
  lo: number;
  hi: number;
  /** Anomaly probability. */
  p: number;
  dir: 'high' | 'low';
}

export interface AnomalyFinding {
  sid: string;
  points: AnomalyPoint[];
  status: string;
}

export interface WarningRule {
  consecutiveDays: number;
  excessAboveUpperBound: number;
  source: string;
  detectorThreshold: number;
}

export interface Warning {
  /** The series this fired on: a district code, or `districtCode|drugId`. */
  sid: string;
  /** The day the run reached k -- the day the warning could have been raised. */
  raisedOn: string;
  /** The days of the qualifying run, ascending. */
  days: string[];
  /** Observed total across the run. */
  observed: number;
  /** What the model expected across the same days, at its upper bound. */
  expectedUpperBound: number;
  /** `observed / expectedUpperBound`. How far above normal, as a multiple. */
  ratio: number;
  /** Highest anomaly probability in the run, as the detector reported it. */
  peakProbability: number;
}

const dayBefore = (iso: string): string => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Every warning the rule raises on one series.
 *
 * A run of qualifying days is ONE warning, raised on the day the run reaches k.
 * Counting each day would turn a fourteen-day surge into fourteen warnings,
 * which is the same arithmetic that made the tuning run's first false-alarm
 * rate meaningless.
 */
export function warningsForSeries(finding: AnomalyFinding, rule: WarningRule): Warning[] {
  // STRICTLY above the bound, as well as by the tuned margin -- the same
  // predicate `scripts/tune-warning.mts` scored. Without the strict term a day
  // with zero consumption against an upper bound of zero satisfies 0 >= 0 x 1.1,
  // and the interop feed shipped twelve "Rising consumption" signals whose
  // observed value was 0. The rule the table chose never raised those.
  const qualifying = finding.points
    .filter((p) => p.dir === 'high' && p.v > p.hi && p.v >= p.hi * (1 + rule.excessAboveUpperBound))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));

  const out: Warning[] = [];
  let run: AnomalyPoint[] = [];

  for (const point of qualifying) {
    const continues = run.length > 0 && run[run.length - 1].d === dayBefore(point.d);
    run = continues ? [...run, point] : [point];
    if (run.length === rule.consecutiveDays) {
      out.push({
        sid: finding.sid,
        raisedOn: point.d,
        days: run.map((p) => p.d),
        observed: run.reduce((a, p) => a + p.v, 0),
        expectedUpperBound: +run.reduce((a, p) => a + p.hi, 0).toFixed(1),
        ratio: +(
          run.reduce((a, p) => a + p.v, 0) / Math.max(1, run.reduce((a, p) => a + p.hi, 0))
        ).toFixed(3),
        peakProbability: Math.max(...run.map((p) => p.p)),
      });
    }
  }

  return out;
}

/** Every warning across a set of findings, newest first. */
export function warningsFrom(findings: AnomalyFinding[], rule: WarningRule): Warning[] {
  return findings
    .flatMap((f) => warningsForSeries(f, rule))
    .sort((a, b) => (a.raisedOn < b.raisedOn ? 1 : a.raisedOn > b.raisedOn ? -1 : 0));
}
