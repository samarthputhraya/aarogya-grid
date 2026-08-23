import type {
  Facility,
  FacilityType,
  StockBatch,
  StockRisk,
  TransferLine,
  TransferRecommendation,
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
};

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
  /** Total transport spend, INR. */
  totalCostInr: number;
  /** Expected units of unmet demand averted across the plan. */
  totalShortfallAverted: number;
  /** Units rescued from expiring unused. */
  totalWasteAvertedUnits: number;
  /** Value of that rescued stock, INR. */
  totalWasteAvertedInr: number;
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
}

/**
 * Build a transfer plan for ONE drug across a set of facilities.
 *
 * Scoped per drug because a dispatch carries what it carries -- combining drugs
 * onto one vehicle is a routing problem we deliberately do not solve here.
 * `planRedistribution` runs this across a whole catalogue.
 */
export function planForDrug(
  contexts: TransferContext[],
  options: RedistributionOptions,
): RedistributionPlan {
  const o = { ...DEFAULTS, ...options };
  const penalty = options.shortagePenalty ?? DEFAULT_SHORTAGE_PENALTY;

  const transfers: TransferRecommendation[] = [];
  let totalCostInr = 0;
  let totalShortfallAverted = 0;
  let totalWasteAvertedUnits = 0;
  let totalWasteAvertedInr = 0;
  let totalBenefitInr = 0;
  const unserved: UnservedNeed[] = [];
  const unservedByReason = emptyReasonHistogram();

  // Mutable donor capacity, so successive transfers cannot over-commit one donor.
  const capacity = new Map<string, number>();
  for (const c of contexts) capacity.set(c.facility.id, donatableUnits(c));

  // Whether there was anything to give at the START of the pass, so a receiver
  // reached after the surplus has been spent can say so instead of reporting
  // "no stock anywhere". Those are opposite diagnoses: one needs procurement,
  // the other needs a better allocation than greedy.
  // (A facility cannot be on both sides of this: surplus means it is above its
  // reorder point, and a need means it is below. So testing the whole map,
  // receiver included, cannot produce a false positive.)
  const anyInitialSurplus = [...capacity.values()].some((v) => v > 0);

  // Units already promised out of a specific batch, across both passes.
  const committed = new Map<string, number>();

  // Receivers: anyone expecting to fall short. Served worst-harm-first.
  const receivers = contexts
    .filter((c) => c.risk.expectedShortfallUnits > 0.5)
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

      const available = capacity.get(donor.facility.id) ?? 0;
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
      const wasteAverted = Math.min(qty, donor.risk.projectedExpiryWaste);

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

    capacity.set(best.donor.facility.id, (capacity.get(best.donor.facility.id) ?? 0) - best.qty);
    commitAllocation(best.donor, best.lines, committed);

    const rationale =
      `${best.donor.facility.name} can spare ${formatQty(best.qty, drug.unit)} ` +
      `(${describeLines(best.lines, drug.unit)}) while ` +
      `${receiver.facility.name} holds ${formatQty(receiver.risk.onHand, drug.unit)} ` +
      `against a ${(probBefore * 100).toFixed(0)}% chance of running short within its ` +
      `${receiver.leadTimeDays}-day resupply window. Moving them ${best.distance.toFixed(0)} km ` +
      `costs ${'₹'}${best.cost.toLocaleString('en-IN')} and averts an expected ` +
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
      estimatedCostInr: best.cost,
      wasteAvertedUnits: best.wasteAverted,
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
    .filter((c) => c.risk.projectedExpiryWaste > 0 && (capacity.get(c.facility.id) ?? 0) > 0)
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
    let rescuable = Math.min(donor.risk.projectedExpiryWaste, donor.risk.onHand);
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

      capacity.set(donor.facility.id, (capacity.get(donor.facility.id) ?? 0) - qty);
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
        wasteAvertedUnits: qty,
        riskReduction: 0,
        rationale:
          `${formatQty(qty, drug.unit)} at ${donor.facility.name} (${describeLines(lines, drug.unit)}) ` +
          `cannot be used there before expiry. ` +
          `${cand.ctx.facility.name} dispenses about ${cand.ctx.fit.meanDemand.toFixed(1)} ${drug.unit}s a day ` +
          `and will consume them well before expiry. Moving them ${cand.distance.toFixed(0)} km costs ` +
          `₹${cost.toLocaleString('en-IN')} and saves ₹${Math.round(benefit).toLocaleString('en-IN')} ` +
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
    totalCostInr,
    totalShortfallAverted,
    totalWasteAvertedUnits,
    totalWasteAvertedInr,
    netBenefitInr: Math.round(totalBenefitInr - totalCostInr),
    unservedReceivers: unserved.length,
    unserved,
    unservedByReason,
  };
}

/** Run the planner across every drug present in `contexts`. */
export function planRedistribution(
  contexts: TransferContext[],
  options: RedistributionOptions,
): RedistributionPlan {
  const byDrug = new Map<string, TransferContext[]>();
  for (const c of contexts) {
    const list = byDrug.get(c.drug.id);
    if (list) list.push(c);
    else byDrug.set(c.drug.id, [c]);
  }

  const merged: RedistributionPlan = {
    transfers: [],
    totalCostInr: 0,
    totalShortfallAverted: 0,
    totalWasteAvertedUnits: 0,
    totalWasteAvertedInr: 0,
    netBenefitInr: 0,
    unservedReceivers: 0,
    unserved: [],
    unservedByReason: emptyReasonHistogram(),
  };

  for (const group of byDrug.values()) {
    const plan = planForDrug(group, options);
    merged.transfers.push(...plan.transfers);
    merged.unserved.push(...plan.unserved);
    for (const reason of UNSERVED_REASONS) merged.unservedByReason[reason] += plan.unservedByReason[reason];
    merged.totalCostInr += plan.totalCostInr;
    merged.totalShortfallAverted += plan.totalShortfallAverted;
    merged.totalWasteAvertedUnits += plan.totalWasteAvertedUnits;
    merged.totalWasteAvertedInr += plan.totalWasteAvertedInr;
    merged.netBenefitInr += plan.netBenefitInr;
    merged.unservedReceivers += plan.unservedReceivers;
  }

  // Highest-value dispatches first -- that is the order a district officer works in.
  merged.transfers.sort((a, b) => b.riskReduction - a.riskReduction);
  // Worst unmet need first, for the same reason: the top of this list is the
  // next thing that has to be procured or escalated.
  merged.unserved.sort((a, b) => b.expectedShortfallUnits - a.expectedShortfallUnits);
  return merged;
}
