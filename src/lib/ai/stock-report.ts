import type { Facility } from '@/lib/domain/types';
import { formularyFor, type CatalogueDrug } from '@/lib/domain/drugs';
import { resolveWithinFormulary, normalise, AUTO_ACCEPT, type ResolutionResult } from './resolve';
import {
  VoiceStockReport,
  RegisterExtraction,
  geminiSchema,
  checkRegisterArithmetic,
  type SpokenStockItem,
  type StockEntryKind,
  type RegisterRow,
} from './schemas';
import { generateStructured, fastModelId } from './client';

/**
 * Last-mile stock capture.
 *
 * WHY THIS IS THE HARD PART
 * -------------------------
 * The reason India's PHC stock data is thin is not that nobody built a
 * dashboard. It is that the person who knows the number -- an ANM at a
 * sub-centre, with a paper register and a feature phone, already doing six
 * other jobs -- has no way to get it into a system that is faster than not
 * doing it. Every dashboard built on top of that gap inherits the gap.
 *
 * So this module attacks data GENESIS, not data presentation. Speak the numbers
 * in your own language, or photograph the register page you already fill in by
 * hand, and the structuring happens on our side.
 *
 * THE SAFETY MODEL
 * ----------------
 * A model transcribing "pachas" as 50 is fine. A model transcribing it as 500
 * and silently writing that to a national ledger is not. So extraction is
 * split from commitment:
 *
 *   extract*   -- talks to Gemini, returns raw understanding. Impure.
 *   draft*     -- resolves, validates, flags. PURE, fully unit-testable.
 *   (the UI)   -- shows every flagged item to a human before anything commits.
 *
 * Nothing reaches the ledger without passing `draft*`, and anything the draft
 * marks `needs_confirmation` or `rejected` requires a human decision.
 */

export type FlagCode =
  | 'low_model_confidence'
  | 'unresolved_drug'
  | 'ambiguous_drug'
  | 'not_in_formulary'
  | 'negative_quantity'
  | 'implausible_quantity'
  | 'unverifiable_quantity'
  | 'inferred_zero'
  | 'unit_mismatch'
  | 'register_arithmetic';

export interface Flag {
  code: FlagCode;
  message: string;
  /** `block` prevents commitment outright; `warn` requires confirmation. */
  severity: 'info' | 'warn' | 'block';
}

export interface DraftEntry {
  spokenText: string;
  quantity: number;
  kind: StockEntryKind;
  unitGuess: string;
  modelConfidence: number;
  resolution: ResolutionResult;
  drug: CatalogueDrug | null;
  flags: Flag[];
  status: 'auto_accept' | 'needs_confirmation' | 'rejected';
}

export interface DraftStockReport {
  facilityId: string;
  entries: DraftEntry[];
  language: string;
  transcript: string;
  transcriptEnglish: string;
  notes: string;
  /** True when every entry auto-accepted -- the UI can commit without prompting. */
  fullyAutomatic: boolean;
}

/**
 * What we already believe about a facility's position, used to sanity-check
 * what was just reported. Supplied by the caller from the pipeline.
 */
export interface Expectation {
  /** Last known on-hand quantity. */
  lastKnownOnHand: number;
  /** Fitted mean daily demand, for days-of-cover plausibility. */
  meanDailyDemand: number;
}

/** Units that are containers of other units -- these need an explicit conversion. */
const CONTAINER_UNITS = ['strip', 'strips', 'box', 'boxes', 'carton', 'cartons', 'packet', 'packets'];

/**
 * Kinds whose quantity is, or may be, an on-hand position.
 *
 * `unknown` is in this set deliberately. It is what the model returns when it
 * could not tell a balance from a receipt -- precisely when a number deserves
 * MORE scrutiny, not less.
 */
const POSITION_KINDS: ReadonlySet<StockEntryKind> = new Set<StockEntryKind>([
  'closing_balance',
  'unknown',
]);

