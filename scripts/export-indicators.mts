/**
 * Turns the detector's cache into warnings, and the warnings into an
 * interoperable early-warning feed.
 *
 * Run with:  npx tsx scripts/export-indicators.mts
 * Output:    src/data/early-warnings.json  (the payload the site and API serve)
 *            docs/indicator-schema.json    (the JSON Schema it validates against)
 *
 * THE SCHEMA IS EMITTED FROM THE SAME DEFINITION THAT VALIDATES
 * ------------------------------------------------------------
 * `IndicatorPayloadSchema` is a Zod object; `z.toJSONSchema` renders it as a
 * standard JSON Schema document. So the file a foreign consumer validates
 * against and the code that builds our payload cannot drift apart -- there is
 * one definition, and the build fails if the payload does not satisfy it.
 *
 * WHY THIS RUNS AT BUILD TIME AND NOT PER REQUEST
 * -----------------------------------------------
 * Everything upstream is already a committed artefact: the anomaly cache, the
 * tuned rule, the snapshot. Recomputing the feed on every request would be the
 * same arithmetic on the same inputs, and the one thing it would add is a way
 * for two consumers to get different answers a second apart.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import {
  IndicatorPayloadSchema,
  HAZARD_FOR_PATTERN,
  confidenceFor,
  type IndicatorPayload,
  type Signal,
} from '../src/lib/surge/indicator';
import { warningsFrom, type AnomalyFinding, type WarningRule } from '../src/lib/surge/warnings';
import { DISTRICTS_BY_CODE, districtPopulation } from '../src/lib/domain/geo';
import { DRUGS_BY_ID } from '../src/lib/domain/drugs';
import { SYNDROMES, type Syndrome } from '../src/lib/idsp/bulletin';

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

interface AnomalyCache {
  asOf: string;
  scoredDays: number;
  threshold: number;
  model: string;
  footfall: AnomalyFinding[];
  consumption: AnomalyFinding[];
}
interface RuleFile extends WarningRule {
  measured: {
    detectionRateAt2x: number;
    medianLeadDays: number | null;
    falseAlarmsPerDistrictWeek: number;
    precision: number;
  };
}

const anomalies = JSON.parse(read('src/data/anomalies.json')) as AnomalyCache;
const rule = JSON.parse(read('src/data/warning-rule.json')) as RuleFile;
const tuning = JSON.parse(read('docs/warning-tuning.json')) as {
  rounds: number;
  surgedPerRound: number;
  districts: number;
  scenarios: unknown[];
  surge: { days: number; multipliers: number[] };
};

console.log('Building the early-warning indicator feed');
console.log('  data through:', anomalies.asOf);
console.log(
  '  rule        : k=' + rule.consecutiveDays + ', e=' + rule.excessAboveUpperBound +
    ' on ' + rule.source,
);

/**
 * The rule was tuned on ONE series and is applied to that one.
 *
 * The tuning run measured footfall and consumption separately and consumption
 * won -- a 2x outbreak arrives in total OPD as x1.09, because vector-borne
 * illness is under a tenth of a district's outpatient load. Applying a rule
 * tuned on consumption to the footfall series would be quoting a false-alarm
 * rate that was never measured for it.
 */
const findings = rule.source === 'footfall' ? anomalies.footfall : anomalies.consumption;
const warnings = warningsFrom(findings, rule);
console.log('  warnings    :', warnings.length, 'from', findings.length, 'flagged series');

/**
 * A stable, opaque signal id.
 *
 * NOT `districtCode|drugId@date`, which is what this was first. That spelling
 * is convenient for us and leaks two of our internal key spaces into a required
 * field of a payload whose entire claim is that its required fields carry no
 * local vocabulary -- a consumer would have had to understand an Indian
 * district code and a state EDL item code just to deduplicate a feed. The
 * identifiers still travel, in the optional `local` block, where a consumer can
 * ignore them.
 *
 * FNV-1a: stable across runs and across machines, which is what lets a consumer
 * recognise the same signal in tomorrow's feed.
 */
function signalId(sid: string, day: string): string {
  let h = 0x811c9dc5;
  for (const ch of sid + '@' + day) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'sig-' + h.toString(16).padStart(8, '0');
}

