import { z } from 'zod';

/**
 * Schemas for everything Gemini returns.
 *
 * TWO RULES THESE SCHEMAS ENFORCE
 * -------------------------------
 * 1. NO CATALOGUE IDs. Every drug field is `drugNameGuess` -- a natural-language
 *    name, as spoken or as written on the page. The model is never asked for an
 *    item code, because a model asked for a code will produce a well-formed one
 *    whether or not it exists. Mapping to real IDs happens in `resolve.ts`.
 *
 * 2. NO OPTIONAL FIELDS. Every property is required, with an empty string or a
 *    sentinel standing in for "absent". Optional properties are the single most
 *    common source of structured-output retries -- the model omits a key, the
 *    parse fails, and we burn a round trip. Requiring everything and accepting
 *    "" costs nothing and removes that failure mode entirely.
 */

/** What kind of number the health worker just gave us. */
export const StockEntryKind = z.enum([
  'closing_balance', // "we have 50 left"  -- the common case
  'received', // "we got 200 yesterday"
  'issued', // "we gave out 30 today"
  'expired', // "40 expired last month"
  'unknown',
]);
export type StockEntryKind = z.infer<typeof StockEntryKind>;

export const SpokenStockItem = z.object({
  /** The phrase this item came from, verbatim, for the audit trail. */
  spokenText: z.string(),
  /** Normalised English drug name. NEVER a catalogue code. */
  drugNameGuess: z.string(),
  /** Strength if stated, e.g. "500 mg". Empty string if not stated. */
  strengthGuess: z.string(),
  quantity: z.number(),
  /** Unit as spoken -- "tablets", "vials", "strips". Empty if not stated. */
  unitGuess: z.string(),
  kind: StockEntryKind,
  /** The model's own confidence that it heard this item correctly, 0..1. */
  confidence: z.number().min(0).max(1),
});
export type SpokenStockItem = z.infer<typeof SpokenStockItem>;

export const VoiceStockReport = z.object({
  /** BCP-47-ish tag the speaker used, e.g. "hi-IN", "mr-IN", "en-IN". */
  language: z.string(),
  /** Verbatim transcript in the original language. */
  transcript: z.string(),
  /** English translation of the transcript. Empty if already English. */
  transcriptEnglish: z.string(),
  items: z.array(SpokenStockItem),
  /** Anything the worker said that is not a stock figure but matters. */
  notes: z.string(),
});
export type VoiceStockReport = z.infer<typeof VoiceStockReport>;

/**
 * One row of a paper stock register.
 *
 * Indian PHCs keep these by hand, in a ruled ledger, with columns for opening
 * balance, receipts, issues and closing balance. The arithmetic is done by hand
 * and does not always balance -- which is a finding worth surfacing, not an
 * error to paper over. See `checkRegisterArithmetic`.
 */
export const RegisterRow = z.object({
  drugNameGuess: z.string(),
  strengthGuess: z.string(),
  openingBalance: z.number(),
  received: z.number(),
  issued: z.number(),
  closingBalance: z.number(),
  batchNo: z.string(),
  /** As written on the page -- often "05/27" or "MAY 2027" rather than ISO. */
  expiryAsWritten: z.string(),
  /** 0..1. Low values mean smudged, overwritten, or ambiguous handwriting. */
  rowConfidence: z.number().min(0).max(1),
});
export type RegisterRow = z.infer<typeof RegisterRow>;

export const RegisterExtraction = z.object({
  facilityNameGuess: z.string(),
  /** Reporting period as written, e.g. "September 2026". */
  periodGuess: z.string(),
  rows: z.array(RegisterRow),
  /** Legibility or layout problems the model noticed. */
  warnings: z.array(z.string()),
});
export type RegisterExtraction = z.infer<typeof RegisterExtraction>;

/**
 * Convert a Zod schema into the JSON Schema Gemini accepts.
 *
 * `io: 'output'` describes what the model should PRODUCE, and inlining reused
 * definitions matters because Gemini's schema support does not follow `$ref`.
 */
export function geminiSchema(schema: z.ZodType): unknown {
  const json = z.toJSONSchema(schema, { io: 'output', reused: 'inline' }) as Record<string, unknown>;
  return stripUnsupported(json);
}

/**
 * Remove JSON Schema keywords Gemini rejects.
 *
 * The API validates the schema it is handed and errors on vocabulary it does
 * not implement, so a stray `$schema` or `additionalProperties` fails the whole
 * request rather than being ignored.
 */
function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node === null || typeof node !== 'object') return node;

  const DROP = new Set([
    '$schema',
    '$id',
    'additionalProperties',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'const',
    'default',
  ]);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (DROP.has(key)) continue;
    out[key] = stripUnsupported(value);
  }
  return out;
}

/**
 * Check that a register row balances: opening + received - issued = closing.
 *
 * Hand-kept ledgers frequently do not. Rather than silently trusting the
 * closing balance (or silently trusting the arithmetic), we surface the
 * discrepancy so a human decides which number is right. A supply chain built on
 * quietly-corrected numbers is worse than one that admits what it does not know.
 */
export function checkRegisterArithmetic(row: RegisterRow): {
  balances: boolean;
  expectedClosing: number;
  discrepancy: number;
} {
  const expectedClosing = row.openingBalance + row.received - row.issued;
  const discrepancy = row.closingBalance - expectedClosing;
  return { balances: discrepancy === 0, expectedClosing, discrepancy };
}
