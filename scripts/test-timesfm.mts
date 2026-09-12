/**
 * Offline tests for the TimesFM integration.
 *
 * Run with:  npx tsx scripts/test-timesfm.mts   (part of `npm test`)
 *
 * No network, no cache file, no BigQuery. What this pins down is the arithmetic
 * between a district forecast and a facility's stock-out probability, which is
 * where a quiet error would be most expensive and least visible: every figure
 * downstream would still look plausible.
 *
 * The four properties that matter, and why:
 *
 *   1. Disaggregation CONSERVES demand. Facility mean paths must sum back to the
 *      district path TimesFM produced, or the national totals stop reconciling.
 *   2. The forecast actually reaches the Monte Carlo. Expected lead-time demand
 *      must equal the forecast's own sum -- if it did not, TimesFM would be
 *      decorative and Croston would still be driving.
 *   3. Seasonality is NOT applied twice. A TimesFM path already carries the
 *      seasonality it learned; multiplying by `horizonMultipliers` on top would
 *      inflate monsoon demand silently.
 *   4. The spread is never NARROWER than Croston's. Under-dispersing lead-time
 *      demand understates the stock-out tail, which is the whole quantity being
 *      estimated.
 */
import {
  facilityShares,
  scaleForecast,
  forecastWindow,
  intervalSigma,
  uncensoredMean,
  districtForecast,
  asForecastCache,
  zFor,
  seriesId,
  CONFIDENCE_LEVEL,
  type DailyForecast,
  type ForecastCache,
} from '../src/lib/forecast/timesfm';
import { leadTimeDemandSamples, computeStockRisk } from '../src/lib/forecast/risk';
import { fitDemand } from '../src/lib/forecast/croston';
import { getDrug } from '../src/lib/domain/drugs';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  -- ' + detail : ''));
  }
}

function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

const flat = (value: number, half: number, days = 21): DailyForecast => ({
  mean: new Array(days).fill(value),
  lower: new Array(days).fill(Math.max(0, value - half)),
  upper: new Array(days).fill(value + half),
});

console.log('\nshares and disaggregation');
{
  const shares = facilityShares([10, 30, 60]);
  check('shares sum to exactly 1', near(shares.reduce((a, b) => a + b, 0), 1, 1e-12));
  check('shares are proportional', near(shares[2], 0.6, 1e-12), String(shares[2]));
}
{
  const shares = facilityShares([0, 0, 0]);
  check('all-zero demand splits evenly rather than dividing by zero', near(shares[0], 1 / 3, 1e-12));
  check('all-zero shares still sum to 1', near(shares.reduce((a, b) => a + b, 0), 1, 1e-12));
}
{
  // The conservation property: the facility paths must add back up to the
  // district path, or district and national totals stop reconciling.
  const district = flat(120, 30);
  const shares = facilityShares([5, 15, 40, 40]);
  const parts = shares.map((s) => scaleForecast(district, s));
  const summedDay0 = parts.reduce((a, p) => a + p.mean[0], 0);
  check('facility paths sum back to the district path', near(summedDay0, 120, 1e-9), String(summedDay0));
  const summedUpper = parts.reduce((a, p) => a + p.upper[0], 0);
  check('the interval is conserved too', near(summedUpper, 150, 1e-9), String(summedUpper));
}

console.log('\nwindowing and sigma');
{
  const f = flat(10, 5, 21);
  check('a shorter lead time reads a prefix', forecastWindow(f, 8).mean.length === 8);
  const over = forecastWindow(f, 25);
  check('past the horizon, the last day repeats rather than truncating', over.mean.length === 25 && over.mean[24] === 10);
}
{
  const f = flat(10, 4.9347, 21); // half-width = 3 * 1.6449
  const s = intervalSigma(f);
  check('sigma is (hi - lo) / 2z', near(s[0], 3, 1e-3), String(s[0]));
  check('z for 0.9 is 1.6449', near(zFor(CONFIDENCE_LEVEL), 1.6449, 1e-9));
}
{
  checks++;
  try {
    zFor(0.93);
    failures++;
    console.log('  FAIL an unlisted confidence level throws rather than approximating');
  } catch {
    console.log('  ok   an unlisted confidence level throws rather than approximating');
  }
}

console.log('\nuncensored mean');
{
  // Censored days are stocked-out days: a recorded zero means "no stock", not
  // "no demand". Counting them would shrink a stocked-out facility's share of
  // its district -- the exact feedback loop the correction exists to break.
  const series = [10, 0, 10, 0, 10, 0];
  const censored = [false, true, false, true, false, true];
  check('stocked-out days are excluded', near(uncensoredMean(series, censored, 6), 10, 1e-9));
  check('raw mean would have been 5', near(mean(series), 5, 1e-9));
  check(
    'all days censored falls back to the raw mean, not zero',
    near(uncensoredMean(series, [true, true, true, true, true, true], 6), 5, 1e-9),
  );
  check('the window limits how far back it looks', near(uncensoredMean(series, censored, 2), 10, 1e-9));
}

