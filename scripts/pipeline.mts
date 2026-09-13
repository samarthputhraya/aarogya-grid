/**
 * Every artefact, regenerated in dependency order.
 *
 * Run:  npx tsx scripts/pipeline.mts                      (every stage)
 *       npx tsx scripts/pipeline.mts demand forecast      (named stages, in order given)
 *       npx tsx scripts/pipeline.mts --from snapshot      (a stage and everything after it)
 *
 * The order is not a preference. The forecast cache must start on the snapshot's
 * as-of date; the backtest scores the series the refresh forecast; the federated
 * nodes read the district payloads the snapshot wrote; the warning rule is tuned
 * on the footfall and demand series; the indicator feed is built from the
 * detector's output and the tuned rule. Running any of them out of order produces
 * artefacts that disagree with each other while every one of them looks valid,
 * which is the failure the claims guard exists to catch after the fact -- this
 * exists so it does not happen in the first place.
 *
 * The district registry and the state indicators are fetched from the network
 * and are NOT stages here: they change when their sources do, not when a batch
 * runs, and a rebuild must never quietly move the country it is computed over.
 */
import { spawnSync } from 'node:child_process';

interface Stage {
  name: string;
  script: string;
  args?: string[];
  /** True when the stage calls BigQuery. Skipped with AAROGYA_NO_BQ=1. */
  bigQuery?: boolean;
}

const STAGES: Stage[] = [
  { name: 'demand', script: 'scripts/export-demand.mts' },
  { name: 'forecast', script: 'scripts/forecast-refresh.mts', bigQuery: true },
  { name: 'backtest', script: 'scripts/backtest-forecast.mts', bigQuery: true },
  { name: 'snapshot', script: 'scripts/build-snapshot.mts' },
  { name: 'federated', script: 'scripts/build-federated.mts' },
  { name: 'footfall', script: 'scripts/export-footfall.mts' },
  { name: 'anomalies', script: 'scripts/detect-anomalies.mts', bigQuery: true },
  { name: 'tuning', script: 'scripts/tune-warning.mts', bigQuery: true },
  { name: 'indicators', script: 'scripts/export-indicators.mts' },
  { name: 'surge', script: 'scripts/surge-example.mts' },
  { name: 'censoring', script: 'scripts/eval-censoring.mts' },
];

const argv = process.argv.slice(2);
const fromIdx = argv.indexOf('--from');
let selected: Stage[];
if (fromIdx >= 0) {
  const start = STAGES.findIndex((s) => s.name === argv[fromIdx + 1]);
  if (start < 0) throw new Error('unknown stage ' + argv[fromIdx + 1]);
  selected = STAGES.slice(start);
} else if (argv.length) {
  selected = argv.map((n) => {
    const s = STAGES.find((x) => x.name === n);
    if (!s) throw new Error('unknown stage ' + n + '; stages: ' + STAGES.map((x) => x.name).join(', '));
    return s;
  });
} else {
  selected = STAGES;
}

const offline = process.env.AAROGYA_NO_BQ === '1';
const timings: [string, string][] = [];
const t0 = Date.now();

for (const stage of selected) {
  if (stage.bigQuery && offline) {
    console.log('\n==> ' + stage.name + ': skipped (AAROGYA_NO_BQ=1)');
    timings.push([stage.name, 'skipped']);
    continue;
  }
  console.log('\n==> ' + stage.name + ' (' + stage.script + ')');
  const started = Date.now();
  const r = spawnSync('npx', ['tsx', stage.script, ...(stage.args ?? [])], { stdio: 'inherit', shell: true });
  const secs = ((Date.now() - started) / 1000).toFixed(0) + 's';
  timings.push([stage.name, r.status === 0 ? secs : 'FAILED after ' + secs]);
  if (r.status !== 0) {
    console.error('\nstage ' + stage.name + ' failed (exit ' + r.status + '); stopping so nothing downstream runs on a stale input.');
    break;
  }
}

console.log('\n' + '='.repeat(40));
for (const [name, t] of timings) console.log('  ' + name.padEnd(12) + t);
console.log('  ' + 'total'.padEnd(12) + ((Date.now() - t0) / 1000).toFixed(0) + 's');
process.exit(timings.some(([, t]) => t.startsWith('FAILED')) ? 1 : 0);
