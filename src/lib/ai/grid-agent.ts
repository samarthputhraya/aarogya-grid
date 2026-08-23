import { FunctionCallingConfigMode, type Content, type Part } from '@google/genai';
import { z, type ZodType } from 'zod';
import { DISTRICTS_BY_CODE } from '@/lib/domain/geo';
import { AiValidationError, getClient, modelId, fastModelId } from './client';
import { geminiSchema } from './schemas';
import { normalise } from './resolve';
import { runTool, toolDeclarations, toolNames, ToolError, type GridToolContext } from './grid-tools';

/**
 * The grid agent: Gemini as an operator of the supply network, not a narrator
 * of it.
 *
 * WHAT THE MODEL DOES AND DOES NOT DO
 * -----------------------------------
 * It does not forecast, it does not price a transfer, it does not decide what
 * moves. Croston, the Monte Carlo risk model and the redistribution optimiser
 * do all of that, deterministically, before this file runs. What the model does
 * is the job nobody has built for a District Health Officer: read a 100 KB
 * table of 140 stock positions, 36 dispatch orders and 40 needs the optimiser
 * declined, work out which four rows answer the question actually asked, and
 * say so in the language the question was asked in.
 *
 * That is a planning-and-retrieval problem over a large structured artefact.
 * It is genuinely hard, it is what a language model is genuinely good at, and
 * it is not something a `<select>` and a table filter can do -- an officer who
 * asks "kaunsi dawa khatam hone wali hai aur kya bhej sakte hain?" is asking a
 * question that spans three tables and a taxonomy.
 *
 * WHY THE LOOP IS HAND-WRITTEN
 * ----------------------------
 * The SDK will run this loop for us -- but only for tools implementing the
 * `CallableTool` interface, and mixing those with plain function declarations
 * throws outright. More to the point, automatic function calling gives us none
 * of the four things this loop exists for:
 *
 *   1. Reject any tool name not in our registry. The model has been observed
 *      inventing one ("default_api:list_critical_positions").
 *   2. Zod-validate every argument object before it reaches real data.
 *   3. Record an auditable trace of which tool returned which numbers -- WRITTEN
 *      BY THIS CODE, never quoted from the model.
 *   4. Cap the turns, so a confused model cannot bill an unbounded number of
 *      calls against a demo key.
 *
 * THE TRACE IS THE PRODUCT
 * ------------------------
 * A briefing that says "dispatch 19 doses of Td vaccine from SC Lucknow-11" is
 * only worth acting on if the officer can see that the 19 came out of the
 * optimiser and not out of the model. So the trace is not debug output: it is
 * the evidence, and it is rendered next to the answer.
 */

export type GridLanguage = 'en' | 'hi' | 'hinglish';

/** Turns, not tool calls: the model may call several tools in one turn. */
const MAX_TURNS = 6;
/** Total tool executions across the run. A stop, not a budget to be spent. */
const MAX_TOOL_CALLS = 14;

export interface ToolTraceEntry {
  /** 1-based, in execution order. */
  step: number;
  tool: string;
  /** Exactly what the model asked for, after Zod validation. */
  args: Record<string, unknown>;
  ok: boolean;
  /** One line, written by the tool itself. Never model output. */
  summary: string;
  rows: number;
  elapsedMs: number;
}

export interface AgentRun {
  trace: ToolTraceEntry[];
  turns: number;
  model: string;
  elapsedMs: number;
  /** Names the tools actually put in front of the model, for citation checking. */
  groundedFacilities: string[];
  groundedDrugs: string[];
}

export interface GridAnswer extends AgentRun {
  answer: string;
  /** Facilities the model cited, filtered to those a tool actually returned. */
  citedFacilities: string[];
  citedDrugs: string[];
  /**
   * Citations dropped because no tool returned that name.
   *
   * Surfaced rather than silently swallowed: a non-empty list here is the
   * clearest possible signal that the answer drifted from its evidence.
   */
  droppedCitations: string[];
  /** What the model says it could not answer from the tools. Empty when none. */
  dataGaps: string;
  followUps: string[];
  /** False when the model answered without calling a single tool. */
  grounded: boolean;
}