/** Phrases that state a quantity of ZERO. Small and high-confidence on purpose. */
const STOCK_OUT_CUES = [
  'khatam ho gaya', 'khatam', 'khatm', 'samapt', 'sampla', 'sampat',
  'out of stock', 'stock out', 'stockout', 'no stock', 'nil stock', 'nil balance', 'nil',
  'nothing left', 'none left', 'not available', 'finished', 'exhausted',
  'zero', 'shunya', 'sunya', 'nahi hai', 'nahin hai', 'nahi bacha',
];

/** Words carrying no drug identity, stripped before resolving a zero clause. */
const ZERO_CLAUSE_FILLER = new Set([
  'ho', 'gaya', 'gayi', 'gaye', 'hai', 'hain', 'tha', 'thi', 'the', 'aahe', 'ahe',
  'bilkul', 'ekdam', 'poora', 'puri', 'ab', 'aur', 'ani', 'ka', 'ke', 'ki', 'se',
  'mein', 'me', 'is', 'was', 'are', 'we', 'have', 'has', 'no', 'not', 'any', 'all',
  'left', 'since', 'a', 'an', 'of', 'our', 'and', 'completely', 'totally', 'more',
  'ho', 'gone',
]);

/**
 * Validate and resolve one spoken item. Pure.
 */
function draftEntry(
  item: SpokenStockItem,
  formulary: CatalogueDrug[],
  expectations: Map<string, Expectation>,
): DraftEntry {
  const flags: Flag[] = [];
  const resolution = resolveWithinFormulary(
    item.drugNameGuess || item.spokenText,
    formulary,
  );
  const drug = resolution.best?.drug ?? null;

  if (!drug) {
    flags.push({
      code: 'unresolved_drug',
      message: `Could not match "${item.drugNameGuess || item.spokenText}" to any item this facility stocks.`,
      severity: 'block',
    });
  } else {
    if (resolution.alternatives.length > 0 &&
        resolution.best!.confidence - resolution.alternatives[0].confidence < 0.08) {
      flags.push({
        code: 'ambiguous_drug',
        message:
          `Could be ${drug.name} or ${resolution.alternatives[0].drug.name} -- ` +
          `too close to call automatically.`,
        severity: 'warn',
      });
    }
    if (resolution.best!.confidence < AUTO_ACCEPT) {
      flags.push({
        code: 'unresolved_drug',
        message: `Best match ${drug.name} is only ${(resolution.best!.confidence * 100).toFixed(0)}% confident.`,
        severity: 'warn',
      });
    }
  }

  if (item.confidence < 0.6) {
    flags.push({
      code: 'low_model_confidence',
      message: `Transcription confidence for this item was ${(item.confidence * 100).toFixed(0)}%.`,
      severity: 'warn',
    });
  }

  if (item.quantity < 0) {
    flags.push({
      code: 'negative_quantity',
      message: 'Quantity is negative.',
      severity: 'block',
    });
  }

  // Unit mismatch: "three strips" is not three tablets. We refuse to assume a
  // conversion factor -- pack sizes vary by supplier and guessing wrong is a
  // 10x error in a stock figure.
  const spokenUnit = item.unitGuess.trim().toLowerCase();
  if (drug && spokenUnit && CONTAINER_UNITS.includes(spokenUnit) && spokenUnit !== drug.unit) {
    flags.push({
      code: 'unit_mismatch',
      message:
        `Reported in "${item.unitGuess}" but ${drug.name} is tracked in ${drug.unit}s. ` +
        `Pack size must be confirmed -- we will not assume one.`,
      severity: 'warn',
    });
  }

  // Plausibility, expressed in days of cover rather than raw magnitude, so the
  // check means the same thing for paracetamol and for antivenom.
  if (drug && POSITION_KINDS.has(item.kind)) {
    const exp = expectations.get(drug.id);
    if (exp && exp.meanDailyDemand > 0) {
      const impliedCover = item.quantity / exp.meanDailyDemand;
      if (impliedCover > 400) {
        flags.push({
          code: 'implausible_quantity',
          message:
            `${item.quantity} ${drug.unit}s implies ${Math.round(impliedCover)} days of cover ` +
            `at this facility's usual consumption. Please confirm.`,
          severity: 'warn',
        });
      }
    }

    // The jump check needs only `lastKnownOnHand`. Nesting it under
    // `meanDailyDemand > 0` disabled it for every item whose fitted demand is
    // zero -- Anti-Snake Venom among them (fitted demand 0.000, last known on
    // hand 1), so 5,000 vials auto-accepted with no flag at all.
    if (exp && exp.lastKnownOnHand > 0 && item.quantity > exp.lastKnownOnHand * 25) {
      flags.push({
        code: 'implausible_quantity',
        message:
          `Jump from ${exp.lastKnownOnHand} to ${item.quantity} ${drug.unit}s since the last report. ` +
          `Confirm this is not a decimal-point or unit error.`,
        severity: 'warn',
      });
    }

    // No baseline means no basis to judge the number -- and `no basis to
    // judge` must not read as `fine`.
    if (!exp) {
      flags.push({
        code: 'unverifiable_quantity',
        message:
          `No consumption baseline for ${drug.name} at this facility, so ${item.quantity} ` +
          `${drug.unit}s could not be sanity-checked. Confirm it by eye.`,
        severity: 'warn',
      });
    }
  }

  const blocked = flags.some((f) => f.severity === 'block');
  const warned = flags.some((f) => f.severity === 'warn');

  return {
    spokenText: item.spokenText,
    quantity: item.quantity,
    kind: item.kind,
    unitGuess: item.unitGuess,
    modelConfidence: item.confidence,
    resolution,
    drug,
    flags,
    status: blocked ? 'rejected' : warned ? 'needs_confirmation' : 'auto_accept',
  };
}

