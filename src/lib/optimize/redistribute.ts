import type {
  Facility,
  FacilityType,
  StockBatch,
  StockRisk,
  TransferLine,
  TransferRecommendation,
  CorridorTrip,
  VedClass,
} from '@/lib/domain/types';
import type { CatalogueDrug } from '@/lib/domain/drugs';
import type { DemandFit } from '@/lib/forecast/croston';
import { leadTimeDemandSamples, expectedShortfall, stockoutProbabilityAt } from '@/lib/forecast/risk';
import { roadDistanceKm } from '@/lib/domain/geo';

/**
 * Cross-facility stock redistribution.
 *
 * THE DECISION THIS AUTOMATES
 * ---------------------------
 * At any moment some facilities hold stock they will never use before it
 * expires, and others are about to run out of the same item. Nobody sees both
 * halves at once, so the surplus is written off and the shortage is met by an
 * emergency purchase -- or not met at all. The stock exists; the VISIBILITY
 * does not.
 *
 * WHAT THIS IS, HONESTLY
 * ----------------------
 * The exact formulation is a min-cost flow on a bipartite graph of donors and
 * receivers. What is implemented here is a GREEDY heuristic over the same
 * objective: receivers are served in order of the harm their shortage causes,
 * and each is matched to the donor with the best benefit-to-cost ratio.
 *
 * Greedy is not optimal, and we do not claim it is. It is chosen because it is
 * explainable -- a district officer can read why each specific transfer was
 * proposed, which matters far more for adoption than the last few percent of
 * theoretical efficiency. `evaluatePlan` reports the objective value so a
 * min-cost-flow solver can be dropped in later and compared directly.
 *
 * HARD CONSTRAINTS
 * ----------------
 *   1. A donor may never fall below its own reorder point. We do not solve one
 *      stock-out by creating another.
 *   2. Cold-chain items only move within cold-box range.
 *   3. A receiver must actually carry the item in its formulary.
 *   4. An order may only move units that named batches physically hold, and no
 *      batch may be promised twice across the plan. A quantity a storekeeper
 *      cannot pick is not a recommendation, it is a discrepancy report.
 *
 * WHAT THE PLAN KEEPS
 * -------------------
 * Both halves. `transfers` is what the system decided to do; `unserved` is
 * every need it looked at and declined, with the reason it declined. The second
 * list is the more informative one -- it is the denominator, and it is where
 * the binding constraint on this whole idea shows up.
 */

export interface TransferContext {
  facility: Facility;
  drug: CatalogueDrug;
  fit: DemandFit;
  risk: StockRisk;
  batches: StockBatch[];
  leadTimeDays: number;
}

/**
 * Harm value of one unit of unmet demand, as a MULTIPLE of the unit cost.
 *
 * This is a POLICY PARAMETER, not a measurement. It encodes the judgement that
 * failing to supply a Vital drug costs far more than the drug is worth, and it
 * is exposed here rather than buried so that a ministry can set its own value
 * and see the plan change. The defaults are deliberately conservative.
 */
export const DEFAULT_SHORTAGE_PENALTY: Record<VedClass, number> = {
  V: 25,
  E: 8,
  D: 2,
};

export interface RedistributionOptions {
  asOf: Date;
  maxDistanceKm?: number;
  coldChainMaxDistanceKm?: number;
  shortagePenalty?: Record<VedClass, number>;
  tripFixedCostInr?: number;
  perKmCostInr?: number;
  coldChainMultiplier?: number;
  /** A transfer must return at least this much benefit per rupee spent. */
  minBenefitCostRatio?: number;
  maxTransfers?: number;
  simulations?: number;
  /**
   * Cost of adding one more drug line to a vehicle that is already going:
   * picking, packing, paperwork and the receiving check. Not haulage -- the
   * vehicle is paid for by the order that justified it.
   *
   * This is the number that makes consolidation matter. At Rs450 + Rs18/km, a
   * dedicated trip for a second drug on a route a truck is already driving is
   * not a transport decision, it is an accounting artefact.
   */
  perLineHandlingInr?: number;
  /**
   * Let a need that failed the benefit/cost gate ride a corridor some other
   * order has already opened, priced at handling only.
   *
   * Off leaves the planner's decisions exactly as they were.
   */
  rideAlongs?: boolean;
  /**
   * Restrict which contexts may RECEIVE. Everything supplied can still donate.
   *
   * This is what makes a cross-district pass possible without giving this
   * module a notion of a district. The caller hands in one district's contexts
   * plus its neighbours', and scopes receivers to the district being planned:
   * the neighbours are donors only, so the plan solves this district's needs
   * and cannot quietly spend a neighbour's stock on the neighbour's own
   * problems -- which that district's own pass handles, against the same shared
   * state, when its turn comes.
   *
   * A predicate rather than a district list on purpose: the planner stays
   * domain-agnostic, and the same seam serves any other scoping a caller wants.
   */
  eligibleReceiver?: (ctx: TransferContext) => boolean;
}

const DEFAULTS = {
  maxDistanceKm: 150,
  coldChainMaxDistanceKm: 60,
  tripFixedCostInr: 450,
  perKmCostInr: 18,
  coldChainMultiplier: 1.8,
  minBenefitCostRatio: 1.5,
  maxTransfers: 500,
  simulations: 1000,
  perLineHandlingInr: 60,
  rideAlongs: true,
};

/**
 * Merge caller options over the defaults, DROPPING explicit `undefined`.
 *
 * `{ ...DEFAULTS, ...options }` does not do this, and the difference is not
 * cosmetic. A wrapper that forwards optional config -- exactly what a
 * cross-district caller looks like -- writes `{ maxDistanceKm: cfg.max }` where
 * `cfg.max` may be undefined, and then `maxDistanceKm` is undefined rather than
 * 150. Every downstream comparison silently changes meaning: `distance > undefined`
 * is false so every donor on earth is in range, and `ratio >= undefined` is
 * false so NOTHING is ever accepted and every need reports failed_bc_gate. Both
 * failures are silent and both look like a modelling result.
 */
