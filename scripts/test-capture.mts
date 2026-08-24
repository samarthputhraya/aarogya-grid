/**
 * Tests for the last-mile capture validation layer.
 * Run with:  npx tsx scripts/test-capture.mts
 *
 * No API key needed. The Gemini call is deliberately separated from the
 * validation logic, so everything that decides whether a number is allowed to
 * reach the ledger is a pure function and can be tested exhaustively.
 *
 * The cases below are the ones that matter: not "does it work when the model is
 * right", but "does it refuse when the model is wrong".
 */
import { draftFromVoiceReport, draftFromRegister, type Expectation } from '../src/lib/ai/stock-report';
import { geminiSchema, VoiceStockReport, RegisterExtraction, checkRegisterArithmetic } from '../src/lib/ai/schemas';
import { generateNetwork, DEMO_SCALE } from '../src/lib/sim/facilities';
import { DISTRICTS_BY_CODE } from '../src/lib/domain/geo';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail && !ok ? '  -> ' + detail : ''));
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. Gemini response schema generation ===');

const voiceSchema = geminiSchema(VoiceStockReport) as Record<string, unknown>;
const registerSchema = geminiSchema(RegisterExtraction) as Record<string, unknown>;
const asText = JSON.stringify(voiceSchema) + JSON.stringify(registerSchema);

check('voice schema is an object type', voiceSchema.type === 'object');
check('no $ref (Gemini does not follow them)', !asText.includes('"$ref"'));
check('no $schema keyword', !asText.includes('"$schema"'));
check('no additionalProperties', !asText.includes('"additionalProperties"'));
check('voice schema declares items array', JSON.stringify(voiceSchema).includes('"items"'));
check('register schema declares rows array', JSON.stringify(registerSchema).includes('"rows"'));

// ---------------------------------------------------------------------------
console.log('\n=== 2. Voice report validation (pure) ===');

const network = generateNetwork(DEMO_SCALE, [DISTRICTS_BY_CODE['DST-22-BASTAR']]);
const phc = network.find((f) => f.type === 'PHC')!;
const sc = network.find((f) => f.type === 'SC')!;

const expectations = new Map<string, Expectation>([
  ['PARA-500-TAB', { lastKnownOnHand: 1800, meanDailyDemand: 25 }],
  ['ORS-SACHET', { lastKnownOnHand: 300, meanDailyDemand: 9 }],
  ['ASV-POLY-10ML', { lastKnownOnHand: 6, meanDailyDemand: 0.02 }],
]);

// A clean, ordinary report -- should sail through untouched.
const clean = draftFromVoiceReport(
  {
    language: 'hi-IN',
    transcript: 'Paracetamol pachas bache hain, ORS ke sau packet hain',
    transcriptEnglish: 'Fifty paracetamol left, one hundred ORS packets',
    notes: '',
    items: [
      { spokenText: 'Paracetamol pachas bache hain', drugNameGuess: 'Paracetamol', strengthGuess: '500 mg', quantity: 50, unitGuess: 'tablets', kind: 'closing_balance', confidence: 0.95 },
      { spokenText: 'ORS ke sau packet', drugNameGuess: 'ORS', strengthGuess: '', quantity: 100, unitGuess: 'sachets', kind: 'closing_balance', confidence: 0.93 },
    ],
  },
  phc,
  expectations,
);
check('clean report resolves both items', clean.entries.every((e) => e.drug !== null));
check('clean report auto-accepts', clean.fullyAutomatic, JSON.stringify(clean.entries.map((e) => [e.drug?.id, e.status, e.flags.map((f) => f.code)])));
check('paracetamol maps correctly', clean.entries[0].drug?.id === 'PARA-500-TAB');
check('ORS maps correctly', clean.entries[1].drug?.id === 'ORS-SACHET');

// Implausible quantity -- an order-of-magnitude slip.
const implausible = draftFromVoiceReport(
  {
    language: 'en-IN', transcript: 'Paracetamol fifty thousand left', transcriptEnglish: '', notes: '',
    items: [{ spokenText: 'fifty thousand paracetamol', drugNameGuess: 'Paracetamol', strengthGuess: '', quantity: 50000, unitGuess: 'tablets', kind: 'closing_balance', confidence: 0.9 }],
  },
  phc,
  expectations,
);
check('implausible quantity is flagged', implausible.entries[0].flags.some((f) => f.code === 'implausible_quantity'));
check('implausible quantity blocks auto-accept', implausible.entries[0].status === 'needs_confirmation');

// Container units must never be silently converted.
const strips = draftFromVoiceReport(
  {
    language: 'en-IN', transcript: 'three strips of paracetamol', transcriptEnglish: '', notes: '',
    items: [{ spokenText: 'three strips of paracetamol', drugNameGuess: 'Paracetamol', strengthGuess: '', quantity: 3, unitGuess: 'strips', kind: 'closing_balance', confidence: 0.92 }],
  },
  phc,
  expectations,
);
check('strip/tablet unit mismatch is flagged', strips.entries[0].flags.some((f) => f.code === 'unit_mismatch'));
check('unit mismatch requires confirmation', strips.entries[0].status === 'needs_confirmation');