console.log('\ncache lookup');
{
  const cache: ForecastCache = {
    model: 'TimesFM 2.0', horizon: 3, contextDays: 90, confidenceLevel: 0.9,
    contextStart: '2026-07-02', contextEnd: '2026-09-29', forecastStart: '2026-09-30',
    seriesRequested: 1, seriesForecast: 1, seriesDeclined: [], seriesMissing: [],
    forecasts: { 'DST-29-BLR|ORS-SACHET': { m: [1, 2, 3], lo: [0, 1, 2], hi: [2, 3, 4] } },
  };
  check('a present series resolves', districtForecast(cache, 'DST-29-BLR', 'ORS-SACHET')?.mean[2] === 3);
  check('a missing series returns null (Croston fallback)', districtForecast(cache, 'DST-29-BLR', 'PARA-500-TAB') === null);
  check('a null cache returns null', districtForecast(null, 'DST-29-BLR', 'ORS-SACHET') === null);
  check('series id is district|drug', seriesId('DST-29-BLR', 'ORS-SACHET') === 'DST-29-BLR|ORS-SACHET');
  // A horizon mismatch means the cache answers a different question than the one
  // being asked. Better to fall back than to mis-scale.
  const shortened = { ...cache, horizon: 21 };
  check('a horizon mismatch falls back rather than mis-scaling', districtForecast(shortened, 'DST-29-BLR', 'ORS-SACHET') === null);
  check('malformed input is rejected', asForecastCache({ nope: true }) === null);
  check('null input is rejected', asForecastCache(null) === null);
  check('a valid cache is accepted', asForecastCache(cache) !== null);
}

console.log('\nthe forecast reaches the Monte Carlo');
const drug = getDrug('ORS-SACHET');
// A realistic intermittent-ish series: demand most days, variable size.
const history = Array.from({ length: 120 }, (_, i) => (i % 4 === 0 ? 0 : 8 + ((i * 7) % 9)));
const fit = fitDemand(history);
const asOf = new Date(Date.UTC(2026, 8, 30));
{
  const f = flat(20, 8, 21);
  const samples = leadTimeDemandSamples('F1', drug, fit, 14, asOf, 20000, f);
  const expected = f.mean.slice(0, 14).reduce((a, b) => a + b, 0);
  // 14 days x 20/day = 280. Monte Carlo error on 20k draws is well under 2%.
  check(
    'expected lead-time demand equals the forecast sum',
    near(mean(samples), expected, expected * 0.03),
    mean(samples).toFixed(1) + ' vs ' + expected,
  );
}
{
  // Doubling the forecast must double expected demand. If Croston were still
  // driving the level, this would barely move.
  const a = mean(leadTimeDemandSamples('F1', drug, fit, 14, asOf, 20000, flat(20, 8)));
  const b = mean(leadTimeDemandSamples('F1', drug, fit, 14, asOf, 20000, flat(40, 16)));
  check('doubling the forecast doubles expected demand', near(b / a, 2, 0.06), (b / a).toFixed(3));
}
{
  // Property 4: a degenerate interval must NOT collapse the spread -- Croston's
  // own dispersion survives, because zero-width uncertainty about the mean does
  // not mean zero day-to-day variability.
  const narrow = sd(leadTimeDemandSamples('F1', drug, fit, 14, asOf, 20000, flat(20, 0)));
  const wide = sd(leadTimeDemandSamples('F1', drug, fit, 14, asOf, 20000, flat(20, 60)));
  check('a zero-width interval still leaves Croston dispersion', narrow > 0, String(narrow));
  check('a wider interval widens the sampled spread', wide > narrow * 1.5, wide.toFixed(1) + ' vs ' + narrow.toFixed(1));
}

