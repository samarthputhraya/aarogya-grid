/**
 * WS3: the warning rule, the indicator contract, and the outbreak scenario.
 *
 * Run with:  npx tsx scripts/test-surge.mts   (part of `npm test`)
 *
 * Offline. The detector itself needs BigQuery and is exercised by
 * `npm run anomalies:detect`; what is pinned here is everything downstream of
 * it, which is where the claims live.
 *
 * THE THREE THINGS THIS DEFENDS
 * -----------------------------
 * 1. The RULE. `docs/warning-tuning.md` publishes a false-alarm rate measured
 *    for one specific rule. If the code that applies it drifted -- k counted
 *    over array positions instead of dates, say -- the published rate would
 *    describe a rule the product no longer runs, and nothing else would fail.
 *
 * 2. The CONTRACT. The indicator payload is offered to a foreign consumer as
 *    something they can validate. A payload that stopped satisfying its own
 *    schema, or that grew a required India-specific field, would break that
 *    quietly.
 *
 * 3. The BUDGET. `simulate_outbreak` is kept out of the assistant's default
 *    tool set because it is expensive; the design note's gate is four seconds.
 *    A scenario that crept over it would take the whole assistant with it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  warningsForSeries,
  warningsFrom,
  type AnomalyFinding,
  type WarningRule,
} from '../src/lib/surge/warnings';
import {
  IndicatorPayloadSchema,
  HAZARD_CLASSES,
  HAZARD_FOR_PATTERN,
  confidenceFor,
} from '../src/lib/surge/indicator';
import { simulateSurge, EMERGENCY_SHORTAGE_PENALTY } from '../src/lib/surge/scenario';
import { DEFAULT_SHORTAGE_PENALTY } from '../src/lib/optimize/redistribute';
import { asForecastCache, asForecastMethod } from '../src/lib/forecast/timesfm';

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

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const RULE: WarningRule = {
  consecutiveDays: 2,
  excessAboveUpperBound: 0.1,
  source: 'consumption',
  detectorThreshold: 0.95,
};

const point = (d: string, v: number, hi: number, dir: 'high' | 'low' = 'high', p = 0.99) => ({
  d,
  v,
  lo: 0,
  hi,
  p,
  dir,
});

console.log('\nthe warning rule');
{
  // Two consecutive days, both well above the band. This is a warning.
  const sustained: AnomalyFinding = {
    sid: 'DST-10-PURNIA|ORS-SACHET',
    points: [point('2026-09-28', 200, 100), point('2026-09-29', 210, 100)],
    status: '',
  };
  const w = warningsForSeries(sustained, RULE);
  check('two consecutive days above the band raise one warning', w.length === 1, String(w.length));
  check('raised on the day the run reaches k', w[0]?.raisedOn === '2026-09-29', w[0]?.raisedOn);
  check('carrying both days', w[0]?.days.length === 2);
  check('and what was observed against what was expected', w[0]?.observed === 410 && w[0]?.expectedUpperBound === 200);
  check('as a ratio', w[0]?.ratio === 2.05, String(w[0]?.ratio));

  // CONSECUTIVE MEANS CONSECUTIVE DATES. The cache holds only flagged days, so
  // two points three days apart sit next to each other in the array. Reading
  // the array naively would call that a sustained rise.
  const scattered: AnomalyFinding = {
    sid: 'x',
    points: [point('2026-09-24', 200, 100), point('2026-09-29', 210, 100)],
    status: '',
  };
  check('two days five apart are not a run', warningsForSeries(scattered, RULE).length === 0);

  // NOTHING IS NOT A RISE. A flagged day of zero consumption against an upper
  // bound of zero satisfied "v >= hi x 1.1" and shipped twelve "Rising
  // consumption" signals with an observed value of 0. The tuned predicate
  // requires the value to be strictly above the bound.
  const nothing: AnomalyFinding = {
    sid: 'DST-36-MAHABUBN|ASV-POLY-10ML',
    points: [point('2026-09-22', 0, 0), point('2026-09-23', 0, 0)],
    status: '',
  };
  check('zero against a zero bound is not a warning', warningsForSeries(nothing, RULE).length === 0);

  // The magnitude gate. A day that is flagged but barely above the band is not
  // an outbreak; it is the 0.95 threshold doing what a 0.95 threshold does.
  const marginal: AnomalyFinding = {
    sid: 'x',
    points: [point('2026-09-28', 105, 100), point('2026-09-29', 104, 100)],
    status: '',
  };
  check('a run that never clears the excess is not a warning', warningsForSeries(marginal, RULE).length === 0);

  // A collapse is a different warning with a different response, and the surge
  // rule must not claim it.
  const collapse: AnomalyFinding = {
    sid: 'x',
    points: [point('2026-09-28', 2, 100, 'low'), point('2026-09-29', 1, 100, 'low')],
    status: '',
  };
  check('a collapse is not a surge warning', warningsForSeries(collapse, RULE).length === 0);

  // A long run is ONE warning. Counting each day would turn a fortnight-long
  // outbreak into fourteen, which is the arithmetic that made the tuning run's
  // first false-alarm rate meaningless.
  const long: AnomalyFinding = {
    sid: 'x',
    points: ['25', '26', '27', '28', '29'].map((d) => point('2026-09-' + d, 300, 100)),
    status: '',
  };
  check('a five-day run is one warning, not four', warningsForSeries(long, RULE).length === 1);

  // Two separate episodes ARE two warnings: the rise stopped and started again.
  const twice: AnomalyFinding = {
    sid: 'x',
    points: [
      point('2026-09-20', 300, 100),
      point('2026-09-21', 300, 100),
      point('2026-09-28', 300, 100),
      point('2026-09-29', 300, 100),
    ],
    status: '',
  };
  check('two separate runs are two warnings', warningsForSeries(twice, RULE).length === 2);

  const k3 = warningsForSeries(long, { ...RULE, consecutiveDays: 3 });
  check('a stricter k raises the warning later', k3[0]?.raisedOn === '2026-09-27', k3[0]?.raisedOn);
  check('warningsFrom returns newest first', warningsFrom([twice], RULE)[0].raisedOn === '2026-09-29');
}

console.log('\nthe shipped rule is the one that was measured');
{
  const rule = JSON.parse(read('src/data/warning-rule.json')) as WarningRule & {
    measured: Record<string, number | null>;
  };
  const tuning = JSON.parse(read('docs/warning-tuning.json')) as {
    gate: { detection: number; leadDays: number; falseAlarms: number };
  };
  check('a rule is shipped', rule.consecutiveDays >= 1 && rule.excessAboveUpperBound >= 0);
  check('with all four measured numbers', [
    'detectionRateAt2x',
    'medianLeadDays',
    'falseAlarmsPerDistrictWeek',
    'precision',
  ].every((k) => k in rule.measured));
  check(
    'and it clears the gate the design note set',
    (rule.measured.detectionRateAt2x ?? 0) >= tuning.gate.detection &&
      (rule.measured.medianLeadDays ?? -1) >= tuning.gate.leadDays &&
      (rule.measured.falseAlarmsPerDistrictWeek ?? 1) <= tuning.gate.falseAlarms,
  );
}

console.log('\nthe indicator contract');
{
  const feed = JSON.parse(read('src/data/early-warnings.json'));
  const parsed = IndicatorPayloadSchema.safeParse(feed);
  check(
    'the shipped feed validates against its own schema',
    parsed.success,
    parsed.success ? '' : JSON.stringify(parsed.error.issues[0]),
  );

  if (parsed.success) {
    const p = parsed.data;
    check('it states its provenance', p.disclosure.dataProvenance === 'simulated');
    check('and says so in words a consumer will read', /SIMULATED/.test(p.disclosure.note));
    check('it publishes how a signal is decided', p.method.consecutiveDays >= 1);
    check('and what that was measured at', p.method.validation.precision >= 0);
    check('every signal names a hazard class from the fixed list',
      p.signals.every((s) => (HAZARD_CLASSES as readonly string[]).includes(s.hazardClass)));

    // THE INTEROPERABILITY CLAIM, CHECKED RATHER THAN ASSERTED. Strip the
    // optional `local` block -- the only place Indian vocabulary is allowed --
    // and the payload must still be valid. If a district code ever migrated
    // into a required field, this is what would catch it.
    const stripped = {
      ...p,
      signals: p.signals.map((s) => {
        const copy = { ...s };
        delete copy.local;
        return copy;
      }),
    };
    check(
      'the payload is still valid with every local block removed',
      IndicatorPayloadSchema.safeParse(stripped).success,
    );
    /*
     * `area.code` legitimately carries our identifier -- an area has to be
     * nameable -- and it is qualified by `codeSystem`, which is the whole
     * interoperable pattern: a consumer can tell whether two feeds' codes are
     * comparable without knowing what either means. What must NOT appear in a
     * required field is a key from a vocabulary a consumer would have to
     * understand: the drug catalogue, which is a state essential-medicines
     * list. Those live in `local`.
     */
    check(
      'no required field carries a medicine identifier from our catalogue',
      p.signals.every((s) => {
        const drugId = s.local?.drugId;
        if (!drugId) return true;
        const withoutLocal = JSON.stringify({ ...s, local: undefined });
        return !withoutLocal.includes(drugId);
      }),
    );
    check(
      'and every area code is qualified by the system it belongs to',
      p.signals.every((s) => s.area.codeSystem.length > 0 && s.area.code.length > 0),
    );
    check(
      'signal ids are opaque, not our internal keys',
      p.signals.every((s) => /^sig-[0-9a-f]{8}$/.test(s.id)),
      p.signals[0]?.id,
    );
    check(
      'and unique across the feed',
      new Set(p.signals.map((s) => s.id)).size === p.signals.length,
    );
    check('areas carry a population a consumer can normalise against',
      p.signals.every((s) => s.area.population > 0));
    check('and name the code system, rather than implying one',
      p.signals.every((s) => s.area.codeSystem.length > 0));
  }

  // The emitted JSON Schema has to be the same contract.
  const schema = JSON.parse(read('docs/indicator-schema.json')) as {
    $schema: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  check('a JSON Schema is published', schema.$schema.includes('json-schema.org'));
  check(
    'and it requires the disclosure block',
    (schema.required ?? []).includes('disclosure'),
    (schema.required ?? []).join(','),
  );
  check('and the method block', (schema.required ?? []).includes('method'));

  check('hazard mapping covers every seasonal pattern the catalogue uses',
    ['monsoon_vector', 'summer_enteric', 'winter_respiratory', 'monsoon_envenomation', 'summer_heat', 'obstetric', 'flat']
      .every((p) => p in HAZARD_FOR_PATTERN));

  // Confidence is derived from the evidence, not from a feeling.
  check('a big sustained certain rise is high confidence', confidenceFor(2.0, 4, 0.999) === 'high');
  check('a modest two-day rise is moderate', confidenceFor(1.3, 2, 0.96) === 'moderate');
  check('a marginal one is low', confidenceFor(1.05, 2, 0.95) === 'low');
}