function resolveOptions(options: RedistributionOptions): typeof DEFAULTS & { asOf: Date } {
  const out = { ...DEFAULTS } as typeof DEFAULTS & { asOf: Date };
  out.asOf = options.asOf;
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined && k !== 'asOf' && k !== 'shortagePenalty' && k !== 'eligibleReceiver') {
      (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** `from|to` -- the identity of one vehicle movement. */
function corridorKey(fromFacilityId: string, toFacilityId: string): string {
  return fromFacilityId + '|' + toFacilityId;
}

/**
 * The token pass 1 writes where the charged cost goes, substituted once the
 * trip is known.
 *
 * The rationale is generated at the moment of decision and copied verbatim onto
 * the dispatch note, deliberately -- regenerating it later from rounded fields
 * produces a sentence that quietly disagrees with the plan it describes. But
 * the charged cost is genuinely not known until every order is in, because it
 * depends on who else is travelling. A placeholder keeps one authoritative
 * sentence rather than two that can drift.
 */
const COST_TOKEN = '{{COST}}';

/** Transport cost for one dispatch. */
export function transferCost(
  distanceKm: number,
  coldChain: boolean,
  opts: Required<Pick<RedistributionOptions, 'tripFixedCostInr' | 'perKmCostInr' | 'coldChainMultiplier'>>,
): number {
  const base = opts.tripFixedCostInr + opts.perKmCostInr * distanceKm;
  return Math.round(coldChain ? base * opts.coldChainMultiplier : base);
}

/** Units a facility can give away without dropping below its own reorder point. */
export function donatableUnits(ctx: TransferContext): number {
  return Math.max(0, Math.floor(ctx.risk.onHand - ctx.risk.reorderPoint));
}

function formatQty(n: number, unit: string): string {
  return n.toLocaleString('en-IN') + ' ' + unit + (n === 1 ? '' : 's');
}

function daysUntil(iso: string, asOf: Date): number {
  return Math.round((new Date(iso + 'T00:00:00Z').getTime() - asOf.getTime()) / 86_400_000);
}

/**
 * Reserve up to `cap` units from a donor's shelves, earliest expiry first.
 *
 * WHY THIS EXISTS
 * ---------------
 * The planner used to move `min(donor surplus, receiver need)` while quoting a
 * SINGLE batch number in the rationale. Donor surplus is a facility-level
 * figure spread across every batch on the shelf, so whenever the surplus
 * exceeded the earliest-expiring batch the order asked for more units than the
 * batch it named actually held. The arithmetic was right and the paperwork was
 * unfillable, which is the failure mode that matters: nobody rejects a plan for
 * being 3% off the optimum, everybody rejects one whose first order cannot be
 * picked.
 *
 * Two things bound the quantity here. The batch must survive the journey with
 * usable life left (`minDaysUsable`), and it must not already be promised to an
 * earlier, higher-harm receiver -- `committed` carries those reservations
 * across the whole plan, because donor capacity alone cannot tell you which
 * batch the previous order emptied.
 */
function allocateFefo(
  donor: TransferContext,
  cap: number,
  minDaysUsable: number,
  committed: Map<string, number>,
  asOf: Date,
): { lines: TransferLine[]; quantity: number } {
  const lines: TransferLine[] = [];
  let quantity = 0;
  if (cap <= 0) return { lines, quantity };

  const usable = donor.batches
    .filter((b) => b.quantity > 0)
    .map((b) => ({ batch: b, daysToExpiry: daysUntil(b.expiryDate, asOf) }))
    .filter((x) => x.daysToExpiry > minDaysUsable)
    .sort((a, b) => a.batch.expiryDate.localeCompare(b.batch.expiryDate));

  for (const { batch, daysToExpiry } of usable) {
    if (quantity >= cap) break;
    // Floor: a pick list cannot ask for a fraction of a dispensing unit, and
    // rounding up would reintroduce the exact defect this function fixes.
    const free = Math.floor(batch.quantity) - (committed.get(batchKey(donor, batch)) ?? 0);
    if (free <= 0) continue;
    const take = Math.min(free, cap - quantity);
    if (take <= 0) continue;
    lines.push({ batchNo: batch.batchNo, quantity: take, expiryDate: batch.expiryDate, daysToExpiry });
    quantity += take;
  }

  return { lines, quantity };
}

function batchKey(donor: TransferContext, batch: Pick<StockBatch, 'batchNo'>): string {
  return donor.facility.id + '|' + donor.drug.id + '|' + batch.batchNo;
}

/** Book an accepted allocation against the donor's batches so it cannot be re-sold. */
function commitAllocation(donor: TransferContext, lines: TransferLine[], committed: Map<string, number>): void {
  for (const line of lines) {
    const key = batchKey(donor, line);
    committed.set(key, (committed.get(key) ?? 0) + line.quantity);
  }
}

/** The batch clause of a rationale — one batch reads exactly as it always did. */
function describeLines(lines: TransferLine[], unit: string): string {
  if (lines.length === 1) {
    return `batch ${lines[0].batchNo}, expires in ${lines[0].daysToExpiry} days`;
  }
  return (
    `${lines.length} batches: ` +
    lines.map((l) => `${l.batchNo} (${formatQty(l.quantity, unit)}, ${l.daysToExpiry} days)`).join(', ')
  );
}

/**
 * Why a facility that needed stock did not get any.
 *
 * This taxonomy is descriptive, not aspirational: each value corresponds to one
 * specific place the pass-1 donor loop gives up, and the resolution order below
 * reports the FURTHEST the search got, which is the constraint that actually
 * binds. Do not add a value here without a matching branch in the code.
 *
 *   no_surplus              nobody else in the district holds this drug above
 *                           their own reorder point -- the stock does not exist
 *   donor_stock_committed   it existed when the pass began, and earlier
 *                           higher-harm receivers took all of it
 *   out_of_range            surplus exists but every holder is beyond the
 *                           road-distance cap
 *   cold_chain_range        same, against the much tighter cold-box cap -- a
 *                           physically different constraint, so counted apart
 *   no_usable_batch         a donor is in range, but no batch survives the trip
 *                           with usable life left (or is already promised)
 *   failed_bc_gate          a fillable dispatch exists and is rejected on
 *                           economics: the medicine is worth less than the trip
 */
export type UnservedReason =
  | 'no_surplus'
  | 'donor_stock_committed'
  | 'out_of_range'
  | 'cold_chain_range'
  | 'no_usable_batch'
  | 'failed_bc_gate';

export const UNSERVED_REASONS: UnservedReason[] = [
  'no_surplus',
  'donor_stock_committed',
  'out_of_range',
  'cold_chain_range',
  'no_usable_batch',
  'failed_bc_gate',
];

export type UnservedReasonHistogram = Record<UnservedReason, number>;

export function emptyReasonHistogram(): UnservedReasonHistogram {
  return {
    no_surplus: 0,
    donor_stock_committed: 0,
    out_of_range: 0,
    cold_chain_range: 0,
    no_usable_batch: 0,
    failed_bc_gate: 0,
  };
}

/**
 * One need the optimiser could not serve.
 *
 * Denormalised (names and VED carried alongside the ids) for the same reason
 * the alert rows are: whatever renders this has no catalogue to join against,
 * and a shortfall list that cannot say WHICH drug at WHICH facility is not a
 * finding, it is a number.
 */
export interface UnservedNeed {
  facilityId: string;
  facilityName: string;
  facilityType: FacilityType;
  drugId: string;
  drugName: string;
  ved: VedClass;
  unit: string;
  /** Units required to bring the facility back to its reorder point. */
  neededUnits: number;
  /**
   * Expected units of demand that will go unmet before replenishment lands.
   *
   * Taken from the samples the planner itself drew, not from `risk`, so the
   * number in this row is the number the decision was made against.
   */
  expectedShortfallUnits: number;
  /** P(hitting zero before replenishment lands), 0..1, at current on-hand. */
  stockoutProbability: number;
  onHand: number;
  reason: UnservedReason;
  /** Road km to the closest facility holding any surplus, in range or not. */
  nearestDonorKm: number | null;
  /** Best benefit/cost ratio any fillable dispatch reached — the gate is `minBenefitCostRatio`. */
  bestBenefitCostRatio: number | null;
}

export interface RedistributionPlan {
  transfers: TransferRecommendation[];
  /**
   * The vehicle movements behind those transfers, one per route.
   *
   * `transfers.length` is what a storekeeper picks; `trips.length` is what the
   * transport budget pays for. Keeping both is the point -- the gap between
   * them was the single largest error in this model's economics.
   */
  trips: CorridorTrip[];
  /** Total transport spend, INR. Summed over TRIPS, not over transfers. */
  totalCostInr: number;
  /** Expected units of unmet demand averted across the plan. */
  totalShortfallAverted: number;
  /** Units rescued from expiring unused. */
  totalWasteAvertedUnits: number;
  /** Value of that rescued stock, INR. */
  totalWasteAvertedInr: number;
  /**
   * Total modelled benefit before transport, INR: averted harm valued at the
   * VED shortage penalty, plus stock rescued from expiry at unit cost.
   *
   * Exposed so that a caller recomputing the bill -- which corridor
   * consolidation does -- can subtract a new cost from the same benefit rather
   * than reconstructing it from a rounded net.
   */
  grossBenefitInr: number;
  /** Objective value: total benefit minus total cost, INR. */
  netBenefitInr: number;
  /** Receivers that needed stock but had no feasible donor. Equals `unserved.length`. */
  unservedReceivers: number;
  /**
   * The needs behind that count, one row each, with the reason for the refusal.
   *
   * Kept rather than counted because "we served 15" is a numerator and nobody
   * believes a numerator. The denominator, broken down by why each need failed,
   * is what tells a district officer whether the answer is more visibility,
   * more stock, or a bigger transport budget -- and those are different asks.
   */
  unserved: UnservedNeed[];
  /** `unserved` tallied by reason. Every key present, zeros included. */
  unservedByReason: UnservedReasonHistogram;
  /**
   * Needs that failed the benefit/cost gate on their own and were served anyway
   * because a vehicle was already going to that facility.
   *
   * Reported separately because it is the whole argument for consolidation: it
   * counts the stock-outs that were being declined for the price of a truck
   * nobody needed to hire.
   */
  rideAlongsServed: number;
  /** Trips whose two endpoints sit in different districts. */
  crossDistrictTrips: number;
}

/**
 * Build a transfer plan for ONE drug across a set of facilities.
 *
 * Scoped per drug because a dispatch carries what it carries -- combining drugs
 * onto one vehicle is a routing problem we deliberately do not solve here.
 * `planRedistribution` runs this across a whole catalogue.
 */
/**
 * State that must outlive one drug's plan.
 *
 * `planRedistribution` runs `planForDrug` once per drug. Anything that has to
 * stay consistent ACROSS drugs -- which batches are already promised, how much
 * each donor has left, how much of a donor's expiring stock has already been
 * claimed as rescued -- has to live above that loop, or each drug plans as if
 * it were the only one.
 *
 * Keys are namespaced by drug where the quantity is per drug, which is why this
 * is safe to share: `capacity` is `facilityId|drugId` (a facility's surplus of
 * paracetamol is not its surplus of ORS), and `committed` is
 * `facilityId|drugId|batchNo`.
 */
export interface PlannerState {
  /** Units each (facility, drug) can still give away. */
  capacity: Map<string, number>;
  /** Units already promised out of each specific batch. */
  committed: Map<string, number>;
  /**
   * Expiring units at each (facility, drug) not yet claimed as rescued.
   *
   * Without this, `wasteAverted` is computed against the donor's ORIGINAL
   * projected waste for every order independently, so two orders off the same
   * shelf each claim the same rescued units and the plan's benefit -- and
   * therefore its net -- overstates. Consolidation concentrates orders on the
   * same donor pairs, which makes that double-count more likely, not less.
   */
  wasteBudget: Map<string, number>;
}

function capKey(ctx: TransferContext): string {
  return ctx.facility.id + '|' + ctx.drug.id;
}

export function newPlannerState(): PlannerState {
  return { capacity: new Map(), committed: new Map(), wasteBudget: new Map() };
}

export function planForDrug(
  contexts: TransferContext[],
  options: RedistributionOptions,
  sharedState?: PlannerState,
): RedistributionPlan {
  const o = resolveOptions(options);
  const penalty = options.shortagePenalty ?? DEFAULT_SHORTAGE_PENALTY;

  const transfers: TransferRecommendation[] = [];
  let totalCostInr = 0;
  let totalShortfallAverted = 0;
  let totalWasteAvertedUnits = 0;
  let totalWasteAvertedInr = 0;
  let totalBenefitInr = 0;
  const unserved: UnservedNeed[] = [];
  const unservedByReason = emptyReasonHistogram();

  // Mutable donor capacity, so successive transfers cannot over-commit one
  // donor. Shared across drugs when the caller supplies state, so that a
  // ride-along pass sees what the anchor pass already spent.
  const state = sharedState ?? newPlannerState();
  const capacity = state.capacity;
  const wasteBudget = state.wasteBudget;
  for (const c of contexts) {
    const k = capKey(c);
    if (!capacity.has(k)) capacity.set(k, donatableUnits(c));
    if (!wasteBudget.has(k)) wasteBudget.set(k, c.risk.projectedExpiryWaste);
  }

  // Whether there was anything to give at the START of the pass, so a receiver
  // reached after the surplus has been spent can say so instead of reporting
  // "no stock anywhere". Those are opposite diagnoses: one needs procurement,
  // the other needs a better allocation than greedy.
  // (A facility cannot be on both sides of this: surplus means it is above its
  // reorder point, and a need means it is below. So testing the whole map,
  // receiver included, cannot produce a false positive.)
  // Scoped to THIS drug's contexts, not to the whole shared map. With state
  // shared across drugs, `[...capacity.values()]` would answer "did anything,
  // anywhere, have surplus of any drug" -- and a district genuinely out of
  // antivenom would be told its antivenom had been taken by someone else.
  const anyInitialSurplus = contexts.some((c) => (capacity.get(capKey(c)) ?? 0) > 0);

  // Units already promised out of a specific batch, across both passes.
  const committed = state.committed;

  // Receivers: anyone expecting to fall short. Served worst-harm-first.
  // `eligibleReceiver` narrows who may receive without narrowing who may give,
  // which is how a cross-district pass draws on a neighbour's surplus without
  // also planning the neighbour's district.
  const eligible = options.eligibleReceiver;
  const receivers = contexts
    .filter((c) => c.risk.expectedShortfallUnits > 0.5)
    .filter((c) => !eligible || eligible(c))
    .sort(
      (a, b) =>
        b.risk.expectedShortfallUnits * penalty[b.drug.ved] -
        a.risk.expectedShortfallUnits * penalty[a.drug.ved],
    );

  for (const receiver of receivers) {
    if (transfers.length >= o.maxTransfers) break;

    const drug = receiver.drug;
    const maxDist = drug.coldChain ? o.coldChainMaxDistanceKm : o.maxDistanceKm;

    // Draw the receiver's lead-time demand distribution once; every candidate
    // quantity is then priced against the same samples.
    const samples = leadTimeDemandSamples(
      receiver.facility.id,
      drug,
      receiver.fit,
      receiver.leadTimeDays,
      o.asOf,
      o.simulations,
    );
    const shortfallBefore = expectedShortfall(samples, receiver.risk.onHand);
    const probBefore = stockoutProbabilityAt(samples, receiver.risk.onHand);
    if (shortfallBefore <= 0.5) continue;

    // Bring the receiver up to its service-level target, no further.
    const need = Math.max(0, Math.ceil(receiver.risk.reorderPoint - receiver.risk.onHand));
    if (need <= 0) continue;

    let best: {
      donor: TransferContext;
      qty: number;
      distance: number;
      cost: number;
      benefit: number;
      ratio: number;
      wasteAverted: number;
      shortfallAverted: number;
      probAfter: number;
      lines: TransferLine[];
    } | null = null;

    // How far the search got before every candidate fell over. Read off in
    // precedence order below to name the constraint that actually binds.
    let sawSurplus = false;
    let sawInRange = false;
    let sawFillable = false;
    let nearestDonorKm: number | null = null;
    let bestRatioSeen: number | null = null;

    for (const donor of contexts) {
      if (donor.facility.id === receiver.facility.id) continue;

      const available = capacity.get(capKey(donor)) ?? 0;
      if (available <= 0) continue;
      sawSurplus = true;

      const distance = roadDistanceKm(
        donor.facility.lat,
        donor.facility.lon,
        receiver.facility.lat,
        receiver.facility.lon,
      );
      if (nearestDonorKm === null || distance < nearestDonorKm) nearestDonorKm = distance;
      if (distance > maxDist) continue;
      sawInRange = true;

      // Move the earliest-expiring usable batch first (FEFO). That is both good
      // practice and the source of most of the benefit. The walk also fixes the
      // quantity: the order can only move what the batches it names can fill.
      const { lines, quantity: qty } = allocateFefo(
        donor,
        Math.min(available, need),
        distance / 200 + 3,
        committed,
        o.asOf,
      );
      if (qty <= 0) continue;
      sawFillable = true;

      const shortfallAfter = expectedShortfall(samples, receiver.risk.onHand + qty);
      const shortfallAverted = Math.max(0, shortfallBefore - shortfallAfter);

      // Units the donor was going to lose anyway are pure gain when moved.
      // Against what is LEFT of this donor's expiring stock, not against its
      // original projection: two orders off the same shelf must not each claim
      // the same rescued units as a benefit.
      const wasteAverted = Math.min(qty, wasteBudget.get(capKey(donor)) ?? 0);

      const harmValueInr = shortfallAverted * drug.unitCostInr * penalty[drug.ved];
      const wasteValueInr = wasteAverted * drug.unitCostInr;
      const benefit = harmValueInr + wasteValueInr;

      const cost = transferCost(distance, drug.coldChain, o);
      const ratio = cost > 0 ? benefit / cost : Infinity;
      if (bestRatioSeen === null || ratio > bestRatioSeen) bestRatioSeen = ratio;

      if (ratio >= o.minBenefitCostRatio && (!best || ratio > best.ratio)) {
        best = {
          donor,
          qty,
          distance,
          cost,
          benefit,
          ratio,
          wasteAverted,
          shortfallAverted,
          probAfter: stockoutProbabilityAt(samples, receiver.risk.onHand + qty),
          lines,
        };
      }
    }

    if (!best) {
      // Furthest progress wins: reaching the economics gate is a different
      // problem from having no stock, and conflating them would turn the most
      // useful thing this list says into noise.
      const reason: UnservedReason = sawFillable
        ? 'failed_bc_gate'
        : sawInRange
          ? 'no_usable_batch'
          : sawSurplus
            ? drug.coldChain
              ? 'cold_chain_range'
              : 'out_of_range'
            : anyInitialSurplus
              ? 'donor_stock_committed'
              : 'no_surplus';

      unserved.push({
        facilityId: receiver.facility.id,
        facilityName: receiver.facility.name,
        facilityType: receiver.facility.type,
        drugId: drug.id,
        drugName: drug.name,
        ved: drug.ved,
        unit: drug.unit,
        neededUnits: need,
        expectedShortfallUnits: +shortfallBefore.toFixed(2),
        stockoutProbability: +probBefore.toFixed(4),
        onHand: receiver.risk.onHand,
        reason,
        nearestDonorKm: nearestDonorKm === null ? null : +nearestDonorKm.toFixed(1),
        bestBenefitCostRatio:
          bestRatioSeen === null || !Number.isFinite(bestRatioSeen) ? null : +bestRatioSeen.toFixed(3),
      });
      unservedByReason[reason]++;
      continue;
    }

    const donorKey = capKey(best.donor);
    capacity.set(donorKey, (capacity.get(donorKey) ?? 0) - best.qty);
    wasteBudget.set(donorKey, Math.max(0, (wasteBudget.get(donorKey) ?? 0) - best.wasteAverted));
    commitAllocation(best.donor, best.lines, committed);

    const rationale =
      `${best.donor.facility.name} can spare ${formatQty(best.qty, drug.unit)} ` +
      `(${describeLines(best.lines, drug.unit)}) while ` +
      `${receiver.facility.name} holds ${formatQty(receiver.risk.onHand, drug.unit)} ` +
      `against a ${(probBefore * 100).toFixed(0)}% chance of running short within its ` +
      `${receiver.leadTimeDays}-day resupply window. Moving them ${best.distance.toFixed(0)} km ` +
      `costs ${COST_TOKEN} and averts an expected ` +
      `${best.shortfallAverted.toFixed(1)} ${drug.unit}s of unmet demand, cutting stock-out risk to ` +
      `${(best.probAfter * 100).toFixed(0)}%.`;

    transfers.push({
      fromFacilityId: best.donor.facility.id,
      toFacilityId: receiver.facility.id,
      drugId: drug.id,
      quantity: best.qty,
      batchNo: best.lines[0].batchNo,
      lines: best.lines,
      distanceKm: best.distance,
      // Provisional: consolidation replaces this with the order's share of a
      // shared trip once every order is in.
      estimatedCostInr: best.cost,
      standaloneCostInr: best.cost,
      corridorId: corridorKey(best.donor.facility.id, receiver.facility.id),
      rideAlong: false,
      coldUpgradeInr: 0,
      wasteAvertedUnits: best.wasteAverted,
      shortfallAvertedUnits: +best.shortfallAverted.toFixed(2),
      riskReduction: Math.max(0, probBefore - best.probAfter),
      rationale,
    });

    totalCostInr += best.cost;
    totalShortfallAverted += best.shortfallAverted;
    totalWasteAvertedUnits += best.wasteAverted;
    totalWasteAvertedInr += best.wasteAverted * drug.unitCostInr;
    totalBenefitInr += best.benefit;
  }

  // ---------------------------------------------------------------------
  // PASS 2 -- EXPIRY RESCUE (donor-driven)
  //
  // Pass 1 asks "who is short, and who can supply them?". That question never
  // reaches stock which is quietly dying on a shelf next to nobody in crisis:
  // it only gets moved if some nearby facility happens to be at risk for the
  // same item. In practice most avoidable waste is exactly that -- surplus with
  // no matching emergency.
  //
  // So this pass asks the opposite question: "this stock will expire; who can
  // actually USE it in time?" The receiver does not need to be at risk. It only
  // needs to consume the units before the batch dies, which is a check on its
  // demand rate and the days remaining, not on its risk score.
  //
  // The benefit is avoided procurement: units the receiver would otherwise have
  // had to buy, valued at unit cost. That is deliberately conservative -- it
  // ignores any stock-out risk the transfer also happens to relieve.
  // ---------------------------------------------------------------------
  const wasteDonors = contexts
    .filter((c) => (wasteBudget.get(capKey(c)) ?? 0) > 0 && (capacity.get(capKey(c)) ?? 0) > 0)
    .sort((a, b) => b.risk.projectedExpiryWaste * b.drug.unitCostInr - a.risk.projectedExpiryWaste * a.drug.unitCostInr);

  // Track units already pushed into a facility this round so we do not simply
  // relocate the expiry problem from one shelf to another.
  const received = new Map<string, number>();

  for (const donor of wasteDonors) {
    if (transfers.length >= o.maxTransfers) break;

    const drug = donor.drug;
    const maxDist = drug.coldChain ? o.coldChainMaxDistanceKm : o.maxDistanceKm;

    // Units projected to expire unused are surplus BY DEFINITION -- the FEFO
    // projection already granted this facility every unit it will consume. So
    // they are movable even when the facility sits below its own reorder point;
    // donating stock it was never going to use cannot cause it a stock-out.
    let rescuable = Math.min(wasteBudget.get(capKey(donor)) ?? 0, donor.risk.onHand);
    if (rescuable <= 0) continue;

    const dyingBatch = donor.batches
      .filter((b) => b.quantity > 0)
      .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))[0];
    if (!dyingBatch) continue;
    const daysLeft = daysUntil(dyingBatch.expiryDate, o.asOf);
    if (daysLeft <= 3) continue; // too late to move and still be usable

    // Prefer receivers that will burn through it fastest.
    const candidates = contexts
      .filter((c) => c.facility.id !== donor.facility.id && c.fit.meanDemand > 0)
      .filter((c) => !eligible || eligible(c))
      .map((c) => ({
        ctx: c,
        distance: roadDistanceKm(donor.facility.lat, donor.facility.lon, c.facility.lat, c.facility.lon),
      }))
      .filter((c) => c.distance <= maxDist)
      .sort((a, b) => b.ctx.fit.meanDemand - a.ctx.fit.meanDemand);

    for (const cand of candidates) {
      if (rescuable <= 0) break;

      const already = received.get(cand.ctx.facility.id) ?? 0;

      // The receiver must not already be holding stock that dies SOONER than
      // the incoming batch. If it is, adding more just relocates the write-off.
      const receiverEarliest = cand.ctx.batches
        .filter((b) => b.quantity > 0)
        .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))[0];
      if (receiverEarliest && receiverEarliest.expiryDate <= dyingBatch.expiryDate) continue;

      // Under FEFO the incoming short-dated batch is dispensed FIRST, so the
      // receiver's own longer-dated stock simply waits its turn rather than
      // blocking the transfer. What limits the quantity is therefore how much
      // the receiver dispenses before the batch expires -- not what it already
      // holds. (Subtracting its on-hand here was wrong, and made the rescue
      // pass reject almost every genuinely rescuable batch.)
      //
      // The 0.85 factor leaves room for the demand estimate being optimistic;
      // overshooting would move the write-off rather than prevent it.
      const consumable = cand.ctx.fit.meanDemand * daysLeft * 0.85;
      const absorbable = Math.floor(consumable - already);
      if (absorbable <= 0) continue;

      // Same rule as pass 1: the order may only move what named batches hold,
      // and short-dated stock is exactly where double-promising a batch is
      // easiest -- every rescue in this pass is reaching for the same shelf.
      const { lines, quantity: qty } = allocateFefo(
        donor,
        Math.min(rescuable, absorbable),
        3,
        committed,
        o.asOf,
      );
      if (qty < 1) continue;

      const cost = transferCost(cand.distance, drug.coldChain, o);
      const benefit = qty * drug.unitCostInr;
      const ratio = cost > 0 ? benefit / cost : Infinity;
      if (ratio < o.minBenefitCostRatio) continue;

      const dKey = capKey(donor);
      capacity.set(dKey, (capacity.get(dKey) ?? 0) - qty);
      wasteBudget.set(dKey, Math.max(0, (wasteBudget.get(dKey) ?? 0) - qty));
      commitAllocation(donor, lines, committed);
      received.set(cand.ctx.facility.id, already + qty);
      rescuable -= qty;

      transfers.push({
        fromFacilityId: donor.facility.id,
        toFacilityId: cand.ctx.facility.id,
        drugId: drug.id,
        quantity: qty,
        batchNo: lines[0].batchNo,
        lines,
        distanceKm: cand.distance,
        estimatedCostInr: cost,
        standaloneCostInr: cost,
        corridorId: corridorKey(donor.facility.id, cand.ctx.facility.id),
        rideAlong: false,
        coldUpgradeInr: 0,
        wasteAvertedUnits: qty,
        // The expiry-rescue pass values avoided procurement, not averted
        // shortage -- the receiver need not be at risk at all.
        shortfallAvertedUnits: 0,
        riskReduction: 0,
        rationale:
          `${formatQty(qty, drug.unit)} at ${donor.facility.name} (${describeLines(lines, drug.unit)}) ` +
          `cannot be used there before expiry. ` +
          `${cand.ctx.facility.name} dispenses about ${cand.ctx.fit.meanDemand.toFixed(1)} ${drug.unit}s a day ` +
          `and will consume them well before expiry. Moving them ${cand.distance.toFixed(0)} km costs ` +
          `${COST_TOKEN} and saves ₹${Math.round(benefit).toLocaleString('en-IN')} ` +
          `of stock from being written off.`,
      });

      totalCostInr += cost;
      totalWasteAvertedUnits += qty;
      totalWasteAvertedInr += benefit;
      totalBenefitInr += benefit;
    }
  }

  return {
    transfers,
    // Trips are a cross-drug notion, so they are built once in
    // `planRedistribution` after every drug has planned. A single-drug plan
    // reports its standalone costs and no trips.
    trips: [],
    totalCostInr,
    totalShortfallAverted,
    totalWasteAvertedUnits,
    totalWasteAvertedInr,
    grossBenefitInr: totalBenefitInr,
    netBenefitInr: Math.round(totalBenefitInr - totalCostInr),
    unservedReceivers: unserved.length,
    unserved,
    unservedByReason,
    rideAlongsServed: 0,
    crossDistrictTrips: 0,
  };
}

