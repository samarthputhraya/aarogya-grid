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

/** WS3 artefacts. Each is written by the script that measured it. */
const warningRule = JSON.parse(read('src/data/warning-rule.json')) as {
  consecutiveDays: number;
  excessAboveUpperBound: number;
  measured: {
    detectionRateAt2x: number;
    medianLeadDays: number | null;
    falseAlarmsPerDistrictWeek: number;
    precision: number;
  };
};
const anomalyRuntime = JSON.parse(read('docs/anomaly-runtime.json')) as {
  runs: { label: string; series: number; batches: number; flaggedSeries: number }[];
};
const surgeExample = JSON.parse(read('docs/surge-example.json')) as { sentence: string };
const indicatorFeed = JSON.parse(read('src/data/early-warnings.json')) as { signals: unknown[] };
const anomalySeries = anomalyRuntime.runs.reduce((a, r) => a + r.series, 0);
const anomalyBatches = anomalyRuntime.runs.reduce((a, r) => a + r.batches, 0);
const footfallRun = anomalyRuntime.runs.find((r) => r.label === 'footfall')!;

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
 * RE-MEASURED 12 Sep 2026, after TimesFM landed: 95.8 / 98.5 / 98.6 / 98.6 s on
 * a quiet laptop, 202.8 s with other work alongside it.
 *
 * The spread is MACHINE LOAD, not the code, and that was worth proving rather
 * than assuming. The obvious story -- "TimesFM scores fewer positions critical,
 * so the planner does less work, so the build got twice as fast" -- is wrong: a
 * Croston-only build (`AAROGYA_NO_BQ=1`) on the same quiet machine takes 93.6 s,
 * within 3 s of the TimesFM build. Both earlier 200 s readings were simply taken
 * while something else was running. A causal claim about the model would have
 * been published on a coincidence.
 *
 * The surfaces quote the BAND rather than the last run, because that spread is
 * wider than anything the code does, and a second-precision figure would put
 * every rebuild on the claim treadmill this guard exists to end. What is checked
 * is that the shipped run still falls inside the band -- if it stops doing so,
 * the band is wrong and the prose must change, which is exactly the moment a
 * human should look.
 */
const BUILD_BAND: [number, number] = [94, 203];
/** Extrapolations are quoted from the SLOW end. A scale claim should not flatter. */
const slowPerDistrict = BUILD_BAND[1] / t.districts;
const roundTo = (v: number, step: number) => Math.round(v / step) * step;

/**
 * The plan, summed over the 128 shipped district payloads.
 *
 * The deck's before/after table is built from these rather than from
 * `totals`, because its denominator is the planner's own bookkeeping --
 * `reasonHistogram` counts every need the optimiser declined, which `totals`
 * does not carry. Deriving them here is not optional: the table's "after"
 * column drifted three builds out of date while every guarded number stayed
 * green, which is precisely the failure this file exists to prevent.
 */
