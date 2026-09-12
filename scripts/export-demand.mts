/**
 * Exports the district x drug daily demand history that TimesFM forecasts from.
 *
 * Run with:  npx tsx scripts/export-demand.mts
 * Output:    src/data/demand-district-daily.json
 *
 * WHY DISTRICT x DRUG AND NOT FACILITY x DRUG
 * -------------------------------------------
 * See the long note in `src/lib/bq/series.ts`. Briefly: 80,896 facility-level
 * series are both unreachable inside a 1 MB statement and the wrong shape for a
 * foundation model -- they are mostly zeros, which is Croston's regime, not
 * TimesFM's. The district aggregate is smooth and seasonal, which is TimesFM's.
 *
 * THE CENSORING CORRECTION, AND HOW IT DIFFERS FROM THE FACILITY ONE
 * ------------------------------------------------------------------
 * A stock ledger records what was DISPENSED, not what was NEEDED: a day when
 * the shelf was empty reads as a zero, indistinguishable from a day nobody came.
 * `fitDemandCensored` handles that at the facility by LISTWISE DELETION -- it
 * drops stocked-out days and fits on the rest, imputing nothing.
 *
 * Deletion is not available here, and it is worth being exact about why. A
 * district series has ONE time axis shared by every facility in it. Facility A
 * is stocked out on Tuesday and facility B on Friday; deleting either day would
 * throw away the other facility's good observation, and TimesFM needs a
 * complete, evenly spaced grid regardless.
 *
 * So the district day is a RATIO ESTIMATOR: total the facilities that could
 * actually have dispensed, then scale by how many were open.
 *
 *     y_t = (sum of issues at open facilities) x (all carriers / open carriers)
 *
 * That IS an imputation, unlike the facility-level correction, and it is stated
 * as one here and in the artefact's own metadata rather than being quietly
 * folded in. The assumption it makes -- that a stocked-out facility would have
 * dispensed at the same rate as its open neighbours that day -- is the mildest
 * one available, it is the standard unconstraining ratio from revenue
 * management, and it is applied to a minority of facility-days. `adjustedDays`
 * and `blindDays` in the output record exactly how often it fired and how often
 * every carrier in a district was dark at once (where the value is left as the
 * raw total, and so is a lower bound).
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
import { formularyFor } from '../src/lib/domain/drugs';
import { generateNetwork, DEMO_SCALE } from '../src/lib/sim/facilities';
import { simulateInventory } from '../src/lib/sim/inventory';

/** Must match `build-snapshot.mts`, or the forecast describes a different world. */
const ASOF = process.env.AAROGYA_ASOF
  ? new Date(process.env.AAROGYA_ASOF + 'T00:00:00Z')
  : new Date(Date.UTC(2026, 8, 30));
const SEED = 20260930;
const HISTORY_DAYS = 365;

/**
 * Days of history kept in the artefact.
 *
 * 180, not 365, and not 90. TimesFM reads a 90-day context; the WS1 backtest
 * holds out 28 days and needs a full context BEFORE that holdout, so 118 is the
 * true floor. 180 leaves room to slide the holdout window without re-running
 * the simulator, and costs about 2 MB.
 */
const WINDOW_DAYS = Number(process.env.AAROGYA_DEMAND_WINDOW ?? 180);

const OUT = resolve(import.meta.dirname, '../src/data/demand-district-daily.json');