/**
 * Turn a raw voice extraction into a validated draft. PURE -- no network, no
 * clock, no randomness. This is the function the tests exercise.
 */
export function draftFromVoiceReport(
  report: VoiceStockReport,
  facility: Facility,
  expectations: Map<string, Expectation> = new Map(),
): DraftStockReport {
  const formulary = formularyFor(facility.type);
  const entries = report.items.map((i) => draftEntry(i, formulary, expectations));
  entries.push(...recoverStockOuts(report, entries, formulary, expectations));

  return {
    facilityId: facility.id,
    entries,
    language: report.language,
    transcript: report.transcript,
    transcriptEnglish: report.transcriptEnglish,
    notes: report.notes,
    fullyAutomatic: entries.length > 0 && entries.every((e) => e.status === 'auto_accept'),
  };
}

/**
 * Recover verbal zeros that arrived as prose instead of as a figure.
 *
 * Zero is the most consequential number in this system -- it is the one that
 * triggers resupply -- and the one least likely to be spoken as a number. A
 * health worker does not say "anti-snake venom, zero vials"; she says "saap
 * kaatne ka injection khatam ho gaya". Told to put anything that is not a stock
 * figure into notes, the model filed the stock-out as prose, and the report that
 * mattered most produced no structured entries at all.
 *
 * The prompt now states that a stock-out IS a figure. This is the net underneath
 * that instruction, because a prompt is not a guarantee.
 *
 * SAFETY: a zero recovered from prose is an INFERENCE, not a transcription, so it
 * never auto-accepts, and it never overrides the model -- a drug the model already
 * reported a figure for is skipped. Pure.
 */