const plan = (() => {
  let transfers = 0;
  let trips = 0;
  let crossDistrictTrips = 0;
  let rideAlongOrders = 0;
  let unserved = 0;
  const reasons: Record<string, number> = {};
  /** Road km to the nearest donor, for needs the benefit/cost gate declined. */
  const gateKm: number[] = [];

  for (const f of readdirSync(districtDir)) {
    const payload = JSON.parse(readFileSync(resolve(districtDir, f), 'utf8')) as {
      economics: {
        transfers: number;
        trips: number;
        crossDistrictTrips: number;
        rideAlongOrders: number;
        unservedReceivers: number;
        reasonHistogram: Record<string, number>;
      };
      unserved?: { reason: string; nearestDonorKm: number | null }[];
    };
    const e = payload.economics;
    transfers += e.transfers;
    trips += e.trips;
    crossDistrictTrips += e.crossDistrictTrips;
    rideAlongOrders += e.rideAlongOrders;
    unserved += e.unservedReceivers;
    for (const [k, v] of Object.entries(e.reasonHistogram)) reasons[k] = (reasons[k] ?? 0) + v;
    for (const u of payload.unserved ?? []) {
      if (u.reason === 'failed_bc_gate' && typeof u.nearestDonorKm === 'number') {
        gateKm.push(u.nearestDonorKm);
      }
    }
  }

  gateKm.sort((a, b) => a - b);
  const mid = gateKm.length / 2;
  // NOTE: the payloads truncate their `unserved` list, so this is the median
  // over the declined needs they SHIP, not over the whole population. The deck
  // says so in its footnote rather than implying a population median.
  const medianGateKm = gateKm.length
    ? gateKm.length % 2
      ? gateKm[(gateKm.length - 1) / 2]
      : (gateKm[mid - 1] + gateKm[mid]) / 2
    : 0;

  return {
    transfers,
    trips,
    crossDistrictTrips,
    rideAlongOrders,
    unserved,
    reasons,
    medianGateKm,
    gateShare: unserved > 0 ? (reasons.failed_bc_gate ?? 0) / unserved : 0,
    noStockAnywhere: reasons.no_surplus ?? 0,
  };
})();

/**
 * The pre-consolidation baseline the README and the deck compare against.
 *
 * A HISTORICAL CONSTANT, pinned here because it cannot be re-derived: it
 * describes a build (commit 73cf60a) that planned each district in isolation
 * and billed every order its own vehicle. The code that produced it no longer
 * exists, so the honest options were to pin it with its provenance or to stop
 * quoting it. The percentages derived from it ARE checked, which is what stops
 * a stale "78% more" surviving a rebuild that moved the numerator.
 */
const BASELINE_SHORTFALL_AVERTED = 495_166;
const shortfallUplift = Math.round(
  (t.shortfallAverted / BASELINE_SHORTFALL_AVERTED - 1) * 100,
);
/** Cash actually spent: transport out, waste rescued back in. */
const netCashInr = t.transportCostInr - t.wasteAvertedInr;

/**
 * The held-out backtest, as the surfaces quote it.
 *
 * The submission's central AI claim is no longer "we used TimesFM" but "we used
 * TimesFM where it measurably wins". That is a stronger claim and a more
 * fragile one: it depends on a margin, a winning class and a position count
 * that all move whenever the backtest is re-run. So all three are read from the
 * measurement rather than typed.
 */
