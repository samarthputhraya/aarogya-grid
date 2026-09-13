/**
 * DONOR GUARDRAILS AND ADMINISTRATIVE ADMISSIBILITY
 * =================================================
 *
 * Run with:  npx tsx scripts/verify-guardrails.mts [districts]
 *
 * "We never create a stock-out to fix one" is on the landing page. Until this
 * script existed it rested on one line of arithmetic in `donatableUnits` and a
 * comment saying what that line was for -- which is exactly the shape of a
 * claim that is true today and quietly false after the next change to the
 * planner.
 *
 * So the invariant is re-derived here from the other end. The planner enforces
 * the guardrail while it selects; this script takes the finished plan, adds up
 * everything each donor gave across every order and every pass, redraws that
 * donor's own lead-time demand distribution from scratch, and asks what its
 * stock-out probability actually is at the stock it is left holding. Two
 * thresholds, both fixed before the first run:
 *
 *     P(out) after donating  <=  0.10
 *     P(out) after donating  <=  P(out) before  + 0.02
 *
 * ANY violation fails `npm test`. There is no "mostly", no sampled tolerance,
 * and no count-of-acceptable-breaches: a supply-chain planner that empties one
 * shelf to fill another has done the one thing it must never do, and a test
 * that let that through at 1% would be worse than no test.
 *
 * It also checks the other half of WS6C -- that the plan contains no order
 * nobody has the authority to issue, and that every order that needs a
 * countersign says so in a field, not in prose.
 *
 * AND IT CHECKS THAT THE GUARDRAIL IS LOAD-BEARING
 * ------------------------------------------------
 * A guardrail that never binds is indistinguishable from no guardrail. The last
 * section re-plans one district with the caps lifted and reports what changes.
 * If nothing changes, the run says so rather than claiming a protection it is
 * not providing.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DISTRICTS, districtNeighbours } from '../src/lib/domain/geo';
import { buildDistrictState, toTransferContexts } from '../src/lib/pipeline';
import {
  planRedistribution,
  newPlannerState,
  DONOR_GUARDRAILS,
  type TransferContext,
} from '../src/lib/optimize/redistribute';
import { administrativeAdmissibility } from '../src/lib/optimize/admissibility';
import { leadTimeDemandSamples, stockoutProbabilityAt } from '../src/lib/forecast/risk';

const ASOF = new Date(Date.UTC(2026, 8, 30));
const SIMULATIONS = 600;
const PLAN_SIMS = 500;
const RADIUS_KM = 250;
const MAX_NEIGHBOURS = 4;
/**
 * The audit's own draw: an independent seed (`AUDIT_SALT`), so the guardrail is
 * checked against dice the planner never saw.
 *
 * What independence buys, stated precisely: a plan that only satisfies its
 * guardrail against one particular sample vector fails here. What it does NOT
 * buy: a systematic bias in the sampler itself, which both draws would share.
 * That is guarded from the other side, in `scripts/test-timesfm.mts`, which
 * requires the sampler's mean to equal the demand the risk record publishes.
 */
const AUDIT_SIMS = 2000;
const AUDIT_SALT = 'guardrail-audit';

const args = process.argv.slice(2);
const jsonArg = args.indexOf('--json');
const jsonPath = jsonArg >= 0 ? args[jsonArg + 1] : undefined;
const sampleSize = Math.max(1, Number.parseInt(args.find((a) => /^\d+$/.test(a)) ?? '4', 10));
const stride = Math.max(1, Math.floor(DISTRICTS.length / sampleSize));
const sample = Array.from({ length: sampleSize }, (_, i) => DISTRICTS[(i * stride) % DISTRICTS.length]);

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (ok || !detail ? '' : '\n        ' + detail));
}

