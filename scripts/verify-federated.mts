/**
 * THE LEAKAGE SWEEP
 * =================
 *
 * "States keep their data and share only models" is the sentence this project
 * puts on a slide. This script is what makes it checkable rather than
 * believable. It runs in `npm test`, and it fails the build if any of the
 * following stops being true:
 *
 *   1. Every key in every shipped node file is on an allowlist, and every value
 *      satisfies the constraint declared for that key. There is no field a
 *      district code, a facility id, a batch number or a quantity of medicine
 *      could travel in.
 *   2. No string anywhere in a node file matches a district code, a facility id,
 *      a batch number, or the name of any district in the network.
 *   3. Every count published is PINNED TO STRUCTURE -- the series count equals
 *      the sum of the per-item counts, the observation count equals series times
 *      days, the month-observation counts sum to the window length. A count that
 *      must equal a structural identity cannot be smuggling a stock level.
 *   4. The SHA-256 of each node file matches the digest recorded in the national
 *      prior, so "the API returns the committed file byte for byte" is a claim
 *      with an anchor rather than an assurance.
 *   5. Refitting a state from the source data reproduces its shipped file
 *      exactly -- the artefact is derived, not hand-maintained.
 *   6. The leave-one-state-out prior really excludes the state: pooling with and
 *      without it gives different answers, which is the only mechanical evidence
 *      that the evaluation is not scoring a state against itself.
 *
 * A SWEEP THAT HAS NEVER REJECTED ANYTHING IS NOT A TEST
 * ------------------------------------------------------
 * The most dangerous version of this script is one that passes because it is
 * looking for the wrong thing. So before it sweeps the real files it sweeps
 * deliberately poisoned copies -- a facility id, a district code, a batch
 * number, a raw quantity and a district name, each planted in a different place
 * -- and fails if any of them survives. The run reports how many planted leaks
 * the sweep caught, so a green line says what it actually verified.
 *
 * Run:  npx tsx scripts/verify-federated.mts     (part of `npm test`)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fitStateNode, type NodeWorkforceRecord } from '../src/lib/federated/node';
import { poolNodes } from '../src/lib/federated/pool';
import { DISTRICTS, DISTRICTS_BY_CODE, STATES } from '../src/lib/domain/geo';
import { DRUGS_BY_ID } from '../src/lib/domain/drugs';

const root = process.cwd();
const dir = resolve(root, 'src/data/federated');
const read = (p: string) => readFileSync(p, 'utf8');

let failures = 0;
const check = (ok: boolean, what: string, detail?: string) => {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + what + (ok || !detail ? '' : '\n        ' + detail));
};

// ------------------------------------------------------------ what may travel

type Kind = 'index' | 'rate' | 'se' | 'count' | 'zero';

/**
 * The allowlist, as paths with `[]` standing for any array position.
 *
 * Strings are listed with the pattern they must match. Anything not on this
 * list is a leak by definition -- the sweep does not try to judge whether a new
 * field looks harmless, because that judgement is exactly what fails quietly.
 */
const NUMERIC: Record<string, Kind> = {
  'window.days': 'count',
  'scope.districts': 'count',
  'scope.series': 'count',
  'scope.observations': 'count',
  'seasonality[].series': 'count',
  'seasonality[].index[]': 'index',
  'seasonality[].monthObs[]': 'count',
  'seasonality[].indexSe[]': 'se',
  'seasonality[].residualCv': 'se',
  'seasonality[].p95Ratio': 'index',
  'workforce[].vacancyRate': 'rate',
  'workforce[].vacancyRateSe': 'se',
  'shared.numbers': 'count',
  'shared.facilityRows': 'zero',
  'shared.stockQuantities': 'zero',
  'shared.patientRecords': 'zero',
  'shared.districtIdentifiers': 'zero',
};