function recoverStockOuts(
  report: VoiceStockReport,
  existing: DraftEntry[],
  formulary: CatalogueDrug[],
  expectations: Map<string, Expectation>,
): DraftEntry[] {
  const already = new Set(
    existing.map((e) => e.drug?.id).filter((id): id is string => Boolean(id)),
  );
  const recovered: DraftEntry[] = [];

  const clauses = [report.notes, report.transcriptEnglish, report.transcript]
    .filter(Boolean)
    .join(' . ')
    .split(/[.!?;\n,]+/)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const clause of clauses) {
    const padded = ' ' + normalise(clause) + ' ';
    if (!STOCK_OUT_CUES.some((cue) => padded.includes(' ' + cue + ' '))) continue;

    let stripped = padded;
    for (const cue of STOCK_OUT_CUES) {
      stripped = stripped.split(' ' + cue + ' ').join(' ');
    }
    const query = stripped
      .split(' ')
      .filter((t) => t && !ZERO_CLAUSE_FILLER.has(t))
      .join(' ')
      .trim();
    if (!query) continue;

    const resolution = resolveWithinFormulary(query, formulary);
    // Strict: an inferred entry takes the auto-accept bar as its FLOOR, because a
    // wrong drug here invents a stock-out that was never reported.
    if (!resolution.best || resolution.best.confidence < AUTO_ACCEPT) continue;
    if (already.has(resolution.best.drug.id)) continue;
    already.add(resolution.best.drug.id);

    const entry = draftEntry(
      {
        spokenText: clause,
        drugNameGuess: query,
        strengthGuess: '',
        quantity: 0,
        unitGuess: '',
        kind: 'closing_balance',
        // Not a transcription confidence -- nothing was mis-heard. The
        // `inferred_zero` flag states the provenance; 0.6 keeps this from also
        // tripping the low-confidence flag and saying the same thing twice.
        confidence: 0.6,
      },
      formulary,
      expectations,
    );

    entry.flags.push({
      code: 'inferred_zero',
      message:
        `Reported as a stock-out in words, not as a figure ("${clause}"). ` +
        `Recorded as 0 ${entry.drug ? entry.drug.unit : 'unit'}s on hand -- confirm before committing.`,
      severity: 'warn',
    });
    if (entry.status !== 'rejected') entry.status = 'needs_confirmation';
    recovered.push(entry);
  }

  return recovered;
}

/** Turn a register OCR extraction into a validated draft. PURE. */
export function draftFromRegister(
  extraction: RegisterExtraction,
  facility: Facility,
  expectations: Map<string, Expectation> = new Map(),
): DraftStockReport {
  const formulary = formularyFor(facility.type);

  const entries = extraction.rows.map((row: RegisterRow) => {
    const entry = draftEntry(
      {
        spokenText: `${row.drugNameGuess} ${row.strengthGuess} (batch ${row.batchNo || 'n/a'})`.trim(),
        drugNameGuess: row.drugNameGuess,
        strengthGuess: row.strengthGuess,
        quantity: row.closingBalance,
        unitGuess: '',
        kind: 'closing_balance',
        confidence: row.rowConfidence,
      },
      formulary,
      expectations,
    );

    // A hand-kept ledger that does not add up is a real finding. Surface it
    // rather than trusting either number.
    const arithmetic = checkRegisterArithmetic(row);
    if (!arithmetic.balances) {
      entry.flags.push({
        code: 'register_arithmetic',
        message:
          `Register does not balance: ${row.openingBalance} opening + ${row.received} received ` +
          `- ${row.issued} issued = ${arithmetic.expectedClosing}, but closing is written as ` +
          `${row.closingBalance} (off by ${arithmetic.discrepancy > 0 ? '+' : ''}${arithmetic.discrepancy}).`,
        severity: 'warn',
      });
      if (entry.status === 'auto_accept') entry.status = 'needs_confirmation';
    }

    return entry;
  });

  return {
    facilityId: facility.id,
    entries,
    language: 'en',
    transcript: '',
    transcriptEnglish: '',
    notes: extraction.warnings.join(' '),
    fullyAutomatic: entries.length > 0 && entries.every((e) => e.status === 'auto_accept'),
  };
}

// ---------------------------------------------------------------------------
// Gemini calls (impure)
// ---------------------------------------------------------------------------

