import type { Facility, StockBatch, StockTransaction, ReportSource } from '@/lib/domain/types';
import type { CatalogueDrug } from '@/lib/domain/drugs';
import { SEASONAL_PROFILES } from '@/lib/forecast/seasonality';
import { createRng, hashSeed, type Rng } from '@/lib/rng';
import { facilityLeadTime, CATCHMENT } from './facilities';

/**
 * Day-by-day inventory simulation.
 *
 * THE POINT OF THIS FILE: CENSORED DEMAND
 * ---------------------------------------
 * When a PHC runs out of a drug, its records do not show unmet demand. They
 * show ZERO CONSUMPTION -- because nothing was dispensed. A patient turned away
 * leaves no trace in the ledger.
 *
 * That single fact quietly breaks naive forecasting everywhere it is deployed.
 * A facility that stocks out repeatedly looks like a facility with low demand,
 * so the next allocation is smaller, so it stocks out sooner. The forecast
 * causes the shortage it then justifies. This is a well-known failure mode in
 * inventory theory and it is endemic in public health supply chains.
 *
 * So the simulator tracks BOTH series:
 *   - `recordedSeries` -- what an HMIS/DVDMS extract would contain. Censored.
 *   - `trueSeries`     -- the demand that actually presented. Never observable.
 *
 * The forecasting engine is only ever shown `recordedSeries`, exactly as it
 * would be in production. `trueSeries` exists so we can MEASURE the bias and
 * demonstrate the correction, which is something a real deployment can never
 * do for itself. That evaluation lives in `scripts/eval-censoring.ts`.
 */

export interface InventorySimConfig {
  /** Evaluation date -- the simulation ends here. */
  asOf: Date;
  /** Days of history to simulate before `asOf`. */
  historyDays: number;
  seed: number;
  /** Emit a full transaction ledger. Expensive; off by default. */
  emitTransactions?: boolean;
}

export interface InventorySimResult {
  facilityId: string;
  drugId: string;
  /** Daily recorded issues -- censored by availability. This is what forecasting sees. */
  recordedSeries: number[];
  /** Daily true demand. Ground truth, unobservable in the real world. */
  trueSeries: number[];
  /**
   * Per-day censoring flag, defined the way PRODUCTION can define it: the shelf
   * held zero units at the close of that day, so the recorded issue is a lower
   * bound on demand rather than demand itself.
   *
   * Deliberately NOT defined as `demand > issued`, which is only knowable in a
   * simulation. A facility that drains to exactly zero while meeting all demand
   * is flagged too -- an over-flag we accept, because the alternative needs
   * information no real deployment has.
   */
  censoredMask: boolean[];
  /** Days on which at least one unit of demand could not be met. */
  stockoutDays: number;
  /** Total units of demand that went unmet. */
  unmetUnits: number;
  /** Units written off because they expired on the shelf. */
  expiredUnits: number;
  /** Closing position at `asOf`. */
  batches: StockBatch[];
  onHand: number;
  lastReportedAt: string | null;
  lastReportSource: ReportSource;
  transactions?: StockTransaction[];
}

/**
 * District supply reliability, 0..1.
 *
 * Some districts are chronically under-served -- vehicles break down, the
 * warehouse itself is short, tenders lapse. Modelling this as a persistent
 * district-level property (rather than independent noise per facility) is what
 * produces the SPATIAL CLUSTERING a real map shows: shortages come in regions,
 * not scattered at random. Without it the national map is uniform static and
 * tells an officer nothing.
 */
export function districtReliability(districtCode: string): number {
  const rng = createRng(hashSeed('reliability', districtCode));
  const roll = rng.next();
  if (roll < 0.15) return rng.real(0.45, 0.62); // chronically disrupted
  if (roll < 0.4) return rng.real(0.62, 0.8); // strained
  return rng.real(0.8, 0.97); // functioning
}

/**
 * How DEMAND-DRIVEN a district's allocation is, 0..1.
 *
 * This is a separate axis from reliability, and it is the more interesting one.
 * A district can deliver reliably and still allocate badly: most public supply
 * chains run on PUSH, sending each facility a standard quantity derived from
 * its tier norm (a PHC is "meant to" serve 30,000 people) rather than from what
 * it actually consumes.
 *
 * Because real catchments vary widely around the norm, push allocation
 * systematically over-supplies small facilities and starves large ones -- at
 * the same time, for the same drug, inside the same district. That is why a
 * district can show stock expiring on one shelf and patients turned away at
 * another 30 km down the road, and it is precisely the failure redistribution
 * is meant to catch.
 *
 * 1.0 = fully demand-driven (pull). 0.0 = pure norm-based push.
 */
export function districtPullFraction(districtCode: string): number {
  const rng = createRng(hashSeed('pull', districtCode));
  return rng.real(0.15, 0.8);
}