// Negative quantity must be refused outright.
const negative = draftFromVoiceReport(
  {
    language: 'en-IN', transcript: 'minus ten', transcriptEnglish: '', notes: '',
    items: [{ spokenText: 'minus ten paracetamol', drugNameGuess: 'Paracetamol', strengthGuess: '', quantity: -10, unitGuess: 'tablets', kind: 'closing_balance', confidence: 0.9 }],
  },
  phc, expectations,
);
check('negative quantity is REJECTED', negative.entries[0].status === 'rejected');

// A drug the facility does not stock.
const outOfFormulary = draftFromVoiceReport(
  {
    language: 'en-IN', transcript: 'ceftriaxone twenty vials', transcriptEnglish: '', notes: '',
    items: [{ spokenText: 'ceftriaxone twenty vials', drugNameGuess: 'Ceftriaxone', strengthGuess: '1 g', quantity: 20, unitGuess: 'vials', kind: 'closing_balance', confidence: 0.95 }],
  },
  sc, expectations,
);
check('sub-centre rejects a drug outside its formulary', outOfFormulary.entries[0].status === 'rejected', 'got ' + outOfFormulary.entries[0].status + ' drug=' + outOfFormulary.entries[0].drug?.id);

// Low model confidence must surface even when the drug resolves cleanly.
const mumbled = draftFromVoiceReport(
  {
    language: 'hi-IN', transcript: '[inaudible] paracetamol', transcriptEnglish: '', notes: '',
    items: [{ spokenText: '[inaudible] paracetamol', drugNameGuess: 'Paracetamol', strengthGuess: '', quantity: 40, unitGuess: '', kind: 'closing_balance', confidence: 0.35 }],
  },
  phc, expectations,
);
check('low transcription confidence is flagged', mumbled.entries[0].flags.some((f) => f.code === 'low_model_confidence'));
check('low confidence requires confirmation', mumbled.entries[0].status === 'needs_confirmation');

// Nonsense drug name.
const nonsense = draftFromVoiceReport(
  {
    language: 'en-IN', transcript: 'zzzz forty', transcriptEnglish: '', notes: '',
    items: [{ spokenText: 'zzzz forty', drugNameGuess: 'zzzzqqq', strengthGuess: '', quantity: 40, unitGuess: '', kind: 'closing_balance', confidence: 0.8 }],
  },
  phc, expectations,
);
check('unresolvable drug is REJECTED', nonsense.entries[0].status === 'rejected');

// ---------------------------------------------------------------------------
console.log('\n=== 3. Register arithmetic ===');

const balanced = checkRegisterArithmetic({
  drugNameGuess: 'Paracetamol', strengthGuess: '500mg', openingBalance: 1000, received: 500,
  issued: 300, closingBalance: 1200, batchNo: 'B1', expiryAsWritten: '05/27', rowConfidence: 0.9,
});
check('balanced row is detected', balanced.balances && balanced.discrepancy === 0);

const unbalanced = checkRegisterArithmetic({
  drugNameGuess: 'Paracetamol', strengthGuess: '500mg', openingBalance: 1000, received: 500,
  issued: 300, closingBalance: 1150, batchNo: 'B1', expiryAsWritten: '05/27', rowConfidence: 0.9,
});
check('unbalanced row is detected', !unbalanced.balances);
check('discrepancy is computed correctly', unbalanced.discrepancy === -50, 'got ' + unbalanced.discrepancy);

const registerDraft = draftFromRegister(
  {
    facilityNameGuess: 'PHC Bastar', periodGuess: 'September 2026', warnings: [],
    rows: [
      { drugNameGuess: 'Paracetamol', strengthGuess: '500mg', openingBalance: 1000, received: 500, issued: 300, closingBalance: 1150, batchNo: 'B1', expiryAsWritten: '05/27', rowConfidence: 0.9 },
      { drugNameGuess: 'ORS', strengthGuess: '', openingBalance: 200, received: 100, issued: 80, closingBalance: 220, batchNo: 'B2', expiryAsWritten: '11/27', rowConfidence: 0.88 },
    ],
  },
  phc, expectations,
);
check('unbalanced register row is flagged', registerDraft.entries[0].flags.some((f) => f.code === 'register_arithmetic'));
check('balanced register row is not flagged', !registerDraft.entries[1].flags.some((f) => f.code === 'register_arithmetic'));
check('unbalanced row requires confirmation', registerDraft.entries[0].status === 'needs_confirmation');
check('register does not silently correct the ledger', registerDraft.entries[0].quantity === 1150);

console.log('\n' + '='.repeat(70));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
