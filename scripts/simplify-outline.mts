/**
 * Simplifies the national outline of India down to something shippable.
 *
 * Run with:  npx tsx scripts/simplify-outline.mts
 * In:        src/data/india-raw-outline.geojson   (~10.7 MB, datameet composite)
 * Out:       src/data/india-outline.json          (target < 200 KB)
 *
 * WHY THIS FILE AND NOT A STATE-LEVEL BOUNDARY SET
 * ------------------------------------------------
 * The map previously rendered GADM state polygons and they had to be removed:
 * pre-2011 vintage, no Telangana, states still labelled "Orissa" and
 * "Uttaranchal". Replacing them raises a question that is not a design
 * question. In India the depiction of national boundaries is governed, not a
 * matter of cartographic preference, and the ordinary international boundary
 * files -- Natural Earth, GADM -- draw the Line of Control as a border. Using
 * one of those in a system pitched at a state health department is not a
 * cosmetic error.
 *
 * `datameet/maps` publishes this outline as a COMPOSITE, meaning the full
 * territory India claims. Verified on the source before adopting it:
 *
 *     north extent  37.10 N   -- reaches Gilgit-Baltistan and Aksai Chin
 *                                (an LoC-terminated file stops near 35.5 N)
 *     east  extent  97.40 E   -- the whole of Arunachal Pradesh
 *     south extent   6.75 N   -- includes the Nicobar Islands
 *
 * Only the national outline is shipped. Internal state boundaries are not
 * drawn: they would add a second class of boundary claim for no analytical
 * gain, since districts are already plotted from their own coordinates and
 * labelled by state. One outline says "this is India" and asserts nothing else.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

type Ring = [number, number][];

const IN = resolve(process.cwd(), 'src/data/india-raw-outline.geojson');
const OUT = resolve(process.cwd(), 'src/data/india-outline.json');

if (!existsSync(IN)) {
  console.error('Missing', IN);
  console.error('Fetch it first:');
  console.error('  curl -L https://raw.githubusercontent.com/datameet/maps/master/Country/india-composite.geojson \\');
  console.error('    -o src/data/india-raw-outline.geojson');
  process.exit(1);
}

/** Perpendicular distance from a point to the line through `a` and `b`. */
function perpendicularDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

/** Douglas-Peucker, iterative so a 100k-point coastline cannot blow the stack. */
function simplify(points: Ring, epsilon: number): Ring {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
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

/** Shoelace area in square degrees. Sign is discarded; only magnitude matters. */
function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(sum / 2);
}

// ~2.2 km at this latitude. The map renders India across roughly 700px, so one
// pixel is ~4 km -- simplifying below that spends bytes on detail no projector
// will resolve.
const EPSILON = 0.02;
// Drop islands under roughly 250 sq km. At this zoom they are sub-pixel, and
// the Andaman and Nicobar chains survive because the large members do.
const MIN_AREA = 0.02;
// Three decimals is ~110 m. Beyond that we are shipping noise.
const PRECISION = 3;

const round = (ring: Ring): Ring =>
  ring.map(([lon, lat]) => [+lon.toFixed(PRECISION), +lat.toFixed(PRECISION)] as [number, number]);

const source = JSON.parse(readFileSync(IN, 'utf8')) as {
  features: { geometry: { type: string; coordinates: unknown } }[];
};

let pointsIn = 0;
let pointsOut = 0;
let ringsDropped = 0;
const polygons: Ring[][] = [];

for (const feature of source.features) {
  const geom = feature.geometry;
  const groups =
    geom.type === 'MultiPolygon'
      ? (geom.coordinates as Ring[][])
      : geom.type === 'Polygon'
        ? [geom.coordinates as unknown as Ring[]]
        : [];

  for (const rings of groups) {
    const outer = rings[0];
    if (!outer) continue;
    pointsIn += outer.length;

    if (ringArea(outer) < MIN_AREA) {
      ringsDropped++;
      continue;
    }

    const simplified = round(simplify(outer, EPSILON));
    if (simplified.length < 4) {
      ringsDropped++;
      continue;
    }
    pointsOut += simplified.length;

    // Holes are kept only if they are large enough to read, so that an enclave
    // does not vanish while its container survives.
    const holes: Ring[] = [];
    for (let i = 1; i < rings.length; i++) {
      if (ringArea(rings[i]) < MIN_AREA) continue;
      const h = round(simplify(rings[i], EPSILON));
      if (h.length >= 4) holes.push(h);
    }

    polygons.push([simplified, ...holes]);
  }
}

const out = {
  type: 'Feature' as const,
  properties: {
    name: 'India',
    source: 'datameet/maps Country/india-composite.geojson',
    note: 'Composite outline: the full territory claimed by India. National outline only; no internal boundaries.',
  },
  geometry: { type: 'MultiPolygon' as const, coordinates: polygons },
};

const json = JSON.stringify(out);
writeFileSync(OUT, json);

console.log('India outline simplified');
console.log('  polygons :', polygons.length, '(' + ringsDropped + ' rings dropped as sub-pixel)');
console.log('  points   :', pointsIn.toLocaleString(), '->', pointsOut.toLocaleString(),
  '(' + ((1 - pointsOut / pointsIn) * 100).toFixed(1) + '% removed)');
console.log('  size     :', (readFileSync(IN).length / 1024 / 1024).toFixed(1) + ' MB ->',
  (json.length / 1024).toFixed(0) + ' KB');