export interface GridBriefing extends AgentRun {
  headline: string;
  willFail: string[];
  dispatchToday: string[];
  escalate: string[];
  citedFacilities: string[];
  citedDrugs: string[];
  droppedCitations: string[];
  dataGaps: string;
  grounded: boolean;
}

/*
 * Answer envelopes.
 *
 * Structured output and function calling coexist on this model -- verified
 * live -- so the discipline `generateStructured` applies to extraction extends
 * to the agent's final answer: schema-constrained on the way out, Zod-validated
 * on the way in. Every field is required, with "" or [] standing in for absent,
 * for the reason set out in `schemas.ts`: an omitted key costs a whole round
 * trip.
 *
 * The citation fields are NAMES, not ids, and are checked against what the
 * tools returned. Everything else is prose, deliberately: a numeric field in
 * this envelope would be an invitation for the model to recompute rather than
 * quote.
 *
 * THE ENVELOPES ARE BUILT PER LANGUAGE, and the language is written into the
 * FIELD DESCRIPTIONS.
 *
 * This is the third and most effective place the requirement is stated, and it
 * is the one that finally moved the briefing. A model handed a response schema
 * treats that schema as the specification of the thing it is producing; an
 * instruction that lives anywhere else is, from the schema's point of view,
 * background. Saying "in Devanagari" on the `headline` field is saying it at the
 * moment the headline is composed, which is why it survives a prompt whose
 * scaffolding and whose evidence are both entirely in English.
 *
 * The citation arrays deliberately do NOT get the directive: they are
 * identifiers-by-another-name, matched against tool output by string equality,
 * and a translated facility name matches nothing.
 */
const FIELD_LANGUAGE: Record<GridLanguage, string> = {
  en: 'Written in English.',
  hi: 'Written in HINDI, in Devanagari script — not English, and not Hindi transliterated into Latin letters.',
  hinglish: 'Written in HINGLISH — Hindi in Latin script — not English, and not Devanagari.',
};

const CITED_FACILITIES = 'Facility names you referred to, spelled exactly as the tools spelled them, in Latin script.';
const CITED_DRUGS = 'Medicine names you referred to, spelled exactly as the tools spelled them, in Latin script.';
const GAPS = 'What the officer asked for that no tool could supply. Empty string when nothing was missing. ';

function answerEnvelope(language: GridLanguage) {
  const prose = FIELD_LANGUAGE[language];
  return z.object({
    answer: z.string().describe('Your reply to the officer. ' + prose),
    citedFacilities: z.array(z.string()).describe(CITED_FACILITIES),
    citedDrugs: z.array(z.string()).describe(CITED_DRUGS),
    dataGaps: z.string().describe(GAPS + prose),
    followUps: z.array(z.string()).describe('At most four questions the officer might reasonably ask next. ' + prose),
  });
}

function briefingEnvelope(language: GridLanguage) {
  const prose = FIELD_LANGUAGE[language];
  return z.object({
    headline: z.string().describe('One sentence a Collector would read. ' + prose),
    willFail: z.array(z.string()).describe('What is about to run out, worst first. ' + prose),
    dispatchToday: z.array(z.string()).describe('Transfers to execute today, one per line. ' + prose),
    escalate: z.array(z.string()).describe('What needs procurement or a policy decision rather than a transfer. ' + prose),
    citedFacilities: z.array(z.string()).describe(CITED_FACILITIES),
    citedDrugs: z.array(z.string()).describe(CITED_DRUGS),
    dataGaps: z.string().describe(GAPS + prose),
  });
}

/*
 * The language directive, and why it is stated twice.
 *
 * Asking once, in the middle of a long system instruction, does not survive
 * this loop. By the time the model writes its answer it has read three or four
 * tool payloads that are entirely in English -- field names, glossary text,
 * optimiser rationales -- and it follows the language of the evidence rather
 * than the language of the request. Observed live on Bastar: a briefing asked
 * for in Hindi came back wholly in English, and a Hindi question came back in
 * Latin script. The same model, given the same instruction as its only
 * instruction, writes flawless Devanagari -- so this is a salience problem, not
 * a capability one.
 *
 * Two changes fix it, and both matter. The directive is the LAST line of the
 * system instruction rather than the middle one, and it is repeated on the user
 * turn so it is also the last thing said before the tools start talking. It
 * names the JSON explicitly, because a model that has been handed a response
 * schema reads the schema as the thing being asked for and the language as
 * commentary on it.
 *
 * WHAT MUST NOT BE TRANSLATED is as important as what must. A facility name,
 * batch number or unit that has been helpfully rendered into Devanagari is a
 * string the officer cannot find in the register, in the ledger, or in this
 * app's own search box -- so the answer stops being actionable at exactly the
 * moment it becomes readable.
 */