console.log('Aarogya Grid -- donor guardrails and administrative admissibility');
console.log('  sample     :', sample.map((d) => d.name).join(', '));
console.log(
  '  guardrails :',
  `<= ${(DONOR_GUARDRAILS.maxDonorFraction * 100).toFixed(0)}% of shelf ·`,
  `cover floor ${DONOR_GUARDRAILS.coverFloorDays.V}/${DONOR_GUARDRAILS.coverFloorDays.E}/${DONOR_GUARDRAILS.coverFloorDays.D} d (V/E/D) ·`,
  `donor P(out) <= ${DONOR_GUARDRAILS.maxDonorStockoutAfter} and <= before + ${DONOR_GUARDRAILS.maxDonorStockoutRise}`,
);
console.log();

interface DonorAudit {
  key: string;
  ctx: TransferContext;
  given: number;
}

let totalOrders = 0;
let auditedDonors = 0;
let worstAfter = 0;
let worstRise = -1;
let worstAfterLabel = '';
let worstRiseLabel = '';
const byAdmissibility = new Map<string, number>();
/** Filled by the last section: what the guardrail costs on one district. */
let costOfTheGuardrail: {
  district: string;
  guardedOrders: number;
  unguardedOrders: number;
  guardedWorstDonorStockout: number;
  unguardedWorstDonorStockout: number;
} | null = null;

/** One planner state across the sweep, exactly as the batch job runs it. */
const shared = newPlannerState();