const STRINGS: Record<string, RegExp> = {
  schema: /^aarogya\.federated\.node\/1$/,
  'node.stateCode': /^\d{2}$/,
  'node.stateName': /^[A-Za-z ]{3,40}$/,
  'node.abbr': /^[A-Z]{2}$/,
  'window.start': /^\d{4}-\d{2}-\d{2}$/,
  'window.end': /^\d{4}-\d{2}-\d{2}$/,
  'seasonality[].item': /^[A-Z0-9][A-Z0-9.\-]{2,30}$/,
  // Letters, spaces, hyphens, slashes and parentheses -- "Anti-tuberculosis",
  // "MPW (Male)". Deliberately no digits: a batch number or a quantity dressed
  // up as a label has nowhere to hide.
  'seasonality[].group': /^[A-Za-z][A-Za-z ()/-]{2,39}$/,
  'workforce[].cadre': /^[a-z_]{2,20}$/,
  'workforce[].label': /^[A-Za-z][A-Za-z ()/-]{1,39}$/,
};

const IN_RANGE: Record<Kind, (v: number) => boolean> = {
  // Zero is a legitimate multiplier: Lakshadweep, one district on an island
  // chain, dispenses no anti-snake venom in most months, and a state whose item
  // saw no demand in a month says exactly that. The pool already treats a zero
  // as "no information about the month's shape" rather than as a zero.
  index: (v) => Number.isFinite(v) && v >= 0 && v <= 20,
  rate: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
  se: (v) => Number.isFinite(v) && v >= 0 && v <= 50,
  count: (v) => Number.isInteger(v) && v >= 0 && v <= 10_000_000,
  zero: (v) => v === 0,
};

/** Shapes that must never appear in any string in a node file. */
const BANNED: { name: string; re: RegExp }[] = [
  { name: 'district code', re: /DST-\d{2}-/ },
  { name: 'facility id', re: /-(SC|PHC|CHC|SDH|DH|DW)-\d{3}/ },
  { name: 'facility name', re: /^(SC|PHC|CHC|SDH|DH|DW) [A-Z]/ },
  { name: 'batch number', re: /\b(B\d{3}-[A-Z0-9]+|OPEN-[A-Z0-9]+)\b/ },
  { name: 'batch vocabulary', re: /batch/i },
  { name: 'coordinate pair', re: /\d{2}\.\d{3,},\s*\d{2}\.\d{3,}/ },
];

/** District names are data about which districts exist inside the state. */
const DISTRICT_NAMES = new Set(DISTRICTS.map((d) => d.name.toLowerCase()));
const STATE_NAMES = new Set(STATES.map((s) => s.name.toLowerCase()));

interface Finding {
  path: string;
  why: string;
}

/** Walk a parsed node payload and return everything that should not be there. */
function sweep(value: unknown, path = '', out: Finding[] = []): Finding[] {
  if (Array.isArray(value)) {
    for (const v of value) sweep(v, path + '[]', out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/[^A-Za-z0-9_]/.test(k)) out.push({ path: path + '.' + k, why: 'key is not a plain identifier' });
      sweep(v, path ? path + '.' + k : k, out);
    }
    return out;
  }
  if (value === null) {
    // Only a standard error is allowed to be absent, and absence is its own
    // statement: "this node has no information about that month".
    const kind = NUMERIC[path];
    if (kind !== 'se') out.push({ path, why: 'null in a field that is not a standard error' });
    return out;
  }
  if (typeof value === 'number') {
    const kind = NUMERIC[path];
    if (!kind) out.push({ path, why: 'number at a path that is not on the allowlist' });
    else if (!IN_RANGE[kind](value)) out.push({ path, why: `${kind} out of range: ${value}` });
    return out;
  }
  if (typeof value === 'string') {
    const pattern = STRINGS[path];
    if (!pattern) out.push({ path, why: 'string at a path that is not on the allowlist' });
    else if (!pattern.test(value)) out.push({ path, why: `does not match ${pattern}: ${JSON.stringify(value)}` });
    for (const b of BANNED) {
      if (b.re.test(value)) out.push({ path, why: `contains a ${b.name}: ${JSON.stringify(value)}` });
    }
    // A node's own name is allowed to be a district's name too -- Chandigarh,
    // Lakshadweep and Puducherry are each a union territory AND a district in
    // it -- but only in the one field that names the state, and only when it IS
    // a state's name. "Patna" in that field is still a district leaking out.
    const isOwnStateName = path === 'node.stateName' && STATE_NAMES.has(value.toLowerCase());
    if (DISTRICT_NAMES.has(value.toLowerCase()) && !isOwnStateName) {
      out.push({ path, why: `is the name of a district: ${JSON.stringify(value)}` });
    }
    return out;
  }
  out.push({ path, why: 'value is neither number, string nor null' });
  return out;
}

