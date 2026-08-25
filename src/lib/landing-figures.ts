import type { NationalSnapshot } from '@/lib/snapshot-types';

/**
 * Every number the landing page says out loud.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A marketing surface is exactly where a fabricated figure goes to hide. The
 * console is audited constantly because people read it to make decisions; a
 * landing page is read once, believed, and never checked. So this module exists
 * to make it structurally impossible to type a number into the page: the page
 * imports from here, and here imports from the shipped snapshot. If the
 * pipeline is re-run and the plan changes, the headline changes with it, and
 * nobody has to remember to go and edit a hero.
 *
 * The one thing to watch: `derive` must not compute anything the pipeline
 * already computed. Where the snapshot carries a total, it is passed through
 * untouched. Only genuinely new relationships -- the net cash line, the
 * break-even price, the consolidation saving -- are calculated, and each one is
 * derived from two published totals rather than re-aggregated from parts.
 */
export interface LandingFigures {
  /** Snapshot position date, e.g. 2026-09-30. */
  asOf: string;
  /** Wall-clock seconds the national build took. */
  buildSeconds: number;

  // Reach.
  districts: number;
  states: number;
  facilities: number;
  populationCovered: number;
  trackedPositions: number;

  // The problem.
  criticalPositions: number;
  zeroStockPositions: number;
  expectedShortfallUnits: number;

  // The result.
  shortfallAverted: number;
  transfers: number;
  trips: number;
  crossDistrictTrips: number;
  crossDistrictOrders: number;
  rideAlongOrders: number;
  netBenefitInr: number;

  // Corridors.
  corridors: number;
  crossStateCorridors: number;
  districtsOnACorridor: number;

  // The ledger. Negative is not hidden here; it is the point.
  wasteAvertedInr: number;
  transportCostInr: number;
  unconsolidatedCostInr: number;
  /** waste averted less transport spent. Currently negative, deliberately. */
  netCashInr: number;
  /** Rupees saved by pricing a route once instead of once per order. */
  consolidationSavingInr: number;
  /**
   * The rupee value one averted unit of unmet demand must carry for the plan to
   * break even in cash. This is the honest form of the argument: rather than
   * claiming a return, state the price at which the return exists and let the
   * reader decide whether a dose of a Vital medicine reaching a patient clears
   * it.
   */
  breakEvenInrPerUnit: number;

  /**
   * Who has spare stock and who needs it.
   *
   * `crossDistrictTrips` on a district row is undirected -- it counts trips with an
   * end here without saying which end -- so this walks the directional corridor rows
   * instead. It is the difference between asserting "the medicine was already nearby"
   * and being able to point at the districts where that is literally true.
   */
  netGivers: number;
  netTakers: number;
  /** The district with the largest order deficit, and where most of it comes from. */
  deepestDeficit: {
    name: string;
    stateName: string;
    net: number;
    supplierName: string;
    supplierState: string;
    supplierOrders: number;
    /** Whether that supplier is inside the same state -- often it is. */
    sameState: boolean;
  } | null;

  // Workforce, the reason the stock numbers deserve an error bar.
  facilitiesWithoutPharmacist: number;
  vacancyRate: number;
  absenteeismRate: number;
}

export function derive(snapshot: NationalSnapshot): LandingFigures {
  const t = snapshot.totals;
  const links = snapshot.crossDistrictLinks;

  // A corridor touches two districts; a district can sit on many corridors.
  // Counting the union rather than 2 x links is the difference between "244
  // corridors reach 116 districts" and a meaningless 488.
  const touched = new Set<string>();
  for (const l of links) {
    touched.add(l.fromDistrictCode);
    touched.add(l.toDistrictCode);
  }

  const netCashInr = t.wasteAvertedInr - t.transportCostInr;

  // One pass over the directional corridors gives both the give/take split and the
  // worked example beneath it.
  const sent = new Map<string, number>();
  const got = new Map<string, number>();
  for (const l of links) {
    sent.set(l.fromDistrictCode, (sent.get(l.fromDistrictCode) ?? 0) + l.orders);
    got.set(l.toDistrictCode, (got.get(l.toDistrictCode) ?? 0) + l.orders);
  }

  let netGivers = 0;
  let netTakers = 0;
  let worst: { code: string; net: number } | null = null;
  for (const d of snapshot.districts) {
    const net = (sent.get(d.districtCode) ?? 0) - (got.get(d.districtCode) ?? 0);
    if (net > 0) netGivers += 1;
    else if (net < 0) netTakers += 1;
    if (net < 0 && (worst === null || net < worst.net)) {
      worst = { code: d.districtCode, net };
    }
  }

  // The single largest corridor INTO that district -- read from the plan rather than
  // inferred, so the example on the page is one the console can be made to show.
  let deepestDeficit: LandingFigures['deepestDeficit'] = null;
  if (worst) {
    const into = links.filter((l) => l.toDistrictCode === worst.code);
    const top = into.reduce<(typeof into)[number] | null>(
      (best, l) => (best === null || l.orders > best.orders ? l : best),
      null,
    );
    const row = snapshot.districts.find((d) => d.districtCode === worst.code);
    if (top && row) {
      deepestDeficit = {
        name: row.districtName,
        stateName: row.stateName,
        net: Math.abs(worst.net),
        supplierName: top.fromDistrictName,
        supplierState:
          snapshot.districts.find((d) => d.districtCode === top.fromDistrictCode)
            ?.stateName ?? '',
        supplierOrders: top.orders,
        sameState: !top.crossState,
      };
    }
  }

  return {
    asOf: snapshot.asOf,
    buildSeconds: snapshot.buildSeconds,

    districts: t.districts,
    states: t.states,
    facilities: t.facilities,
    populationCovered: t.populationCovered,
    trackedPositions: t.trackedPositions,

    criticalPositions: t.criticalPositions,
    zeroStockPositions: t.zeroStockPositions,
    expectedShortfallUnits: t.expectedShortfallUnits,

    shortfallAverted: t.shortfallAverted,
    transfers: t.transfers,
    trips: t.trips,
    crossDistrictTrips: t.crossDistrictTrips,
    crossDistrictOrders: t.crossDistrictOrders,
    rideAlongOrders: t.rideAlongOrders,
    netBenefitInr: t.netBenefitInr,

    corridors: links.length,
    crossStateCorridors: links.filter((l) => l.crossState).length,
    districtsOnACorridor: touched.size,

    wasteAvertedInr: t.wasteAvertedInr,
    transportCostInr: t.transportCostInr,
    unconsolidatedCostInr: t.unconsolidatedCostInr,
    netCashInr,
    consolidationSavingInr: t.unconsolidatedCostInr - t.transportCostInr,
    // Guarded: a plan that averted nothing would divide by zero, and a hero
    // reading "₹Infinity" is a worse failure than a hero reading "₹0".
    breakEvenInrPerUnit:
      t.shortfallAverted > 0 ? Math.abs(netCashInr) / t.shortfallAverted : 0,

    netGivers,
    netTakers,
    deepestDeficit,

    facilitiesWithoutPharmacist: t.facilitiesWithoutPharmacist,
    vacancyRate: t.vacancyRate,
    absenteeismRate: t.absenteeismRate,
  };
}
