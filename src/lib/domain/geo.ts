/**
 * Geography: every state, union territory and district of India.
 *
 * PROVENANCE
 * ----------
 * Nothing in this file is typed in. The table is `src/data/india-districts.json`,
 * written by `scripts/fetch-districts.mts`, which records per district where each
 * field came from:
 *
 * - **State codes** are the real Local Government Directory / Census codes
 *   (08 = Rajasthan, 27 = Maharashtra), checked against Wikidata's LGD State
 *   Code at fetch time. A real HMIS or DVDMS extract joins on them unchanged.
 * - **Districts** are every row of the English Wikipedia's district list, pinned
 *   to the revision that was read. Where Wikidata carries the district's real
 *   LGD district code it is kept alongside (`lgdDistrictCode`).
 * - **Coordinates** are the district article's own, else Wikidata's, else the
 *   headquarters town's -- whichever source first places the district inside
 *   India, with rejected candidates recorded. They locate a district on a
 *   national map; they are not survey-grade.
 * - **Population** is the source table's figure, with its vintage recorded per
 *   district rather than assumed: the 2011 Census apportioned to current
 *   boundaries for most, Andhra Pradesh's own 2021 estimates for that state,
 *   and a small number of round editorial estimates for districts newer than
 *   the census.
 * - **District codes** are synthetic and stable (`DST-<state>-<slug>`). The 128
 *   districts the grid modelled first keep the codes they already had.
 *
 * WHAT "MODELLED" MEANS
 * ---------------------
 * `DISTRICTS` holds the districts the grid actually simulates, forecasts and
 * plans. A district the source lists without a population figure, or that no
 * source can place inside India, is kept in `REGISTRY` and is never given an
 * invented number: population scales both the facility network and the risk
 * score's exposure term, so a made-up figure would reach every number that
 * district produces.
 *
 * ORDER IS PART OF THE MODEL
 * --------------------------
 * The cross-district planner shares one allocation state across the whole run,
 * so districts earlier in this table get first refusal on stock they share. The
 * order is therefore fixed and explicit -- by state code, then district name --
 * rather than an accident of how an object's keys happen to enumerate. (It used
 * to be exactly that accident: integer-like keys enumerate before '08' and '09',
 * so Bihar planned first and Uttar Pradesh last.)
 */
import REGISTRY_FILE from '@/data/india-districts.json';

export interface StateInfo {
  /** Real LGD / Census state code. */
  code: string;
  name: string;
  /** Short label for dense chart axes. */
  abbr: string;
}

export interface DistrictInfo {
  code: string;
  name: string;
  stateCode: string;
  stateName: string;
  lat: number;
  lon: number;
}

export type PopulationVintage = 'census-2011' | 'state-2021' | 'estimate';

export interface RegistryDistrict {
  code: string;
  name: string;
  stateCode: string;
  lat: number | null;
  lon: number | null;
  coordinateSource: string | null;
  headquarters: string | null;
  population: number | null;
  populationVintage: PopulationVintage | null;
  wikidata2011: number | null;
  lgdDistrictCode: string | null;
  wikidata: string | null;
  wikipedia: string;
  modelled: boolean;
  notModelledReason?: string;
}

interface RegistryFile {
  revision: number;
  retrievedAt: string;
  states: StateInfo[];
  districts: RegistryDistrict[];
}

const FILE = REGISTRY_FILE as unknown as RegistryFile;

export const STATES: StateInfo[] = FILE.states.map(({ code, name, abbr }) => ({ code, name, abbr }));

export const STATES_BY_CODE: Record<string, StateInfo> = Object.fromEntries(
  STATES.map((s) => [s.code, s]),
);

/** Every district the source lists, modelled or not. */
export const REGISTRY: RegistryDistrict[] = FILE.districts;

/** The source revision the registry was read from. */
export const REGISTRY_REVISION = FILE.revision;

const byStateThenName = (a: RegistryDistrict, b: RegistryDistrict) =>
  Number(a.stateCode) - Number(b.stateCode) || a.name.localeCompare(b.name);

/** The districts the grid simulates, in planning order. */
export const DISTRICTS: DistrictInfo[] = REGISTRY.filter((d) => d.modelled)
  .sort(byStateThenName)
  .map((d) => ({
    code: d.code,
    name: d.name,
    stateCode: d.stateCode,
    stateName: STATES_BY_CODE[d.stateCode].name,
    lat: d.lat as number,
    lon: d.lon as number,
  }));

export const DISTRICTS_BY_CODE: Record<string, DistrictInfo> = Object.fromEntries(
  DISTRICTS.map((d) => [d.code, d]),
);

const REGISTRY_BY_CODE: Record<string, RegistryDistrict> = Object.fromEntries(
  REGISTRY.map((d) => [d.code, d]),
);

export function registryEntry(code: string): RegistryDistrict | undefined {
  return REGISTRY_BY_CODE[code];
}

export function districtsOfState(stateCode: string): DistrictInfo[] {
  return DISTRICTS.filter((d) => d.stateCode === stateCode);
}

