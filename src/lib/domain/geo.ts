/**
 * Geography: states and districts.
 *
 * PROVENANCE
 * ----------
 * - State codes are the REAL codes used by India's Local Government Directory
 *   (LGD) and the Census (08 = Rajasthan, 27 = Maharashtra, and so on). Keeping
 *   the authentic codes means a real HMIS or DVDMS extract joins to this table
 *   on day one, with no mapping layer.
 * - District names are real. Coordinates are APPROXIMATE district-headquarters
 *   positions, accurate enough to place a facility on a national map but not
 *   survey-grade; they are replaced by authoritative LGD / Bhuvan centroids
 *   when those are connected.
 * - District codes here are SYNTHETIC and stable (`DST-<state>-<slug>`). Real
 *   LGD district codes slot into the same field without any other change.
 * - District population is MODELLED, not census data -- see `districtPopulation`.
 *
 * This is a representative national sample (16 states, 128 districts), not the
 * full 750+ district list. It is deliberately weighted toward the states where
 * supply-chain failure is most consequential.
 */
import { createRng, hashSeed } from '@/lib/rng';

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

export const STATES: StateInfo[] = [
  { code: '08', name: 'Rajasthan', abbr: 'RJ' },
  { code: '09', name: 'Uttar Pradesh', abbr: 'UP' },
  { code: '10', name: 'Bihar', abbr: 'BR' },
  { code: '18', name: 'Assam', abbr: 'AS' },
  { code: '19', name: 'West Bengal', abbr: 'WB' },
  { code: '20', name: 'Jharkhand', abbr: 'JH' },
  { code: '21', name: 'Odisha', abbr: 'OD' },
  { code: '22', name: 'Chhattisgarh', abbr: 'CG' },
  { code: '23', name: 'Madhya Pradesh', abbr: 'MP' },
  { code: '24', name: 'Gujarat', abbr: 'GJ' },
  { code: '27', name: 'Maharashtra', abbr: 'MH' },
  { code: '28', name: 'Andhra Pradesh', abbr: 'AP' },
  { code: '29', name: 'Karnataka', abbr: 'KA' },
  { code: '32', name: 'Kerala', abbr: 'KL' },
  { code: '33', name: 'Tamil Nadu', abbr: 'TN' },
  { code: '36', name: 'Telangana', abbr: 'TG' },
];

export const STATES_BY_CODE: Record<string, StateInfo> = Object.fromEntries(
  STATES.map((s) => [s.code, s]),
);

