import 'server-only';
import rawCache from '@/data/forecast-cache.json';
import rawMethod from '@/data/forecast-method.json';
import { asForecastCache, asForecastMethod } from '@/lib/forecast/timesfm';

/**
 * The forecast cache and method table, for RUNTIME use by API routes only.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS THE ONLY PLACE THAT IMPORTS THE CACHE
 * -----------------------------------------------------------------------
 * The batch job reads the cache from disk and injects it into the pipeline,
 * precisely so no page or component pulls 2.5 MB of JSON into a bundle. But a
 * live recompute happens inside a request, and `next.config.ts` sets
 * `output: 'standalone'` -- the runtime image is `.next/standalone` plus
 * `public`, and `src/data/` is NOT copied into it. A `readFileSync` here would
 * work in `npm run dev` and throw ENOENT on Cloud Run, which is the worst
 * possible place to discover it.
 *
 * So it is a static import, which Next traces into the server bundle. The cost
 * is paid once per instance at module load, on a service that runs with
 * `min-instances=1`, and the cache never reaches a browser.
 *
 * `server-only` makes the boundary a build error rather than a code review: any
 * client component that imports this, directly or through a chain, fails the
 * build instead of shipping megabytes to a phone on a district hospital's wifi.
 */

export const RUNTIME_FORECAST_CACHE = asForecastCache(rawCache);

/**
 * Which demand class TimesFM is allowed to serve, from the held-out backtest.
 *
 * The live recompute must apply the SAME gate as the nightly batch. If it did
 * not, a committed report would move a row onto a different model than the one
 * that scored it last night, and the change a judge sees would be partly the
 * code path rather than the report.
 */
export const RUNTIME_FORECAST_METHOD = asForecastMethod(rawMethod);
