import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /*
   * Standalone output for Cloud Run.
   *
   * Next traces the modules the server actually needs and emits a
   * self-contained bundle, so the runtime image carries no node_modules tree.
   */
  output: 'standalone',

  /*
   * What the traced server carries from `src/data/`, stated rather than inferred.
   *
   * The run store reads the reference run's artefacts at request time with a
   * path built from `process.cwd()`, which the tracer cannot resolve to specific
   * files -- so it used to take the whole folder, into every route that could
   * reach the store. That swept in inputs no request ever reads: the demand
   * history TimesFM forecasts from (26 MB at 769 districts), the footfall series,
   * the anomaly cache, and a second copy of the forecast cache that
   * `runtime-forecast.ts` already bundles by import. So the batch artefacts a
   * request serves are included explicitly, and the batch's own inputs are
   * excluded explicitly.
   */
  outputFileTracingIncludes: {
    '/*': [
      'src/data/national-snapshot.json',
      'src/data/districts/*.json',
      'src/data/federated/*.json',
      'src/data/early-warnings.json',
    ],
  },
  outputFileTracingExcludes: {
    '/*': [
      'src/data/demand-district-daily.json',
      'src/data/footfall-district-daily.json',
      'src/data/anomalies.json',
      'src/data/forecast-cache.json',
      'src/data/india-raw-outline.geojson',
    ],
  },
};

export default nextConfig;