for (const d of sample) {
  const nb = districtNeighbours(d.code, RADIUS_KM, MAX_NEIGHBOURS).map((n) => n.code);
  const own = buildDistrictState(d.code, { asOf: ASOF, simulations: SIMULATIONS });
  const neighbours = nb.flatMap((code) => buildDistrictState(code, { asOf: ASOF, simulations: SIMULATIONS }));
  const contexts = toTransferContexts([...own, ...neighbours]);

  const ctxByKey = new Map<string, TransferContext>();
  for (const c of contexts) ctxByKey.set(c.facility.id + '|' + c.drug.id, c);

  const plan = planRedistribution(
    contexts,
    { asOf: ASOF, simulations: PLAN_SIMS, eligibleReceiver: (c) => c.facility.districtCode === d.code },
    shared,
  );
  totalOrders += plan.transfers.length;

  // ---- 1. no order in the plan is administratively impossible --------------
  const impossible = plan.transfers.filter((t) => {
    const from = ctxByKey.get(t.fromFacilityId + '|' + t.drugId);
    const to = ctxByKey.get(t.toFacilityId + '|' + t.drugId);
    if (!from || !to) return false;
    return administrativeAdmissibility(from.facility, to.facility).status === 'refused';
  });
  check(`${d.name}: no order that no procedure permits`, impossible.length === 0,
    impossible.slice(0, 3).map((t) => `${t.fromFacilityId} -> ${t.toFacilityId}`).join('; '));

  // ---- 2. the recorded verdict agrees with a fresh one ---------------------
  const disagreeing = plan.transfers.filter((t) => {
    const from = ctxByKey.get(t.fromFacilityId + '|' + t.drugId);
    const to = ctxByKey.get(t.toFacilityId + '|' + t.drugId);
    if (!from || !to) return false;
    const fresh = administrativeAdmissibility(from.facility, to.facility);
    return fresh.status !== t.admissibility || fresh.escalateTo !== t.escalateTo;
  });
  check(
    `${d.name}: every order's recorded admissibility matches a fresh classification`,
    disagreeing.length === 0,
  );

  for (const t of plan.transfers) {
    byAdmissibility.set(t.admissibility, (byAdmissibility.get(t.admissibility) ?? 0) + 1);
  }

  // Every order says who has to sign it, in a field. A plan whose governance
  // lives only in prose is a plan whose governance is not machine-checkable.
  check(
    `${d.name}: every order carries an escalation route and a note`,
    plan.transfers.every(
      (t) =>
        t.admissibilityNote.length > 0 &&
        (t.admissibility === 'permitted' ? t.escalateTo === null : t.escalateTo !== null),
    ),
  );

  // ---- 3. the donor invariant, re-derived -----------------------------------
  const given = new Map<string, DonorAudit>();
  for (const t of plan.transfers) {
    const key = t.fromFacilityId + '|' + t.drugId;
    const ctx = ctxByKey.get(key);
    if (!ctx) continue;
    const entry = given.get(key) ?? { key, ctx, given: 0 };
    entry.given += t.quantity;
    given.set(key, entry);
  }

  let districtWorstAfter = 0;
  const breaches: string[] = [];
  for (const donor of given.values()) {
    auditedDonors++;

    // Redrawn from an independent seed, so a guardrail that only holds against
    // the planner's particular sample vector fails here. (It used to be redrawn
    // at the same seed "at a different simulation count", which returns the
    // identical numbers -- the audit was re-reading the planner's own dice.)
    const samples = leadTimeDemandSamples(
      donor.ctx.facility.id,
      donor.ctx.drug,
      donor.ctx.fit,
      donor.ctx.leadTimeDays,
      ASOF,
      AUDIT_SIMS,
      donor.ctx.forecast,
      AUDIT_SALT,
    );
    const before = stockoutProbabilityAt(samples, donor.ctx.risk.onHand);
    const after = stockoutProbabilityAt(samples, donor.ctx.risk.onHand - donor.given);
    const rise = after - before;

    if (after > districtWorstAfter) districtWorstAfter = after;
    if (after > worstAfter) {
      worstAfter = after;
      worstAfterLabel = `${donor.ctx.facility.name} / ${donor.ctx.drug.name}`;
    }
    if (rise > worstRise) {
      worstRise = rise;
      worstRiseLabel = `${donor.ctx.facility.name} / ${donor.ctx.drug.name}`;
    }

    // The audit redraws the distribution, so a donor sitting exactly on the
    // threshold can land a hair either side of it for sampling reasons alone.
    // One simulation step of tolerance, stated rather than hidden: anything
    // beyond that is the planner, not the dice.
    const tolerance = 1 / AUDIT_SIMS;
    if (after > DONOR_GUARDRAILS.maxDonorStockoutAfter + tolerance) {
      breaches.push(
        `${donor.ctx.facility.name}/${donor.ctx.drug.id}: gave ${donor.given} of ${donor.ctx.risk.onHand}, P(out) ${(before * 100).toFixed(1)}% -> ${(after * 100).toFixed(1)}%`,
      );
    } else if (rise > DONOR_GUARDRAILS.maxDonorStockoutRise + tolerance) {
      breaches.push(
        `${donor.ctx.facility.name}/${donor.ctx.drug.id}: P(out) rose ${(rise * 100).toFixed(1)} pp (cap ${(DONOR_GUARDRAILS.maxDonorStockoutRise * 100).toFixed(0)})`,
      );
    }

    // The two static caps, checked directly against what left the shelf.
    const fractionCap = donor.ctx.risk.onHand * DONOR_GUARDRAILS.maxDonorFraction;
    if (donor.given > Math.floor(fractionCap) + 1) {
      breaches.push(
        `${donor.ctx.facility.name}/${donor.ctx.drug.id}: gave ${donor.given}, fraction cap ${Math.floor(fractionCap)}`,
      );
    }
    const coverFloor =
      DONOR_GUARDRAILS.coverFloorDays[donor.ctx.drug.ved] *
      Math.max(0, donor.ctx.risk.forecastDailyDemand);
    if (donor.ctx.risk.onHand - donor.given < Math.floor(coverFloor) - 1) {
      breaches.push(
        `${donor.ctx.facility.name}/${donor.ctx.drug.id}: left ${donor.ctx.risk.onHand - donor.given}, cover floor ${Math.floor(coverFloor)}`,
      );
    }
  }

  check(
    `${d.name}: ${given.size} donors, worst post-donation P(out) ${(districtWorstAfter * 100).toFixed(1)}%`,
    breaches.length === 0,
    breaches.slice(0, 4).join('\n        '),
  );
}

