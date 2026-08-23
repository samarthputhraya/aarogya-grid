import type { Facility, FacilityType } from '@/lib/domain/types';
import { DISTRICTS, districtPopulation, roadDistanceKm, type DistrictInfo } from '@/lib/domain/geo';
import { BED_NORMS } from '@/lib/domain/resources';
import { createRng, hashSeed } from '@/lib/rng';

/**
 * Facility network generator.
 *
 * WHAT IS REAL AND WHAT IS NOT
 * ----------------------------
 * The STRUCTURE is real: Indian Public Health Standards define the tier system
 * and its catchment norms (a Sub-Centre serves ~5,000 people, a PHC ~30,000, a
 * CHC ~120,000), and replenishment genuinely flows District Warehouse -> CHC ->
 * PHC -> Sub-Centre. Districts and their coordinates are real.
 *
 * The INDIVIDUAL FACILITIES are generated. Names are deliberately systematic
 * ("PHC Bastar-04") so nobody can mistake them for a real facility register.
 * When the ABDM Health Facility Registry is connected, real facility IDs, names
 * and geolocations replace this generator and nothing downstream changes --
 * every consumer depends on the `Facility` interface, not on this file.
 *
 * NATIONAL SCALE
 * --------------
 * India runs roughly 1.6 lakh Sub-Centres, 25,000 PHCs and 5,500 CHCs. The demo
 * dataset is a representative SAMPLE of that, sized by `NetworkScale`, because
 * a jury laptop should not have to hold the whole country in memory. The
 * generator itself is linear in facility count -- `scripts/bench-scale.ts`
 * exercises it at full national volume.
 */

export interface NetworkScale {
  chcPerDistrict: number;
  phcPerDistrict: number;
  scPerDistrict: number;
}

/** Sample size used for the interactive demo. */
export const DEMO_SCALE: NetworkScale = { chcPerDistrict: 2, phcPerDistrict: 6, scPerDistrict: 12 };

/** Approximate real-world density per district, for the scale benchmark. */
export const NATIONAL_SCALE: NetworkScale = { chcPerDistrict: 8, phcPerDistrict: 34, scPerDistrict: 215 };

/**
 * IPHS catchment norms -- the population one facility of each tier is MEANT to
 * serve. Exported because the simulator needs it to model push allocation: a
 * norm-based supply system sends stock against this number rather than against
 * the facility's actual catchment, which is the root of most misallocation.
 */
export const CATCHMENT: Record<FacilityType, number> = {
  SC: 5_000,
  PHC: 30_000,
  CHC: 120_000,
  SDH: 400_000,
  DH: 1_000_000,
  DW: 0,
};

/**
 * Replenishment lead time in days for the hop from a facility to its parent.
 *
 * These widen with distance because the binding constraint in rural districts
 * is vehicle availability and route frequency, not road speed.
 */