/**
 * A corridor some order has already justified a vehicle for.
 *
 * The distance and cold-chain flag are properties of the ROUTE, not of any one
 * order on it, which is what makes them safe to reuse when pricing a second.
 */
interface OpenCorridor {
  fromFacilityId: string;
  toFacilityId: string;
  distanceKm: number;
  coldChain: boolean;
}

/**
 * PASS 3 -- RIDE-ALONGS.
 *
 * WHY THIS EXISTS
 * ---------------
 * Passes 1 and 2 price every order as its own dedicated vehicle: ~Rs450 plus
 * Rs18/km, per drug. That is correct for the FIRST order between two
 * facilities and wrong for the second, because the vehicle is already going.
 * The planner could not see this, structurally: it plans one drug at a time,
 * so two orders on the same route are computed in different invocations and
 * never meet.
 *
 * The consequence was not a rounding error. 94% of all unmet need in the
 * shipped national plan was declined on the benefit/cost gate -- not for want
 * of medicine, but because the model priced a truck per tablet. A Sub-Centre
 * receiving paracetamol from its CHC was told its ORS could not be afforded,
 * for a journey already being made.
 *
 * WHAT IT DOES
 * ------------
 * Every need binned `failed_bc_gate` is re-tested against donors that are
 * ALREADY sending that exact receiver something, at handling cost instead of
 * haulage. Nothing else changes: same benefit model, same gate, same threshold.
 *
 * WHY THIS IS NOT A THUMB ON THE SCALE
 * ------------------------------------
 * A ride-along may only use a corridor an order justified at FULL price. The
 * anchor pays for the vehicle on its own merits; the ride-along pays what it
 * genuinely adds. So the plan can never invent a trip that nothing justified,
 * and the ordering artefact that would come from letting whichever drug happens
 * to be processed first pay for everyone does not arise -- pass 1 is untouched.
 *
 * A truck going A to B can only unload at B, so a ride-along must share the
 * receiver, not merely the neighbourhood. That is a physical constraint, and it
 * is why this rescues far fewer needs than the gate declines.
 */
