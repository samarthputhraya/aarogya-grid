/**
 * Simplifies India state boundaries down to something shippable.
 *
 * Run with:  npx tsx scripts/simplify-geo.ts
 * In:        src/data/india-raw.geojson   (~23 MB, GADM level-1)
 * Out:       src/data/india-states.json   (target < 300 KB)
 *
 * A national overview map does not need survey-grade coastline. Douglas-Peucker
 * at a few kilometres of tolerance, plus dropping islands too small to see at
 * this zoom, removes ~99% of the bytes and none of the meaning.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

type Ring = [number, number][];

const IN = resolve(process.cwd(), 'src/data/india-raw.geojson');
const OUT = resolve(process.cwd(), 'src/data/india-states.json');

if (!existsSync(IN)) {
  console.error('Missing', IN);
  console.error('Fetch it first (GADM level-1 India boundaries).');
  process.exit(1);
}

/** LGD / Census state codes, keyed by the name used in the source data. */
const CODE_BY_NAME: Record<string, string> = {
  'Jammu and Kashmir': '01',
  'Himachal Pradesh': '02',
  Punjab: '03',
  Chandigarh: '04',
  Uttaranchal: '05',
  Uttarakhand: '05',
  Haryana: '06',
  Delhi: '07',
  Rajasthan: '08',
  'Uttar Pradesh': '09',
  Bihar: '10',
  Sikkim: '11',
  'Arunachal Pradesh': '12',
  Nagaland: '13',
  Manipur: '14',
  Mizoram: '15',
  Tripura: '16',
  Meghalaya: '17',
  Assam: '18',
  'West Bengal': '19',
  Jharkhand: '20',
  Orissa: '21',
  Odisha: '21',
  Chhattisgarh: '22',
  'Madhya Pradesh': '23',
  Gujarat: '24',
  'Daman and Diu': '25',
  'Dadra and Nagar Haveli': '26',
  Maharashtra: '27',
  'Andhra Pradesh': '28',
  Karnataka: '29',
  Goa: '30',
  Lakshadweep: '31',
  Kerala: '32',
  'Tamil Nadu': '33',
  Puducherry: '34',
  Pondicherry: '34',
  'Andaman and Nicobar': '35',
  Telangana: '36',
};

/** Perpendicular distance from p to the segment a-b, in degrees. */
function perpendicularDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + clamped * dx), py - (ay + clamped * dy));
}

/** Douglas-Peucker, iterative to avoid blowing the stack on 100k-point rings. */
function simplify(points: Ring, epsilon: number): Ring {
  if (points.length < 3) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > epsilon && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: Ring = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Shoelace area in square degrees -- used only to drop specks. */
function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a / 2);
}

function roundRing(ring: Ring, dp: number): Ring {
  const f = Math.pow(10, dp);
  const out: Ring = [];
  let prev: string | null = null;
  for (const [x, y] of ring) {
    const rx = Math.round(x * f) / f;
    const ry = Math.round(y * f) / f;
    const key = rx + ',' + ry;
    if (key !== prev) {
      out.push([rx, ry]);
      prev = key;
    }
  }
  // Close the ring if rounding broke the closure.
  if (out.length > 2) {
    const [fx, fy] = out[0];
    const [lx, ly] = out[out.length - 1];
    if (fx !== lx || fy !== ly) out.push([fx, fy]);
  }
  return out;
}

const EPSILON = 0.035; // ~3.9 km at these latitudes
const MIN_AREA = 0.02; // drop islands smaller than roughly 250 sq km
const DECIMALS = 3;

console.log('Reading', IN);
const raw = JSON.parse(readFileSync(IN, 'utf8')) as {
  features: {
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown } | null;
  }[];
};

let ringsIn = 0;
let ringsOut = 0;
let pointsIn = 0;
let pointsOut = 0;

const features = raw.features
  .map((f) => {
    const name = String(f.properties.NAME_1 ?? f.properties.name ?? 'Unknown');
    const code = CODE_BY_NAME[name] ?? null;
    if (!f.geometry) return null;

    const polygons: Ring[][] =
      f.geometry.type === 'Polygon'
        ? [f.geometry.coordinates as Ring[]]
        : (f.geometry.coordinates as Ring[][]);

    const kept: Ring[][] = [];
    for (const poly of polygons) {
      const outer = poly[0];
      if (!outer) continue;
      ringsIn++;
      pointsIn += outer.length;

      if (ringArea(outer) < MIN_AREA) continue;

      const simplified = roundRing(simplify(outer, EPSILON), DECIMALS);
      if (simplified.length < 4) continue;

      ringsOut++;
      pointsOut += simplified.length;
      // Interior rings (lakes, enclaves) are dropped -- invisible at this zoom.
      kept.push([simplified]);
    }

    if (kept.length === 0) return null;

    return {
      type: 'Feature' as const,
      properties: { code, name },
      geometry: { type: 'MultiPolygon' as const, coordinates: kept },
    };
  })
  .filter((f): f is NonNullable<typeof f> => f !== null);

const collection = { type: 'FeatureCollection' as const, features };
const json = JSON.stringify(collection);
writeFileSync(OUT, json);

console.log('\nSimplified:');
console.log('  features :', features.length);
console.log('  rings    :', ringsIn, '->', ringsOut);
console.log('  points   :', pointsIn.toLocaleString(), '->', pointsOut.toLocaleString(),
  '(' + ((1 - pointsOut / pointsIn) * 100).toFixed(1) + '% removed)');
console.log('  size     :', (readFileSync(IN).length / 1024 / 1024).toFixed(1) + ' MB ->',
  (json.length / 1024).toFixed(0) + ' KB');

const mapped = features.filter((f) => f.properties.code).length;
console.log('  mapped to LGD codes:', mapped, '/', features.length);
const unmapped = features.filter((f) => !f.properties.code).map((f) => f.properties.name);
if (unmapped.length) console.log('  unmapped:', unmapped.join(', '));
console.log('\nWrote', OUT);
