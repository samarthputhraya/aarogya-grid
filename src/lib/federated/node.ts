import { fitSeasonalIndex } from '@/lib/forecast/seasonality';
import type { ItemSeasonality, StateNode, WorkforceStatistic } from './types';

/**
 * A state node: fit locally, publish statistics, keep the rows.
 *
 * WHAT RUNS WHERE
 * ---------------
 * Everything this function takes as input is data a state health department
 * already holds about its own facilities, and none of it appears in what the
 * function returns. The daily consumption series go in; twelve monthly
 * multipliers per catalogue item come out. The staff roster goes in; one
 * vacancy rate per cadre comes out. `scripts/verify-federated.mts` enforces
 * that asymmetry against the shipped files rather than trusting this comment.
 *
 * In a real deployment this function runs INSIDE the state -- on a state data
 * centre, against the state's own DVDMS or e-Aushadhi extract -- and only its
 * return value crosses the boundary. Here all sixteen run in one process
 * because there is one simulator; the partition is enforced by what is passed
 * in, and `scripts/build-federated.mts` never hands a node another state's
 * series.
 *
 * WHY THE SERIES ARE NORMALISED BEFORE THEY ARE POOLED
 * ----------------------------------------------------
 * A metro district dispenses ORS sachets in the thousands and a tribal district
 * in the hundreds. Summing raw units across the state and fitting a shape to the
 * total would fit the largest district's shape and call it the state's. Each
 * district series is divided by its own mean first, so the fitted index is the
 * average SHAPE of that item's demand and every district gets one vote.
 *
 * WHY THE DAY IS THE UNIT OF EVIDENCE
 * -----------------------------------
 * The standard errors published here are computed over DAILY state means, not
 * over individual district-days. Eight districts in one state on one day are not
 * eight independent observations of July -- they share the same weather, the
 * same week, the same outbreak. Treating them as independent would produce error
 * bars small enough to make every node look certain, the pooling weights would
 * all be 1, and the federation would quietly stop doing anything while still
 * reporting that it had.
 */

/** One district x drug daily series, as it exists inside the state. Never published. */
export interface NodeSeries {
  /** Catalogue item id -- the unit the index is fitted and published at. */
  item: string;
  /** Therapeutic group, carried through as a reporting label. */
  group: string;
  /** Daily observed consumption, aligned to `startDate`. */
  values: number[];
}

/** One facility's establishment for one cadre, as it exists inside the state. Never published. */
export interface NodeWorkforceRecord {
  cadre: string;
  label: string;
  /** Facility key -- used only to cluster the standard error. Never published. */
  facility: string;
  sanctioned: number;
  inPosition: number;
}

export interface FitStateNodeInput {
  stateCode: string;
  stateName: string;
  abbr: string;
  /** First day of `values`, UTC. */
  startDate: Date;
  /**
   * Leading days of history this node is allowed to use.
   *
   * The whole newcomer experiment turns on this parameter: a state that joined
   * the grid a month ago is a node fitted with `fitDays = 30`, and everything
   * that follows -- thin months, null standard errors, a pooling weight near
   * zero, a national prior filling in July -- follows from it mechanically
   * rather than being simulated as a special case.
   */
  fitDays: number;
  districts: number;
  series: NodeSeries[];
  workforce: NodeWorkforceRecord[];
  /** Passed through to `fitSeasonalIndex`: months with fewer days are pulled toward 1. */
  minObs?: number;
}

/** Six decimals. Enough to reproduce a forecast, few enough that the file is stable. */
const round = (v: number, dp = 6) => +v.toFixed(dp);

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const ISO = (d: Date) => d.toISOString().slice(0, 10);

