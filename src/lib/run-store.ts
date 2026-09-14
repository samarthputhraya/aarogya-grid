// Not marked `server-only`: the agent's tool surface reads districts through
// here, and the offline agent and surge suites exercise that surface from plain
// Node. Nothing client-side imports it -- it reads the filesystem.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DistrictDetail } from '@/lib/district-detail';
import type { NationalSnapshot } from '@/lib/snapshot-types';
import { googleRequest, asGoogleApiError } from '@/lib/gcp/request';

/**
 * THE RUN STORE: which batch run the service is serving, and its artefacts.
 *
 * WHY THE PAGES STOPPED IMPORTING THE SNAPSHOT
 * -------------------------------------------
 * `/console` used to `import` the national snapshot and every district page was
 * prerendered from its payload at build time. That was right for 128 districts
 * and wrong in two ways for 769:
 *
 *   - **Size.** A prerendered district page is its payload twice over, as HTML
 *     and as the React payload, about 1.2 MB. 769 of them is most of a gigabyte
 *     in the image before a single request is served.
 *   - **The batch could never reach the site.** A batch run whose output only
 *     lands at the next `next build` is not a scheduled job, it is a deploy
 *     step. The nightly job has to be able to publish a run that the running
 *     service then serves.
 *
 * So everything that reads batch output reads it through here, at request time,
 * with the parsed artefacts cached in memory per run.
 *
 * TWO BACKENDS, ONE CONTRACT
 * --------------------------
 *   bundled   `src/data/` as committed -- the reference run. What a fresh clone
 *             serves, what `npm test` checks every published figure against, and
 *             the fallback whenever the published run cannot be read.
 *   gcs       `gs://$AAROGYA_RUN_BUCKET/runs/<runId>/...`, pointed at by
 *             `runs/latest.json`, written by the scheduled batch job. Enabled
 *             only when the bucket is configured.
 *
 * A published run that fails to load is never half-served: the store falls back
 * to the bundled run as a whole and reports why, so a page can never show a
 * national total from one run beside a district from another.
 */

export type RunSource = 'bundled' | 'gcs';

export interface RunManifest {
  runId: string;
  /** When the batch that produced it finished. */
  publishedAt: string;
  /** SHA-256 of the national snapshot's bytes. */
  snapshotSha256?: string;
  /** Whether the run reproduced the reference snapshot byte for byte. */
  reproducedReference?: boolean;
  trigger?: string;
  stages?: { name: string; seconds: number; ok: boolean }[];
}

export interface RunInfo {
  runId: string;
  source: RunSource;
  publishedAt: string | null;
  manifest: RunManifest | null;
  /** Set when a published run exists but could not be read. */
  fallbackReason: string | null;
  loadedAt: string;
}

interface LoadedRun {
  info: RunInfo;
  prefix: string;
  snapshot: Promise<NationalSnapshot>;
  districts: Map<string, DistrictDetail>;
}

/** Thrown when no payload exists for a code that is in the registry. */
export class DistrictNotBuiltError extends Error {
  constructor(readonly districtCode: string) {
    super('No computed snapshot exists for ' + districtCode);
    this.name = 'DistrictNotBuiltError';
  }
}

const BUCKET = process.env.AAROGYA_RUN_BUCKET?.trim() || null;
/** How long a pointer read is trusted before `latest.json` is looked at again. */
const POINTER_TTL_MS = 5 * 60_000;
/**
 * District payloads held per run. ~115 KB of JSON each, so 96 is ~11 MB -- a
 * conversation's worth of districts and every district a demo opens, with the
 * national snapshot beside it, on an instance with 2 GiB.
 */
const DISTRICT_CACHE_SIZE = 96;

const HOST = Symbol.for('aarogya.run-store');
type Host = typeof globalThis & {
  [HOST]?: { current: LoadedRun | null; pending: Promise<LoadedRun> | null; checkedAt: number };
};
function host() {
  const h = globalThis as Host;
  if (!h[HOST]) h[HOST] = { current: null, pending: null, checkedAt: 0 };
  return h[HOST];
}

