/**
 * CLAIM-DRIFT GUARD
 * =================
 *
 * Every number on a surface a judge reads -- the README, the deck -- is checked
 * against the artefact it claims to describe, and the check fails `npm test` if
 * they disagree.
 *
 * WHY THIS EXISTS
 * ---------------
 * The snapshot is regenerated whenever the model changes, and prose is not.
 * That gap has already shipped: the deck's dispatch-order slide said "778
 * tablets, batch B012-DH001" in its sentence and "x 781" in the pick list
 * directly beneath it, while the artefact it names -- and cites by filename --
 * held 118 tablets of a different batch. The repo's homepage pointed at a mirror
 * whose totals contradicted the deck. A reviewer who opens the file a slide
 * cites and finds a different number stops believing the other eleven slides,
 * and they are right to.
 *
 * The rule this enforces is the project's first guardrail: never publish a
 * figure that is not read from a re-run script or a shipped payload. A claim
 * that cannot be derived here does not belong on a surface.
 *
 * Run:  npx tsx scripts/check-claims.mts     (part of `npm test`)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NationalSnapshot } from '../src/lib/snapshot-types';

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const snapshot = JSON.parse(read('src/data/national-snapshot.json')) as NationalSnapshot;
const t = snapshot.totals;

// ---------------------------------------------------------------- derivations

/** Indian digit grouping, the way every surface renders a count. */
const n = (v: number) => Math.round(v).toLocaleString('en-IN');
/** Lakhs to one decimal, the way the README writes transport cost. */
const lakh = (v: number) => (v / 1_00_000).toFixed(1);
const crore = (v: number) => (v / 1_00_00_000).toFixed(2);

const links = snapshot.crossDistrictLinks;
const districtsOnACorridor = new Set<string>();
for (const l of links) {
  districtsOnACorridor.add(l.fromDistrictCode);
  districtsOnACorridor.add(l.toDistrictCode);
}

/** Lead-time window, measured over every position in every district payload. */
const districtDir = resolve(root, 'src/data/districts');
let leadMin = Infinity;
let leadMax = -Infinity;
for (const f of readdirSync(districtDir)) {
  const payload = JSON.parse(readFileSync(resolve(districtDir, f), 'utf8')) as {
    positions?: { leadTimeDays?: number }[];
  };
  for (const p of payload.positions ?? []) {
    if (typeof p.leadTimeDays !== 'number') continue;
    if (p.leadTimeDays < leadMin) leadMin = p.leadTimeDays;
    if (p.leadTimeDays > leadMax) leadMax = p.leadTimeDays;
  }
}

