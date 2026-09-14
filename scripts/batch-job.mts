/**
 * THE NIGHTLY BATCH: what Cloud Scheduler runs, as a Cloud Run Job.
 *
 * Run:  npx tsx scripts/batch-job.mts                     (every stage, publishes)
 *       npx tsx scripts/batch-job.mts --skip-reproduce    (IDSP and the feed only)
 *       npx tsx scripts/batch-job.mts --dry               (every stage, publishes nothing)
 *
 * Needs AAROGYA_RUN_BUCKET, BigQuery and Pub/Sub -- the same service account the
 * web service runs as. Deployed and scheduled by the commands in docs/operations.md.
 *
 * WHAT CHANGES OVERNIGHT, AND WHAT MUST NOT
 * -----------------------------------------
 * Two kinds of input, treated as the opposites they are:
 *
 *   OBSERVED   Kerala publishes a new IDSP bulletin most days. The job fetches
 *              the new ones, runs the detector over the series and rebuilds the
 *              early-warning feed. This is the part of the batch that is
 *              SUPPOSED to change the site every night.
 *
 *   SIMULATED  The network, the forecasts and the plan are pinned to a seed and
 *              an as-of date. Rebuilt from the committed inputs they must come
 *              out identical, figure for figure. The job rebuilds the national
 *              snapshot and all 769 district plans and refuses to publish if a
 *              single one differs from the reference -- so the nightly run is
 *              also a nightly proof that what the site serves is reproducible.
 *              On real data this is where a DVDMS extract would enter, and the
 *              same comparison would become a diff report instead of a gate.
 *
 * PUBLISHING
 * ----------
 * A run is a folder, `gs://$AAROGYA_RUN_BUCKET/runs/<runId>/`, written in full
 * before `runs/latest.json` is pointed at it -- so an instance reads either the
 * previous run or this one, never half of each (`src/lib/run-store.ts`). Then a
 * `batch.published` message on the fan-out topic tells every running instance to
 * look now rather than at its next five-minute check.
 *
 * STATE THAT CARRIES FROM NIGHT TO NIGHT
 * --------------------------------------
 * The job's image holds the bulletins as of the last commit. Before fetching, it
 * takes the IDSP series and manifest from the last published run if that run is
 * further along, so a job image a month old downloads last night's bulletin,
 * not thirty.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { googleRequest, resolveProjectId, asGoogleApiError } from '../src/lib/gcp/request';
import { PUBSUB_TOPIC } from '../src/lib/durable/schema';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const SKIP_REPRODUCE = argv.includes('--skip-reproduce');
const BUCKET = process.env.AAROGYA_RUN_BUCKET?.trim();
const GCS = 'https://storage.googleapis.com/storage/v1/b/';
const UPLOAD = 'https://storage.googleapis.com/upload/storage/v1/b/';
const started = Date.now();
const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-') + '-' + (process.env.CLOUD_RUN_EXECUTION?.slice(-5) ?? 'local');

if (!BUCKET && !DRY) {
  console.error('AAROGYA_RUN_BUCKET is not set. Use --dry to run without publishing.');
  process.exit(1);
}

interface StageRecord {
  name: string;
  seconds: number;
  ok: boolean;
  detail?: string;
}
const stages: StageRecord[] = [];

/**
 * One stage, as a child process -- awaited, never run synchronously.
 *
 * The first run on Cloud Run rebuilt all 769 plans and then failed its first
 * upload with `write EPIPE`. The stages ran under spawnSync then, so for five
 * minutes this process's event loop did not turn: the keep-alive connections
 * left from the opening reads stayed in the pool after Cloud Storage had closed
 * them, and the uploads were handed those dead sockets. A probe in this image on
 * Cloud Run reproduced it: 16 of 16 uploads failed straight after a blocked
 * wait, 0 of 32 when the loop was given one turn first. While a child runs here
 * the loop keeps turning, so idle sockets expire on schedule -- and the uploads
 * retry a dropped connection anyway (`idempotent`).
 */
async function run(name: string, script: string, args: string[] = []): Promise<void> {
  console.log('\n==> ' + name);
  const t = Date.now();
  const status = await new Promise<number | null>((done) => {
    const child = spawn(process.execPath, [resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'), script, ...args], {
      stdio: 'inherit',
    });
    child.on('error', () => done(null));
    child.on('exit', (code) => done(code));
  });
  const seconds = +((Date.now() - t) / 1000).toFixed(1);
  stages.push({ name, seconds, ok: status === 0 });
  if (status !== 0) fail(name + ' exited ' + status);
}

