/**
 * The committed inputs every thread of the national batch reads: the as-of date,
 * the TimesFM forecast cache and the backtest's per-class model choice.
 *
 * Loaded by the main thread (for the snapshot's `forecast` block) and again by
 * each worker (to score positions), so both must reach exactly the same answer
 * -- which is why this is one module and not two copies of the same checks.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  asForecastCache,
  asForecastMethod,
  FORECAST_HORIZON_DAYS,
  CONFIDENCE_LEVEL,
  type ForecastCache,
  type ForecastMethodMap,
} from '../../src/lib/forecast/timesfm';

/**
 * The evaluation date the whole snapshot is computed against.
 *
 * FIXED, NOT DERIVED FROM THE BUILD CLOCK, AND DELIBERATELY SO. It is a
 * scenario, and every screen says "position as of". A fixed scenario date is
 * what makes every figure in the deck, the README and the demo reproducible by
 * anyone who clones the repo: same seed, same as-of, same numbers. 30 September
 * 2026 is the submission deadline, so by the time anyone evaluates it the date
 * reads as current rather than stale.
 *
 * Override for a different scenario with AAROGYA_ASOF=YYYY-MM-DD.
 */
export const ASOF = process.env.AAROGYA_ASOF
  ? new Date(process.env.AAROGYA_ASOF + 'T00:00:00Z')
  : new Date(Date.UTC(2026, 8, 30));

/**
 * `AAROGYA_NO_BQ=1` drops the cache and every position falls back to censored
 * Croston. That is a SUPPORTED path, not a degraded one. This module never
 * imports the BigQuery client, so the build cannot reach the network by accident.
 */
export const FORECASTS_DISABLED = process.env.AAROGYA_NO_BQ === '1';

export function loadForecastCache(log = true): ForecastCache | null {
  if (FORECASTS_DISABLED) return null;
  const path = resolve(process.cwd(), 'src/data/forecast-cache.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    if (log) {
      console.warn('  ! no forecast cache at src/data/forecast-cache.json -- falling back to Croston');
      console.warn('    run `npm run forecast:refresh` to build it');
    }
    return null;
  }
  const cache = asForecastCache(parsed);
  if (!cache) throw new Error('forecast-cache.json is malformed. Re-run `npm run forecast:refresh`.');

  // A cache built at a different horizon, confidence level or as-of date
  // describes a different question, and would pass through as plausible numbers.
  const asOfIso = ASOF.toISOString().slice(0, 10);
  if (cache.forecastStart !== asOfIso) {
    throw new Error(
      'Forecast cache starts ' + cache.forecastStart + ' but this snapshot is as-of ' + asOfIso +
        '. Re-run `npm run export:demand && npm run forecast:refresh`.',
    );
  }
  if (cache.horizon !== FORECAST_HORIZON_DAYS) {
    throw new Error('Forecast cache horizon is ' + cache.horizon + ', expected ' + FORECAST_HORIZON_DAYS + '.');
  }
  if (cache.confidenceLevel !== CONFIDENCE_LEVEL) {
    throw new Error(
      'Forecast cache confidence level is ' + cache.confidenceLevel + ', expected ' + CONFIDENCE_LEVEL +
        '. The interval-to-sigma conversion assumes the latter.',
    );
  }
  return cache;
}

/**
 * Which demand classes TimesFM may serve, from the held-out backtest -- NOT
 * "wherever the cache has it". TimesFM takes a class only where it beat Croston
 * by more than the published margin on days neither model had seen.
 */
export function loadForecastMethod(log = true): ForecastMethodMap | null {
  if (FORECASTS_DISABLED) return null;
  const path = resolve(process.cwd(), 'src/data/forecast-method.json');
  try {
    const method = asForecastMethod(JSON.parse(readFileSync(path, 'utf8')));
    if (!method) throw new Error('malformed');
    return method;
  } catch {
    if (log) {
      console.warn('  ! no usable forecast-method.json -- TimesFM will serve every class');
      console.warn('    run `npm run forecast:backtest` to measure which classes it should');
    }
    return null;
  }
}