/** [district name, latitude, longitude] keyed by LGD state code. */
const DISTRICT_TABLE: Record<string, [string, number, number][]> = {
  '08': [
    ['Jaipur', 26.91, 75.79], ['Jodhpur', 26.24, 73.02], ['Udaipur', 24.58, 73.68],
    ['Kota', 25.21, 75.86], ['Bikaner', 28.02, 73.31], ['Ajmer', 26.45, 74.64],
    ['Barmer', 25.75, 71.39], ['Alwar', 27.55, 76.63],
  ],
  '09': [
    ['Lucknow', 26.85, 80.95], ['Kanpur Nagar', 26.45, 80.33], ['Varanasi', 25.32, 82.97],
    ['Gorakhpur', 26.76, 83.37], ['Prayagraj', 25.44, 81.85], ['Agra', 27.18, 78.01],
    ['Bareilly', 28.37, 79.43], ['Jhansi', 25.45, 78.57],
  ],
  '10': [
    ['Patna', 25.59, 85.14], ['Gaya', 24.79, 85.00], ['Muzaffarpur', 26.12, 85.39],
    ['Bhagalpur', 25.24, 86.98], ['Darbhanga', 26.15, 85.90], ['Purnia', 25.78, 87.47],
    ['Saran', 25.78, 84.75], ['West Champaran', 26.80, 84.50],
  ],
  '18': [
    ['Kamrup Metropolitan', 26.14, 91.74], ['Dibrugarh', 27.47, 94.91], ['Jorhat', 26.75, 94.22],
    ['Cachar', 24.83, 92.78], ['Nagaon', 26.35, 92.68], ['Barpeta', 26.32, 91.00],
    ['Sonitpur', 26.63, 92.80], ['Dhubri', 26.02, 89.98],
  ],
  '19': [
    ['Kolkata', 22.57, 88.36], ['Murshidabad', 24.10, 88.25], ['Purba Bardhaman', 23.25, 87.86],
    ['Darjeeling', 27.04, 88.26], ['Malda', 25.01, 88.14], ['Nadia', 23.40, 88.50],
    ['Purulia', 23.33, 86.36], ['South 24 Parganas', 22.15, 88.43],
  ],
  '20': [
    ['Ranchi', 23.34, 85.31], ['Dhanbad', 23.80, 86.43], ['East Singhbhum', 22.80, 86.20],
    ['Bokaro', 23.67, 86.15], ['Hazaribagh', 23.99, 85.36], ['Palamu', 24.04, 84.07],
    ['Dumka', 24.27, 87.25], ['Gumla', 23.04, 84.54],
  ],
  '21': [
    ['Khordha', 20.27, 85.84], ['Cuttack', 20.46, 85.88], ['Ganjam', 19.31, 84.79],
    ['Sundargarh', 22.25, 84.02], ['Mayurbhanj', 21.93, 86.73], ['Koraput', 18.81, 82.71],
    ['Kalahandi', 19.91, 83.16], ['Balasore', 21.49, 86.93],
  ],
  '22': [
    ['Raipur', 21.25, 81.63], ['Bilaspur', 22.08, 82.15], ['Durg', 21.19, 81.28],
    ['Bastar', 19.08, 82.03], ['Surguja', 23.12, 83.20], ['Raigarh', 21.90, 83.40],
    ['Dantewada', 18.90, 81.35], ['Korba', 22.35, 82.68],
  ],
  '23': [
    ['Bhopal', 23.26, 77.41], ['Indore', 22.72, 75.86], ['Jabalpur', 23.18, 79.99],
    ['Gwalior', 26.22, 78.18], ['Rewa', 24.53, 81.30], ['Sagar', 23.84, 78.74],
    ['Chhindwara', 22.06, 78.94], ['Mandla', 22.60, 80.38],
  ],
  '24': [
    ['Ahmedabad', 23.02, 72.57], ['Surat', 21.17, 72.83], ['Vadodara', 22.31, 73.18],
    ['Rajkot', 22.30, 70.80], ['Bhavnagar', 21.76, 72.15], ['Dahod', 22.83, 74.25],
    ['Kachchh', 23.24, 69.67], ['Valsad', 20.61, 72.93],
  ],
  '27': [
    ['Pune', 18.52, 73.86], ['Nagpur', 21.15, 79.09], ['Nashik', 20.00, 73.79],
    ['Chhatrapati Sambhajinagar', 19.88, 75.34], ['Gadchiroli', 20.18, 80.00],
    ['Nandurbar', 21.37, 74.24], ['Solapur', 17.66, 75.91], ['Amravati', 20.93, 77.75],
  ],
  '28': [
    ['Visakhapatnam', 17.69, 83.22], ['Guntur', 16.31, 80.44], ['Kurnool', 15.83, 78.04],
    ['Kakinada', 16.99, 82.24], ['Chittoor', 13.22, 79.10], ['Anantapur', 14.68, 77.60],
    ['Srikakulam', 18.30, 83.90], ['Prakasam', 15.50, 80.05],
  ],
  '29': [
    ['Bengaluru Urban', 12.97, 77.59], ['Mysuru', 12.30, 76.64], ['Belagavi', 15.85, 74.50],
    ['Kalaburagi', 17.33, 76.83], ['Raichur', 16.21, 77.36], ['Dakshina Kannada', 12.87, 74.88],
    ['Ballari', 15.14, 76.92], ['Vijayapura', 16.83, 75.71],
  ],
  '32': [
    ['Thiruvananthapuram', 8.52, 76.94], ['Ernakulam', 9.98, 76.28], ['Kozhikode', 11.25, 75.78],
    ['Thrissur', 10.52, 76.21], ['Malappuram', 11.07, 76.07], ['Wayanad', 11.61, 76.08],
    ['Palakkad', 10.78, 76.65], ['Idukki', 9.85, 76.97],
  ],
  '33': [
    ['Chennai', 13.08, 80.27], ['Coimbatore', 11.02, 76.96], ['Madurai', 9.93, 78.12],
    ['Tiruchirappalli', 10.79, 78.70], ['Salem', 11.66, 78.15], ['Thoothukudi', 8.76, 78.13],
    ['Vellore', 12.92, 79.13], ['Nilgiris', 11.41, 76.70],
  ],
  '36': [
    ['Hyderabad', 17.39, 78.49], ['Warangal', 17.97, 79.59], ['Karimnagar', 18.44, 79.13],
    ['Khammam', 17.25, 80.15], ['Nizamabad', 18.67, 78.09], ['Adilabad', 19.67, 78.53],
    ['Nalgonda', 17.05, 79.27], ['Mahabubnagar', 16.75, 77.99],
  ],
};