function planRideAlongs(
  byDrug: Map<string, TransferContext[]>,
  unserved: UnservedNeed[],
  corridors: Map<string, OpenCorridor>,
  state: PlannerState,
  o: ReturnType<typeof resolveOptions>,
  penalty: Record<VedClass, number>,
): {
  transfers: TransferRecommendation[];
  rescued: Set<UnservedNeed>;
  benefitInr: number;
  shortfallAverted: number;
  wasteAvertedUnits: number;
  wasteAvertedInr: number;
} {
  const transfers: TransferRecommendation[] = [];
  const rescued = new Set<UnservedNeed>();
  let benefitInr = 0;
  let shortfallAverted = 0;
  let wasteAvertedUnits = 0;
  let wasteAvertedInr = 0;

  // Corridors indexed by where they END, because a ride-along must be going to
  // the same place.
  const byReceiver = new Map<string, OpenCorridor[]>();
  for (const c of corridors.values()) {
    const list = byReceiver.get(c.toFacilityId);
    if (list) list.push(c);
    else byReceiver.set(c.toFacilityId, [c]);
  }
  if (byReceiver.size === 0)
    return { transfers, rescued, benefitInr, shortfallAverted, wasteAvertedUnits, wasteAvertedInr };

  const ctxByKey = new Map<string, TransferContext>();
  for (const group of byDrug.values()) for (const c of group) ctxByKey.set(capKey(c), c);

  for (const need of unserved) {
    if (need.reason !== 'failed_bc_gate') continue;

    const inbound = byReceiver.get(need.facilityId);
    if (!inbound || inbound.length === 0) continue;

    const receiver = ctxByKey.get(need.facilityId + '|' + need.drugId);
    if (!receiver) continue;

    const drug = receiver.drug;
    const maxDist = drug.coldChain ? o.coldChainMaxDistanceKm : o.maxDistanceKm;

    // Re-drawn rather than carried over from pass 1: identical inputs give an
    // identical vector (the sampler seeds on facility, drug and date), so this
    // costs time and not determinism.
    const samples = leadTimeDemandSamples(
      receiver.facility.id,
      drug,
      receiver.fit,
      receiver.leadTimeDays,
      o.asOf,
      o.simulations,
    );
    const shortfallBefore = expectedShortfall(samples, receiver.risk.onHand);
    if (shortfallBefore <= 0.5) continue;
    const probBefore = stockoutProbabilityAt(samples, receiver.risk.onHand);
    const want = Math.max(0, Math.ceil(receiver.risk.reorderPoint - receiver.risk.onHand));
    if (want <= 0) continue;

    let best: {
      donor: TransferContext;
      qty: number;
      distance: number;
      benefit: number;
      ratio: number;
      wasteAverted: number;
      shortfallAverted: number;
      probAfter: number;
      lines: TransferLine[];
      /** The trip this order joins, so admitting it can mark the run cold. */
      corridor: OpenCorridor;
      /** Vehicle upgrade this order forces on that trip, or 0. */
      upgradeInr: number;
    } | null = null;

    for (const corridor of inbound) {
      if (corridor.distanceKm > maxDist) continue;
      const donor = ctxByKey.get(corridor.fromFacilityId + '|' + drug.id);
      if (!donor || donor.facility.id === receiver.facility.id) continue;

      const available = state.capacity.get(capKey(donor)) ?? 0;
      if (available <= 0) continue;

      const { lines, quantity: qty } = allocateFefo(
        donor,
        Math.min(available, want),
        corridor.distanceKm / 200 + 3,
        state.committed,
        o.asOf,
      );
      if (qty <= 0) continue;

      const shortfallAfter = expectedShortfall(samples, receiver.risk.onHand + qty);
      const shortfallAverted = Math.max(0, shortfallBefore - shortfallAfter);
      const wasteAverted = Math.min(qty, state.wasteBudget.get(capKey(donor)) ?? 0);
      const benefit = shortfallAverted * drug.unitCostInr * penalty[drug.ved] + wasteAverted * drug.unitCostInr;

      // The whole point: handling, not haulage. The vehicle is already paid for.
      //
      // WITH ONE EXCEPTION, AND IT IS NOT A SMALL ONE. If this drug needs a cold
      // box and the trip it wants to join is running ambient, admitting it
      // refrigerates the WHOLE vehicle -- `consolidateTrips` prices the run as
      // cold if any order on it is. That upgrade is 0.8x the base trip on the
      // shipped parameters, several hundred rupees, and it was being charged to
      // nobody: the gate quoted Rs60 of handling for an order whose true
      // marginal cost was Rs60 plus the upgrade. On the 128-district plan that
      // was 238 trips and Rs1.82 lakh of vehicle -- about 4.8% of the transport
      // budget -- admitted against a test it had not actually passed. The money
      // was always counted in the totals; it simply was not counted in the
      // DECISION, which is the harder error to see and the one that lets
      // through orders that should have been declined.
      const upgradeInr =
        drug.coldChain && !corridor.coldChain
          ? transferCost(corridor.distanceKm, true, o) - transferCost(corridor.distanceKm, false, o)
          : 0;
      const cost = o.perLineHandlingInr + upgradeInr;
      const ratio = cost > 0 ? benefit / cost : Number.POSITIVE_INFINITY;
      if (ratio < o.minBenefitCostRatio) continue;
      if (best && ratio <= best.ratio) continue;

      best = {
        donor,
        qty,
        distance: corridor.distanceKm,
        benefit,
        ratio,
        wasteAverted,
        shortfallAverted,
        probAfter: stockoutProbabilityAt(samples, receiver.risk.onHand + qty),
        lines,
        corridor,
        upgradeInr,
      };
    }

    if (!best) continue;

    const donorKey = capKey(best.donor);
    state.capacity.set(donorKey, (state.capacity.get(donorKey) ?? 0) - best.qty);
    state.wasteBudget.set(
      donorKey,
      Math.max(0, (state.wasteBudget.get(donorKey) ?? 0) - best.wasteAverted),
    );
    commitAllocation(best.donor, best.lines, state.committed);

    // The vehicle is refrigerated from here on, so the NEXT cold-chain order
    // wanting this trip joins a cold run and pays handling only. Without this
    // every cold rider on the same corridor would be quoted the same upgrade
    // and the corridor would be charged for several cold boxes it does not
    // hire. `consolidateTrips` bills the upgrade exactly once, to the order
    // that forced it, and this is what keeps the gate agreeing with the bill.
    if (best.upgradeInr > 0) best.corridor.coldChain = true;

    transfers.push({
      fromFacilityId: best.donor.facility.id,
      toFacilityId: receiver.facility.id,
      drugId: drug.id,
      quantity: best.qty,
      batchNo: best.lines[0].batchNo,
      lines: best.lines,
      distanceKm: best.distance,
      estimatedCostInr: o.perLineHandlingInr,
      standaloneCostInr: transferCost(best.distance, drug.coldChain, o),
      corridorId: corridorKey(best.donor.facility.id, receiver.facility.id),
      rideAlong: true,
      coldUpgradeInr: best.upgradeInr,
      wasteAvertedUnits: best.wasteAverted,
      shortfallAvertedUnits: +best.shortfallAverted.toFixed(2),
      riskReduction: Math.max(0, probBefore - best.probAfter),
      rationale:
        `${receiver.facility.name} needs ${formatQty(want, drug.unit)} of ${drug.name} and a vehicle is ` +
        `already going there from ${best.donor.facility.name} with other stock. ` +
        `Adding ${formatQty(best.qty, drug.unit)} (${describeLines(best.lines, drug.unit)}) to that run ` +
        `costs ${COST_TOKEN} in ` +
        // Naming the cold box matters on the dispatch note: this order is why
        // the vehicle has to be refrigerated, and a storekeeper reading
        // "picking and handling" against a figure several hundred rupees above
        // the handling charge would reasonably think the sheet was wrong.
        (best.upgradeInr > 0
          ? `picking, handling and the cold box it puts on that vehicle, rather than a second `
          : `picking and handling rather than a second `) +
        `₹${transferCost(best.distance, drug.coldChain, o).toLocaleString('en-IN')} vehicle, and averts an ` +
        `expected ${best.shortfallAverted.toFixed(1)} ${drug.unit}s of unmet demand, cutting stock-out risk ` +
        `from ${(probBefore * 100).toFixed(0)}% to ${(best.probAfter * 100).toFixed(0)}%.`,
    });

    rescued.add(need);
    benefitInr += best.benefit;
    shortfallAverted += best.shortfallAverted;
    wasteAvertedUnits += best.wasteAverted;
    wasteAvertedInr += best.wasteAverted * drug.unitCostInr;
  }

  return { transfers, rescued, benefitInr, shortfallAverted, wasteAvertedUnits, wasteAvertedInr };
}

