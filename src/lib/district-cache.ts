import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DistrictDetail } from '@/lib/district-detail';
import type { NationalSnapshot } from '@/lib/snapshot-types';

/**
 * Read the batch output the consoles read, once per process, LRU-capped.
 *
 * `buildDistrictState` + `planRedistribution` would recompute a district from
 * scratch in about 1.7 s, deterministically and byte-identically. That is a
 * fine trade for a page build and a terrible one inside a request, so anything
 * that needs a district at runtime reads the payload the nightly job wrote --
 * exactly as `src/app/district/[code]/page.tsx` does.
 *
 * WHY THE CAP EXISTS, AND WHY IT IS HERE RATHER THAN IN ONE CALLER
 * ----------------------------------------------------------------
 * Each payload is ~175 KB of parsed JSON and there are 128 of them, so an
 * unbounded cache is ~22 MB of heap reachable by anyone who visits enough
 * districts. The service runs `--max-instances=1` so that the live overlay and
 * the SSE stream have one place to live, which means there is no second
 * instance to absorb an OOM: the process that dies is the demo.
 *
 * It started as a private cache inside the agent's tool module. The moment a
 * second caller needed district payloads -- dispatch tickets, which must read
 * the planned order server-side rather than trust the client's copy of it --
 * the choice was one shared cap or two independent ones that each look bounded
 * and together are not.
 *
 * 16 comfortably holds a conversation's worth of districts while bounding the
 * cache at ~2.8 MB. Eviction is least-recently-used by way of `Map` insertion
 * order, the same trick `build-snapshot.mts` uses for its state cache:
 * re-reading a key deletes and re-inserts it, moving it to the back.
 */
const DISTRICT_CACHE_SIZE = 16;
const districtCache = new Map<string, DistrictDetail>();
let nationalCache: Promise<NationalSnapshot> | null = null;

function dataPath(...parts: string[]): string {
  return join(process.cwd(), 'src', 'data', ...parts);
}

/** Thrown when no payload exists for a code that is in the registry. */
export class DistrictNotBuiltError extends Error {
  constructor(readonly districtCode: string) {
    super('No computed snapshot exists for ' + districtCode);
    this.name = 'DistrictNotBuiltError';
  }
}

export async function loadNationalSnapshot(): Promise<NationalSnapshot> {
  if (!nationalCache) {
    nationalCache = readFile(dataPath('national-snapshot.json'), 'utf8').then(
      (raw) => JSON.parse(raw) as NationalSnapshot,
    );
  }
  return nationalCache;
}

export async function loadDistrictDetail(code: string): Promise<DistrictDetail> {
  const cached = districtCache.get(code);
  if (cached) {
    // Re-inserting moves the key to the back of the insertion order, which is
    // what makes the eviction below least-recently-used rather than oldest-first.
    districtCache.delete(code);
    districtCache.set(code, cached);
    return cached;
  }

  let detail: DistrictDetail;
  try {
    const raw = await readFile(dataPath('districts', code + '.json'), 'utf8');
    detail = JSON.parse(raw) as DistrictDetail;
  } catch {
    throw new DistrictNotBuiltError(code);
  }

  while (districtCache.size >= DISTRICT_CACHE_SIZE) {
    const oldest = districtCache.keys().next();
    if (oldest.done) break;
    districtCache.delete(oldest.value);
  }
  districtCache.set(code, detail);
  return detail;
}