// ---------------------------------------------------------------------------
// 4. Is the guardrail load-bearing? Re-plan one district with the caps lifted.
// ---------------------------------------------------------------------------
console.log('\nwhat the guardrail costs, and whether it binds');
{
  const d = sample[0];
  const nb = districtNeighbours(d.code, RADIUS_KM, MAX_NEIGHBOURS).map((n) => n.code);
  const own = buildDistrictState(d.code, { asOf: ASOF, simulations: SIMULATIONS });
  const neighbours = nb.flatMap((code) => buildDistrictState(code, { asOf: ASOF, simulations: SIMULATIONS }));
  const contexts = toTransferContexts([...own, ...neighbours]);

  const guarded = planRedistribution(
    contexts,
    { asOf: ASOF, simulations: PLAN_SIMS, eligibleReceiver: (c) => c.facility.districtCode === d.code },
    newPlannerState(),
  );

  /* Everything admitted, so the difference is the guardrail and nothing else. */
  const savedFraction = DONOR_GUARDRAILS.maxDonorFraction;
  const savedAfter = DONOR_GUARDRAILS.maxDonorStockoutAfter;
  const savedRise = DONOR_GUARDRAILS.maxDonorStockoutRise;
  const savedFloor = { ...DONOR_GUARDRAILS.coverFloorDays };
  DONOR_GUARDRAILS.maxDonorFraction = 1;
  DONOR_GUARDRAILS.maxDonorStockoutAfter = 1;
  DONOR_GUARDRAILS.maxDonorStockoutRise = 1;
  DONOR_GUARDRAILS.coverFloorDays.V = 0;
  DONOR_GUARDRAILS.coverFloorDays.E = 0;
  DONOR_GUARDRAILS.coverFloorDays.D = 0;

  const unguarded = planRedistribution(
    contexts,
    {
      asOf: ASOF,
      simulations: PLAN_SIMS,
      eligibleReceiver: (c) => c.facility.districtCode === d.code,
      // Admissibility off too, so this arm is the plan as it stood before WS6C.
      admissibility: () => ({
        status: 'permitted' as const,
        approvableByDistrict: true,
        escalateTo: null,
        note: '',
      }),
    },
    newPlannerState(),
  );

  DONOR_GUARDRAILS.maxDonorFraction = savedFraction;
  DONOR_GUARDRAILS.maxDonorStockoutAfter = savedAfter;
  DONOR_GUARDRAILS.maxDonorStockoutRise = savedRise;
  DONOR_GUARDRAILS.coverFloorDays.V = savedFloor.V;
  DONOR_GUARDRAILS.coverFloorDays.E = savedFloor.E;
  DONOR_GUARDRAILS.coverFloorDays.D = savedFloor.D;

  const ctxByKey = new Map<string, TransferContext>();
  for (const c of contexts) ctxByKey.set(c.facility.id + '|' + c.drug.id, c);

  /** Worst post-donation donor risk in a plan, measured the same way for both arms. */
  const worstOf = (transfers: typeof guarded.transfers) => {
    const given = new Map<string, { ctx: TransferContext; given: number }>();
    for (const t of transfers) {
      const key = t.fromFacilityId + '|' + t.drugId;
      const ctx = ctxByKey.get(key);
      if (!ctx) continue;
      const e = given.get(key) ?? { ctx, given: 0 };
      e.given += t.quantity;
      given.set(key, e);
    }
    let worst = 0;
    let overCap = 0;
    for (const e of given.values()) {
      const samples = leadTimeDemandSamples(
        e.ctx.facility.id, e.ctx.drug, e.ctx.fit, e.ctx.leadTimeDays, ASOF, AUDIT_SIMS, e.ctx.forecast, AUDIT_SALT,
      );
      const after = stockoutProbabilityAt(samples, e.ctx.risk.onHand - e.given);
      if (after > worst) worst = after;
      if (after > DONOR_GUARDRAILS.maxDonorStockoutAfter) overCap++;
    }
    return { donors: given.size, worst, overCap };
  };

  const g = worstOf(guarded.transfers);
  const u = worstOf(unguarded.transfers);
  costOfTheGuardrail = {
    district: d.name,
    guardedOrders: guarded.transfers.length,
    unguardedOrders: unguarded.transfers.length,
    guardedWorstDonorStockout: +g.worst.toFixed(4),
    unguardedWorstDonorStockout: +u.worst.toFixed(4),
  };
  console.log(
    `  ${d.name}: guarded ${guarded.transfers.length} orders, worst donor P(out) ${(g.worst * 100).toFixed(1)}%, ` +
      `${g.overCap} over the cap`,
  );
  console.log(
    `  ${d.name}: unguarded ${unguarded.transfers.length} orders, worst donor P(out) ${(u.worst * 100).toFixed(1)}%, ` +
      `${u.overCap} over the cap`,
  );
  check(
    'lifting the guardrails changes the plan -- it is load-bearing, not decorative',
    unguarded.transfers.length !== guarded.transfers.length || u.overCap > g.overCap || u.worst > g.worst + 1e-9,
    'the guardrail never bound on this district; check the sample or the caps',
  );
  check('the guarded plan leaves no donor over the cap', g.overCap === 0);
}