/**
 * Collapse orders onto the vehicles that actually carry them, and bill once.
 *
 * Every order between the same two facilities travels together. The corridor
 * pays one trip charge -- the max over its orders, so a cold-chain line prices
 * the whole run, since the box has to be on board either way -- plus handling
 * for each additional line.
 *
 * Each order's `estimatedCostInr` becomes its SHARE, so the per-order figures a
 * district officer reads still sum to the transport budget instead of
 * over-counting it by the number of drugs. The shares are apportioned by
 * largest-remainder so that rounding cannot make them disagree with the trip
 * total by a rupee.
 *
 * `facilityDistrict` is optional and only labels the trip; nothing about the
 * arithmetic depends on it.
 */
function consolidateTrips(
  transfers: TransferRecommendation[],
  o: ReturnType<typeof resolveOptions>,
  coldChainByDrug: Map<string, boolean>,
  facilityDistrict?: Map<string, string>,
): { trips: CorridorTrip[]; totalCostInr: number } {
  const groups = new Map<string, TransferRecommendation[]>();
  for (const t of transfers) {
    const list = groups.get(t.corridorId);
    if (list) list.push(t);
    else groups.set(t.corridorId, [t]);
  }

  const trips: CorridorTrip[] = [];
  let totalCostInr = 0;

  for (const [id, orders] of groups) {
    const first = orders[0];
    const coldChain = orders.some((t) => coldChainByDrug.get(t.drugId) === true);
    const distanceKm = Math.max(...orders.map((t) => t.distanceKm));
    const tripCostInr = transferCost(distanceKm, coldChain, o);
    const handlingCostInr = o.perLineHandlingInr * Math.max(0, orders.length - 1);
    const total = tripCostInr + handlingCostInr;

    const fromDistrict = facilityDistrict?.get(first.fromFacilityId);
    const toDistrict = facilityDistrict?.get(first.toFacilityId);

    trips.push({
      id,
      fromFacilityId: first.fromFacilityId,
      toFacilityId: first.toFacilityId,
      distanceKm,
      coldChain,
      tripCostInr,
      handlingCostInr,
      totalCostInr: total,
      orders: orders.length,
      crossDistrict: Boolean(fromDistrict && toDistrict && fromDistrict !== toDistrict),
    });
    totalCostInr += total;

    // Apportionment mirrors the decision rule, rather than splitting evenly.
    //
    // A ride-along was admitted on the promise that it costs handling and not
    // haulage, so that is what it is billed -- charging it a share of a vehicle
    // it did not justify would make the per-order column contradict the
    // sentence that justified the order. The anchors, which each had to clear
    // the gate against a full trip, carry what remains.
    //
    // Largest-remainder over the anchors so the integer shares sum EXACTLY to
    // the trip: rounding each of an even split would leave the per-order column
    // disagreeing with the transport budget by a few rupees, which is precisely
    // the class of quiet inconsistency this change exists to remove.
    // A cold-chain rider joining an ambient run refrigerates the whole vehicle,
    // and that upgrade is billed to the rider that caused it rather than spread
    // over the anchors. Two reasons, and the second is the important one: the
    // anchors each cleared the gate against an ambient trip and would not have
    // cleared it against this one, and the rider's own gate was tested against
    // exactly this figure -- so billing it here is what keeps the decision and
    // the invoice describing the same transaction. At most one order per trip
    // carries it: the first cold arrival marks the run cold and every later one
    // joins a vehicle that is already refrigerated.
    const riders = orders.filter((t) => t.rideAlong);
    const anchors = orders.filter((t) => !t.rideAlong);
    for (const t of riders) t.estimatedCostInr = o.perLineHandlingInr + t.coldUpgradeInr;

    // Every order on a corridor can be a rider only if the anchor that opened
    // it was later dropped, which cannot happen -- but if it ever did, the
    // vehicle would still have to be paid for by someone on board.
    const payers = anchors.length > 0 ? anchors : orders;
    const owed =
      anchors.length > 0
        ? total - riders.reduce((acc, t) => acc + o.perLineHandlingInr + t.coldUpgradeInr, 0)
        : total;
    const base = Math.floor(owed / payers.length);
    let remainder = owed - base * payers.length;
    const ordered = [...payers].sort(
      (a, b) => b.standaloneCostInr - a.standaloneCostInr || a.drugId.localeCompare(b.drugId),
    );
    for (const t of ordered) {
      t.estimatedCostInr = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
    }
  }

  return { trips, totalCostInr };
}