function leadTimeFor(type: FacilityType, distanceKm: number): number {
  const base: Record<FacilityType, number> = {
    DW: 21, // district warehouse replenished from the state medical store
    DH: 10,
    SDH: 10,
    CHC: 7,
    PHC: 10,
    SC: 14,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const distancePenalty = Math.floor(distanceKm / 40);
  return base[type] + distancePenalty;
}

/** Scatter a point within `radiusKm` of an origin, roughly uniformly by area. */
function scatter(
  rng: ReturnType<typeof createRng>,
  lat: number,
  lon: number,
  radiusKm: number,
): { lat: number; lon: number } {
  // sqrt keeps the distribution uniform over the disc rather than clustered at the centre.
  const r = radiusKm * Math.sqrt(rng.next());
  const theta = rng.next() * 2 * Math.PI;
  const dLat = (r * Math.cos(theta)) / 111;
  const dLon = (r * Math.sin(theta)) / (111 * Math.cos((lat * Math.PI) / 180));
  return { lat: +(lat + dLat).toFixed(4), lon: +(lon + dLon).toFixed(4) };
}

function makeFacility(
  district: DistrictInfo,
  type: FacilityType,
  index: number,
  lat: number,
  lon: number,
  parent: Facility | null,
  rng: ReturnType<typeof createRng>,
): Facility {
  const id = `${district.code}-${type}-${String(index).padStart(3, '0')}`;
  const distanceToParentKm = parent ? roadDistanceKm(lat, lon, parent.lat, parent.lon) : 0;

  // Actual catchment varies around the IPHS norm -- facilities are not evenly spaced.
  const population =
    type === 'DW' ? 0 : Math.round(CATCHMENT[type] * rng.real(0.65, 1.45));

  // Sanctioned bed strength comes from the IPHS norm table in
  // `@/lib/domain/resources`, which is also what the bed occupancy simulator
  // reads. One table, two consumers: a facility register and an occupancy
  // report that disagreed about the denominator would be worse than useless.
  const bedsSanctioned = BED_NORMS[type];
  // A coarse free-bed count stamped into the registry record at generation
  // time. `simulateBeds` supersedes it -- that is where functional strength,
  // seasonal occupancy and the capacity-censored demand series live. Retained
  // because `Facility` mirrors an ABDM HFR record, and an HFR record carries a
  // bed count.
  const bedsAvailable =
    bedsSanctioned === 0 ? 0 : Math.max(0, Math.round(bedsSanctioned * rng.real(0.05, 0.6)));

  const label =
    type === 'DW'
      ? `District Warehouse ${district.name}`
      : `${type} ${district.name}-${String(index).padStart(2, '0')}`;

  return {
    id,
    name: label,
    type,
    stateCode: district.stateCode,
    stateName: district.stateName,
    districtCode: district.code,
    districtName: district.name,
    block: type === 'DW' ? undefined : `Block-${Math.floor(index / 3) + 1}`,
    lat,
    lon,
    population,
    bedsSanctioned,
    bedsAvailable,
    parentId: parent ? parent.id : null,
    distanceToParentKm,
  };
}

/** Nearest facility from a list, by road distance. */
function nearest(lat: number, lon: number, candidates: Facility[]): Facility {
  let best = candidates[0];
  let bestD = Infinity;
  for (const c of candidates) {
    const d = roadDistanceKm(lat, lon, c.lat, c.lon);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * Build the full facility network for the given districts.
 *
 * Each Sub-Centre is attached to its NEAREST PHC rather than a random one,
 * because the referral and replenishment hierarchy in practice follows road
 * distance. That choice matters later: the optimiser reasons about transfers
 * between siblings under the same parent, and a geographically incoherent tree
 * would make those recommendations nonsense.
 */
export function generateNetwork(
  scale: NetworkScale = DEMO_SCALE,
  districts: DistrictInfo[] = DISTRICTS,
  seed = 20260930,
): Facility[] {
  const out: Facility[] = [];

  for (const district of districts) {
    const rng = createRng(hashSeed(seed, district.code));

    // 1. District warehouse, at the district headquarters.
    const dw = makeFacility(district, 'DW', 1, district.lat, district.lon, null, rng);
    out.push(dw);

    // 2. District hospital, co-located with the HQ, replenished from the warehouse.
    const dhPos = scatter(rng, district.lat, district.lon, 6);
    const dh = makeFacility(district, 'DH', 1, dhPos.lat, dhPos.lon, dw, rng);
    out.push(dh);

    // 3. CHCs across the district, drawing from the warehouse.
    const chcs: Facility[] = [];
    for (let i = 1; i <= scale.chcPerDistrict; i++) {
      const p = scatter(rng, district.lat, district.lon, 45);
      const chc = makeFacility(district, 'CHC', i, p.lat, p.lon, dw, rng);
      chcs.push(chc);
      out.push(chc);
    }

    // 4. PHCs, each attached to its nearest CHC.
    const phcs: Facility[] = [];
    for (let i = 1; i <= scale.phcPerDistrict; i++) {
      const p = scatter(rng, district.lat, district.lon, 70);
      const parent = chcs.length > 0 ? nearest(p.lat, p.lon, chcs) : dw;
      const phc = makeFacility(district, 'PHC', i, p.lat, p.lon, parent, rng);
      phcs.push(phc);
      out.push(phc);
    }

    // 5. Sub-Centres, each attached to its nearest PHC.
    for (let i = 1; i <= scale.scPerDistrict; i++) {
      const p = scatter(rng, district.lat, district.lon, 85);
      const parent = phcs.length > 0 ? nearest(p.lat, p.lon, phcs) : dw;
      out.push(makeFacility(district, 'SC', i, p.lat, p.lon, parent, rng));
    }
  }

  return out;
}

/** Replenishment lead time for a facility, given its tier and distance to parent. */
export function facilityLeadTime(f: Facility): number {
  return leadTimeFor(f.type, f.distanceToParentKm);
}

export function indexByDistrict(facilities: Facility[]): Map<string, Facility[]> {
  const m = new Map<string, Facility[]>();
  for (const f of facilities) {
    const list = m.get(f.districtCode);
    if (list) list.push(f);
    else m.set(f.districtCode, [f]);
  }
  return m;
}