console.log('\nthe outbreak scenario');
{
  const cache = asForecastCache(JSON.parse(read('src/data/forecast-cache.json')));
  const method = asForecastMethod(JSON.parse(read('src/data/forecast-method.json')));

  check(
    'an emergency values a stock-out above routine, on every class',
    EMERGENCY_SHORTAGE_PENALTY.V > DEFAULT_SHORTAGE_PENALTY.V &&
      EMERGENCY_SHORTAGE_PENALTY.E > DEFAULT_SHORTAGE_PENALTY.E &&
      EMERGENCY_SHORTAGE_PENALTY.D > DEFAULT_SHORTAGE_PENALTY.D,
  );
  check(
    'and preserves the ordering the catalogue already encodes',
    EMERGENCY_SHORTAGE_PENALTY.V > EMERGENCY_SHORTAGE_PENALTY.E &&
      EMERGENCY_SHORTAGE_PENALTY.E > EMERGENCY_SHORTAGE_PENALTY.D,
  );

  // Warm once: the first call pays for module init and JIT, which is not what
  // the budget is about.
  simulateSurge({
    districtCode: 'DST-10-PURNIA',
    pattern: 'monsoon_vector',
    multiplier: 2,
    forecastCache: cache,
    forecastMethod: method,
  });

  const runs: number[] = [];
  let last: ReturnType<typeof simulateSurge> | null = null;
  for (const district of ['DST-10-PURNIA', 'DST-22-BASTAR', 'DST-09-LUCKNOW']) {
    const t = Date.now();
    last = simulateSurge({
      districtCode: district,
      pattern: 'monsoon_vector',
      multiplier: 2,
      forecastCache: cache,
      forecastMethod: method,
    });
    runs.push(Date.now() - t);
  }
  const worst = Math.max(...runs);
  check(
    'the worst of three districts is under the 4 s gate',
    worst < 4000,
    runs.join('/') + ' ms',
  );

  const r = last!;
  // STRICT. These used to be >= and <=, so a scenario whose surge did nothing at
  // all -- multiplier ignored, same plan twice -- passed every one of them.
  check('an outbreak raises the number of critical positions', r.surged.critical > r.baseline.critical,
    r.baseline.critical + ' -> ' + r.surged.critical);
  check('and the expected shortfall', r.surged.expectedShortfallUnits > r.baseline.expectedShortfallUnits,
    r.baseline.expectedShortfallUnits + ' -> ' + r.surged.expectedShortfallUnits);
  check('only the drugs that treat it are touched',
    r.drugs.every((d) => d.id.length > 0) && r.drugs.length > 0 && r.drugs.length < 20,
    String(r.drugs.length));

  // THE ARGUMENT THE WHOLE SCENARIO EXISTS TO MAKE. Raising demand alone gives
  // a wall of benefit/cost refusals; what changes the answer is the VALUE of a
  // stock-out, which is a policy dial rather than a modelling change.
  check(
    'an emergency valuation serves more needs than routine',
    r.emergency.served > r.routine.served,
    r.routine.served + ' -> ' + r.emergency.served,
  );
  check(
    'and clears benefit/cost refusals rather than inventing stock',
    r.emergency.failedBenefitCost <= r.routine.failedBenefitCost,
    r.routine.failedBenefitCost + ' -> ' + r.emergency.failedBenefitCost,
  );
  check(
    'it costs more transport, and the difference is reported',
    r.extraTransportInr > 0 && r.extraNeedsServed === r.emergency.served - r.routine.served,
    '₹' + r.extraTransportInr + ' for ' + r.extraNeedsServed + ' more needs',
  );
  check('both plans are returned, never only the emergency one',
    r.routine.label === 'routine' && r.emergency.label === 'emergency');

  // Determinism: the agent quotes these numbers, so two identical questions
  // must not give two different answers.
  const again = simulateSurge({
    districtCode: 'DST-09-LUCKNOW',
    pattern: 'monsoon_vector',
    multiplier: 2,
    forecastCache: cache,
    forecastMethod: method,
  });
  check(
    'the same scenario gives the same answer',
    again.emergency.served === r.emergency.served &&
      again.surged.critical === r.surged.critical &&
      again.extraTransportInr === r.extraTransportInr,
  );

  const bigger = simulateSurge({
    districtCode: 'DST-09-LUCKNOW',
    pattern: 'monsoon_vector',
    multiplier: 3,
    forecastCache: cache,
    forecastMethod: method,
  });
  check(
    'a bigger outbreak is at least as bad',
    bigger.surged.critical >= r.surged.critical,
    r.surged.critical + ' -> ' + bigger.surged.critical,
  );
}

