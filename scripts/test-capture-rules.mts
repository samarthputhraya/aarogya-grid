/**
 * Harness for the capture DRAFTING RULES.
 * Run with:  npx tsx scripts/test-capture-rules.mts
 *
 * Distinct from `scripts/test-capture.mts`, which calls Gemini and therefore
 * needs a backend, costs money, and cannot run in CI. Everything asserted here
 * is pure: `draftFromVoiceReport` takes a model's already-extracted report and
 * decides what to flag, what to auto-accept, and what a human must confirm.
 * That decision layer is the safety-critical half and it deserves tests that
 * run every time.
 *
 * WHY THESE CASES
 * ---------------
 * Two live defects sat in this layer, both of which passed the existing tests:
 *
 *   BUG A -- a verbal zero never became an entry. A health worker does not say
 *   "anti-snake venom, zero vials"; she says "saap kaatne ka injection khatam
 *   ho gaya", and the model, told to put anything that is not a stock figure in
 *   notes, filed the stock-out as prose. Zero is the number that triggers
 *   resupply, so the single most consequential report produced no entries at
 *   all -- and it is the exact anecdote the README opens with.
 *
 *   BUG B -- the plausibility guard was gated on `kind === 'closing_balance'`,
 *   but the model usually returns `unknown`, so "paanch hazaar cetirizine"
 *   auto-accepted 5,000 units with no flag while the README claimed implausible
 *   quantities were flagged. `test-capture.mts` passed only because its fixture
 *   hardcodes the right `kind`. A fixture that supplies the condition under
 *   test is not a test.
 *
 * The regression cases matter as much as the bug cases: a guard that flags
 * everything is the same failure as a guard that flags nothing, one review
 * queue later. B4-B6 and A4-A7 exist to keep the fix narrow.
 */
import { draftFromVoiceReport, type Expectation } from '../src/lib/ai/stock-report';
import type { StockEntryKind } from '../src/lib/ai/schemas';
import { generateNetwork, DEMO_SCALE } from '../src/lib/sim/facilities';
import { DISTRICTS_BY_CODE } from '../src/lib/domain/geo';
import { expectationsFor } from '../src/lib/facility-lookup';

const network = generateNetwork(DEMO_SCALE, [DISTRICTS_BY_CODE['DST-22-BASTAR']]);
const phc = network.find((f) => f.type === 'PHC')!;
const asOf = new Date(Date.UTC(2026, 8, 30));
const real = expectationsFor(phc, asOf);

/** A facility with no baseline for Cetirizine, to exercise the unverifiable path. */
const sparse = new Map<string, Expectation>([
  ['PARA-500-TAB', { lastKnownOnHand: 1800, meanDailyDemand: 25 }],
  ['ORS-SACHET', { lastKnownOnHand: 300, meanDailyDemand: 9 }],
  ['ASV-POLY-10ML', { lastKnownOnHand: 6, meanDailyDemand: 0.02 }],
]);

function item(
  name: string,
  quantity: number,
  kind: StockEntryKind,
  confidence = 0.9,
  unitGuess = '',
) {
  return { spokenText: name, drugNameGuess: name, strengthGuess: '', quantity, unitGuess, kind, confidence };
}

type Report = Parameters<typeof draftFromVoiceReport>[0];
function report(partial: Partial<Report>): Report {
  return {
    language: 'en',
    transcript: '',
    transcriptEnglish: '',
    notes: '',
    items: [],
    ...partial,
  } as Report;
}

const checks: [string, boolean][] = [];
function check(name: string, ok: boolean) {
  checks.push([name, ok]);
}

const draft = (r: Partial<Report>, exp = real) => draftFromVoiceReport(report(r), phc, exp);
const codes = (d: ReturnType<typeof draftFromVoiceReport>, drugId: string) =>
  d.entries.find((e) => e.drug?.id === drugId)?.flags.map((f) => f.code) ?? [];