const LANGUAGE_INSTRUCTION: Record<GridLanguage, string> = {
  en: 'LANGUAGE: write every field of your reply in English.',
  hi:
    'LANGUAGE: write every sentence of your reply in HINDI, in Devanagari script. ' +
    'This applies to every text field of the JSON you return, including the headline and every list item. ' +
    'Do NOT answer in English. ' +
    'Keep facility names, drug names, batch numbers, dates and units exactly as the tools spelled them, in Latin script, inside the Hindi sentence — that is how they are written on the register, and the officer has to be able to find them there.',
  hinglish:
    'LANGUAGE: write every sentence of your reply in HINGLISH — Hindi in Latin script, the way a district officer actually writes on WhatsApp. ' +
    'This applies to every text field of the JSON you return. Do NOT answer in English and do NOT use Devanagari script. ' +
    'Keep facility names, drug names, batch numbers, dates and units exactly as the tools spelled them.',
};

/**
 * The contract with the model, and the only place it is stated.
 *
 * Every clause here exists because of an observed failure, not as a
 * precaution: models invent identifiers, models do arithmetic in prose when
 * asked for a total, and models answer confidently about things no tool
 * returned.
 */
function systemInstruction(opts: {
  language: GridLanguage;
  districtName: string | null;
  stateName: string | null;
}): string {
  const lines = [
    'You are the operations assistant inside Aarogya Grid, a medicine-supply intelligence system for India\'s primary health network.',
    'You are speaking to a District Health Officer — an administrator, not an engineer. They act on what you say.',
    '',
    'WHAT YOU KNOW',
    'You know nothing about stock, risk, transfers or forecasts on your own. Every number, name, quantity, cost, distance, probability and date you state MUST have come from a tool result in this conversation. If no tool returned it, you do not know it, and you say so.',
    '',
    'WHAT YOU MUST NEVER DO',
    '1. Never invent, estimate, round or calculate a number. Do not add, subtract, average, convert units, or work out a percentage. If the officer asks for a figure no tool returned, say which part is missing instead of producing one.',
    '1a. Percentages are already done for you. Every probability and share comes back with its percentage alongside it — stockoutProbabilityPercent, coverageSharePercent, riskReductionPercent. Quote that field. Never multiply a probability by a hundred yourself.',
    '2. Never write a district code, facility id or drug code. They do not exist as far as you are concerned. Refer to every place, facility and medicine by its NAME, and pass names to tools.',
    '3. Never rewrite the numbers inside a dispatch rationale. That sentence was written by the optimiser at the moment of the decision. Quote it or translate it, but do not re-derive it.',
    '4. Never state a medicine\'s criticality class, cold-chain requirement or shelf life from memory — call drug_reference.',
    '',
    'HOW TO WORK',
    'Plan which tools answer the question, call them, then answer only from what came back. Call several tools when the question spans them. If a tool reports ambiguity, ask the officer to choose rather than picking one yourself.',
    'Be concrete and short. Lead with the action. An officer reading this at 8am wants to know what to move today and what to escalate, not a summary of the dashboard.',
    'Numbers are meaningless without their date: the tools stamp every result with asOf. Say what the figures are as of when it matters.',
    'Facility and drug names must be spelled exactly as the tools spelled them, because the officer will search for them.',
    /*
     * Observed on the Bastar Hindi briefing: "DH Bastar-01 में Ceftriaxone के
     * लिए 135 onHand और 4.4 daysOfCover बचा है". Every figure was correct and
     * the sentence was still not a sentence -- the model had reached for the
     * JSON key as the noun. A tool payload is a wire format; the officer is
     * owed prose, and this is cheaper to say than to clean up afterwards.
     */
    'Write in words, never in our field names. A tool result is JSON; your answer is a sentence an administrator reads. Say "135 vials on hand, 4.4 days of cover left", never "135 onHand and 4.4 daysOfCover".',
  ];

  if (opts.districtName) {
    lines.push(
      '',
      'The officer is currently looking at ' +
        opts.districtName +
        (opts.stateName ? ', ' + opts.stateName : '') +
        '. Tools default to this district when you omit the district argument — omit it unless the officer names somewhere else.',
    );
  }

  // Last, not in the middle. See the note on LANGUAGE_INSTRUCTION.
  lines.push('', LANGUAGE_INSTRUCTION[opts.language]);

  return lines.join('\n');
}