function fail(why: string): never {
  console.error('\nBATCH FAILED: ' + why + '\nNothing was published; the site keeps serving the previous run.');
  process.exit(1);
}

const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

// ------------------------------------------------------- canonical digests

/**
 * What must not change between two builds of the same seed.
 *
 * Everything except the fields that describe the BUILD rather than the plan:
 * when it ran, how long it took and how many threads it had. Keys are sorted, so
 * the digest is of the content, not of the serialiser's key order.
 */
function canonical(value: unknown): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        if (k === 'builtAt' || k === 'buildSeconds' || k === 'threads') continue;
        out[k] = strip((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(value));
}

function digests(): { snapshot: string; districts: Map<string, string> } {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const districts = new Map<string, string>();
  for (const f of readdirSync(resolve(ROOT, 'src/data/districts')).filter((x) => x.endsWith('.json')).sort()) {
    districts.set(f, sha(canonical(JSON.parse(read('src/data/districts/' + f)))));
  }
  return { snapshot: sha(canonical(JSON.parse(read('src/data/national-snapshot.json')))), districts };
}

// ------------------------------------------------------------- bucket I/O

async function getObject(name: string): Promise<string | null> {
  try {
    const body = await googleRequest<unknown>(GCS + BUCKET + '/o/' + encodeURIComponent(name) + '?alt=media', {
      attempts: 3,
      idempotent: true,
    });
    return typeof body === 'string' ? body : JSON.stringify(body);
  } catch (e) {
    if (asGoogleApiError(e).status === 404) return null;
    throw e;
  }
}

async function putObject(name: string, body: string): Promise<void> {
  await googleRequest(UPLOAD + BUCKET + '/o', {
    method: 'POST',
    params: { uploadType: 'media', name },
    headers: { 'Content-Type': 'application/json' },
    data: body,
    attempts: 4,
    timeoutMs: 60_000,
    // The same bytes to the same name: writing it twice is writing it once.
    idempotent: true,
  });
}

// --------------------------------------------------------------------- run

console.log('Aarogya Grid nightly batch, run ' + runId + (DRY ? ' (dry: nothing is published)' : ''));

// 0. Carry the observed series forward from the last published run.
let carried = false;
if (BUCKET) {
  const pointer = await getObject('runs/latest.json');
  if (pointer) {
    const previous = JSON.parse(pointer) as { runId: string };
    const idsp = await getObject('runs/' + previous.runId + '/idsp-kerala.json');
    const manifest = await getObject('runs/' + previous.runId + '/idsp-manifest.json');
    const local = JSON.parse(read('src/data/idsp-kerala.json')) as { coverage: { last: string } };
    if (idsp && manifest && (JSON.parse(idsp) as { coverage: { last: string } }).coverage.last > local.coverage.last) {
      writeFileSync(resolve(ROOT, 'src/data/idsp-kerala.json'), idsp);
      writeFileSync(resolve(ROOT, 'data/idsp/manifest.json'), manifest);
      carried = true;
      console.log('carried IDSP data forward from run ' + previous.runId);
    }
  }
}
const bulletinsBefore = (JSON.parse(read('src/data/idsp-kerala.json')) as { coverage: { bulletins: number } }).coverage.bulletins;

// 1-3. Observed data: new bulletins, the detector, the feed.
await run('idsp', 'scripts/fetch-idsp.mts');
await run('idsp-detect', 'scripts/detect-idsp.mts');
await run('indicators', 'scripts/export-indicators.mts');
const idsp = JSON.parse(read('src/data/idsp-kerala.json')) as { coverage: { bulletins: number; last: string } };
const feed = JSON.parse(read('src/data/early-warnings.json')) as { signals: { provenance: string }[] };