const entryFor = (d: ReturnType<typeof draftFromVoiceReport>, drugId: string) =>
  d.entries.find((e) => e.drug?.id === drugId);

console.log('Aarogya Grid -- capture drafting rules');

// ---------------------------------------------------------------------------
// BUG B -- the plausibility guard must not depend on the model naming the kind
// ---------------------------------------------------------------------------
{
  const d = draft({ transcript: 'paanch hazaar cetirizine', items: [item('Cetirizine', 5000, 'unknown')] });
  check('B1 kind=unknown still reaches the plausibility guard', codes(d, 'CETIRIZINE-10').includes('implausible_quantity'));
  check('B1 an implausible quantity is not auto-accepted', entryFor(d, 'CETIRIZINE-10')?.status === 'needs_confirmation');
  check('B1 the report as a whole is not fully automatic', d.fullyAutomatic === false);
}
{
  const d = draft({ items: [item('Cetirizine', 5000, 'unknown')] }, sparse);
  check('B2 no baseline is reported as unverifiable, not as fine', codes(d, 'CETIRIZINE-10').includes('unverifiable_quantity'));
  check('B2 an unverifiable quantity still needs a human', entryFor(d, 'CETIRIZINE-10')?.status === 'needs_confirmation');
}
{
  // Anti-Snake Venom has a fitted demand of zero at this facility, so the jump
  // check -- which needs only `lastKnownOnHand` -- was unreachable while it sat
  // nested under `meanDailyDemand > 0`.
  const d = draft({ items: [item('anti snake venom', 5000, 'closing_balance')] });
  check('B3 the jump check fires for a drug with zero fitted demand', codes(d, 'ASV-POLY-10ML').includes('implausible_quantity'));
}
{
  const d = draft({ items: [item('Paracetamol', 50, 'closing_balance', 0.95, 'tablets')] });
  check('B4 REGRESSION a normal closing balance still auto-accepts', d.fullyAutomatic === true && codes(d, 'PARA-500-TAB').length === 0);
}
{
  const d = draft({ items: [item('Paracetamol', 200, 'received', 0.95, 'tablets')] });
  check('B5 REGRESSION a receipt is not judged as a position', d.fullyAutomatic === true);
}
{
  const d = draft({ items: [item('Paracetamol', 30, 'issued', 0.95, 'tablets')] });
  check('B6 REGRESSION an issue is not judged as a position', d.fullyAutomatic === true);
}