console.log('\nno double-counted seasonality');
{
  const f = flat(20, 8, 21);
  const risk = computeStockRisk({
    facilityId: 'F1', drug, fit, onHand: 100, batches: [], leadTimeDays: 14,
    asOf, population: 30000, simulations: 2000, forecast: f,
  });
  // The forecast path is flat at 20/day, so the lead-time mean must be exactly
  // 20 -- not 20 x a seasonal multiplier. ORS peaks hard in the monsoon, so if
  // the multipliers were applied on top this would land well away from 20.
  check(
    'forecastDailyDemand is the forecast mean, unmultiplied',
    near(risk.forecastDailyDemand, 20, 1e-9),
    String(risk.forecastDailyDemand),
  );
}
{
  // Croston path unchanged: no forecast means the seasonal multipliers still
  // apply, so this must NOT equal the raw fitted mean.
  const risk = computeStockRisk({
    facilityId: 'F1', drug, fit, onHand: 100, batches: [], leadTimeDays: 14,
    asOf, population: 30000, simulations: 2000,
  });
  check('without a forecast the Croston path still runs', risk.forecastDailyDemand > 0);
  check(
    'and it is seasonally adjusted, not the bare fit',
    !near(risk.forecastDailyDemand, fit.meanDemand, 1e-9),
    risk.forecastDailyDemand.toFixed(3) + ' vs fit ' + fit.meanDemand.toFixed(3),
  );
}
{
  // A higher forecast must raise stock-out probability against fixed stock.
  const low = computeStockRisk({
    facilityId: 'F1', drug, fit, onHand: 200, batches: [], leadTimeDays: 14,
    asOf, population: 30000, simulations: 4000, forecast: flat(10, 4),
  });
  const high = computeStockRisk({
    facilityId: 'F1', drug, fit, onHand: 200, batches: [], leadTimeDays: 14,
    asOf, population: 30000, simulations: 4000, forecast: flat(30, 12),
  });
  check(
    'a higher forecast raises stock-out probability',
    high.stockoutProbability > low.stockoutProbability,
    low.stockoutProbability.toFixed(3) + ' -> ' + high.stockoutProbability.toFixed(3),
  );
  check('and raises the reorder point', high.reorderPoint > low.reorderPoint, low.reorderPoint + ' -> ' + high.reorderPoint);
}

console.log('\nseasonality is applied exactly once (Croston path)');
{
  // THE REGRESSION THIS GUARDS
  // --------------------------
  // `fit.meanDemand` is exponentially weighted with alpha = 0.15 -- on daily
  // data, roughly "what this facility dispensed last week". Last week already
  // contains the current month's season. Multiplying it by the forward seasonal
  // multiplier applied the season a SECOND time, and the shipped build did
  // exactly that: measured over 6,016 district series on a September holdout,
  // monsoon drugs were forecast 88% high and winter drugs 31% low, while `flat`
  // drugs -- which cannot double-count -- came out unbiased at 1.012.
  //
  // Two drugs, IDENTICAL demand history, different seasonal profiles, evaluated
  // over a lead time inside one month. A correct forecast depends on the
  // history, not on which curve the drug is attached to.
  const flatDrug = getDrug('PARA-500-TAB');
  const seasonalDrug = getDrug('ORS-SACHET');
  const sameHistory = Array.from({ length: 120 }, (_, i) => 20 + ((i * 7) % 5));
  const f = fitDemand(sameHistory);
  // Mid-month as-of with a short lead time, so the whole horizon stays inside
  // one month and the relative multipliers are exactly 1 for both drugs.
  const midSept = new Date(Date.UTC(2026, 8, 10));

  const riskFlat = computeStockRisk({
    facilityId: 'F1', drug: flatDrug, fit: f, onHand: 500, batches: [], leadTimeDays: 10,
    asOf: midSept, population: 30000, simulations: 500,
  });
  const riskSeasonal = computeStockRisk({
    facilityId: 'F1', drug: seasonalDrug, fit: f, onHand: 500, batches: [], leadTimeDays: 10,
    asOf: midSept, population: 30000, simulations: 500,
  });
  const ratio = riskSeasonal.forecastDailyDemand / riskFlat.forecastDailyDemand;
  check(
    'the same history forecasts the same level whatever the seasonal profile',
    near(ratio, 1, 0.02),
    'seasonal/flat = ' + ratio.toFixed(3),
  );
  check(
    'and it tracks the fitted level rather than a multiple of it',
    near(riskFlat.forecastDailyDemand, f.meanDemand, f.meanDemand * 0.02),
    riskFlat.forecastDailyDemand.toFixed(2) + ' vs fitted ' + f.meanDemand.toFixed(2),
  );
}
{
  // Crossing into a different season MUST still move the forecast -- the fix
  // divides the measured season out, it does not switch seasonality off.
  const ors = getDrug('ORS-SACHET');
  const f = fitDemand(Array.from({ length: 120 }, () => 20));
  const fromSept = computeStockRisk({
    facilityId: 'F1', drug: ors, fit: f, onHand: 500, batches: [], leadTimeDays: 21,
    asOf: new Date(Date.UTC(2026, 8, 20)), population: 30000, simulations: 500,
  }).forecastDailyDemand;
  const fromNov = computeStockRisk({
    facilityId: 'F1', drug: ors, fit: f, onHand: 500, batches: [], leadTimeDays: 21,
    asOf: new Date(Date.UTC(2026, 10, 20)), population: 30000, simulations: 500,
  }).forecastDailyDemand;
  check(
    'a horizon crossing a month boundary still moves -- seasonality is not switched off',
    Math.abs(fromSept - fromNov) > 0.01,
    'from 20 Sep ' + fromSept.toFixed(2) + ' vs from 20 Nov ' + fromNov.toFixed(2),
  );
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + '  ' + (checks - failures) + '/' + checks + ' checks');
process.exit(failures === 0 ? 0 : 1);
