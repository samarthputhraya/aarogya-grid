/** A generic worker for `pool.ts`: loads the task module once, runs items as they arrive. */
import { parentPort, workerData } from 'node:worker_threads';

const mod = (await import((workerData as { taskUrl: string }).taskUrl)) as {
  default: (item: unknown) => unknown;
};

parentPort!.on('message', async (msg: { i: number; item: unknown }) => {
  try {
    parentPort!.postMessage({ i: msg.i, ok: true, result: await mod.default(msg.item) });
  } catch (e) {
    parentPort!.postMessage({ i: msg.i, ok: false, error: e instanceof Error ? e.stack ?? e.message : String(e) });
  }
});