/** Agent tools, counted in the file that declares them. */
const toolCount = (read('src/lib/ai/grid-tools.ts').match(/^ {4}name: '/gm) ?? []).length;

/**
 * The integration seam: the adapter functions a real deployment replaces.
 * Counted rather than asserted, because the claim used to be "one file".
 */
const ADAPTERS = [
  ['src/lib/sim/facilities.ts', 'generateNetwork'],
  ['src/lib/sim/inventory.ts', 'simulateInventory'],
  ['src/lib/sim/resources.ts', 'buildResourceStates'],
] as const;
const adapterCount = ADAPTERS.filter(([file, fn]) =>
  new RegExp('export function ' + fn + '\\b').test(read(file)),
).length;
const adapterWord = adapterCount === 3 ? 'three' : String(adapterCount);

/**
 * Seconds per district, and the band the batch is quoted at.
 *
 * The deck extrapolates a state and the whole country off this rate, so
 * deriving the extrapolations here rather than trusting the numbers typed into
 * the table is the difference between a scale claim and a guess.
 *
 * The band was measured across five runs on the
 * same laptop: 186 s on a quiet machine, 261 s with a dev server and a headless
 * Chromium alongside it.
 *
 * The surfaces quote the BAND rather than the last run, because the spread
 * between a quiet machine and a busy one is wider than anything the code does,
 * and a second-precision figure would put every rebuild on the claim treadmill
 * this guard exists to end. What is checked is that the shipped run still falls
 * inside the band -- if it stops doing so, the band is wrong and the prose must
 * change, which is exactly the moment a human should look.
 */
const BUILD_BAND: [number, number] = [186, 261];
/** Extrapolations are quoted from the SLOW end. A scale claim should not flatter. */
const slowPerDistrict = BUILD_BAND[1] / t.districts;
const roundTo = (v: number, step: number) => Math.round(v / step) * step;

/** The dispatch order the deck's solution slide quotes, from the artefact itself. */
interface HeroOrder {
  from: { name: string };
  to: { name: string };
  quantity: number;
  unit: string;
  distanceKm: number;
  estimatedCostInr: number;
  standaloneCostInr: number;
  riskReduction: number;
  lines: { batchNo: string; quantity: number; expiryDate: string }[];
}
const heroPayload = JSON.parse(read('src/data/districts/DST-10-PURNIA.json')) as {
  orders: HeroOrder[];
};
const heroOrder = heroPayload.orders.find(
  (o) => o.from.name === 'SC Bhagalpur-10' && o.to.name === 'CHC Purnia-01',
);

// -------------------------------------------------------------------- claims

type Claim =
  | { file: string; must: string; why: string }
  /** Any one of these spellings satisfies the claim -- see `grouping()`. */
  | { file: string; mustAny: string[]; why: string }
  | { file: string; mustNot: RegExp; why: string };

/**
 * The same figure in both digit groupings.
 *
 * The product renders counts with `en-IN` (8,85,946) because that is what an
 * Indian officer reads; long-form prose in the README sometimes uses the
 * international grouping (885,946). Both are the same number honestly written,
 * so the guard accepts either and cares only that it is the CURRENT number.
 */
const grouping = (v: number) => [
  Math.round(v).toLocaleString('en-IN'),
  Math.round(v).toLocaleString('en-US'),
];

const claims: Claim[] = [
  // ---- national scale, README ---------------------------------------------
  { file: 'README.md', must: n(t.districts) + ' districts', why: 'district count' },
  { file: 'README.md', must: n(t.states) + ' states', why: 'state count' },
  { file: 'README.md', must: n(t.facilities) + ' facilities', why: 'facility count' },
  {
    file: 'README.md',
    must: n(t.trackedPositions) + ' tracked facility',
    why: 'tracked position count',
  },
  { file: 'README.md', must: n(t.functionalBeds) + ' functional beds', why: 'functional beds' },
  { file: 'README.md', must: n(t.staffSanctioned) + ' sanctioned posts', why: 'sanctioned posts' },

  // ---- the plan, README ----------------------------------------------------
  { file: 'README.md', must: '**' + n(t.transfers) + '**', why: 'dispatch orders' },
  { file: 'README.md', must: '**' + n(t.trips) + ' vehicle trips**', why: 'vehicle trips' },
  {
    file: 'README.md',
    must: '**' + n(t.crossDistrictTrips) + ' trips reach',
    why: 'cross-district trips',
  },
  {
    file: 'README.md',
    must: '**' + n(t.crossDistrictOrders) + ' orders**',
    why: 'cross-district orders',
  },
  {
    file: 'README.md',
    must: '**' + n(links.length) + ' district-to-district corridors**',
    why: 'corridor count',
  },
  {
    file: 'README.md',
    must: '**' + n(districtsOnACorridor.size) + ' of the ' + n(t.districts) + ' districts**',
    why: 'districts touched by a corridor',
  },
  {
    file: 'README.md',
    must: '**' + n(links.filter((l) => l.crossState).length) + '** of those corridors',
    why: 'corridors crossing a state line',
  },
  { file: 'README.md', must: '**₹' + lakh(t.transportCostInr) + ' L**', why: 'transport cost' },
  {
    file: 'README.md',
    must: '**₹' + lakh(t.unconsolidatedCostInr) + ' L**',
    why: 'the same orders on dedicated vehicles',
  },
  { file: 'README.md', must: '**' + n(t.rideAlongOrders) + '** orders are filled', why: 'ride-alongs' },
  {
    file: 'README.md',
    mustAny: grouping(t.shortfallAverted).map((g) => g + ' units'),
    why: 'shortfall averted',
  },
  {
    file: 'README.md',
    must: '**' + BUILD_BAND[0] + '-' + BUILD_BAND[1] + ' s**',
    why: 'the measured wall-clock band the shipped run must fall inside',
  },
  {
    file: 'README.md',
    must: n(t.facilitiesWithoutPharmacist) + ' stock-holding',
    why: 'facilities with no pharmacist',
  },
  { file: 'README.md', must: adapterWord + ' adapters', why: 'size of the integration seam' },

  // ---- claims that were wrong once and must not come back ------------------
  {
    file: 'README.md',
    mustNot: /that one file and nothing else/i,
    why: 'the seam is three adapters, not one file',
  },
  {
    file: 'README.md',
    mustNot: /aarogya-grid\.vercel\.app/,
    why:
      'the Vercel mirror is deleted; it could not reach Vertex and served figures from an older ' +
      'build that contradicted every number in this file',
  },
  {
    file: 'README.md',
    mustNot: /flash-lite/,
    why: 'Vertex serves no -lite variant in asia-south1, so it cannot be the deployed default',
  },
  {
    file: 'src/app/page.tsx',
    // Narrow on purpose. The page is RIGHT to name the break-even price in the
    // prose that explains it; what it must never do again is print that price
    // as the rate at which the net-benefit figure accrues, which asserted that
    // net benefit is simultaneously 2.68 Cr and, by definition, zero.
    mustNot: /breakEvenInrPerUnit.*per averted unit/,
    why:
      'the break-even price is the value at which net benefit is ZERO; printing it under the ' +
      'net-benefit figure asserted both at once',
  },
];

// ---- the deck --------------------------------------------------------------
claims.push(
  {
    file: 'docs/pitch-deck.html',
    must: (adapterCount === 3 ? 'Three' : String(adapterCount)) + ' adapters stand between',
    why: 'seam slide headline',
  },
  {
    file: 'docs/pitch-deck.html',
    must: leadMin + '&ndash;' + leadMax + ' day resupply window',
    why: 'lead-time window, measured across every shipped position',
  },
  {
    file: 'docs/pitch-deck.html',
    must: toolCount === 10 ? 'Ten tools' : toolCount + ' tools',
    why: 'agent tool count',
  },
  {
    file: 'docs/pitch-deck.html',
    must: '>~' + Math.round(BUILD_BAND[1] / 60) + ' min<',
    why: 'measured batch wall time on the scale table, at the slow end of the band',
  },
  {
    file: 'docs/pitch-deck.html',
    must: '>~' + roundTo(slowPerDistrict * 40, 10) + ' s<',
    why: 'one-large-state extrapolation, from the slow end of the measured rate',
  },
  {
    file: 'docs/pitch-deck.html',
    must: '>~' + roundTo((slowPerDistrict * 780) / 60, 5) + ' min<',
    why: 'all-India extrapolation, from the slow end of the measured rate',
  },
  {
    file: 'docs/pitch-deck.html',
    mustNot: /one file and nothing else|One file stands between/i,
    why: 'the seam is three adapters, and this slide’s own diagram already lists three',
  },
  { file: 'docs/pitch-deck.html', mustNot: /Nine tools/i, why: 'there are ' + toolCount + ' tools' },
);

// The deck's dispatch-order slide, field by field, against the artefact it cites.
if (heroOrder) {
  const line = heroOrder.lines[0];
  claims.push(
    {
      file: 'docs/pitch-deck.html',
      must: 'spare <b>' + n(heroOrder.quantity) + '</b>',
      why: 'quantity on the dispatch order',
    },
    {
      file: 'docs/pitch-deck.html',
      must: '<b>' + heroOrder.distanceKm + ' km</b>',
      why: 'distance on the dispatch order',
    },
    {
      file: 'docs/pitch-deck.html',
      must: '<b>₹' + n(heroOrder.estimatedCostInr) + '</b>',
      why: 'what the order costs as planned',
    },
    {
      file: 'docs/pitch-deck.html',
      must: '<b>₹' + n(heroOrder.standaloneCostInr) + '</b>',
      why: 'what the same order would cost on its own vehicle',
    },
    {
      file: 'docs/pitch-deck.html',
      must:
        'pick list: ' + line.batchNo + ' × ' + n(line.quantity) + ' (exp ' + line.expiryDate + ')',
      why: 'first batch on the pick list, verbatim from the artefact',
    },
    ...(heroOrder.lines[1]
      ? [
          {
            file: 'docs/pitch-deck.html',
            must:
              heroOrder.lines[1].batchNo +
              ' × ' +
              n(heroOrder.lines[1].quantity) +
              ' (exp ' +
              heroOrder.lines[1].expiryDate +
              ')',
            why: 'second batch on the pick list -- the slide claims oldest-first, so both must be real',
          } as Claim,
        ]
      : []),
  );
} else {
  claims.push({
    file: 'docs/pitch-deck.html',
    must: '__THE ORDER THE DECK QUOTES NO LONGER EXISTS__',
    why: 'SC Bhagalpur-10 -> CHC Purnia-01 is gone from the shipped plan; the slide needs a new protagonist',
  });
}

// ------------------------------------------------------------------- checking

const cache = new Map<string, string>();
const body = (f: string) => {
  const hit = cache.get(f);
  if (hit !== undefined) return hit;
  const v = read(f);
  cache.set(f, v);
  return v;
};

let failures = 0;
let currentFile = '';

// Not a text claim: an assertion about the artefact itself.
console.log('\nsrc/data/national-snapshot.json');
{
  const inBand =
    snapshot.buildSeconds >= BUILD_BAND[0] && snapshot.buildSeconds <= BUILD_BAND[1];
  if (!inBand) failures++;
  console.log(
    '  ' +
      (inBand ? 'PASS' : 'FAIL') +
      '  the shipped run falls inside the quoted ' +
      BUILD_BAND[0] +
      '-' +
      BUILD_BAND[1] +
      ' s band   (this run: ' +
      snapshot.buildSeconds +
      ' s)',
  );
}

for (const c of claims) {
  if (c.file !== currentFile) {
    currentFile = c.file;
    console.log('\n' + c.file);
  }
  const text = body(c.file);
  if ('must' in c) {
    const ok = text.includes(c.must);
    if (!ok) failures++;
    console.log(
      '  ' + (ok ? 'PASS' : 'FAIL') + '  ' + c.why + (ok ? '' : '\n        expected: ' + c.must),
    );
  } else if ('mustAny' in c) {
    const ok = c.mustAny.some((m) => text.includes(m));
    if (!ok) failures++;
    console.log(
      '  ' +
        (ok ? 'PASS' : 'FAIL') +
        '  ' +
        c.why +
        (ok ? '' : '\n        expected one of: ' + c.mustAny.join('  |  ')),
    );
  } else {
    const hit = text.match(c.mustNot);
    if (hit) failures++;
    console.log(
      '  ' +
        (hit ? 'FAIL' : 'PASS') +
        '  must not say: ' +
        c.why +
        (hit ? '\n        found: ' + JSON.stringify(hit[0]) : ''),
    );
  }
}

console.log('\n' + '-'.repeat(70));
console.log('derived from the snapshot built ' + snapshot.builtAt + ', as-of ' + snapshot.asOf);
console.log(
  '  net benefit ₹' +
    crore(t.netBenefitInr) +
    ' Cr · lead-time window ' +
    leadMin +
    '-' +
    leadMax +
    ' d · ' +
    toolCount +
    ' agent tools · ' +
    adapterCount +
    ' adapters',
);
console.log(
  failures === 0
    ? 'claims: ' + claims.length + ' checked, all agree with the shipped artefacts'
    : 'claims: ' + failures + ' of ' + claims.length + ' DISAGREE with the shipped artefacts',
);
process.exit(failures === 0 ? 0 : 1);