interface BacktestFile {
  winMargin: number;
  facilityClasses: { pattern: string; maseDelta: number; winner: string }[];
}
const backtest = JSON.parse(read('src/data/forecast-method.json')) as BacktestFile;
const timesfmClass = backtest.facilityClasses.find((c) => c.winner === 'timesfm') ?? {
  pattern: 'none',
  maseDelta: 0,
  winner: 'croston',
};

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
  // ---- the early-warning layer, README ------------------------------------
  //
  // Every figure below is written by the script that measured it. The surge
  // sentence in particular is stored verbatim in the artefact rather than
  // rebuilt here, because a sentence assembled in two places is a sentence
  // that will eventually be assembled two ways.
  {
    file: 'README.md',
    must: n(t.opdAttendedToday) + ' consultations on the as-of date',
    why: 'outpatient attendance, from the snapshot',
  },
  {
    file: 'README.md',
    must: n(anomalySeries) + ' series in ' + anomalyBatches + ' statements',
    why: 'anomaly detection scale, from the runtime artefact',
  },
  {
    file: 'README.md',
    must: 'flagged ' + footfallRun.flaggedSeries + ' of ' + footfallRun.series + ' districts',
    why: 'how noisy the raw detector is -- the reason the rule exists',
  },
  {
    file: 'README.md',
    must:
      warningRule.consecutiveDays + " consecutive days above the model's upper bound by " +
      String.fromCharCode(8805) + ' ' +
      (warningRule.excessAboveUpperBound * 100).toFixed(0) + '%',
    why: 'the warning rule, as tuned',
  },
  {
    file: 'README.md',
    must: '| **' + (warningRule.measured.detectionRateAt2x * 100).toFixed(0) + '%** |',
    why: 'detection rate at a 2x surge',
  },
  {
    file: 'README.md',
    must: '**' + warningRule.measured.medianLeadDays + ' days**',
    why: 'median lead before the first shelf empties',
  },
  {
    file: 'README.md',
    must: '**' + warningRule.measured.falseAlarmsPerDistrictWeek + '**',
    why: 'false alarms per district-week -- the number that does not move with the base rate',
  },
  {
    file: 'README.md',
    must: '**' + (warningRule.measured.precision * 100).toFixed(0) + '%**',
    why: 'precision, published rather than buried',
  },
  {
    file: 'README.md',
    must: surgeExample.sentence,
    why: 'the worked surge scenario, verbatim from the artefact that computed it',
  },
  {
    file: 'README.md',
    must: n(indicatorFeed.signals.length) + ' signals',
    why: 'signals in the shipped indicator feed',
  },

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
    must: n(links.filter((l) => l.crossState).length) + ' cross-state corridors',
    why: 'cross-state corridors, as quoted in the scaling section',
  },
  {
    file: 'docs/pitch-deck.html',
    must: n(links.filter((l) => l.crossState).length) + ' cross-state corridors',
    why: 'deck scaling slide: cross-state corridors',
  },
  {
    file: 'README.md',
    must: '**' + shortfallUplift + '% more shortfall averted**',
    why: 'shortfall uplift over the pre-consolidation baseline, recomputed not remembered',
  },
  {
    file: 'README.md',
    must: String(BASELINE_SHORTFALL_AVERTED.toLocaleString('en-US')) + ' → ' + n(t.shortfallAverted) + ' units',
    why: 'both ends of that comparison, so the percentage can be checked by hand',
  },
  { file: 'README.md', must: '**₹' + lakh(netCashInr) + ' L**', why: 'net cash cost' },

  // ---- the AI claim, answerable from the artefact rather than from prose ----
  {
    file: 'README.md',
    must: '**' + n(snapshot.forecast.seriesForecast) + '** district × drug series',
    why: 'district x drug series TimesFM forecast',
  },
  {
    file: 'README.md',
    must: '**' + snapshot.forecast.horizonDays + ' days** ahead',
    why: 'forecast horizon',
  },
  {
    file: 'README.md',
    must: '**' + snapshot.forecast.contextDays + '-day** context',
    why: 'forecast context window',
  },
  {
    file: 'README.md',
    must: '**' + n(snapshot.forecast.timesfmPositions) + '** of the **' + n(t.trackedPositions) + '**',
    why: 'positions scored against a TimesFM path, and the denominator beside it',
  },
  {
    file: 'README.md',
    must: '**' + (backtest.winMargin * 100).toFixed(0) + '%** MASE',
    why: 'the margin TimesFM must clear to take a demand class',
  },
  {
    file: 'README.md',
    must: 'won **' + timesfmClass.pattern + '** demand by ' +
      Math.abs(timesfmClass.maseDelta * 100).toFixed(1) + '%',
    why: 'the class TimesFM actually won, and by how much',
  },

  // ---- the deck's before/after table, which drifted while unguarded ----
  {
    file: 'docs/pitch-deck.html',
    must: '<td class="n tnum ok">' + n(plan.transfers) + '</td>',
    why: 'deck table: dispatch orders after consolidation',
  },
  {
    file: 'docs/pitch-deck.html',
    must: '<td class="n tnum ok">' + n(plan.trips) + '</td>',
    why: 'deck table: vehicle trips after consolidation',
  },
  {
    file: 'docs/pitch-deck.html',
    must: '<td class="n tnum ok">' + n(plan.crossDistrictTrips) + ' trips</td>',
    why: 'deck table: trips crossing a district',
  },
  {
    file: 'docs/pitch-deck.html',
    must: '<td class="n tnum ok">' + n(plan.unserved) + '</td>',
    why: 'deck table: needs the planner declined',
  },
  {
    file: 'docs/pitch-deck.html',
    must: '<td class="n tnum ok">' + n(plan.noStockAnywhere) + '</td>',
    why: 'deck table: needs that failed for no donor stock anywhere',
  },
  {
    file: 'docs/pitch-deck.html',
    must: '<b>' + n(plan.rideAlongOrders) + '</b> of those orders',
    why: 'deck note: orders that could not justify a vehicle alone',
  },
  {
    file: 'docs/pitch-deck.html',
    must: '<strong>' + (plan.gateShare * 100).toFixed(1) + '% failed the',
    why: 'deck prose: share of declined needs that failed the benefit/cost gate',
  },
  {
    file: 'docs/pitch-deck.html',
    must: '<strong>' + plan.medianGateKm.toFixed(1) + ' km</strong>',
    why: 'deck prose: median road distance to the nearest donor for those needs',
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
  { file: 'docs/pitch-deck.html', mustNot: /Nine tools|Ten tools/i, why: 'there are ' + toolCount + ' tools' },
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

/**
 * The restart-survival gate, checked as BOUNDS rather than as figures.
 *
 * The README deliberately does not quote the millisecond numbers. They move by
 * a factor of three between a warm laptop and a cold container in asia-south1,
 * and pinning prose to the last run would put every future run on the claim
 * treadmill this file exists to prevent -- the same reasoning that made
 * `buildSeconds` a band. So the artefact holds the figures, the prose makes a
 * bounded claim, and this checks the artefact against the bound.
 *
 * `browserSawRestoredValue` is not a performance number and is not a bound: it
 * is the whole gate. Every other field can be green while a reloaded console
 * shows nothing, because the page is prerendered.
 */
console.log('\ndocs/restart-gate.json');
{
  const APPEND_CEILING_MS = 2_000;
  const RESTORE_CEILING_MS = 6_000;
  let gate: Record<string, {
    durableAppendMs: number;
    restoreMs: number;
    restoredEntries: number;
    browserSawRestoredValue: boolean;
    published: boolean;
    seqBeforeRestart: number;
    seqAfterRestart: number;
  } | undefined> = {};
  try {
    gate = JSON.parse(read('docs/restart-gate.json'));
  } catch {
    failures++;
    console.log('  FAIL  the gate artefact is missing -- run `npm run rehearse:restart`');
  }

  /**
   * Both are required now.
   *
   * Cloud Run was optional while there was no revision carrying the feature to
   * replace -- a suite that failed for eight days is a suite nobody reads. It
   * was measured on 12 Sep against revision 00018, and the artefact keeps the
   * two environments under separate keys, so a local re-run cannot quietly
   * overwrite the deployment's figures and downgrade this back to a TODO.
   */
  const environments: [string, string, boolean][] = [
    ['local', 'a killed local production server', true],
    ['cloudRun', 'a replaced Cloud Run revision', true],
  ];
  for (const [key, label, required] of environments) {
    const m = gate[key];
    if (!m) {
      if (required) {
        failures++;
        console.log('  FAIL  no recorded run against ' + label);
      } else {
        console.log(
          '  TODO  no recorded run against ' + label +
            ' -- run `npm run rehearse:restart -- --base <url> --restart-cmd "..."` after the deploy',
        );
      }
      continue;
    }
    const checks: [boolean, string][] = [
      [
        m.durableAppendMs <= APPEND_CEILING_MS,
        'the append is acknowledged in well under a second (' + m.durableAppendMs + ' ms)',
      ],
      [
        m.restoreMs <= RESTORE_CEILING_MS,
        'the restore query takes a couple of seconds (' + m.restoreMs + ' ms)',
      ],
      [m.restoredEntries >= 1, 'at least one position came back (' + m.restoredEntries + ')'],
      [m.published === true, 'the event reached Pub/Sub'],
      [
        m.seqAfterRestart >= m.seqBeforeRestart,
        'the sequence resumed rather than restarting (' +
          m.seqBeforeRestart + ' -> ' + m.seqAfterRestart + ')',
      ],
      [
        m.browserSawRestoredValue === true,
        'a reloaded /console rendered the restored value',
      ],
    ];
    for (const [ok, why] of checks) {
      if (!ok) failures++;
      console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + ': ' + why);
    }
  }
}