// ------------------------------------------------------------- the positive control

console.log('federated leakage sweep');
console.log('\npositive control -- the sweep must REJECT each of these');

const control = JSON.parse(read(resolve(dir, STATES[0].code + '.json')));
const POISON: { name: string; apply: (n: Record<string, unknown>) => void }[] = [
  {
    name: 'a facility id',
    apply: (n) => {
      (n.seasonality as Record<string, unknown>[])[0].sourceFacility = 'DST-10-PATNA-PHC-007';
    },
  },
  {
    name: 'a district code',
    apply: (n) => {
      (n.scope as Record<string, unknown>).districtCodes = ['DST-10-PATNA'];
    },
  },
  {
    name: 'a batch number',
    apply: (n) => {
      (n.workforce as Record<string, unknown>[])[0].label = 'B012-DH001';
    },
  },
  {
    name: 'a raw quantity',
    apply: (n) => {
      (n.seasonality as Record<string, unknown>[])[0].unitsDispensed = 48213;
    },
  },
  {
    name: 'a district name',
    apply: (n) => {
      (n.node as Record<string, unknown>).stateName = 'Patna';
    },
  },
];

let caught = 0;
for (const p of POISON) {
  const poisoned = JSON.parse(JSON.stringify(control));
  p.apply(poisoned);
  const found = sweep(poisoned);
  const clean = sweep(JSON.parse(JSON.stringify(control)));
  const detected = found.length > clean.length;
  if (detected) caught++;
  check(detected, 'rejects ' + p.name, found.map((f) => f.path + ': ' + f.why).join('; '));
}
check(caught === POISON.length, `the control planted ${POISON.length} leaks and the sweep caught ${caught}`);

// ------------------------------------------------------------------ the real files

const nodeFiles = readdirSync(dir).filter((f) => /^\d{2}\.json$/.test(f)).sort();
console.log(`\nshipped node files (${nodeFiles.length})`);
check(nodeFiles.length === STATES.length, `one file per state (${STATES.length})`);

interface ShippedNode {
  node: { stateCode: string };
  window: { days: number };
  scope: { districts: number; series: number; observations: number };
  seasonality: { item: string; series: number; index: number[]; monthObs: number[]; indexSe: (number | null)[] }[];
  workforce: unknown[];
  shared: { numbers: number };
}

const texts = new Map<string, string>();
let totalFindings = 0;
for (const f of nodeFiles) {
  const text = read(resolve(dir, f));
  texts.set(f, text);
  const parsed = JSON.parse(text) as ShippedNode;
  const found = sweep(parsed);
  totalFindings += found.length;
  if (found.length) {
    check(false, f + ' carries nothing but statistics', found.slice(0, 5).map((x) => x.path + ': ' + x.why).join('; '));
  }
}
check(totalFindings === 0, `all ${nodeFiles.length} node files carry nothing but allowlisted statistics`);

// ---- counts pinned to structure -------------------------------------------
console.log('\ncounts are structural, not quantities');
let structural = 0;
for (const f of nodeFiles) {
  const n = JSON.parse(texts.get(f)!) as ShippedNode;
  const sumSeries = n.seasonality.reduce((a, g) => a + g.series, 0);
  const ok =
    n.scope.series === sumSeries &&
    n.scope.observations === n.scope.series * n.window.days &&
    n.seasonality.every((g) => g.series <= n.scope.districts) &&
    n.seasonality.every((g) => g.monthObs.reduce((a, b) => a + b, 0) === n.window.days) &&
    n.seasonality.every((g) => g.index.length === 12 && g.monthObs.length === 12);
  if (ok) structural++;
  else check(false, f + ': counts satisfy their structural identities');
}
check(
  structural === nodeFiles.length,
  'every published count equals a structural identity (series = sum of per-item series; observations = series x days; month observations sum to the window)',
);