const VOICE_SYSTEM_PROMPT = `You transcribe and structure spoken medicine stock reports from health workers at Indian primary health facilities.

The speaker is typically an ANM, pharmacist, or PHC medical officer. They may speak Hindi, Marathi, Bengali, Tamil, Telugu, Kannada, Odia, Assamese, Gujarati, Punjabi, Malayalam, or Indian English, and will often mix English drug names into a regional-language sentence. That is normal, not an error.

Your job:
1. Transcribe VERBATIM in the original language.
2. Translate to English.
3. Extract every stock figure mentioned.

Rules that matter:
- Return drug names as ORDINARY NAMES, exactly as said plus a normalised English form. NEVER invent or return an item code, SKU, or ID. A separate system does the code mapping.
- Indian number words are common: "pachas" 50, "sau" 100, "dedh sau" 150, "do sau" 200, "hazaar" 1000, "dhai hazaar" 2500, "lakh" 100000. Convert them to digits.
- Distinguish what KIND of number it is. "50 bache hain" / "50 left" is a closing_balance. "200 aaye" / "we received 200" is received. "30 diye" / "gave out 30" is issued. If genuinely unclear, use unknown and lower the confidence.
- If a quantity is inaudible, garbled, or you are guessing, set confidence below 0.5. An honest low confidence is far more useful than a confident guess, because low-confidence items get shown to a human and confident wrong ones do not.
- Capture the unit as spoken ("tablets", "strips", "vials", "bottles"). Do NOT convert strips to tablets.
- A STOCK-OUT IS A STOCK FIGURE, and it is the most important one. "khatam ho gaya", "finished", "nil", "stock out", "nahi hai", "sampla", "zero", "we have none" all mean quantity 0 with kind closing_balance. Emit an item for it, exactly as you would for "pachas bache hain". NEVER leave a stock-out in notes alone: a zero that lands in notes never reaches the ledger, and zero is the number that triggers resupply.
- Put anything said that is not a stock figure -- a broken fridge, a delayed vehicle, an expiry concern -- into notes.`;

const REGISTER_SYSTEM_PROMPT = `You read photographs of handwritten medicine stock registers from Indian primary health facilities.

These are ruled paper ledgers, typically with columns for the medicine name, batch number, expiry, opening balance, quantity received, quantity issued, and closing balance. Handwriting quality varies enormously and pages are often smudged, faded, or photographed at an angle.

Your job is to extract each row as structured data.

Rules that matter:
- Return drug names as ORDINARY NAMES exactly as written. NEVER invent an item code or ID.
- Transcribe numbers as written. Do NOT correct the arithmetic even when a row clearly does not add up -- a separate check handles that, and silently "fixing" a ledger destroys the evidence that it was wrong.
- Copy expiry dates in the format written on the page ("05/27", "MAY 2027", "05-2027"). Do not normalise them.
- Set rowConfidence below 0.5 for any row that is smudged, overwritten, ambiguous, or partially cut off.
- Skip header rows, totals rows, and blank rows.
- Record legibility problems, cut-off columns, or skewed pages in warnings.`;

export interface InlineMedia {
  mimeType: string;
  /** Base64-encoded, without the data: URI prefix. */
  data: string;
}

/** Extract a stock report from audio, or from an already-typed transcript. */
export async function extractVoiceReport(
  input: { audio: InlineMedia } | { text: string },
  opts: { model?: string } = {},
): Promise<VoiceStockReport> {
  const parts: unknown[] =
    'audio' in input
      ? [
          { text: 'Transcribe and structure this stock report.' },
          { inlineData: { mimeType: input.audio.mimeType, data: input.audio.data } },
        ]
      : [{ text: 'Structure this stock report:\n\n' + input.text }];

  return generateStructured(
    [{ role: 'user', parts }],
    VoiceStockReport,
    {
      model: opts.model ?? fastModelId(),
      systemInstruction: VOICE_SYSTEM_PROMPT,
      responseSchema: geminiSchema(VoiceStockReport),
      temperature: 0,
    },
  );
}

/** Extract rows from a photograph of a paper stock register. */
export async function extractRegister(
  image: InlineMedia,
  opts: { model?: string } = {},
): Promise<RegisterExtraction> {
  return generateStructured(
    [
      {
        role: 'user',
        parts: [
          { text: 'Extract every stock row from this register page.' },
          { inlineData: { mimeType: image.mimeType, data: image.data } },
        ],
      },
    ],
    RegisterExtraction,
    {
      // Register OCR is the harder task -- handwriting, skew, faded ink -- so it
      // gets the stronger model rather than the fast one.
      model: opts.model,
      systemInstruction: REGISTER_SYSTEM_PROMPT,
      responseSchema: geminiSchema(RegisterExtraction),
      temperature: 0,
    },
  );
}