// 4. Simulated data: rebuild, and require the reference.
let reproduced: boolean | null = null;
let snapshotDigest: string;
/** How the rebuild ran, beside how the reference it was held to was built. */
let rebuild: { threads: number; seconds: number; referenceThreads: number } | null = null;
type BuildRecord = { buildSeconds: number; batch: { threads: number } };
if (SKIP_REPRODUCE) {
  snapshotDigest = digests().snapshot;
  console.log('\n==> reproduce: skipped');
} else {
  const reference = digests();
  const referenceBuild = JSON.parse(read('src/data/national-snapshot.json')) as BuildRecord;
  await run('reproduce', 'scripts/build-snapshot.mts');
  const rebuilt = digests();
  const rebuiltBuild = JSON.parse(read('src/data/national-snapshot.json')) as BuildRecord;
  rebuild = {
    threads: rebuiltBuild.batch.threads,
    seconds: rebuiltBuild.buildSeconds,
    referenceThreads: referenceBuild.batch.threads,
  };
  const differing = [...reference.districts.keys()].filter((f) => reference.districts.get(f) !== rebuilt.districts.get(f));
  reproduced = rebuilt.snapshot === reference.snapshot && differing.length === 0 && rebuilt.districts.size === reference.districts.size;
  snapshotDigest = rebuilt.snapshot;
  stages[stages.length - 1].detail = reproduced
    ? 'national snapshot and ' + rebuilt.districts.size + ' district plans identical to the reference'
    : differing.length + ' district plan(s) and ' + (rebuilt.snapshot === reference.snapshot ? 'not ' : '') + 'the national snapshot differ';
  console.log('  ' + stages[stages.length - 1].detail);
  if (!reproduced) {
    fail('the simulated plan did not reproduce: ' + differing.slice(0, 10).join(', '));
  }
}

// 5. Publish the run, then move the pointer.
const manifest = {
  runId,
  publishedAt: new Date().toISOString(),
  snapshotSha256: snapshotDigest,
  reproducedReference: reproduced,
  rebuild,
  // From inside, a scheduled execution and one started by hand look the same.
  trigger: process.env.CLOUD_RUN_EXECUTION ? 'cloud-run-job' : 'manual',
  // The execution whose logs hold this run's full output.
  execution: process.env.CLOUD_RUN_EXECUTION ?? null,
  stages,
  idsp: {
    bulletins: idsp.coverage.bulletins,
    newThisRun: idsp.coverage.bulletins - bulletinsBefore,
    dataThrough: idsp.coverage.last,
    carriedForward: carried,
  },
  feed: {
    signals: feed.signals.length,
    observed: feed.signals.filter((s) => s.provenance === 'observed').length,
  },
};
writeFileSync(resolve(ROOT, 'docs/batch-run.json'), JSON.stringify(manifest, null, 2) + '\n');

if (DRY) {
  console.log('\ndry run: would publish ' + runId);
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

console.log('\n==> publish gs://' + BUCKET + '/runs/' + runId + '/');
const t5 = Date.now();
const files: [string, string][] = [
  ['national-snapshot.json', 'src/data/national-snapshot.json'],
  ['early-warnings.json', 'src/data/early-warnings.json'],
  ['idsp-kerala.json', 'src/data/idsp-kerala.json'],
  ['idsp-anomalies.json', 'src/data/idsp-anomalies.json'],
  ['idsp-manifest.json', 'data/idsp/manifest.json'],
  ...readdirSync(resolve(ROOT, 'src/data/districts'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => ['districts/' + f, 'src/data/districts/' + f] as [string, string]),
];
const queue = [...files];
await Promise.all(
  Array.from({ length: 16 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await putObject('runs/' + runId + '/' + next[0], read(next[1]));
    }
  }),
);
await putObject('runs/' + runId + '/manifest.json', JSON.stringify(manifest));
// Only now: a reader following the pointer finds a complete run.
await putObject('runs/latest.json', JSON.stringify(manifest));
stages.push({ name: 'publish', seconds: +((Date.now() - t5) / 1000).toFixed(1), ok: true, detail: files.length + ' files' });
console.log('  ' + files.length + ' files in ' + ((Date.now() - t5) / 1000).toFixed(1) + ' s; runs/latest.json -> ' + runId);

// 6. Tell every instance.
try {
  const projectId = await resolveProjectId();
  await googleRequest('https://pubsub.googleapis.com/v1/projects/' + projectId + '/topics/' + PUBSUB_TOPIC + ':publish', {
    method: 'POST',
    data: {
      messages: [
        {
          attributes: { type: 'batch.published', instanceId: 'batch-' + runId, runId },
          data: Buffer.from(JSON.stringify({ type: 'batch.published', runId, publishedAt: manifest.publishedAt })).toString('base64'),
        },
      ],
    },
  });
  console.log('==> announced batch.published on ' + PUBSUB_TOPIC);
} catch (e) {
  // The pointer is already moved; instances pick the run up within five minutes.
  console.log('announce failed (' + asGoogleApiError(e).message + '); instances will find the run at their next check');
}

console.log('\nBATCH OK in ' + ((Date.now() - started) / 1000).toFixed(0) + ' s: ' + manifest.feed.observed + ' observed signal(s), IDSP through ' + idsp.coverage.last);
