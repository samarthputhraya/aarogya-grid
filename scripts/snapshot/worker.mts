/**
 * A worker thread of the national batch. Receives district jobs, one at a time,
 * and posts back each district's roll-up. See `district-job.mts` for why a
 * district's answer does not depend on which thread computed it.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runDistrictJob, StateCache, type DistrictJob } from './district-job';
import { ASOF, loadForecastCache, loadForecastMethod } from './inputs';

const cache = new StateCache((workerData as { cacheSize: number }).cacheSize, {
  asOf: ASOF,
  forecastCache: loadForecastCache(false),
  forecastMethod: loadForecastMethod(false),
});

parentPort!.on('message', (job: DistrictJob) => {
  try {
    parentPort!.postMessage({ ok: true, result: runDistrictJob(job, cache) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, code: job.code, error: e instanceof Error ? e.stack ?? e.message : String(e) });
  }
});
