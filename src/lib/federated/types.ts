/**
 * What a state node publishes, and what the national prior gives back.
 *
 * THE WHOLE POINT OF THIS FILE
 * ----------------------------
 * "Federated" is a word a deck can write in three seconds and a reviewer cannot
 * check at all. These types are the contract that makes it checkable: a state
 * node is allowed to publish exactly the fields declared here, every one of
 * them is a model statistic, and `scripts/verify-federated.mts` fails the test
 * suite if a shipped node file carries a key that is not on this list or a
 * value outside its declared range.
 *
 * Read the field comments as a data-sharing agreement rather than as
 * documentation. A district code, a facility id, a batch number or a quantity
 * of medicine has no field to travel in -- not by policy, by schema.
 */

/** Kinds of number a node is allowed to publish. Mirrored by the leakage sweep. */
export type StatisticKind =
  /** A seasonal multiplier. Dimensionless, centred on 1. */
  | 'index'
  /** A proportion in [0, 1]. */
  | 'rate'
  /** A standard error: non-negative, dimensionless relative to its statistic. */
  | 'se'
  /** A count of RECORDS -- observations, series, districts. Never a quantity of anything. */
  | 'count'
  /** A variance component. Non-negative. */
  | 'variance';

/**
 * One catalogue item's fitted demand shape, as the node shares it.
 *
 * `index` is the output of `fitSeasonalIndex` over the node's own daily
 * consumption of that item, with each district contributing equally. `monthObs`
 * and `indexSe` are what make it poolable: a month the node has never observed
 * carries a null standard error, and the national prior then supplies that month
 * outright instead of the node pretending to know it.
 *
 * WHY THE ITEM AND NOT THE THERAPEUTIC GROUP
 * ------------------------------------------
 * The first build fitted one index per therapeutic group, and three groups came
 * back WORSE than assuming no seasonality at all -- including the oracle arm,
 * which cannot be a worse description of a state than a flat line. The cause was
 * the grouping key: "Analgesic / Antipyretic" holds Paracetamol, whose demand
 * tracks the monsoon, alongside Ibuprofen and Diclofenac, whose demand does not.
 * Averaging a monsoon curve with two flat ones produces a shape that describes
 * none of the three. "Antibiotic" was worse still -- it spans winter
 * respiratory, summer enteric and monsoon vector-borne illness in one bucket.
 *
 * So the fitted unit is the catalogue item, which is also the unit a reorder
 * point is computed for. `group` rides along as a label for reporting.
 */
export interface ItemSeasonality {
  /** Catalogue item id. A public drug code, not a batch and not a consignment. */
  item: string;
  /** Therapeutic group, carried as a reporting label. */
  group: string;
  /** District series behind the fit. A count of series, not of stock. */
  series: number;
  /** Twelve monthly multipliers, index 0 = January. */
  index: number[];
  /** Days of observation behind each month. Zero means the month was never seen. */
  monthObs: number[];
  /** Standard error of each monthly multiplier; null where there is no information. */
  indexSe: (number | null)[];
  /**
   * Residual coefficient of variation after the seasonal index is removed.
   *
   * The anomaly baseline. A detector downstream needs to know how noisy a
   * quiet week looks here before it can call a loud one an outbreak, and that
   * is a property of the state's reporting behaviour -- not something the
   * national average can supply.
   */
  residualCv: number;
  /** 95th percentile of deseasonalised daily demand, as a ratio to its own mean. */
  p95Ratio: number;
}

/**
 * One cadre's vacancy rate, as the node shares it.
 *
 * Present because the shrinkage mechanism has to be reusable to be real. If
 * `poolNodes` only ever pooled seasonal indices it would be a seasonal-index
 * function with an ambitious name; pooling a second, unrelated statistic
 * through the identical code path is the difference.
 *
 * No establishment counts travel. `vacancyRateSe` carries everything the pool
 * needs to know about how much data stands behind the rate.
 */
export interface WorkforceStatistic {
  cadre: string;
  label: string;
  vacancyRate: number;
  vacancyRateSe: number | null;
}

/** The complete published payload of one state node. */
export interface StateNode {
  schema: 'aarogya.federated.node/1';
  node: { stateCode: string; stateName: string; abbr: string };
  /** The history window the fit is over. Dates, not data. */
  window: { start: string; end: string; days: number };
  /** Counts of records behind the fit, so a reader can size the evidence. */
  scope: { districts: number; series: number; observations: number };
  seasonality: ItemSeasonality[];
  workforce: WorkforceStatistic[];
  /**
   * The disclosure the panel renders, computed rather than asserted.
   *
   * `numbers` is counted by walking the payload this object sits in, so it can
   * never drift from what the file actually contains. The zeros are the claim.
   */
  shared: {
    numbers: number;
    facilityRows: 0;
    stockQuantities: 0;
    patientRecords: 0;
    districtIdentifiers: 0;
  };
}

/** One statistic offered to the pool by one node. */
export interface NodeEstimate {
  /** A node label -- a state code. Never a district, never a facility. */
  node: string;
  value: number;
  /** Standard error as the node measured it. `null` means "no information". */
  se: number | null;
}

/** What `poolNodes` returns for a single statistic. */
export interface PooledStatistic {
  /** Random-effects pooled mean across the nodes. */
  mean: number;
  /**
   * Between-node variance (DerSimonian-Laird).
   *
   * This is the `k` of the shrinkage: it decides how much of its own estimate a
   * node keeps. Zero means the nodes are indistinguishable given their own
   * error bars, and every node is pulled all the way to the national mean.
   */
  tauSquared: number;
  /** Cochran's Q and its degrees of freedom, so tau^2 can be recomputed by hand. */
  q: number;
  df: number;
  /** Share of total variance that is between-node rather than sampling noise. */
  iSquared: number;
  /** Nodes that carried usable information. */
  nodes: number;
  /** Nodes that offered the statistic but had no data behind it. */
  uninformativeNodes: number;
  /** Per node: the shrunk estimate, and how much of its own data survived. */
  shrunk: { node: string; value: number; weight: number }[];
}
