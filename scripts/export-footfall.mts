/**
 * Exports the district daily OPD footfall history the surge detector watches.
 *
 * Run with:  npx tsx scripts/export-footfall.mts
 * Output:    src/data/footfall-district-daily.json
 *
 * WHY THIS SERIES AND NOT THE STOCK ONE
 * -------------------------------------
 * The stock consumption series is what the supply chain acts on, and it is
 * late. Consumption cannot move until people have already walked in, been
 * seen, and been treated -- so by the time a block's anti-malarial issues rise,
 * the malaria has been there a fortnight. The OPD register records the walking
 * in, and every PHC in India already keeps one. If this project's claim is that
 * it sees a health emergency coming, this is the series that has to carry it.
 *
 * TWO SERIES PER DISTRICT, AND ONLY ONE OF THEM IS REAL
 * ----------------------------------------------------
 *   `attended` -- consultations actually recorded. This is what an HMIS return
 *                 contains, it is censored by who was present to give them, and
 *                 it is the ONLY series the detector is allowed to see.
 *   `demand`   -- everyone who presented, including those turned away. Ground
 *                 truth that only a simulation can know.
 *
 * Both are written because the tuning run has to measure what the detector
 * MISSED, and that question is unanswerable from the censored series alone. The
 * separation is the point: any warning rule that reads `demand` is cheating,
 * and a reader of this file can check which one a script opened.
 *
 * REPRODUCIBILITY
 * ---------------
 * Same seed, same as-of date, same scale as `build-snapshot.mts`, and no
 * wall-clock timestamp anywhere in the output -- so two runs are byte-identical
 * and a diff on this file means the data changed, never that it was rebuilt.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DISTRICTS } from '../src/lib/domain/geo';
import { generateNetwork, DEMO_SCALE } from '../src/lib/sim/facilities';
import { simulateFootfall } from '../src/lib/sim/footfall';

/** Must match `build-snapshot.mts`, or this describes a different country. */
const ASOF = new Date(Date.UTC(2026, 8, 30));
const SEED = 20260930;
/**
 * Days exported, and the one-day offset that makes them line up.
 *
 * The two series HAVE to share a calendar. A surge rule that sees footfall rise
 * on day 140 and stock consumption rise on day 147 is measuring a lead time,
 * and it can only do that if day 140 is the same date in both files.
 *
 * `export-demand` ends its window on the day BEFORE the as-of date, because a
 * stock ledger's last complete day is yesterday -- today's dispensing is still
 * happening. The same is true of an OPD register, so the same convention is
 * used: simulate through the as-of date and export everything up to the day
 * before it. Both files then run 2026-04-03 to 2026-09-29 and index `i` means
 * one date.
 *
 * (The facility's `attendedToday` in the snapshot is the as-of day itself --
 * the live, incomplete count a console shows. It is deliberately outside this
 * series, because a partial day at the end of a history is exactly the thing an
 * anomaly detector would flag.)
 */
const WINDOW_DAYS = 180;
const SIM_DAYS = WINDOW_DAYS + 1;

const OUT = resolve(process.cwd(), 'src/data/footfall-district-daily.json');

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const start = new Date(ASOF.getTime());
start.setUTCDate(start.getUTCDate() - (SIM_DAYS - 1));
const lastDate = new Date(ASOF.getTime());
lastDate.setUTCDate(lastDate.getUTCDate() - 1);

console.log('Exporting district OPD footfall');
console.log('  as-of      :', isoDate(ASOF));
console.log('  window     :', isoDate(start), '->', isoDate(lastDate), '(' + WINDOW_DAYS + ' days)');
console.log('  districts  :', DISTRICTS.length);

interface DistrictFootfall {
  code: string;
  name: string;
  stateCode: string;
  /** Facilities with an outpatient department. Warehouses have none. */
  facilities: number;
  population: number;
  attended: number[];
  demand: number[];
  /** Facility-days the OPD could not see everyone who came. */
  cappedFacilityDays: number;
  /** Facility-days no clinician was present and the OPD did not run. */
  closedFacilityDays: number;
}

const districts: DistrictFootfall[] = [];
let attendedTotal = 0;
let demandTotal = 0;
let cappedTotal = 0;
let closedTotal = 0;
const t0 = Date.now();

for (const district of DISTRICTS) {
  // One district at a time: the whole national network is held only as long as
  // it takes to sum it, which is what keeps this inside a normal heap.
  const facilities = generateNetwork(DEMO_SCALE, [district], SEED);

  const attended = new Array<number>(WINDOW_DAYS).fill(0);
  const demand = new Array<number>(WINDOW_DAYS).fill(0);
  let withOpd = 0;
  let population = 0;
  let capped = 0;
  let closed = 0;

  for (const facility of facilities) {
    const f = simulateFootfall(facility, { asOf: ASOF, historyDays: SIM_DAYS, seed: SEED });
    if (f.attendedSeries.length === 0) continue;
    withOpd++;
    population += facility.population;
    capped += f.daysCapped;
    closed += f.daysClosed;
    // Drop the last element: that is the as-of day, which is still running.
    for (let i = 0; i < WINDOW_DAYS; i++) {
      attended[i] += f.attendedSeries[i];
      demand[i] += f.demandSeries[i];
    }
  }

  attendedTotal += attended.reduce((a, b) => a + b, 0);
  demandTotal += demand.reduce((a, b) => a + b, 0);
  cappedTotal += capped;
  closedTotal += closed;

  districts.push({
    code: district.code,
    name: district.name,
    stateCode: district.stateCode,
    facilities: withOpd,
    population,
    attended,
    demand,
    cappedFacilityDays: capped,
    closedFacilityDays: closed,
  });
}

const artefact = {
  asOf: isoDate(ASOF),
  startDate: isoDate(start),
  lastDate: isoDate(lastDate),
  days: WINDOW_DAYS,
  seed: SEED,
  scale: DEMO_SCALE,
  note:
    'Simulated OPD attendance. `attended` is what an HMIS return would contain -- ' +
    'censored by the clinicians present on the day, from the same roster the workforce ' +
    'panel shows. `demand` is everyone who presented, which only a simulation can know ' +
    'and which no detector in this project is allowed to read.',
  districts,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(artefact) + '\n');

const sizeKb = Math.round(JSON.stringify(artefact).length / 1024);
console.log('');
console.log('  attended   :', attendedTotal.toLocaleString('en-IN'), 'consultations');
console.log(
  '  turned away:',
  (demandTotal - attendedTotal).toLocaleString('en-IN'),
  '(' + (((demandTotal - attendedTotal) / demandTotal) * 100).toFixed(1) + '% of those who came)',
);
console.log(
  '  censoring  :',
  cappedTotal.toLocaleString('en-IN'),
  'facility-days capped ·',
  closedTotal.toLocaleString('en-IN'),
  'with no clinician at all',
);
console.log('  wrote      :', OUT, '(' + sizeKb + ' KB)');
console.log('  took       :', ((Date.now() - t0) / 1000).toFixed(1) + 's');