/**
 * The user turn, with the language directive restated at the end of it.
 *
 * The officer's own words come first and are never edited -- the model must see
 * the question exactly as it was asked, including the language it was asked in.
 * The directive is appended after a blank line so it reads as an instruction
 * about the reply rather than as part of the question.
 */
function userTurn(text: string, language: GridLanguage): Content[] {
  return [{ role: 'user', parts: [{ text: text + '\n\n' + LANGUAGE_INSTRUCTION[language] }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip markdown fences some models wrap JSON in, before parsing. */
function stripFences(text: string): string {
  const t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced ? fenced[1] : t).trim();
}

/** One retry. Not a queue -- if the second attempt is throttled too, say so. */
const RATE_LIMIT_RETRIES = 1;
/** Never wait longer than this, whatever the API suggests. */
const MAX_BACKOFF_MS = 20_000;

/**
 * How long to wait before retrying, or null if this is not a throttle.
 *
 * The free tier allows five requests per minute per model, and one briefing is
 * three or four of them -- so an officer who asks a question and then presses
 * "morning briefing" is throttled by arithmetic, not by misuse. The API tells
 * us exactly how long to wait in its own error body; honouring that is the
 * difference between a demo that pauses for eight seconds and a demo that dies.
 *
 * The error text is read here and never leaves the server. Upstream errors can
 * quote the request that failed, and the request carries the credential -- the
 * reason `/api/ask` returns a fixed message.
 */
function rateLimitDelayMs(e: unknown): number | null {
  const status = (e as { status?: number } | null)?.status;
  const message = e instanceof Error ? e.message : '';
  if (status !== 429 && !message.includes('RESOURCE_EXHAUSTED')) return null;

  const suggested = message.match(/"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"/);
  // One second of headroom: the suggested delay is when the window reopens, and
  // arriving exactly on it is another 429.
  const waitMs = suggested ? Number(suggested[1]) * 1000 + 1000 : 8_000;
  return Math.min(waitMs, MAX_BACKOFF_MS);
}

/**
 * True when the throttle is the DAILY cap rather than the per-minute one.
 *
 * The distinction decides whether waiting helps. Per-minute exhaustion clears
 * in seconds; the free tier's daily allowance for a model does not clear until
 * tomorrow, and no amount of backoff will recover it.
 */
function isDailyQuota(e: unknown): boolean {
  return e instanceof Error && e.message.includes('PerDay');
}

/**
 * Drop reasoning signatures from everything already in the conversation.
 *
 * A `thoughtSignature` is one model's own reasoning state and is meaningless
 * to another. Handing model B a transcript stamped by model A is at best
 * ignored and at worst rejected, so the signatures are cleared at the moment
 * the backend switches -- and only then, because on the normal path preserving
 * them is what keeps the second turn warm.
 */
function stripThoughtSignatures(contents: Content[]): void {
  for (const content of contents) {
    for (const part of content.parts ?? []) delete part.thoughtSignature;
  }
}

interface LoopResult<T> {
  value: T;
  run: AgentRun;
  toolCallCount: number;
}

/**
 * The loop.
 *
 * Branches on `functionCalls` FIRST and never on `text`: on a tool-calling turn
 * `response.text` is undefined and the SDK logs a warning about non-text parts.
 * Code that checks the text first sees an empty answer and gives up one turn
 * before the model was going to answer.
 *
 * The model's own content object is pushed back VERBATIM rather than
 * reconstructed, because its parts carry a `thoughtSignature` that is the
 * model's own reasoning state. Rebuilding the part from its fields drops that
 * signature and the next turn starts colder than it needs to.
 */
async function runLoop<T>(opts: {
  contents: Content[];
  system: string;
  schema: ZodType<T>;
  ctx: GridToolContext;
  model: string;
}): Promise<LoopResult<T>> {
  const ai = getClient();
  const started = Date.now();
  const declarations = toolDeclarations();
  const responseSchema = geminiSchema(opts.schema as z.ZodType);

  const trace: ToolTraceEntry[] = [];
  const groundedFacilities = new Set<string>();
  const groundedDrugs = new Set<string>();
  const contents = opts.contents;

  let toolCallCount = 0;
  let turns = 0;
  let finalText: string | null = null;
  let activeModel = opts.model;
  const fallbackModel = fastModelId();

  /**
   * Results of tool calls already made in this run, keyed by name + arguments.
   *
   * The tools are pure functions of a file on disk, so a repeated call is
   * guaranteed to return the same bytes; serving it from here costs nothing and
   * keeps the loop from spending its finite budget re-reading what it has.
   */
  const callCache = new Map<string, unknown>();

  /** Argument fingerprint with stable key order, so {a,b} and {b,a} match. */
  const stableArgs = (args: Record<string, unknown>): string =>
    JSON.stringify(
      Object.keys(args)
        .sort()
        .map((k) => [k, args[k]]),
    );

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    turns++;

    // Tools are withdrawn once the budget is spent, which forces the model to
    // answer from what it already has instead of stalling on a call it cannot
    // make. A model with no way to finish will keep asking.
    const budgetLeft = toolCallCount < MAX_TOOL_CALLS && turn < MAX_TURNS - 1;

    const request = {
      model: opts.model,
      contents,
      config: {
        temperature: 0,
        systemInstruction: opts.system,
        responseMimeType: 'application/json',
        responseSchema: responseSchema as never,
        ...(budgetLeft
          ? {
              tools: [{ functionDeclarations: declarations }],
              toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
            }
          : {}),
      },
    };

    let response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await ai.models.generateContent({ ...request, model: activeModel });
        break;
      } catch (e) {
        /*
         * Fall back to the fast model before giving up.
         *
         * The free tier's daily allowance is per model, and one agent run costs
         * two to five requests of it -- so the primary model runs dry after a
         * handful of questions and stays dry until tomorrow. A demo that dies
         * at that moment is a demo that dies on stage, which is the failure
         * `client.ts` design note 1 exists to prevent. The fallback answers
         * from the same tools with the same numbers; only the prose is a little
         * plainer, and the trace records which model actually answered.
         */
        if (isDailyQuota(e) && activeModel !== fallbackModel) {
          console.warn('[grid-agent] daily quota exhausted on ' + activeModel + '; falling back to ' + fallbackModel);
          stripThoughtSignatures(contents);
          activeModel = fallbackModel;
          continue;
        }

        const waitMs = rateLimitDelayMs(e);
        if (waitMs === null || attempt >= RATE_LIMIT_RETRIES) throw e;
        console.warn('[grid-agent] throttled by the model API; retrying in ' + waitMs + 'ms');
        await new Promise((done) => setTimeout(done, waitMs));
      }
    }

    const calls = response.functionCalls;
    if (!calls || calls.length === 0) {
      finalText = response.text ?? '';
      break;
    }

    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);

    const responseParts: Part[] = [];
    for (const call of calls) {
      const name = call.name ?? '';
      const args = isRecord(call.args) ? call.args : {};
      const callStarted = Date.now();
      toolCallCount++;

      let payload: Record<string, unknown>;
      let entry: ToolTraceEntry;

      /*
       * A repeated call is answered from cache and NOT charged to the budget.
       *
       * Observed live: asked "which facilities will run out of a Vital drug in
       * the next two weeks?", the model called `list_positions` with identical
       * arguments five times, spent the entire turn budget, and produced a
       * preamble -- "I am fetching the full list..." -- instead of an answer.
       * The tools had been correctly withdrawn on the last turn; there was
       * simply nothing left to answer with.
       *
       * Charging a duplicate is the wrong trade twice over. It buys no new
       * information, and it spends the budget that exists to guarantee a final
       * synthesising turn. So a repeat returns the same bytes with an explicit
       * instruction not to ask again, and the counter is left alone. The trace
       * still records it, because a judge watching the audit trail should see
       * exactly what the model did, including the parts it got wrong.
       */
      const callKey = name + '|' + stableArgs(args);
      const cached = callCache.get(callKey);

      if (cached !== undefined) {
        payload = {
          output: cached,
          note: 'You already requested this exact call and this is the same result. Do not call it again. Answer the question from the data you now hold.',
        };
        entry = {
          step: toolCallCount,
          tool: name,
          args,
          ok: true,
          summary: 'repeat call — served from cache, not charged to the budget',
          rows: 0,
          elapsedMs: 0,
        };
        toolCallCount--;
      } else if (toolCallCount > MAX_TOOL_CALLS) {
        payload = { error: 'Tool call budget exhausted. Answer from what you already have.' };
        entry = { step: toolCallCount, tool: name, args, ok: false, summary: 'refused — call budget exhausted', rows: 0, elapsedMs: 0 };
      } else {
        try {
          const outcome = await runTool(name, args, opts.ctx);
          for (const f of outcome.grounded.facilities) groundedFacilities.add(f);
          for (const d of outcome.grounded.drugs) groundedDrugs.add(d);
          // The documented convention: "output" for a result, "error" for a
          // failure. Giving failures their own key means a failed tool call is
          // never mistaken by the model for a result that happened to be empty.
          payload = { output: outcome.data };
          callCache.set(callKey, outcome.data);
          entry = {
            step: toolCallCount,
            tool: name,
            args,
            ok: true,
            summary: outcome.summary,
            rows: outcome.rows,
            elapsedMs: Date.now() - callStarted,
          };
        } catch (e) {
          const message =
            e instanceof ToolError
              ? e.message
              : 'That tool failed. Do not retry it with the same arguments.';
          // Unexpected failures are logged with their real cause; the model is
          // told only what it can act on.
          if (!(e instanceof ToolError)) console.error('[grid-agent] tool ' + name + ' failed', e);
          payload = { error: message };
          entry = {
            step: toolCallCount,
            tool: name,
            args,
            ok: false,
            summary: message,
            rows: 0,
            elapsedMs: Date.now() - callStarted,
          };
        }
      }

      trace.push(entry);
      responseParts.push({
        functionResponse: {
          ...(call.id ? { id: call.id } : {}),
          name,
          response: payload,
        },
      });
    }

    contents.push({ role: 'user', parts: responseParts });
  }

  const run: AgentRun = {
    trace,
    turns,
    // The model that actually answered, which is not always the one asked for.
    model: activeModel,
    elapsedMs: Date.now() - started,
    groundedFacilities: [...groundedFacilities],
    groundedDrugs: [...groundedDrugs],
  };

  const value = parseEnvelope(opts.schema, finalText ?? '');
  return { value, run, toolCallCount };
}