const signals: Signal[] = [];
for (const w of warnings) {
  // A consumption series id is `districtCode|drugId`; a footfall one is just
  // the district code.
  const [districtCode, drugId] = w.sid.includes('|') ? w.sid.split('|') : [w.sid, undefined];
  const district = DISTRICTS_BY_CODE[districtCode];
  if (!district) continue;
  const drug = drugId ? DRUGS_BY_ID[drugId] : undefined;
  const pattern = drug?.seasonality ?? 'flat';

  signals.push({
    id: signalId(w.sid, w.raisedOn),
    hazardClass: HAZARD_FOR_PATTERN[pattern] ?? 'unspecified',
    hazardLabel: drug
      ? 'Rising consumption of ' + drug.name + ' (' + pattern.replace(/_/g, ' ') + ')'
      : 'Rising outpatient attendance',
    area: {
      code: district.code,
      // Named rather than implied: a consumer has to be able to tell whether
      // two feeds' codes are comparable, and ours are not LGD codes.
      codeSystem: 'aarogya-grid-district',
      name: district.name,
      country: 'IND',
      region: district.stateName,
      // Census 2011, apportioned to current boundaries. Real, unlike the
      // caseload -- and the one number in the area block a foreign consumer
      // would normalise against.
      population: districtPopulation(district.code),
    },
    observedFrom: w.days[0],
    observedTo: w.days[w.days.length - 1],
    metric: drug ? 'medicine_consumption_units' : 'outpatient_consultations',
    observedValue: w.observed,
    expectedUpperBound: w.expectedUpperBound,
    exceedanceRatio: w.ratio,
    confidence: confidenceFor(w.ratio, w.days.length, w.peakProbability),
    provenance: 'simulated',
    local: {
      districtCode: district.code,
      drugId,
      drugName: drug?.name,
      seasonalityProfile: pattern,
    },
  });
}
const simulatedCount = signals.length;

/*
 * OBSERVED SIGNALS: Kerala's IDSP daily bulletins.
 *
 * The same detector and the same tuned rule, applied to counts a state
 * surveillance unit actually published (`scripts/fetch-idsp.mts`,
 * `scripts/detect-idsp.mts`). Two differences from the simulated path, both
 * deliberate:
 *
 *   - A flagged point on a day whose bulletin is missing -- filled in only so
 *     the series stays a series -- is dropped before the rule sees it. An
 *     observed signal must rest on published numbers.
 *   - The rule's validation (detection, lead, false alarms, precision) was
 *     measured on injected surges in simulated consumption, not on these
 *     series. The disclosure says so rather than letting the method block imply
 *     it; there is no ground truth of past Kerala outbreaks here to measure
 *     against.
 */
interface IdspAnomalies {
  asOf: string;
  imputed: Record<string, string[]>;
  findings: AnomalyFinding[];
}
interface IdspData {
  source: { title: string; publisher: string };
  districts: { abbr: string; code: string; name: string; population: number }[];
  coverage: { last: string; bulletins: number };
}
interface IdspManifest {
  entries: { date: string; status: string; url: string | null; sha256: string | null }[];
}
let observedThrough: string | null = null;
let bulletins = 0;
if (existsSync(resolve(root, 'src/data/idsp-anomalies.json'))) {
  const idspAnomalies = JSON.parse(read('src/data/idsp-anomalies.json')) as IdspAnomalies;
  const idsp = JSON.parse(read('src/data/idsp-kerala.json')) as IdspData;
  const manifest = JSON.parse(read('data/idsp/manifest.json')) as IdspManifest;
  const documents = new Map(manifest.entries.filter((e) => e.status === 'ok').map((e) => [e.date, e]));
  observedThrough = idsp.coverage.last;
  bulletins = idsp.coverage.bulletins;

  const published = idspAnomalies.findings.map((f) => ({
    ...f,
    points: f.points.filter((p) => !(idspAnomalies.imputed[f.sid] ?? []).includes(p.d)),
  }));
  const observedWarnings = warningsFrom(published, rule);
  console.log('  observed    :', observedWarnings.length, 'warnings from', published.length, 'flagged IDSP series');

  for (const w of observedWarnings) {
    const [districtCode, tag] = w.sid.split('|');
    const syndrome = tag.replace(/^idsp:/, '') as Syndrome;
    const district = DISTRICTS_BY_CODE[districtCode];
    const spec = SYNDROMES[syndrome];
    const last = w.days[w.days.length - 1];
    const doc = documents.get(last);
    if (!district || !spec || !doc?.url || !doc.sha256) continue;
    signals.push({
      id: signalId(w.sid, w.raisedOn),
      hazardClass: spec.hazardClass,
      hazardLabel: spec.label + ' above the expected range',
      area: {
        code: district.code,
        codeSystem: 'aarogya-grid-district',
        name: district.name,
        country: 'IND',
        region: district.stateName,
        population: districtPopulation(district.code),
      },
      observedFrom: w.days[0],
      observedTo: last,
      metric: syndrome === 'fever' ? 'outpatient_consultations' : 'notified_cases',
      observedValue: w.observed,
      expectedUpperBound: w.expectedUpperBound,
      exceedanceRatio: w.ratio,
      confidence: confidenceFor(w.ratio, w.days.length, w.peakProbability),
      provenance: 'observed',
      sourceDocument: { publisher: idsp.source.publisher, title: idsp.source.title, url: doc.url, sha256: doc.sha256 },
      local: { districtCode: district.code, syndrome },
    });
  }
}
const observedCount = signals.length - simulatedCount;