console.log('\n' + '-'.repeat(70));
console.log(
  `  ${totalOrders} orders across ${sample.length} district plans · ${auditedDonors} donor positions audited`,
);
console.log(
  `  worst post-donation donor P(out) ${(worstAfter * 100).toFixed(1)}% (${worstAfterLabel})`,
);
console.log(
  `  largest rise in a donor's P(out) ${(worstRise * 100).toFixed(1)} pp (${worstRiseLabel})`,
);
console.log(
  '  by admissibility: ' +
    [...byAdmissibility.entries()].map(([k, v]) => `${k} ${v}`).join(' · '),
);
console.log(
  failures === 0
    ? 'guardrails: every donor in every plan stayed inside its own limits'
    : `guardrails: ${failures} checks FAILED`,
);

/*
 * The artefact, so the README quotes a figure this script measured rather than
 * one a person remembered. `scripts/check-claims.mts` reads it back.
 */
if (jsonPath) {
  const out = resolve(process.cwd(), jsonPath);
  mkdirSync(dirname(out), { recursive: true });
  /*
   * The timestamp moves only when the measurement does. `npm test` runs this with
   * `--json`, and a suite that rewrote a committed file on every run left a
   * fresh clone dirty after its own gate -- one changed line, `measuredAt`, on a
   * measurement that was byte-identical. So an unchanged audit keeps the time it
   * was first measured, and `git status` after the gate means something again.
   */
  let previousAt: string | undefined;
  let previousBody: string | undefined;
  try {
    const prior = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    previousAt = typeof prior.measuredAt === 'string' ? prior.measuredAt : undefined;
    delete prior.measuredAt;
    previousBody = JSON.stringify(prior);
  } catch {
    // No prior artefact, or an unreadable one: this run's time is the right one.
  }
  const measured = {
        districts: sample.map((d) => d.name),
        guardrails: {
          maxDonorFraction: DONOR_GUARDRAILS.maxDonorFraction,
          coverFloorDays: DONOR_GUARDRAILS.coverFloorDays,
          maxDonorStockoutAfter: DONOR_GUARDRAILS.maxDonorStockoutAfter,
          maxDonorStockoutRise: DONOR_GUARDRAILS.maxDonorStockoutRise,
          enforcementMargin: DONOR_GUARDRAILS.enforcementMargin,
        },
        orders: totalOrders,
        donorsAudited: auditedDonors,
        worstDonorStockoutAfter: +worstAfter.toFixed(4),
        worstDonorStockoutAfterAt: worstAfterLabel,
        largestRisePp: +(worstRise * 100).toFixed(2),
        largestRiseAt: worstRiseLabel,
        byAdmissibility: Object.fromEntries(byAdmissibility),
        cost: costOfTheGuardrail,
        violations: failures,
        passed: failures === 0,
  };
  const unchanged = previousBody !== undefined && previousBody === JSON.stringify(measured);
  writeFileSync(
    out,
    JSON.stringify(
      { measuredAt: unchanged && previousAt ? previousAt : new Date().toISOString(), ...measured },
      null,
      1,
    ) + '\n',
  );
  console.log('  ' + (unchanged ? 'unchanged' : 'wrote'), jsonPath);
}

process.exit(failures === 0 ? 0 : 1);
