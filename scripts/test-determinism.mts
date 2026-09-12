/**
 * The pipeline must be deterministic, and the forecast must actually change it.
 *
 * Run with:  npx tsx scripts/test-determinism.mts   (part of `npm test`)
 *
 * WHY THIS IS A TEST AND NOT A ONE-OFF CHECK
 * ------------------------------------------
 * Every number in the README, the deck and the console is quoted from a
 * committed artefact, and `check-claims.mts` holds the prose to it. That whole
 * arrangement rests on one assumption: rebuilding produces the same artefact.
 * If a stray `Math.random()`, a `Date.now()`, or a Map iteration order ever gets
 * between the seed and the output, the guard starts failing on rebuilds that
 * changed nothing, and the reflex will be to update the prose rather than to
 * find the leak. So determinism is checked directly, on the cheapest unit that
 * exercises the whole chain: one district, built twice.
 *
 * The second half is the more interesting one. It asserts that turning the
 * TimesFM cache ON actually MOVES the risk numbers. A forecast that is loaded,
 * disaggregated, threaded through four files and then quietly ignored would
 * pass every other test in this repo -- the snapshot would build, the claims
 * would agree, and the submission's central AI claim would be false.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDistrictState } from '../src/lib/pipeline';
import { asForecastCache } from '../src/lib/forecast/timesfm';
import type { FacilityDrugState } from '../src/lib/pipeline';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  -- ' + detail : ''));
  }
}

/** Must match `build-snapshot.mts`, or this tests a different pipeline. */
const ASOF = new Date(Date.UTC(2026, 8, 30));
const SIMULATIONS = 600;
const DISTRICT = 'DST-10-PURNIA';

const cachePath = resolve(process.cwd(), 'src/data/forecast-cache.json');
const cache = existsSync(cachePath)
  ? asForecastCache(JSON.parse(readFileSync(cachePath, 'utf8')))
  : null;

/** The fields a snapshot actually ships, so the comparison is the real payload. */
const fingerprint = (states: FacilityDrugState[]) =>
  JSON.stringify(
    states.map((s) => [
      s.facility.id,
      s.drug.id,
      s.risk.onHand,
      s.risk.stockoutProbability,
      s.risk.expectedShortfallUnits,
      s.risk.reorderPoint,
      s.risk.riskScore,
      s.risk.forecastDailyDemand,
      s.risk.projectedExpiryWaste,
      s.forecastSource,
    ]),
  );

console.log('\ndeterminism (no forecast cache)');
const plainA = buildDistrictState(DISTRICT, { asOf: ASOF, simulations: SIMULATIONS });
const plainB = buildDistrictState(DISTRICT, { asOf: ASOF, simulations: SIMULATIONS });
check('two builds of one district are identical', fingerprint(plainA) === fingerprint(plainB));
check('and produce the same position count', plainA.length === plainB.length, plainA.length + ' vs ' + plainB.length);
check('every position is on the Croston path', plainA.every((s) => s.forecastSource === 'croston'));

if (!cache) {
  console.log('\n  ! src/data/forecast-cache.json missing -- skipping the TimesFM half.');
  console.log('    run `npm run forecast:refresh` to build it.');
} else {
  console.log('\ndeterminism (with the committed TimesFM cache)');
  const fcA = buildDistrictState(DISTRICT, { asOf: ASOF, simulations: SIMULATIONS, forecastCache: cache });
  const fcB = buildDistrictState(DISTRICT, { asOf: ASOF, simulations: SIMULATIONS, forecastCache: cache });
  check('two forecast builds are identical', fingerprint(fcA) === fingerprint(fcB));
  check('every position is on the TimesFM path', fcA.every((s) => s.forecastSource === 'timesfm'));

  console.log('\nthe forecast is not a no-op');
  // If this ever passes by equality, TimesFM is being loaded and ignored.
  check('turning the cache on changes the risk numbers', fingerprint(plainA) !== fingerprint(fcA));

  const moved = fcA.filter((s, i) => s.risk.forecastDailyDemand !== plainA[i].risk.forecastDailyDemand);
  check(
    'and it moves most positions, not a handful',
    moved.length > fcA.length * 0.5,
    moved.length + ' of ' + fcA.length + ' positions moved',
  );

  // Shares must sum to 1 within each (district, drug) group, or the facility
  // paths no longer add up to the district path TimesFM produced.
  const byDrug = new Map<string, number>();
  for (const s of fcA) {
    if (s.districtShare === undefined) continue;
    byDrug.set(s.drug.id, (byDrug.get(s.drug.id) ?? 0) + s.districtShare);
  }
  const offBy = [...byDrug.entries()].filter(([, sum]) => Math.abs(sum - 1) > 1e-9);
  check(
    'facility shares sum to 1 for every drug in the district',
    offBy.length === 0,
    offBy.length ? offBy[0][0] + ' sums to ' + offBy[0][1] : String(byDrug.size) + ' drugs checked',
  );
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + '  ' + (checks - failures) + '/' + checks + ' checks');
process.exit(failures === 0 ? 0 : 1);
