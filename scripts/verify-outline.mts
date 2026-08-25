/**
 * The boundary regression test.
 *
 * WHY THIS IS IN `npm test` AND NOT A COMMENT
 * -------------------------------------------
 * The national outline is now drawn by two renderers -- the server-rendered SVG and
 * the WebGL relief -- and the reason it looks the way it does is recorded in prose in
 * `src/lib/relief/outline.ts`. Prose does not fail a build.
 *
 * In India the depiction of national boundaries is governed rather than a matter of
 * preference. Every ordinary international dataset (Natural Earth, GADM) and every
 * hosted basemap terminates Jammu and Kashmir at the Line of Control, so the single
 * most likely way this project ships a wrong map is somebody swapping the geometry
 * for a more convenient one -- a CDN silhouette, a Mapbox basemap, a re-simplified
 * file that tessellates more cheaply -- without reading the docblock explaining why
 * they must not.
 *
 * An LoC-terminated file stops near 35.5 N. This asserts 37.09 N, so that swap fails
 * here, loudly, in CI, instead of silently in front of a ministry.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Outline {
  type: string;
  properties?: Record<string, unknown>;
  geometry: { type: string; coordinates: number[][][][] };
}

const PATH = resolve(process.cwd(), 'src/data/india-outline.json');
const outline = JSON.parse(readFileSync(PATH, 'utf8')) as Outline;

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail: string) {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${name} — ${detail}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name} — ${detail}`);
  }
}

console.log('Verifying the national outline…\n');

check(
  'geometry is a MultiPolygon',
  outline.geometry?.type === 'MultiPolygon',
  `got "${outline.geometry?.type}"`,
);

const parts = outline.geometry.coordinates;

check(
  'every polygon part is single-ring',
  parts.every((p) => p.length === 1),
  // `INDIA_POLYGONS` takes `part[0]`. If an interior ring ever appears that shortcut
  // starts silently dropping a hole, so this is the assertion that catches it.
  `${parts.filter((p) => p.length > 1).length} of ${parts.length} parts have holes`,
);

let north = -Infinity;
let south = Infinity;
let east = -Infinity;
let west = Infinity;
let vertices = 0;

for (const part of parts) {
  for (const ring of part) {
    for (const [lon, lat] of ring) {
      vertices += 1;
      if (lat > north) north = lat;
      if (lat < south) south = lat;
      if (lon > east) east = lon;
      if (lon < west) west = lon;
    }
  }
}

check(
  'reaches Gilgit-Baltistan and Aksai Chin',
  north >= 37.09,
  `north extent ${north.toFixed(3)} N (an LoC-terminated file stops near 35.5 N)`,
);

check(
  'reaches the whole of Arunachal Pradesh',
  east >= 97.39,
  `east extent ${east.toFixed(3)} E`,
);

check(
  'reaches the Nicobar Islands',
  south <= 6.76,
  `south extent ${south.toFixed(3)} N`,
);

check('west extent intact', west <= 68.18, `west extent ${west.toFixed(3)} E`);

check(
  'still the composite source',
  String(outline.properties?.source ?? '').includes('india-composite'),
  `properties.source = "${outline.properties?.source ?? '(none)'}"`,
);

// Not a correctness bound, a cost one: the file is imported by a server component and
// serialised into the landing page HTML. A re-simplification that ballooned it would
// show up as a slower first paint rather than as a wrong map, so it gets a looser
// bound and a separate message.
check(
  'vertex count within budget',
  vertices <= 4000,
  `${vertices} vertices across ${parts.length} polygon parts`,
);

console.log();
if (failures > 0) {
  console.error(`${failures} of ${checks} checks FAILED.`);
  console.error(
    '\nIf you changed the outline deliberately, read the docblock in\n' +
      'src/lib/relief/outline.ts before changing these assertions.',
  );
  process.exit(1);
}
console.log(`All ${checks} outline checks passed.`);