/** Fit one state's node from its own data, and return only what it may publish. */
export function fitStateNode(input: FitStateNodeInput): StateNode {
  const { startDate, fitDays, minObs = 30 } = input;
  if (fitDays < 1) throw new Error('fitStateNode: fitDays must be at least 1');

  const dates: Date[] = new Array(fitDays);
  const months: number[] = new Array(fitDays);
  for (let t = 0; t < fitDays; t++) {
    const d = new Date(startDate.getTime() + t * 86400000);
    dates[t] = d;
    months[t] = d.getUTCMonth();
  }

  // ------------------------------------------------------------- seasonality
  const byItem = new Map<string, NodeSeries[]>();
  for (const s of input.series) {
    const list = byItem.get(s.item);
    if (list) list.push(s);
    else byItem.set(s.item, [s]);
  }

  const seasonality: ItemSeasonality[] = [];
  let observations = 0;
  let seriesUsed = 0;

  for (const [item, list] of [...byItem.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // One vote per district: divide each series by its own mean over the window.
    const shares: number[][] = [];
    for (const s of list) {
      const window = s.values.slice(0, fitDays);
      const m = mean(window);
      if (!(m > 0)) continue;
      shares.push(window.map((v) => v / m));
    }
    if (shares.length === 0) continue;

    seriesUsed += shares.length;
    observations += shares.length * fitDays;

    /** Mean normalised demand on each day -- the state's own deseasonalising series. */
    const daily: number[] = new Array(fitDays);
    for (let t = 0; t < fitDays; t++) {
      let s = 0;
      for (const sh of shares) s += sh[t];
      daily[t] = s / shares.length;
    }

    // The production path, finally called: a fitted index, not a hand-written curve.
    const index = fitSeasonalIndex(
      daily.map((value, t) => ({ date: dates[t], value })),
      minObs,
    );

    const monthObs = new Array(12).fill(0);
    const monthValues: number[][] = Array.from({ length: 12 }, () => []);
    for (let t = 0; t < fitDays; t++) {
      monthObs[months[t]] += 1;
      monthValues[months[t]].push(daily[t]);
    }

    /*
     * The standard error of a multiplier is the error of a CONTRAST.
     *
     * This was got wrong first, and the wrong version was the more obvious one:
     * the error of the month's own mean, divided by the overall mean. It makes a
     * node that has observed exactly one month publish a multiplier of 1.0 --
     * which it must, since that month IS its overall mean -- with a standard
     * error of 0.009, i.e. near-certainty. The pool then believed it. A state
     * one month into the grid was confidently telling the country that April is
     * an average month for Paracetamol, and being given weight for it.
     *
     * A monthly multiplier says "this month against the rest of the year", so
     * its uncertainty has to carry the uncertainty of BOTH sides. On the log
     * scale the contrast is a difference and the variances add:
     *
     *     var(log R_m) = var(log mean_m) + var(log mean_rest)
     *
     * With one month observed there is no "rest" to compare against, the
     * contrast is undefined, and the node correctly publishes null -- no
     * information -- instead of a confident 1.0. The honest statement is not
     * "April is average here", it is "I have not been here long enough to say".
     *
     * A week on each side is the floor. Below that the sample standard
     * deviation is too unstable to be worth a weight, and `fitSeasonalIndex`
     * has in any case already pulled such a month most of the way to 1.
     */
    const MIN_CONTRAST_DAYS = 7;
    const indexSe = monthValues.map((vs, m) => {
      const rest: number[] = [];
      for (let k = 0; k < 12; k++) if (k !== m) rest.push(...monthValues[k]);
      if (vs.length < MIN_CONTRAST_DAYS || rest.length < MIN_CONTRAST_DAYS) return null;
      const mMean = mean(vs);
      const rMeanRest = mean(rest);
      if (!(mMean > 0) || !(rMeanRest > 0)) return null;
      const vMonth = (sd(vs) / Math.sqrt(vs.length) / mMean) ** 2;
      const vRest = (sd(rest) / Math.sqrt(rest.length) / rMeanRest) ** 2;
      // Published on the natural scale, as a standard error OF the multiplier,
      // so that se / index recovers the log-scale error the pool works in.
      return round(index[m] * Math.sqrt(vMonth + vRest), 8);
    });

    // Anomaly baseline: what this state's noise looks like once season is out.
    const residual = daily.map((v, t) => (index[months[t]] > 0 ? v / index[months[t]] : v));
    const rMean = mean(residual);

    seasonality.push({
      item,
      group: list[0].group,
      series: shares.length,
      index: index.map((v) => round(v)),
      monthObs,
      indexSe,
      residualCv: rMean > 0 ? round(sd(residual) / rMean) : 0,
      p95Ratio: rMean > 0 ? round(quantile(residual, 0.95) / rMean) : 0,
    });
  }

  // --------------------------------------------------------------- workforce
  const byCadre = new Map<string, NodeWorkforceRecord[]>();
  for (const r of input.workforce) {
    if (r.sanctioned <= 0) continue;
    const list = byCadre.get(r.cadre);
    if (list) list.push(r);
    else byCadre.set(r.cadre, [r]);
  }

  const workforce: WorkforceStatistic[] = [];
  for (const [cadre, records] of [...byCadre.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let sanctioned = 0;
    let inPosition = 0;
    for (const r of records) {
      sanctioned += r.sanctioned;
      inPosition += r.inPosition;
    }
    if (sanctioned <= 0) continue;
    const rate = 1 - inPosition / sanctioned;
    /*
     * Clustered at the facility, not at the post. Posts inside one PHC are not
     * independent draws -- a facility nobody will accept a posting to is vacant
     * across the board -- so the facility is the unit and the error bar is the
     * spread of facility vacancy rates.
     */
    const perFacility = records.map((r) => 1 - r.inPosition / r.sanctioned);
    workforce.push({
      cadre,
      label: records[0].label,
      vacancyRate: round(rate),
      vacancyRateSe:
        perFacility.length >= 2 ? round(sd(perFacility) / Math.sqrt(perFacility.length), 8) : null,
    });
  }

  const node: StateNode = {
    schema: 'aarogya.federated.node/1',
    node: { stateCode: input.stateCode, stateName: input.stateName, abbr: input.abbr },
    window: {
      start: ISO(startDate),
      end: ISO(new Date(startDate.getTime() + (fitDays - 1) * 86400000)),
      days: fitDays,
    },
    scope: { districts: input.districts, series: seriesUsed, observations },
    seasonality,
    workforce,
    shared: {
      numbers: 0,
      facilityRows: 0,
      stockQuantities: 0,
      patientRecords: 0,
      districtIdentifiers: 0,
    },
  };

  // Counted, not asserted. The panel's "N numbers crossed the state line" is
  // this number, and it is a walk over the object the file is written from.
  node.shared.numbers = countNumbers({
    scope: node.scope,
    seasonality: node.seasonality,
    workforce: node.workforce,
  });
  return node;
}

/** Numeric leaves in a payload. Nulls are not numbers -- an unseen month shares nothing. */
export function countNumbers(value: unknown): number {
  if (typeof value === 'number') return 1;
  if (Array.isArray(value)) return value.reduce<number>((a, v) => a + countNumbers(v), 0);
  if (value && typeof value === 'object') {
    return Object.values(value).reduce<number>((a, v) => a + countNumbers(v), 0);
  }
  return 0;
}
