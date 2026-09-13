/**
 * Exports the district x drug daily demand history that TimesFM forecasts from.
 *
 * Run with:  npx tsx scripts/export-demand.mts
 * Output:    src/data/demand-district-daily.json
 *
 * WHY DISTRICT x DRUG AND NOT FACILITY x DRUG
 * -------------------------------------------
 * See the long note in `src/lib/bq/series.ts`. Briefly: some 81,000 facility-level
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
import { DEMO_SCALE } from '../src/lib/sim/facilities';
import { mapInWorkers } from './lib/pool';
import { SEED, HISTORY_DAYS, type DemandTask, type DemandTaskResult, type ExportedSeries } from './tasks/demand-district';

/** Must match `build-snapshot.mts`, or the forecast describes a different world. */
const ASOF = process.env.AAROGYA_ASOF
  ? new Date(process.env.AAROGYA_ASOF + 'T00:00:00Z')
  : new Date(Date.UTC(2026, 8, 30));

/**
 * Days of history kept in the artefact.
 *
 * 180, not 365, and not 90. TimesFM reads a 90-day context; the WS1 backtest
 * holds out 28 days and needs a full context BEFORE that holdout, so 118 is the
 * true floor. 180 leaves room to slide the holdout window without re-running
 * the simulator.
 */
const WINDOW_DAYS = Number(process.env.AAROGYA_DEMAND_WINDOW ?? 180);

const OUT = resolve(import.meta.dirname, '../src/data/demand-district-daily.json');

function isoDate(base: Date, offsetDays: number): string {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

console.log('Exporting district x drug demand');
console.log('  as-of      :', ASOF.toISOString().slice(0, 10));
console.log('  history    :', HISTORY_DAYS + ' days simulated, last ' + WINDOW_DAYS + ' exported');
console.log('  districts  :', DISTRICTS.length);
console.log('  scale      :', JSON.stringify(DEMO_SCALE));
console.log();

const t0 = Date.now();
const tasks: DemandTask[] = DISTRICTS.map((d) => ({
  code: d.code,
  asOfIso: ASOF.toISOString().slice(0, 10),
  windowDays: WINDOW_DAYS,
}));
// One district per task, on every thread memory allows; results in table order.
const perDistrict = await mapInWorkers<DemandTask, DemandTaskResult>(
  resolve(import.meta.dirname, 'tasks/demand-district.ts'),
  tasks,
  {
    memoryPerThreadMb: 300,
    onProgress: (done, total) => {
      if (done % 64 === 0 || done === total) {
        console.log('  ' + String(done).padStart(3) + '/' + total + '  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
      }
    },
  },
);
const series: ExportedSeries[] = perDistrict.flatMap((r) => r.series);
const totalFacilityDays = perDistrict.reduce((a, r) => a + r.totalFacilityDays, 0);
const censoredFacilityDays = perDistrict.reduce((a, r) => a + r.censoredFacilityDays, 0);
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