function slug(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 8);
}

export const DISTRICTS: DistrictInfo[] = Object.entries(DISTRICT_TABLE).flatMap(
  ([stateCode, rows]) =>
    rows.map(([name, lat, lon]) => ({
      code: 'DST-' + stateCode + '-' + slug(name),
      name,
      stateCode,
      stateName: STATES_BY_CODE[stateCode].name,
      lat,
      lon,
    })),
);

export const DISTRICTS_BY_CODE: Record<string, DistrictInfo> = Object.fromEntries(
  DISTRICTS.map((d) => [d.code, d]),
);

export function districtsOfState(stateCode: string): DistrictInfo[] {
  return DISTRICTS.filter((d) => d.stateCode === stateCode);
}

/**
 * MODELLED district population -- not census data.
 *
 * Drawn deterministically from the district code so it is stable across runs
 * and across machines. The range (roughly 0.6M to 4.2M) is the band most Indian
 * districts fall in; metros are pushed to the top of it. Every UI surface that
 * shows this number labels it as modelled.
 */
export function districtPopulation(code: string): number {
  const METRO = new Set([
    'DST-19-KOLKATA', 'DST-33-CHENNAI', 'DST-29-BENGALUR', 'DST-36-HYDERABA',
    'DST-24-AHMEDABA', 'DST-27-PUNE', 'DST-09-LUCKNOW', 'DST-08-JAIPUR',
  ]);
  const rng = createRng(hashSeed('pop', code));
  const base = METRO.has(code) ? rng.real(3_200_000, 4_200_000) : rng.real(600_000, 2_800_000);
  return Math.round(base / 1000) * 1000;
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
 * District adjacency, by road distance between district headquarters.
 *
 * WHY THIS EXISTS
 * ---------------
 * The redistribution optimiser is scope-agnostic -- nothing in it reads a
 * district code, and feasibility is decided purely by `roadDistanceKm` between
 * two facilities. So planning ACROSS districts needs no change to the planner;
 * it only needs a caller willing to hand it more than one district's contexts.
 * This is the index that decides which ones are worth handing over together.
 *
 * WHY HEADQUARTERS DISTANCE IS ONLY A PREFILTER
 * ---------------------------------------------
 * These are HQ-to-HQ distances, and they systematically OVERSTATE how far apart
 * two districts' facilities are. Sub-Centres scatter up to 85 km from their own
 * headquarters and PHCs up to 70 km, so neighbouring districts physically
 * interleave: the nearest facility in the next district is routinely far closer
 * than that district's HQ. Use this to choose a candidate set, then let the
 * planner's own `roadDistanceKm` on real facility coordinates decide what is
 * actually reachable. Treating an HQ radius as the feasibility test would throw
 * away most of the genuine opportunity.
 *
 * Measured over the 128 headquarters in this table, nearest-neighbour road
 * distance runs 30 km at the closest, ~128 km at the median. A radius chosen
 * below that median leaves most districts with no neighbours at all, which is
 * how a cross-district pass ends up silently recommending nothing.
 *
 * The whole matrix is 128x128 -- about 16,000 haversine calls -- so it is
 * computed once, eagerly, on first use and cached. Sorted nearest-first, which
 * is also the order a caller should prefer when budgeting how many neighbours
 * to pull into one plan.
 */
export interface DistrictNeighbour {
  code: string;
  /** Road km between the two district headquarters, same estimate the planner uses. */
  roadKm: number;
}

let NEIGHBOUR_CACHE: Map<string, DistrictNeighbour[]> | null = null;

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
    m.set(a.code, row);
  }
  NEIGHBOUR_CACHE = m;
  return m;
}

/**
 * Districts whose headquarters lie within `withinRoadKm` of this one, nearest
 * first, optionally capped at `limit`.
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

/** Road km between two district headquarters. `null` if either code is unknown. */
export function districtSeparationKm(a: string, b: string): number | null {
  if (a === b) return 0;
  const row = neighbourMatrix().get(a);
  if (!row) return null;
  return row.find((n) => n.code === b)?.roadKm ?? null;
}