const dataPath = (...parts: string[]) => join(process.cwd(), 'src', 'data', ...parts);

async function readArtefact(prefix: string, name: string): Promise<string> {
  if (prefix === 'bundled') return readFile(dataPath(...name.split('/')), 'utf8');
  const url =
    'https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o/' + encodeURIComponent(prefix + name) + '?alt=media';
  const body = await googleRequest<unknown>(url, { attempts: 2, timeoutMs: 20_000, idempotent: true });
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function bundledRun(fallbackReason: string | null): LoadedRun {
  return {
    info: {
      runId: 'reference',
      source: 'bundled',
      publishedAt: null,
      manifest: null,
      fallbackReason,
      loadedAt: new Date().toISOString(),
    },
    prefix: 'bundled',
    snapshot: readArtefact('bundled', 'national-snapshot.json').then((raw) => JSON.parse(raw) as NationalSnapshot),
    districts: new Map(),
  };
}

async function resolveRun(): Promise<LoadedRun> {
  if (!BUCKET) return bundledRun(null);
  try {
    const pointer = JSON.parse(await readArtefact('', 'runs/latest.json')) as RunManifest;
    const prefix = 'runs/' + pointer.runId + '/';
    const current = host().current;
    if (current && current.info.runId === pointer.runId && current.info.source === 'gcs') return current;
    const snapshot = readArtefact(prefix, 'national-snapshot.json').then((raw) => JSON.parse(raw) as NationalSnapshot);
    // Read before switching: a run whose snapshot cannot be read is not served.
    await snapshot;
    return {
      info: {
        runId: pointer.runId,
        source: 'gcs',
        publishedAt: pointer.publishedAt,
        manifest: pointer,
        fallbackReason: null,
        loadedAt: new Date().toISOString(),
      },
      prefix,
      snapshot,
      districts: new Map(),
    };
  } catch (e) {
    const current = host().current;
    // A transient read failure keeps the run already being served, if any.
    if (current) return current;
    return bundledRun('published run unreadable: ' + asGoogleApiError(e).message);
  }
}

async function currentRun(): Promise<LoadedRun> {
  const h = host();
  const stale = Date.now() - h.checkedAt > POINTER_TTL_MS;
  if (h.current && !stale) return h.current;
  if (!h.pending) {
    h.pending = resolveRun()
      .then((run) => {
        h.current = run;
        h.checkedAt = Date.now();
        return run;
      })
      .finally(() => {
        h.pending = null;
      });
  }
  // A stale pointer is refreshed in the background; the run in hand is served.
  return h.current ?? h.pending;
}

/** Look at `latest.json` again now. Called when the batch announces a new run. */
export async function invalidateRun(): Promise<RunInfo> {
  host().checkedAt = 0;
  const h = host();
  h.pending = null;
  const run = await resolveRun();
  h.current = run;
  h.checkedAt = Date.now();
  return run.info;
}

export async function runInfo(): Promise<RunInfo> {
  return (await currentRun()).info;
}

export async function loadNationalSnapshot(): Promise<NationalSnapshot> {
  return (await currentRun()).snapshot;
}

export async function loadDistrictDetail(code: string): Promise<DistrictDetail> {
  const run = await currentRun();
  const cached = run.districts.get(code);
  if (cached) {
    // Re-inserting moves the key to the back: least-recently-used eviction.
    run.districts.delete(code);
    run.districts.set(code, cached);
    return cached;
  }
  let detail: DistrictDetail;
  try {
    detail = JSON.parse(await readArtefact(run.prefix, 'districts/' + code + '.json')) as DistrictDetail;
  } catch {
    throw new DistrictNotBuiltError(code);
  }
  while (run.districts.size >= DISTRICT_CACHE_SIZE) {
    const oldest = run.districts.keys().next();
    if (oldest.done) break;
    run.districts.delete(oldest.value);
  }
  run.districts.set(code, detail);
  return detail;
}

/** Any other artefact of the run, parsed. */
export async function loadRunArtefact<T>(name: string): Promise<T> {
  const run = await currentRun();
  return JSON.parse(await readArtefact(run.prefix, name)) as T;
}
