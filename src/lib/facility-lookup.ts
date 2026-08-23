import type { Facility } from '@/lib/domain/types';
import { DISTRICTS_BY_CODE } from '@/lib/domain/geo';
import { generateNetwork, DEMO_SCALE } from '@/lib/sim/facilities';
import { simulateInventory } from '@/lib/sim/inventory';
import { fitDemandCensored } from '@/lib/forecast/croston';
import { formularyFor } from '@/lib/domain/drugs';
import type { Expectation } from '@/lib/ai/stock-report';

/**
 * Facility lookup by ID.
 *
 * Facility IDs are structured -- `DST-22-BASTAR-PHC-004` -- so the district can
 * be recovered from the ID and only that district's network needs generating.
 * Regenerating one district is cheap (a few milliseconds) and deterministic, so
 * this returns the identical facility every time without any storage.
 *
 * Against real data this is the function that becomes a database read, or an
 * ABDM Health Facility Registry lookup. Nothing else changes.
 */
export function getFacilityById(id: string): Facility | null {
  const parts = id.split('-');
  if (parts.length < 5) return null;

  // District code is the first three segments: DST-<state>-<SLUG>
  const districtCode = parts.slice(0, 3).join('-');
  const district = DISTRICTS_BY_CODE[districtCode];
  if (!district) return null;

  const network = generateNetwork(DEMO_SCALE, [district]);
  return network.find((f) => f.id === id) ?? null;
}

/** Every facility in a district, for pickers. */
export function facilitiesInDistrict(districtCode: string): Facility[] {
  const district = DISTRICTS_BY_CODE[districtCode];
  if (!district) return [];
  return generateNetwork(DEMO_SCALE, [district]);
}

/**
 * What we currently believe about a facility's stock, keyed by drug ID.
 *
 * Used by the capture layer to sanity-check reported numbers. Without this a
 * spoken "five thousand" is just a number; with it, the system knows the
 * facility normally holds fifty and asks a human before accepting a hundredfold
 * jump.
 */
export function expectationsFor(facility: Facility, asOf: Date): Map<string, Expectation> {
  const out = new Map<string, Expectation>();

  for (const drug of formularyFor(facility.type)) {
    const sim = simulateInventory(facility, drug, {
      asOf,
      historyDays: 365,
      seed: 20260930,
    });
    const fit = fitDemandCensored(sim.recordedSeries, sim.censoredMask);
    out.set(drug.id, {
      lastKnownOnHand: sim.onHand,
      meanDailyDemand: fit.meanDemand,
    });
  }

  return out;
}