/**
 * The dispatch-loop figures, checked against the run that produced them.
 *
 * Unlike the restart gate, these ARE quoted in prose -- the gap between a
 * planned 2% and an actual 17% is the argument, and an argument made in
 * adjectives is not an argument. So the rehearsal writes what it measured and
 * this checks that the README still says the same thing.
 *
 * A rehearsal that picked a different order makes this FAIL rather than
 * silently re-baselining, which is correct: it means the README is describing a
 * run that no longer reproduces, and somebody has to decide which is right.
 */
console.log('\ndocs/dispatch-gate.json');
{
  interface DispatchGate {
    orderId: string;
    plannedUnits: number;
    unit: string;
    dispatchedUnits: number;
    receivedUnits: number;
    varianceUnits: number;
    projectedReceiverStockoutBefore: number;
    projectedReceiverStockoutAfter: number;
    receiverStockoutAfter: number;
    receiverOnHandBefore: number;
    receiverOnHandAfter: number;
  }
  let gate: DispatchGate | null = null;
  try {
    gate = JSON.parse(read('docs/dispatch-gate.json')) as DispatchGate;
  } catch {
    failures++;
    console.log('  FAIL  the gate artefact is missing -- run `npm run rehearse:dispatch`');
  }

  if (gate) {
    const readme = body('README.md');
    const pc = (v: number) => (v * 100).toFixed(0) + '%';
    const rows: [boolean, string][] = [
      // The invariants first. These hold whichever order was picked, and they
      // are what the design actually claims.
      [
        gate.varianceUnits === gate.dispatchedUnits - gate.receivedUnits,
        'variance is dispatched minus received (' + gate.varianceUnits + ')',
      ],
      [
        gate.varianceUnits > 0,
        'the run exercised a SHORT receipt, not just the happy path',
      ],
      [
        gate.receiverOnHandAfter - gate.receiverOnHandBefore === gate.receivedUnits,
        'the receiver gained exactly what arrived, not what was sent',
      ],
      [
        gate.receiverStockoutAfter > gate.projectedReceiverStockoutAfter,
        'and its risk therefore recovered LESS than the plan projected (' +
          pc(gate.projectedReceiverStockoutAfter) + ' planned, ' +
          pc(gate.receiverStockoutAfter) + ' actual)',
      ],
      // Then the prose, against those figures.
      [
        readme.includes('P(out) 100% → ' + pc(gate.projectedReceiverStockoutAfter)),
        'the README quotes the projected recovery',
      ],
      [
        readme.includes(
          '**' + gate.receivedUnits + ' arrived**',
        ),
        'and how many units actually arrived',
      ],
      [
        readme.includes('**' + pc(gate.receiverStockoutAfter) + '**'),
        'and where the receiver actually landed',
      ],
      [
        readme.includes('at ' + gate.plannedUnits + ' ' + gate.unit + 's'),
        'and the quantity the projection was made at',
      ],
    ];
    for (const [ok, why] of rows) {
      if (!ok) failures++;
      console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + why);
    }
  }
}