function parseEnvelope<T>(schema: ZodType<T>, text: string): T {
  if (!text.trim()) {
    throw new AiValidationError('The model produced no final answer after its tool calls.', text);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch (e) {
    throw new AiValidationError(
      'Final answer was not JSON: ' + (e instanceof Error ? e.message : String(e)),
      text,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new AiValidationError(
      'Final answer failed schema validation: ' +
        result.error.issues.map((i) => i.path.join('.') + ': ' + i.message).slice(0, 6).join('; '),
      text,
    );
  }
  return result.data;
}

/**
 * Keep only the names a tool actually returned.
 *
 * The model is asked to cite what it is talking about, and a citation is only
 * worth printing if the thing cited was in front of it. Matching is on the
 * normalised string -- the same normaliser the resolvers use -- so
 * "SC Lucknow-04" and "SC Lucknow 04" are the same citation, while a facility
 * that appeared in no tool result is dropped and reported.
 */
function checkCitations(
  claimed: string[],
  grounded: string[],
): { kept: string[]; dropped: string[] } {
  const index = new Map(grounded.map((g) => [normalise(g), g]));
  const kept: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const raw of claimed) {
    const key = normalise(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const hit = index.get(key);
    if (hit) kept.push(hit);
    else dropped.push(raw);
  }
  return { kept, dropped };
}

/**
 * The district code the console holds is the ONE identifier that enters this
 * file, and it is turned into display names immediately. Nothing downstream of
 * here -- prompt, tool argument or answer -- carries a code.
 */
function districtNames(districtCode: string | null): { districtName: string | null; stateName: string | null } {
  if (!districtCode) return { districtName: null, stateName: null };
  const info = DISTRICTS_BY_CODE[districtCode];
  return { districtName: info?.name ?? null, stateName: info?.stateName ?? null };
}

/**
 * A District Health Officer asks a question in plain language.
 *
 * The district code comes from the console the officer has open, never from the
 * model, and it is the tools' default -- so the common case ("what am I short
 * of?") needs no place name at all and cannot be misresolved.
 */
export async function askGrid(opts: {
  districtCode: string | null;
  question: string;
  language?: GridLanguage;
}): Promise<GridAnswer> {
  const language = opts.language ?? 'en';
  const { districtName, stateName } = districtNames(opts.districtCode);

  const { value, run } = await runLoop({
    contents: userTurn(opts.question, language),
    system: systemInstruction({ language, districtName, stateName }),
    schema: answerEnvelope(language),
    ctx: { districtCode: opts.districtCode },
    model: modelId(),
  });

  const facilities = checkCitations(value.citedFacilities, run.groundedFacilities);
  const drugs = checkCitations(value.citedDrugs, run.groundedDrugs);

  return {
    ...run,
    answer: value.answer,
    citedFacilities: facilities.kept,
    citedDrugs: drugs.kept,
    droppedCitations: [...facilities.dropped, ...drugs.dropped],
    dataGaps: value.dataGaps,
    followUps: value.followUps.slice(0, 4),
    grounded: run.trace.some((t) => t.ok),
  };
}

/**
 * The morning briefing.
 *
 * Deliberately not a free-form question. The three sections are the three
 * decisions an officer actually makes before the day starts -- what breaks, what
 * moves, what has to go up the chain -- and the third one is the honest one:
 * a district where 149 of 160 needs failed the benefit-cost gate does not have
 * a logistics problem, it has a procurement problem, and no amount of moving
 * stock around will fix it. That sentence exists in the computed data today and
 * nothing in the product says it out loud.
 */
export async function briefDistrict(opts: {
  districtCode: string;
  language?: GridLanguage;
}): Promise<GridBriefing> {
  const language = opts.language ?? 'en';
  const { districtName, stateName } = districtNames(opts.districtCode);

  const brief = [
    'Write my morning action briefing for ' + (districtName ?? 'this district') + '.',
    '',
    'Work in this order:',
    '1. district_status — the headline position.',
    '2. list_positions with severity "critical" — what will fail in the next two weeks. Say the facility, the medicine, how much is on hand and how many days of cover are left.',
    '3. list_dispatch_orders — what I should physically move today. Say who ships to whom, how much, off which batch, and what it costs. Use the optimiser\'s own rationale.',
    '4. explain_unmet_need — what cannot be fixed by moving stock, and why. This is what I escalate.',
    '',
    'Then fill the sections:',
    'headline: one sentence a Collector would read.',
    'willFail: one line per item at risk, worst first.',
    'dispatchToday: one line per transfer, executable as written.',
    'escalate: what needs procurement or a policy decision rather than a transfer, and the reason the optimiser gave.',
    'Keep each list to at most five lines. Every figure must come from a tool result.',
  ].join('\n');

  const { value, run } = await runLoop({
    contents: userTurn(brief, language),
    system: systemInstruction({ language, districtName, stateName }),
    schema: briefingEnvelope(language),
    ctx: { districtCode: opts.districtCode },
    model: modelId(),
  });

  const facilities = checkCitations(value.citedFacilities, run.groundedFacilities);
  const drugs = checkCitations(value.citedDrugs, run.groundedDrugs);

  return {
    ...run,
    headline: value.headline,
    willFail: value.willFail.slice(0, 5),
    dispatchToday: value.dispatchToday.slice(0, 5),
    escalate: value.escalate.slice(0, 5),
    citedFacilities: facilities.kept,
    citedDrugs: drugs.kept,
    droppedCitations: [...facilities.dropped, ...drugs.dropped],
    dataGaps: value.dataGaps,
    grounded: run.trace.some((t) => t.ok),
  };
}

/** Exposed so the UI and the smoke script agree on what the agent can do. */
export const AGENT_TOOL_NAMES = toolNames();