// ---------------------------------------------------------------------------
// BUG A -- a stock-out spoken in words must still become a zero entry
// ---------------------------------------------------------------------------
{
  const d = draft({
    language: 'hi-IN',
    transcript: 'Saap kaatne ka injection khatam ho gaya hai',
    transcriptEnglish: 'The snake bite injection is finished',
    notes: 'The anti-snake venom is finished.',
  });
  const e = entryFor(d, 'ASV-POLY-10ML');
  check('A1 the README anecdote produces an entry at all', e !== undefined);
  check('A1 the recovered entry is a zero', e?.quantity === 0);
  check('A1 the recovered entry is a closing balance', e?.kind === 'closing_balance');
  check('A1 an inferred zero is labelled as inferred', codes(d, 'ASV-POLY-10ML').includes('inferred_zero'));
  check('A1 an inferred zero NEVER auto-accepts', e?.status === 'needs_confirmation');
}
{
  const d = draft({
    language: 'hi-IN',
    transcript:
      'Aaj paracetamol pachas tablet bache hain, ORS ke sau packet hain, aur lal goli do sau. ' +
      'Anti snake venom bilkul khatam ho gaya hai, monsoon mein zaroorat padegi.',
    transcriptEnglish:
      'Fifty paracetamol tablets left, one hundred ORS packets, two hundred iron tablets. ' +
      'Anti snake venom is completely finished, it will be needed in the monsoon.',
    notes: 'Anti snake venom is completely finished and will be needed in the monsoon.',
    items: [
      item('Paracetamol', 50, 'closing_balance', 0.95, 'tablets'),
      item('ORS', 100, 'closing_balance', 0.93, 'packets'),
      item('lal goli', 200, 'closing_balance', 0.9, 'tablets'),
    ],
  });
  check('A2 the console sample recovers the stock-out alongside the spoken items', entryFor(d, 'ASV-POLY-10ML')?.quantity === 0);
  check('A2 the spoken items survive unchanged', entryFor(d, 'PARA-500-TAB')?.quantity === 50);
  check('A2 a colloquial name still resolves ("lal goli" -> iron-folic acid)', entryFor(d, 'IFA-ADULT-TAB')?.quantity === 200);
}
{
  const d = draft({
    notes: 'The refrigerator has been out of order for two days.',
    transcriptEnglish: 'One hundred fifty paracetamol tablets, forty ORS packets, and four oxytocin ampoules remain. The fridge has been off for two days.',
    items: [
      item('Paracetamol', 150, 'closing_balance', 0.95, 'tablets'),
      item('ORS', 40, 'closing_balance', 0.95, 'packets'),
      item('Oxytocin', 4, 'closing_balance', 0.93, 'ampoules'),
    ],
  });
  check('A4 REGRESSION a cold-chain note invents no stock-out', d.entries.every((e) => e.flags.every((f) => f.code !== 'inferred_zero')));
  check('A4 REGRESSION the spoken items are untouched', d.entries.length === 3);
}
{
  const d = draft({ notes: 'The supply vehicle is finished for the month and the cold chain is out of stock space.' });
  check('A5 REGRESSION "finished"/"out of stock" with no drug names invents nothing', d.entries.length === 0);
}
{
  const d = draft({
    transcript: 'saap kaatne ka injection khatam ho gaya',
    notes: 'anti snake venom is finished',
    items: [item('anti snake venom', 0, 'closing_balance', 0.9, 'vials')],
  });
  check('A6 a zero the model already reported is not duplicated', d.entries.filter((e) => e.drug?.id === 'ASV-POLY-10ML').length === 1);
  check('A6 the model\'s own zero is not downgraded by the recovery pass', entryFor(d, 'ASV-POLY-10ML')?.status === 'auto_accept');
}
{
  const d = draft({
    transcript: 'Paracetamol pachas bache hain, ORS ke sau packet hain',
    transcriptEnglish: 'Fifty paracetamol left, one hundred ORS packets',
    items: [
      item('Paracetamol', 50, 'closing_balance', 0.95, 'tablets'),
      item('ORS', 100, 'closing_balance', 0.93, 'sachets'),
    ],
  });
  check('A7 REGRESSION a clean report stays fully automatic', d.fullyAutomatic === true && d.entries.length === 2);
}

// ---------------------------------------------------------------------------
// Invariants that hold for every draft
// ---------------------------------------------------------------------------
{
  const d = draft({ items: [item('Paracetamol', -5, 'closing_balance', 0.95, 'tablets')] });
  check('a negative quantity is rejected outright', entryFor(d, 'PARA-500-TAB')?.status === 'rejected');
}
{
  const d = draft({ items: [item('Sildenafil', 10, 'closing_balance', 0.95, 'tablets')] });
  check('a drug outside the facility formulary is not silently accepted', d.fullyAutomatic === false);
}
{
  const d = draft({ notes: 'khatam ho gaya' });
  check('a stock-out cue with no drug at all is ignored', d.entries.length === 0);
}

// ---------------------------------------------------------------------------

console.log('\n--- checks ---');
let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  if (!ok) failed++;
}
console.log(
  failed === 0
    ? '\nAll ' + checks.length + ' checks passed.'
    : '\n' + failed + ' of ' + checks.length + ' check(s) FAILED.',
);
process.exit(failed === 0 ? 0 : 1);