console.log('\nthe two tools, through the runner the model reaches them by');
{
  // The design note is explicit: a tool the model can see is a tool it will
  // call, and half a second of CPU on every question kills the assistant's
  // p50-under-eight-seconds budget.
  const { toolNames, onRequestToolNames, runTool, toolDeclarations } = await import(
    '../src/lib/ai/grid-tools'
  );
  check('simulate_outbreak is opt-in', !toolNames().includes('simulate_outbreak'));
  check('and is offered as one', onRequestToolNames().includes('simulate_outbreak'));
  check('early_warnings IS in the default set', toolNames().includes('early_warnings'));
  check(
    'naming it puts it in front of the model',
    toolNames(['simulate_outbreak']).includes('simulate_outbreak'),
  );
  check(
    'the declarations handed to Gemini honour the tier',
    !toolDeclarations().some((d) => d.name === 'simulate_outbreak') &&
      toolDeclarations(['simulate_outbreak']).some((d) => d.name === 'simulate_outbreak'),
  );

  const cache = asForecastCache(JSON.parse(read('src/data/forecast-cache.json')));
  const method = asForecastMethod(JSON.parse(read('src/data/forecast-method.json')));
  const ctx = {
    districtCode: 'DST-10-PURNIA',
    forecastCache: cache,
    forecastMethod: method,
  };

  const warnings = await runTool('early_warnings', {}, ctx);
  check('early_warnings answers for the console district', warnings.rows >= 0);
  const wd = warnings.data as Record<string, unknown>;
  check('and carries how a signal is decided', 'howSignalsAreDecided' in wd);
  check(
    'and the caveat a model must repeat',
    /precision/i.test(String(wd.note)) && /not confirmed outbreaks/i.test(String(wd.note)),
  );

  // The gate, through the same path the model uses -- resolver, Zod, runner --
  // rather than against the library function underneath it.
  const t = Date.now();
  const scenario = await runTool(
    'simulate_outbreak',
    { disease: 'dengue', multiplier: 2 },
    ctx,
  );
  const ms = Date.now() - t;
  check('simulate_outbreak returns through the runner in under 4 s', ms < 4000, ms + ' ms');
  const sd = scenario.data as Record<string, unknown>;
  check('with both plans', 'atRoutineValuation' in sd && 'atEmergencyValuation' in sd);
  check('and the pre-positioning orders', Array.isArray(sd.prePositioningOrders));
  check(
    'and a note saying it is a scenario, not a forecast',
    /SCENARIO, not a forecast/.test(String(sd.note)),
  );
  check(
    'the summary is the sentence a ministry can act on',
    /routine valuation/.test(scenario.summary) && /emergency/.test(scenario.summary),
    scenario.summary,
  );

  // A disease the model has no pattern for is refused, with the list. Guessing
  // the nearest one would answer a question nobody asked.
  let refused = '';
  try {
    await runTool('simulate_outbreak', { disease: 'appendicitis' }, ctx);
  } catch (e) {
    refused = (e as Error).message;
  }
  check('an unknown outbreak pattern is refused', refused.length > 0);
  check('and the refusal lists what IS known', /Vector-borne/.test(refused), refused.slice(0, 90));
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + '  ' + (checks - failures) + '/' + checks + ' checks');
process.exit(failures === 0 ? 0 : 1);