/**
 * Run the planner across every drug present in `contexts`.
 *
 * Three phases. Pass 1 and 2 (inside `planForDrug`) decide what is worth moving
 * when each order must justify its own vehicle. Pass 3 re-tests the needs that
 * failed on economics against the vehicles those decisions have already
 * committed to. Then the bill is recomputed against trips rather than orders.
 *
 * NOTHING HERE READS A DISTRICT CODE. Feasibility is decided by road distance
 * between two facilities and by nothing else, so handing this the contexts of
 * several districts at once plans across them with no change -- which is
 * exactly how cross-district redistribution is built on top of it. The only
 * caller-side requirements are that the contexts come from one seed and scale,
 * that no (facility, drug) pair appears twice, and that `maxDistanceKm` is
 * raised enough for the longer hauls to be in range.
 */
export function planRedistribution(
  contexts: TransferContext[],
  options: RedistributionOptions,
  sharedState?: PlannerState,
): RedistributionPlan {
  const o = resolveOptions(options);
  const penalty = options.shortagePenalty ?? DEFAULT_SHORTAGE_PENALTY;
  const state = sharedState ?? newPlannerState();

  const byDrug = new Map<string, TransferContext[]>();
  const coldChainByDrug = new Map<string, boolean>();
  const facilityDistrict = new Map<string, string>();
  for (const c of contexts) {
    const list = byDrug.get(c.drug.id);
    if (list) list.push(c);
    else byDrug.set(c.drug.id, [c]);
    coldChainByDrug.set(c.drug.id, c.drug.coldChain);
    facilityDistrict.set(c.facility.id, c.facility.districtCode);
  }

  const merged: RedistributionPlan = {
    transfers: [],
    trips: [],
    totalCostInr: 0,
    totalShortfallAverted: 0,
    totalWasteAvertedUnits: 0,
    totalWasteAvertedInr: 0,
    grossBenefitInr: 0,
    netBenefitInr: 0,
    unservedReceivers: 0,
    unserved: [],
    unservedByReason: emptyReasonHistogram(),
    rideAlongsServed: 0,
    crossDistrictTrips: 0,
  };

  let totalBenefitInr = 0;

  for (const group of byDrug.values()) {
    const plan = planForDrug(group, options, state);
    merged.transfers.push(...plan.transfers);
    merged.unserved.push(...plan.unserved);
    for (const reason of UNSERVED_REASONS) merged.unservedByReason[reason] += plan.unservedByReason[reason];
    merged.totalShortfallAverted += plan.totalShortfallAverted;
    merged.totalWasteAvertedUnits += plan.totalWasteAvertedUnits;
    merged.totalWasteAvertedInr += plan.totalWasteAvertedInr;
    // The cost side is rebuilt from trips below, so only the benefit side is
    // accumulated here -- and from the gross figure, not from a rounded net
    // plus the cost it was netted against.
    totalBenefitInr += plan.grossBenefitInr;
  }

  // ---- PASS 3: ride-alongs on corridors pass 1 and 2 already opened --------
  if (o.rideAlongs) {
    const corridors = new Map<string, OpenCorridor>();
    for (const t of merged.transfers) {
      const cold = coldChainByDrug.get(t.drugId) === true;
      const seen = corridors.get(t.corridorId);
      if (seen) {
        // OR, not first-wins. `consolidateTrips` prices a trip as refrigerated
        // if ANY order on it needs a cold box, so a corridor whose first order
        // happens to be tablets and whose second is a vaccine is already a cold
        // run. Recording it from the first order alone told pass 3 the vehicle
        // was ambient and let it sell a cold-chain seat that was already paid
        // for -- and, worse, quote an upgrade against a trip that had one.
        seen.coldChain = seen.coldChain || cold;
        seen.distanceKm = Math.max(seen.distanceKm, t.distanceKm);
        continue;
      }
      corridors.set(t.corridorId, {
        fromFacilityId: t.fromFacilityId,
        toFacilityId: t.toFacilityId,
        distanceKm: t.distanceKm,
        coldChain: cold,
      });
    }

    const extra = planRideAlongs(byDrug, merged.unserved, corridors, state, o, penalty);

    if (extra.transfers.length > 0) {
      merged.transfers.push(...extra.transfers);
      merged.rideAlongsServed = extra.transfers.length;
      merged.totalShortfallAverted += extra.shortfallAverted;
      merged.totalWasteAvertedUnits += extra.wasteAvertedUnits;
      merged.totalWasteAvertedInr += extra.wasteAvertedInr;
      totalBenefitInr += extra.benefitInr;
      // A rescued need is no longer unserved, and the histogram has to agree --
      // `unservedReceivers` is documented as equal to `unserved.length`.
      merged.unserved = merged.unserved.filter((u) => !extra.rescued.has(u));
      merged.unservedByReason.failed_bc_gate -= extra.rescued.size;
    }
  }

  // ---- Bill against vehicles, not orders ----------------------------------
  const { trips, totalCostInr } = consolidateTrips(merged.transfers, o, coldChainByDrug, facilityDistrict);
  merged.trips = trips;
  merged.totalCostInr = totalCostInr;
  merged.crossDistrictTrips = trips.filter((t) => t.crossDistrict).length;

  merged.grossBenefitInr = totalBenefitInr;
  merged.netBenefitInr = Math.round(totalBenefitInr - totalCostInr);

  merged.unservedReceivers = merged.unserved.length;

  // The charged cost is only knowable now, so the sentence written at the
  // moment of decision gets its number here.
  for (const t of merged.transfers) {
    t.rationale = t.rationale.replace(COST_TOKEN, '₹' + t.estimatedCostInr.toLocaleString('en-IN'));
  }

  // Highest-value dispatches first -- that is the order a district officer works in.
  merged.transfers.sort((a, b) => b.riskReduction - a.riskReduction);
  // Worst unmet need first, for the same reason: the top of this list is the
  // next thing that has to be procured or escalated.
  merged.unserved.sort((a, b) => b.expectedShortfallUnits - a.expectedShortfallUnits);
  return merged;
}