const payload: IndicatorPayload = {
  schemaVersion: '1.1',
  source: {
    system: 'Aarogya Grid',
    country: 'IND',
    contact: 'https://github.com/samarthputhraya/aarogya-grid',
  },
  generatedAt: new Date().toISOString(),
  dataThrough: observedThrough && observedThrough > anomalies.asOf ? observedThrough : anomalies.asOf,
  sources: [
    {
      provenance: 'simulated',
      description:
        'Medicine consumption across the simulated primary health network of ' + Object.keys(DISTRICTS_BY_CODE).length +
        ' districts, pinned to a simulated as-of date.',
      dataThrough: anomalies.asOf,
      signals: simulatedCount,
    },
    ...(observedThrough
      ? [
          {
            provenance: 'observed' as const,
            description:
              'Notified cases and fever consultations by district, read from ' + bulletins +
              ' IDSP daily bulletins published by the State Surveillance Unit, Directorate of Health Services, Kerala.',
            dataThrough: observedThrough,
            signals: observedCount,
          },
        ]
      : []),
  ],
  method: {
    detector: anomalies.model,
    anomalyProbabilityThreshold: anomalies.threshold,
    consecutiveDays: rule.consecutiveDays,
    excessAboveUpperBound: rule.excessAboveUpperBound,
    validation: {
      detectionRateAt2x: rule.measured.detectionRateAt2x,
      medianLeadDays: rule.measured.medianLeadDays,
      falseAlarmsPerAreaWeek: rule.measured.falseAlarmsPerDistrictWeek,
      precision: rule.measured.precision,
      basis:
        tuning.scenarios.length + ' injected surges across ' + tuning.rounds +
        ' rounds of ' + tuning.surgedPerRound + ' of ' + tuning.districts +
        ' districts, ' + tuning.surge.days + ' days each at multipliers ' +
        tuning.surge.multipliers.join('/') + '. Full table in docs/warning-tuning.md.',
    },
  },
  disclosure: {
    dataProvenance: observedCount > 0 ? 'mixed' : 'simulated',
    note:
      'Every signal states its provenance. SIMULATED signals come from facility stock and consumption ' +
      'parameterised from IPHS norms and published seasonality, and describe no real outbreak. OBSERVED ' +
      'signals come from notified cases in Kerala\'s IDSP daily bulletins, each linked to its document ' +
      'and SHA-256; the detector and rule are the same, but their validation figures were measured on ' +
      'simulated surges, not on these series. Nothing here should be acted on clinically.',
  },
  signals,
};

// The gate: what we publish has to satisfy what we documented. A payload that
// failed here would be a contract nobody could rely on.
const validated = IndicatorPayloadSchema.safeParse(payload);
if (!validated.success) {
  console.error('The payload does not satisfy its own schema:');
  console.error(JSON.stringify(validated.error.issues, null, 2));
  process.exit(1);
}

const outPath = resolve(root, 'src/data/early-warnings.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload) + '\n');

const schemaPath = resolve(root, 'docs/indicator-schema.json');
// Also served, because `/api/indicators` points at it and a contract behind a
// GitHub link is a contract a machine cannot fetch.
const publicSchemaPath = resolve(root, 'public/docs/indicator-schema.json');
writeFileSync(
  schemaPath,
  JSON.stringify(
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://github.com/samarthputhraya/aarogya-grid/docs/indicator-schema.json',
      title: 'Aarogya Grid early-warning indicator payload',
      description:
        'A country-agnostic early-warning feed. Required fields carry no India-specific ' +
        'vocabulary; everything local travels in the optional `local` block. Generated from ' +
        'src/lib/surge/indicator.ts -- do not edit by hand.',
      ...z.toJSONSchema(IndicatorPayloadSchema, { target: 'draft-2020-12' }),
    },
    null,
    2,
  ) + '\n',
);

const byClass = new Map<string, number>();
for (const s of signals) byClass.set(s.hazardClass, (byClass.get(s.hazardClass) ?? 0) + 1);
const byConfidence = new Map<string, number>();
for (const s of signals) byConfidence.set(s.confidence, (byConfidence.get(s.confidence) ?? 0) + 1);

console.log('  signals     :', signals.length);
console.log(
  '  by hazard   :',
  [...byClass.entries()].map(([k, v]) => k + ' ' + v).join(' · ') || '(none)',
);
console.log(
  '  by certainty:',
  [...byConfidence.entries()].map(([k, v]) => k + ' ' + v).join(' · ') || '(none)',
);
console.log('  validated   : yes, against its own schema');
console.log('  wrote       :', outPath);
mkdirSync(dirname(publicSchemaPath), { recursive: true });
writeFileSync(publicSchemaPath, readFileSync(schemaPath, 'utf8'));

console.log('  wrote       :', schemaPath);
console.log('  wrote       :', publicSchemaPath);