// ---- every item is a public catalogue code ---------------------------------
let unknownItems = 0;
for (const f of nodeFiles) {
  const n = JSON.parse(texts.get(f)!) as ShippedNode;
  for (const g of n.seasonality) if (!DRUGS_BY_ID[g.item]) unknownItems++;
}
check(unknownItems === 0, 'every `item` is a code from the public drug catalogue');

// ---- digests match the national file ---------------------------------------
console.log('\nthe API can be checked against the repository');
const national = JSON.parse(read(resolve(dir, '_national.json'))) as {
  nodes: { stateCode: string; sha256: string; bytes: number }[];
  evaluation: { ladder: { historyDays: number; improvementOverLocal: number; improvementOverFlat: number }[]; headlineHistoryDays: number };
  seasonality: { item: string; prior: number[] }[];
};
let digests = 0;
for (const f of nodeFiles) {
  const code = f.replace('.json', '');
  const recorded = national.nodes.find((n) => n.stateCode === code);
  const sha = createHash('sha256').update(texts.get(f)!).digest('hex');
  if (recorded && recorded.sha256 === sha && recorded.bytes === Buffer.byteLength(texts.get(f)!)) digests++;
}
check(digests === nodeFiles.length, 'every node file matches the SHA-256 and byte count recorded in _national.json');

// ---- the artefact is derived, not maintained -------------------------------
console.log('\nthe files are derived from the source data');
interface DemandFile {
  startDate: string;
  days: number;
  series: { districtCode: string; drugId: string; values: number[] }[];
}
const demand = JSON.parse(read(resolve(root, 'src/data/demand-district-daily.json'))) as DemandFile;
const startDate = new Date(demand.startDate + 'T00:00:00Z');

/** One state, refitted here from scratch, must reproduce its file byte for byte. */
const SAMPLE = STATES[0].code;
const sampleSeries = demand.series
  .filter((s) => DISTRICTS_BY_CODE[s.districtCode]?.stateCode === SAMPLE)
  .map((s) => ({ item: DRUGS_BY_ID[s.drugId].id, group: DRUGS_BY_ID[s.drugId].therapeuticGroup, values: s.values }));
const sampleDistricts = new Set(
  demand.series
    .filter((s) => DISTRICTS_BY_CODE[s.districtCode]?.stateCode === SAMPLE)
    .map((s) => s.districtCode),
);
const sampleWorkforce: NodeWorkforceRecord[] = [];
for (const code of sampleDistricts) {
  const payload = JSON.parse(
    read(resolve(root, 'src/data/districts', code + '.json')),
  ) as { resources: { facilities: { id: string; cadres: { cadre: string; label: string; sanctioned: number; inPosition: number }[] }[] } };
  for (const fac of payload.resources.facilities) {
    for (const c of fac.cadres) {
      sampleWorkforce.push({ cadre: c.cadre, label: c.label, facility: fac.id, sanctioned: c.sanctioned, inPosition: c.inPosition });
    }
  }
}
const state = STATES.find((s) => s.code === SAMPLE)!;
const refit = fitStateNode({
  stateCode: state.code,
  stateName: state.name,
  abbr: state.abbr,
  startDate,
  fitDays: demand.days,
  districts: sampleDistricts.size,
  series: sampleSeries,
  workforce: sampleWorkforce,
});
check(
  JSON.stringify(refit, null, 1) + '\n' === texts.get(SAMPLE + '.json'),
  `refitting ${state.name} from the source data reproduces its committed node file exactly`,
);

// ---- the leave-one-state-out prior really leaves one out --------------------
console.log('\nthe evaluation prior excludes the state it scores');
const allNodes = nodeFiles.map((f) => JSON.parse(texts.get(f)!) as ShippedNode);
const PROBE_ITEM = 'PARA-500-TAB';
const PROBE_MONTH = 7;
const estimatesFor = (exclude: string | null) =>
  allNodes
    .filter((n) => n.node.stateCode !== exclude)
    .map((n) => {
      const g = n.seasonality.find((x) => x.item === PROBE_ITEM)!;
      const v = g.index[PROBE_MONTH];
      const se = g.indexSe[PROBE_MONTH];
      return { node: n.node.stateCode, value: v > 0 ? Math.log(v) : NaN, se: v > 0 && se !== null ? se / v : null };
    });
