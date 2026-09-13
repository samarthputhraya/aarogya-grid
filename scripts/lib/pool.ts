/**
 * Map a pure per-district task across worker threads, results back in input order.
 *
 * The batch scripts each walk every district and simulate its network. Each
 * district is independent -- seeded on (seed, facility, drug), so it computes
 * the same bytes alone or alongside any other -- which makes the walk trivially
 * parallel. What is not trivial is doing it on a laptop:
 *
 *   - THREADS FROM MEMORY. The count is derived from memory free at start, never
 *     from the core count alone. Twelve threads on a machine with four gigabytes
 *     free paged, and ran slower than one.
 *   - PRIORITY. Windows 11 throttles a background process's threads onto
 *     efficiency cores; measured, the national build's threads sat "Ready" at 15%
 *     CPU. The process asks for above-normal priority, which is a request and
 *     fails quietly where it is not allowed.
 *   - ORDER. Results are placed by index, so the output of a script is the same
 *     however the threads happened to finish.
 *
 * `task` is a module whose default export takes one item and returns a
 * structured-cloneable result. With one thread it runs in process, which is also
 * how a test runs it.
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism, freemem, setPriority, constants } from 'node:os';
import { pathToFileURL } from 'node:url';

export interface PoolOptions {
  /** Explicit thread count. Otherwise derived from memory and cores. */
  threads?: number;
  /** Peak memory one thread needs, for deriving the count. */
  memoryPerThreadMb?: number;
  /** Called after each completed item, for progress output. */
  onProgress?: (done: number, total: number) => void;
}

export function poolThreads(memoryPerThreadMb: number, envOverride = process.env.AAROGYA_BUILD_WORKERS): number {
  const raw = Number.parseInt(envOverride ?? '', 10);
  if (Number.isFinite(raw) && raw >= 1) return raw;
  const byMemory = Math.floor((freemem() - 700 * 1024 * 1024) / (memoryPerThreadMb * 1024 * 1024));
  return Math.max(1, Math.min(availableParallelism() - 2, byMemory));
}

/** Ask for above-normal priority; see the header. Never throws. */
export function raisePriority(): void {
  try {
    setPriority(0, constants.priority.PRIORITY_ABOVE_NORMAL);
  } catch {
    // Not permitted here. The work still runs, just slower.
  }
}

export async function mapInWorkers<T, R>(taskPath: string, items: T[], opts: PoolOptions = {}): Promise<R[]> {
  const threads = Math.min(items.length, opts.threads ?? poolThreads(opts.memoryPerThreadMb ?? 350));
  const results: R[] = new Array(items.length);
  let done = 0;
  const taskUrl = pathToFileURL(taskPath).href;

  if (threads <= 1) {
    const mod = (await import(taskUrl)) as { default: (item: T) => R | Promise<R> };
    for (let i = 0; i < items.length; i++) {
      results[i] = await mod.default(items[i]);
      opts.onProgress?.(++done, items.length);
    }
    return results;
  }

  raisePriority();
  const pool = Array.from(
    { length: threads },
    () => new Worker(new URL('./pool-worker.mts', import.meta.url), { workerData: { taskUrl } }),
  );
  try {
    await new Promise<void>((resolveAll, rejectAll) => {
      let next = 0;
      const feed = (w: Worker) => {
        if (next >= items.length) return;
        const i = next++;
        w.postMessage({ i, item: items[i] });
      };
      for (const w of pool) {
        w.on('message', (msg: { i: number; ok: boolean; result?: R; error?: string }) => {
          if (!msg.ok) {
            rejectAll(new Error('item ' + msg.i + ' failed on a worker:\n' + msg.error));
            return;
          }
          results[msg.i] = msg.result as R;
          opts.onProgress?.(++done, items.length);
          if (done === items.length) resolveAll();
          else feed(w);
        });
        w.on('error', rejectAll);
        feed(w);
      }
    });
  } finally {
    await Promise.all(pool.map((w) => w.terminate()));
  }
  return results;
}