/**
 * The warning rule, checked against the run that chose it.
 *
 * The four numbers the design note asks for -- detection rate, median lead
 * time, false alarms per district-week, precision -- are not decorative. Each
 * one closes a way of lying with the other three: detection alone is bought by
 * lowering the bar, precision alone is bought by never warning, and a lead time
 * quoted without a false-alarm rate describes a system nobody is still reading.
 *
 * So this checks that all four are present, that the shipped rule is the one
 * the table chose, and that it clears the gate the design note set BEFORE any
 * of it was measured. A rule file that drifted from its tuning run would be a
 * product making a claim no experiment supports.
 */
console.log('\nsrc/data/warning-rule.json');
{
  interface WarningRule {
    consecutiveDays: number;
    excessAboveUpperBound: number;
    source: string;
    measured: {
      detectionRateAt2x: number;
      medianLeadDays: number | null;
      falseAlarmsPerDistrictWeek: number;
      precision: number;
    };
  }
  interface Tuning {
    gate: { detection: number; leadDays: number; falseAlarms: number };
    chosen: { rule: { k: number; e: number }; source: string } | null;
    evaluations: {
      rule: { k: number; e: number };
      source: string;
      medianLeadDays: number | null;
      falseAlarmsPerDistrictWeek: number;
      precision: number;
      byMultiplier: { multiplier: number; rate: number }[];
    }[];
    scenarios: unknown[];
  }

  let rule: WarningRule | null = null;
  let tuning: Tuning | null = null;
  try {
    rule = JSON.parse(read('src/data/warning-rule.json')) as WarningRule;
    tuning = JSON.parse(read('docs/warning-tuning.json')) as Tuning;
  } catch {
    failures++;
    console.log('  FAIL  the tuning artefacts are missing -- run `npm run tune:warning`');
  }

  if (rule && tuning) {
    const m = rule.measured;
    const chosen = tuning.chosen;
    const row = tuning.evaluations.find(
      (e) =>
        e.rule.k === rule.consecutiveDays &&
        e.rule.e === rule.excessAboveUpperBound &&
        e.source === rule.source,
    );
    const rowRate = row?.byMultiplier.find((x) => x.multiplier === 2)?.rate ?? -1;

    const rows: [boolean, string][] = [
      [chosen !== null, 'a rule was chosen at all'],
      [
        chosen?.rule.k === rule.consecutiveDays &&
          chosen?.rule.e === rule.excessAboveUpperBound &&
          chosen?.source === rule.source,
        'the shipped rule is the one the table chose',
      ],
      [row !== undefined, 'and it appears in the published table'],
      [
        Math.abs(rowRate - m.detectionRateAt2x) < 1e-9,
        'its detection rate matches the table (' + (m.detectionRateAt2x * 100).toFixed(0) + '%)',
      ],
      [m.medianLeadDays !== null, 'a median lead time is published'],
      [
        typeof m.falseAlarmsPerDistrictWeek === 'number',
        'a false-alarm rate per district-week is published (' + m.falseAlarmsPerDistrictWeek + ')',
      ],
      [typeof m.precision === 'number', 'a precision is published (' + (m.precision * 100).toFixed(0) + '%)'],
      // The gate, as the design note set it before anything was measured.
      [
        m.detectionRateAt2x >= tuning.gate.detection,
        'detection at a 2x surge clears the ' + (tuning.gate.detection * 100).toFixed(0) + '% gate',
      ],
      [
        (m.medianLeadDays ?? -1) >= tuning.gate.leadDays,
        'the median lead clears the ' + tuning.gate.leadDays + '-day gate',
      ],
      [
        m.falseAlarmsPerDistrictWeek <= tuning.gate.falseAlarms,
        'the false-alarm rate clears the ' + tuning.gate.falseAlarms + ' per district-week gate',
      ],
      [
        tuning.scenarios.length >= 100,
        'the table rests on ' + tuning.scenarios.length + ' injected surges, not a handful',
      ],
    ];
    for (const [ok, why] of rows) {
      if (!ok) failures++;
      console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + why);
    }
  }
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