const withAll = poolNodes(estimatesFor(null), PROBE_ITEM, 0);
const without = poolNodes(estimatesFor(SAMPLE), PROBE_ITEM, 0);
check(withAll.nodes === nodeFiles.length, `pooling all states uses ${nodeFiles.length} nodes`);
check(without.nodes === nodeFiles.length - 1, `leaving one out uses ${nodeFiles.length - 1}`);
check(
  Math.abs(withAll.mean - without.mean) > 0,
  'excluding a state changes the prior it would be scored against (so the exclusion is real, not cosmetic)',
);
check(
  !without.shrunk.some((s) => s.node === SAMPLE),
  'the excluded state receives no posterior from a pool it did not join',
);

// ---- the pooling arithmetic ------------------------------------------------
console.log('\nthe pooling arithmetic');
const identical = poolNodes(
  [
    { node: 'a', value: 2, se: 0.1 },
    { node: 'b', value: 2, se: 0.1 },
    { node: 'c', value: 2, se: 0.1 },
  ],
  'identical',
);
check(identical.tauSquared === 0, 'nodes that agree produce tau^2 = 0');
check(identical.shrunk.every((s) => s.weight === 0 && Math.abs(s.value - 2) < 1e-12), '...and are pulled fully to the national mean');

const spread = poolNodes(
  [
    { node: 'a', value: 1, se: 0.05 },
    { node: 'b', value: 3, se: 0.05 },
    { node: 'c', value: 2, se: 0.05 },
    { node: 'd', value: 2, se: null },
  ],
  'spread',
);
check(spread.tauSquared > 0, 'nodes that genuinely disagree produce tau^2 > 0');
check(spread.mean >= 1 && spread.mean <= 3, 'the pooled mean lies inside the range of the node estimates');
check(spread.uninformativeNodes === 1, 'a node with no data is counted as uninformative');
const d = spread.shrunk.find((s) => s.node === 'd')!;
check(d.weight === 0 && Math.abs(d.value - spread.mean) < 1e-12, '...and receives the national mean outright');
const a = spread.shrunk.find((s) => s.node === 'a')!;
check(a.value > 1 && a.value < spread.mean, 'an outlying node is pulled toward the mean but not past it');
check(
  poolNodes([{ node: 'x', value: 5, se: null }], 'empty', 1).mean === 1,
  'a pool with no evidence returns the neutral value it was given, not a NaN',
);
let threw = false;
try {
  poolNodes([{ node: 'x', value: 5, se: null }], 'empty');
} catch {
  threw = true;
}
check(threw, '...and throws when no neutral value was given, rather than producing a silent NaN');

// ---- the published claim ---------------------------------------------------
console.log('\nthe measured claim');
const headline = national.evaluation.ladder.find(
  (r) => r.historyDays === national.evaluation.headlineHistoryDays,
)!;
check(headline !== undefined, 'the headline history window appears in the published ladder');
check(
  headline.improvementOverLocal > 0,
  `a newcomer with ${national.evaluation.headlineHistoryDays} days of history forecasts better with the national prior than without it (${(headline.improvementOverLocal * 100).toFixed(1)}%)`,
);
check(
  headline.improvementOverFlat > 0,
  `...and better than assuming demand has no season (${(headline.improvementOverFlat * 100).toFixed(1)}%)`,
);

console.log('\n' + '-'.repeat(70));
const sharedNumbers = allNodes.reduce((acc, n) => acc + n.shared.numbers, 0);
console.log(
  failures === 0
    ? `federated: ${nodeFiles.length} nodes, ${sharedNumbers.toLocaleString('en-IN')} numbers shared, ` +
        `${POISON.length} planted leaks caught, 0 leaks found`
    : `federated: ${failures} checks FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