/**
 * District population, as the registry sources it.
 *
 * This used to be a hash of the district code drawn into a 0.6M-2.8M band, and
 * it was the single most falsifiable number in the product: Surat came out at
 * 779k against a real 6,081,322. Population also weights the risk score's
 * exposure term, so every ranking inherited the error.
 *
 * THE BOUNDARY VINTAGE, WHICH A READER WILL NOTICE
 * ------------------------------------------------
 * Census figures are 2011 populations apportioned to CURRENT district
 * boundaries, which is what we want because we model today's districts. Where a
 * district has been split since 2011 the figure is therefore SMALLER than the
 * "Census 2011" number a search returns: Bastar is 834,873, while undivided 2011
 * Bastar -- before Kondagaon was carved out -- was 1,413,199.
 * `scripts/verify-census.mts` checks the figures against a second publisher.
 */
export function districtPopulation(code: string): number {
  const row = REGISTRY_BY_CODE[code];
  if (row?.modelled && row.population !== null) return row.population;
  // A modelled district with no population is a data defect, not something to
  // paper over with a plausible-looking number.
  throw new Error(
    'No population for ' + code + '. Re-run: npx tsx scripts/fetch-districts.mts',
  );
}

export function districtPopulationVintage(code: string): PopulationVintage | null {
  return REGISTRY_BY_CODE[code]?.populationVintage ?? null;
}

/** Great-circle distance in km. */
export function haversineKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Road distance estimate.
 *
 * Straight-line distance badly understates travel in hill and forest districts,
 * and transfer feasibility depends on the real thing. Until a routing API is
 * wired in we apply a detour factor -- the standard circuity correction used in
 * transport planning -- so the optimiser is not fooled into recommending a
 * transfer across a river with no bridge.
 */
export function roadDistanceKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
  detourFactor = 1.35,
): number {
  return Math.round(haversineKm(aLat, aLon, bLat, bLon) * detourFactor * 10) / 10;
}

/**
 * District adjacency, by road distance between district locations.
 *
 * WHY THIS EXISTS
 * ---------------
 * The redistribution optimiser is scope-agnostic -- nothing in it reads a
 * district code, and feasibility is decided purely by `roadDistanceKm` between
 * two facilities. So planning ACROSS districts needs no change to the planner;
 * it only needs a caller willing to hand it more than one district's contexts.
 * This is the index that decides which ones are worth handing over together.
 *
 * WHY DISTRICT DISTANCE IS ONLY A PREFILTER
 * -----------------------------------------
 * These are point-to-point distances between district locations, and they
 * systematically OVERSTATE how far apart two districts' facilities are.
 * Sub-Centres scatter up to 85 km from their own headquarters and PHCs up to
 * 70 km, so neighbouring districts physically interleave. Use this to choose a
 * candidate set, then let the planner's own `roadDistanceKm` on real facility
 * coordinates decide what is actually reachable.
 *
 * The matrix is computed once, lazily, on first use: n² haversine calls, about
 * 590,000 at the full table, which takes well under a second. Rows are sorted
 * nearest-first, which is also the order a caller should prefer when budgeting
 * how many neighbours to pull into one plan.
 */
export interface DistrictNeighbour {
  code: string;
  /** Road km between the two district locations, same estimate the planner uses. */
  roadKm: number;
}

let NEIGHBOUR_CACHE: Map<string, DistrictNeighbour[]> | null = null;

/**
 * Neighbours kept per district. The only caller that wants many is the planner
 * (four) and the surge scenario (four within 180 km); keeping the whole sorted
 * row for 769 districts would hold ~590,000 objects on a server for nothing.
 */
const NEIGHBOURS_KEPT = 48;

function neighbourMatrix(): Map<string, DistrictNeighbour[]> {
  if (NEIGHBOUR_CACHE) return NEIGHBOUR_CACHE;
  const m = new Map<string, DistrictNeighbour[]>();
  for (const a of DISTRICTS) {
    const row: DistrictNeighbour[] = [];
    for (const b of DISTRICTS) {
      if (a.code === b.code) continue;
      row.push({ code: b.code, roadKm: roadDistanceKm(a.lat, a.lon, b.lat, b.lon) });
    }
    // Nearest first, with the code as a tie-break so the order is total and
    // stable. The planner's tie-breaks resolve to input order, so an unstable
    // neighbour order would make the plan depend on Array#sort internals.
    row.sort((x, y) => x.roadKm - y.roadKm || x.code.localeCompare(y.code));
    m.set(a.code, row.slice(0, NEIGHBOURS_KEPT));
  }
  NEIGHBOUR_CACHE = m;
  return m;
}

/**
 * Districts within `withinRoadKm` of this one, nearest first, optionally capped
 * at `limit` (and never more than the 48 nearest).
 *
 * Returns an empty array for an unknown code rather than throwing: a caller
 * iterating the district table cannot produce one, and a caller that can should
 * not have a cross-district pass abort a national build.
 */
export function districtNeighbours(
  code: string,
  withinRoadKm: number,
  limit = Number.POSITIVE_INFINITY,
): DistrictNeighbour[] {
  const row = neighbourMatrix().get(code);
  if (!row) return [];
  const out: DistrictNeighbour[] = [];
  for (const n of row) {
    if (n.roadKm > withinRoadKm) break; // sorted, so the first miss ends it
    if (out.length >= limit) break;
    out.push(n);
  }
  return out;
}

/** Road km between two district locations. `null` if either code is unknown. */
export function districtSeparationKm(a: string, b: string): number | null {
  if (a === b) return 0;
  const da = DISTRICTS_BY_CODE[a];
  const db = DISTRICTS_BY_CODE[b];
  if (!da || !db) return null;
  return roadDistanceKm(da.lat, da.lon, db.lat, db.lon);
}