function isoDate(base: Date, offsetDays: number): string {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

interface ExportedSeries {
  sid: string;
  districtCode: string;
  drugId: string;
  /** Facilities in the district whose formulary carries this drug. */
  carriers: number;
  /** Days where at least one carrier was stocked out and the ratio fired. */
  adjustedDays: number;
  /** Days where EVERY carrier was stocked out. The value is a lower bound. */
  blindDays: number;
  values: number[];
}

console.log('Exporting district x drug demand');
console.log('  as-of      :', ASOF.toISOString().slice(0, 10));
console.log('  history    :', HISTORY_DAYS + ' days simulated, last ' + WINDOW_DAYS + ' exported');
console.log('  districts  :', DISTRICTS.length);
console.log('  scale      :', JSON.stringify(DEMO_SCALE));
console.log();

const t0 = Date.now();
const sliceFrom = HISTORY_DAYS - WINDOW_DAYS;
const series: ExportedSeries[] = [];

let totalFacilityDays = 0;
let censoredFacilityDays = 0;

for (let i = 0; i < DISTRICTS.length; i++) {
  const district = DISTRICTS[i];
  const facilities = generateNetwork(DEMO_SCALE, [district], SEED);

  // drugId -> per-day accumulators for this district.
  const openIssues = new Map<string, Float64Array>();
  const openCount = new Map<string, Int32Array>();
  const rawIssues = new Map<string, Float64Array>();
  const carriers = new Map<string, number>();

  for (const facility of facilities) {
    for (const drug of formularyFor(facility.type)) {
      const sim = simulateInventory(facility, drug, {
        asOf: ASOF,
        historyDays: HISTORY_DAYS,
        seed: SEED,
      });

      let open = openIssues.get(drug.id);
      if (!open) {
        open = new Float64Array(WINDOW_DAYS);
        openIssues.set(drug.id, open);
        openCount.set(drug.id, new Int32Array(WINDOW_DAYS));
        rawIssues.set(drug.id, new Float64Array(WINDOW_DAYS));
        carriers.set(drug.id, 0);
      }
      const counts = openCount.get(drug.id)!;
      const raw = rawIssues.get(drug.id)!;
      carriers.set(drug.id, carriers.get(drug.id)! + 1);

      for (let d = 0; d < WINDOW_DAYS; d++) {
        const idx = sliceFrom + d;
        const issued = sim.recordedSeries[idx];
        raw[d] += issued;
        if (!sim.censoredMask[idx]) {
          open[d] += issued;
          counts[d] += 1;
        }
      }

      totalFacilityDays += WINDOW_DAYS;
      for (let d = sliceFrom; d < HISTORY_DAYS; d++) {
        if (sim.censoredMask[d]) censoredFacilityDays++;
      }
    }
  }

  for (const [drugId, open] of openIssues) {
    const counts = openCount.get(drugId)!;
    const raw = rawIssues.get(drugId)!;
    const n = carriers.get(drugId)!;
    const values: number[] = new Array(WINDOW_DAYS);
    let adjustedDays = 0;
    let blindDays = 0;

    for (let d = 0; d < WINDOW_DAYS; d++) {
      if (counts[d] === 0) {
        // Every carrier dark. Nothing to scale from, so the raw total stands --
        // a lower bound, and counted as one so the artefact says how often.
        values[d] = Math.round(raw[d]);
        blindDays++;
      } else {
        if (counts[d] < n) adjustedDays++;
        values[d] = Math.round((open[d] * n) / counts[d]);
      }
    }

    series.push({
      sid: district.code + '|' + drugId,
      districtCode: district.code,
      drugId,
      carriers: n,
      adjustedDays,
      blindDays,
      values,
    });
  }

  if ((i + 1) % 16 === 0 || i === DISTRICTS.length - 1) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      '  ' + String(i + 1).padStart(3) + '/' + DISTRICTS.length +
        '  ' + elapsed + 's  ' + series.length.toLocaleString('en-IN') + ' series',
    );
  }
}

// Deterministic order, so the artefact is byte-identical run to run.
series.sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));

const startDate = isoDate(ASOF, -WINDOW_DAYS);
const lastDate = isoDate(ASOF, -1);

const artefact = {
  asOf: ASOF.toISOString().slice(0, 10),
  startDate,
  lastDate,
  days: WINDOW_DAYS,
  seed: SEED,
  historyDaysSimulated: HISTORY_DAYS,
  scale: DEMO_SCALE,
  censoring: {
    method: 'district uncensored-ratio unconstraining',
    note:
      'Facility-level fitting deletes stocked-out days (no imputation). A district ' +
      'series shares one time axis across its facilities, so deletion is not available: ' +
      'the day is totalled over open carriers and scaled by all carriers / open carriers. ' +
      'That is an imputation, and adjustedDays / blindDays report how often it fired.',
    censoredFacilityDays,
    totalFacilityDays,
    censoredShare: +(censoredFacilityDays / Math.max(1, totalFacilityDays)).toFixed(4),
  },
  seriesCount: series.length,
  series,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(artefact) + '\n');

const sizeKb = Math.round(JSON.stringify(artefact).length / 1024);
const allValues = series.flatMap((s) => s.values);
const mean = allValues.reduce((a, b) => a + b, 0) / Math.max(1, allValues.length);
const max = allValues.reduce((a, b) => Math.max(a, b), 0);
const zeroShare = allValues.filter((v) => v === 0).length / Math.max(1, allValues.length);
const totalAdjusted = series.reduce((a, s) => a + s.adjustedDays, 0);
const totalBlind = series.reduce((a, s) => a + s.blindDays, 0);

console.log();
console.log('='.repeat(66));
console.log('Written to src/data/demand-district-daily.json  (' + sizeKb.toLocaleString('en-IN') + ' KB)');
console.log('  series            :', series.length.toLocaleString('en-IN'));
console.log('  window            :', startDate, '->', lastDate, '(' + WINDOW_DAYS + ' days)');
console.log('  export time       :', ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('  mean daily value  :', mean.toFixed(1), ' max:', max.toLocaleString('en-IN'));
console.log('  zero days         :', (zeroShare * 100).toFixed(1) + '% of all district-days');
console.log('  censored fac-days :', censoredFacilityDays.toLocaleString('en-IN'), 'of', totalFacilityDays.toLocaleString('en-IN'), '(' + ((censoredFacilityDays / totalFacilityDays) * 100).toFixed(1) + '%)');
console.log('  ratio fired on    :', totalAdjusted.toLocaleString('en-IN'), 'district-days');
console.log('  all carriers dark :', totalBlind.toLocaleString('en-IN'), 'district-days (value is a lower bound)');