/**
 * Share of a facility's nominal catchment that actually presents AT that
 * facility for a given item.
 *
 * Catchments NEST -- a Sub-Centre's 5,000 people are inside its PHC's 30,000,
 * which are inside the CHC's 120,000. Charging every tier for its full
 * catchment double-counts the same patients several times over and inflates
 * district demand far beyond the district's population. These shares split the
 * population across the tiers that actually dispense to it: most primary
 * contacts happen at the Sub-Centre and PHC, with higher tiers seeing referrals
 * and their own local walk-ins.
 */
const DISPENSING_SHARE: Record<string, number> = {
  SC: 1.0,
  PHC: 0.35,
  CHC: 0.2,
  SDH: 0.15,
  DH: 0.12,
  DW: 0,
};

/** Order quantities are rounded to realistic pack multiples. */
function packRound(qty: number, unit: string): number {
  const bulk = ['tablet', 'capsule', 'sachet'].includes(unit);
  const step = bulk ? 100 : 1;
  return Math.max(step, Math.ceil(qty / step) * step);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Draw one day of true demand, applying seasonality the way the item behaves. */
function drawDemand(
  rng: Rng,
  meanDaily: number,
  dispersion: number,
  multiplier: number,
): number {
  if (meanDaily <= 0) return 0;
  const scaled = meanDaily * multiplier;
  // Negative binomial: overdispersed counts, which is what clinical demand is.
  return rng.negBinomial(scaled, dispersion);
}

export function simulateInventory(
  facility: Facility,
  drug: CatalogueDrug,
  config: InventorySimConfig,
): InventorySimResult {
  const { asOf, historyDays, seed, emitTransactions = false } = config;
  const rng = createRng(hashSeed(seed, facility.id, drug.id));

  const share = DISPENSING_SHARE[facility.type] ?? 1;
  const meanDaily = (drug.baselinePer1000PerDay * facility.population * share) / 1000;
  // Demand implied by the tier NORM rather than the real catchment. The gap
  // between this and `meanDaily` is what push allocation gets wrong.
  const normDaily =
    (drug.baselinePer1000PerDay * (CATCHMENT[facility.type] || facility.population) * share) / 1000;
  const leadTime = facilityLeadTime(facility);
  const reliability = districtReliability(facility.districtCode);
  const pullFraction = districtPullFraction(facility.districtCode);
  const profile = SEASONAL_PROFILES[drug.seasonality];

  // Inventory policy: review monthly, hold cover for lead time + review + safety.
  const reviewPeriod = 30;
  const safetyDays = drug.ved === 'V' ? 21 : drug.ved === 'E' ? 14 : 7;
  const targetCoverDays = leadTime + reviewPeriod + safetyDays;
  const reorderLevel = meanDaily * leadTime * 1.25;

  const start = new Date(asOf.getTime());
  start.setUTCDate(start.getUTCDate() - historyDays);

  // Opening stock: roughly a month of cover, varying by facility.
  let batches: StockBatch[] = [];
  const openingQty = packRound(meanDaily * rng.real(20, 45), drug.unit);
  if (openingQty > 0) {
    const expiry = new Date(start.getTime());
    expiry.setUTCMonth(expiry.getUTCMonth() + Math.round(drug.shelfLifeMonths * rng.real(0.3, 0.8)));
    batches.push({
      batchNo: 'OPEN-' + facility.id.replace(/[^A-Z0-9]/gi, '').slice(-5),
      quantity: openingQty,
      expiryDate: isoDate(expiry),
      receivedDate: isoDate(start),
    });
  }

  const recordedSeries: number[] = new Array(historyDays).fill(0);
  const trueSeries: number[] = new Array(historyDays).fill(0);
  const censoredMask: boolean[] = new Array(historyDays).fill(false);
  const transactions: StockTransaction[] = [];

  let stockoutDays = 0;
  let unmetUnits = 0;
  let expiredUnits = 0;
  let batchCounter = 0;

  /** Orders in transit: arrival day index -> quantity. */
  const inbound = new Map<number, number>();
  let orderOutstanding = false;
  let daysSinceReview = 0;

  const cursor = new Date(start.getTime());

  for (let day = 0; day < historyDays; day++) {
    const month = cursor.getUTCMonth();
    const today = isoDate(cursor);

    // --- 1. Receive anything arriving today ------------------------------
    const arriving = inbound.get(day);
    if (arriving && arriving > 0) {
      const expiry = new Date(cursor.getTime());
      // Warehouses offload short-dated stock downward. A facility that receives
      // a batch with two months of life left, against 50 days of cover, will
      // almost certainly write part of it off -- which is exactly the surplus
      // the redistribution engine exists to rescue before it dies on the shelf.
      if (rng.bool((1 - reliability) * 0.55)) {
        expiry.setUTCDate(expiry.getUTCDate() + rng.int(35, 130));
      } else {
        expiry.setUTCMonth(expiry.getUTCMonth() + Math.round(drug.shelfLifeMonths * rng.real(0.55, 0.95)));
      }
      const batchNo = `B${String(++batchCounter).padStart(3, '0')}-${facility.id.replace(/[^A-Z0-9]/gi, '').slice(-5)}`;
      batches.push({
        batchNo,
        quantity: arriving,
        expiryDate: isoDate(expiry),
        receivedDate: today,
      });
      if (emitTransactions) {
        transactions.push({
          id: `${facility.id}:${drug.id}:${day}:R`,
          facilityId: facility.id,
          drugId: drug.id,
          date: today,
          type: 'receipt',
          quantity: arriving,
          batchNo,
          source: 'seed',
        });
      }
      inbound.delete(day);
      orderOutstanding = false;
    }

    // --- 2. Write off anything that expired -------------------------------
    for (const b of batches) {
      if (b.quantity > 0 && b.expiryDate <= today) {
        expiredUnits += b.quantity;
        if (emitTransactions) {
          transactions.push({
            id: `${facility.id}:${drug.id}:${day}:X`,
            facilityId: facility.id,
            drugId: drug.id,
            date: today,
            type: 'expiry_writeoff',
            quantity: -b.quantity,
            batchNo: b.batchNo,
            source: 'seed',
          });
        }
        b.quantity = 0;
      }
    }
    batches = batches.filter((b) => b.quantity > 0);

    // --- 3. Demand presents ----------------------------------------------
    const demand = drawDemand(rng, meanDaily, drug.dispersion, profile[month]);
    trueSeries[day] = demand;

    // --- 4. Dispense what we can, first-expiry-first-out ------------------
    const available = batches.reduce((a, b) => a + b.quantity, 0);
    const issued = Math.min(demand, available);

    if (issued > 0) {
      let need = issued;
      batches.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
      for (const b of batches) {
        if (need <= 0) break;
        const take = Math.min(b.quantity, need);
        b.quantity -= take;
        need -= take;
      }
      batches = batches.filter((b) => b.quantity > 0);
      if (emitTransactions) {
        transactions.push({
          id: `${facility.id}:${drug.id}:${day}:I`,
          facilityId: facility.id,
          drugId: drug.id,
          date: today,
          type: 'issue',
          quantity: -issued,
          source: 'seed',
        });
      }
    }

    // THE CENSORING. The ledger records what was dispensed, never what was needed.
    recordedSeries[day] = issued;
    if (demand > issued) {
      stockoutDays++;
      unmetUnits += demand - issued;
    }

    // --- 5. Review and reorder -------------------------------------------
    daysSinceReview++;
    const onHandNow = batches.reduce((a, b) => a + b.quantity, 0);
    // Production-observable censoring signal: the shelf closed the day empty.
    censoredMask[day] = onHandNow === 0;
    // An emergency indent can be raised even with an order already in transit --
    // real facilities do this when they are about to run dry, and modelling it
    // keeps stock-outs from being an artefact of the single-order restriction.
    const emergencyLow = onHandNow <= meanDaily * leadTime * 0.4;
    const dueForReview = daysSinceReview >= reviewPeriod || onHandNow <= reorderLevel;

    if ((dueForReview && !orderOutstanding) || (emergencyLow && inbound.size === 0)) {
      daysSinceReview = 0;

      // What this facility actually needs, from its own consumption.
      const pullTarget = meanDaily * targetCoverDays;
      // What a norm-based push system sends: computed from the IPHS catchment
      // norm for the tier, blind to this facility's real burden.
      const pushTarget = normDaily * targetCoverDays;
      const target = pullFraction * pullTarget + (1 - pullFraction) * pushTarget;

      const gap = target - onHandNow;
      if (gap > 0) {
        // Supply is unreliable: orders arrive short, and sometimes late.
        const fillRate = Math.min(1, rng.real(reliability * 0.7, reliability * 1.15));
        // Bulk consignments: annual tenders and campaign leftovers get pushed
        // down in one drop, sized to the norm rather than to this facility.
        // More common where allocation is push-driven.
        const bulkPush = rng.bool((1 - pullFraction) * 0.18) ? rng.real(2.2, 4.5) : 1;
        const qty = packRound(gap * fillRate * bulkPush, drug.unit);
        const delay = rng.bool(1 - reliability) ? rng.int(3, 18) : 0;
        const arrival = day + leadTime + delay;
        if (arrival < historyDays) {
          inbound.set(arrival, (inbound.get(arrival) ?? 0) + qty);
        }
        orderOutstanding = true;
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const onHand = batches.reduce((a, b) => a + b.quantity, 0);

  // How stale is this facility's last stock report? Reporting discipline tracks
  // district reliability -- the districts that cannot deliver stock also tend to
  // be the ones that cannot file returns on time.
  const staleness = rng.int(0, Math.max(1, Math.round(35 * (1 - reliability))));
  const lastReported = new Date(asOf.getTime());
  lastReported.setUTCDate(lastReported.getUTCDate() - staleness);

  const sources: ReportSource[] = ['manual_web', 'whatsapp_text', 'voice', 'photo_register', 'dvdms_sync'];

  return {
    facilityId: facility.id,
    drugId: drug.id,
    recordedSeries,
    trueSeries,
    censoredMask,
    stockoutDays,
    unmetUnits,
    expiredUnits,
    batches,
    onHand,
    lastReportedAt: isoDate(lastReported),
    lastReportSource: rng.pick(sources),
    transactions: emitTransactions ? transactions : undefined,
  };
}
