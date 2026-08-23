/**
 * Tests for the Gemini grid agent.
 * Run with:  npx tsx scripts/test-agent.mts
 *            npx tsx scripts/test-agent.mts --offline    (no API key needed)
 *
 * The offline half is the important half. Everything that decides what the
 * model is ALLOWED to see and say is a pure function over the precomputed
 * snapshot, so it can be asserted exhaustively without spending a token:
 *
 *   - no tool ever hands the model a district code, facility id or drug id
 *   - every number a tool returns is byte-identical to the one in the file the
 *     pipeline wrote
 *   - a fabricated identifier is rejected rather than fuzzy-matched to
 *     something plausible
 *
 * The live half then checks the two things only a real call can check: that the
 * loop actually plans, calls and answers from what came back, and -- section 7,
 * the number audit -- that every single figure in the prose can be traced to a
 * payload the model was handed. Citation checking catches an invented NAME; the
 * number audit is what catches an invented QUANTITY under a real name, which is
 * the failure an officer could never spot for themselves.
 *
 * It runs against Bastar, Chhattisgarh -- a district none of the offline
 * assertions touch, so it cannot be satisfied by a figure that leaked into this
 * file. Every live run is written to `agent-run-capture.json` with the full
 * payload of every tool call, so a reviewer can re-audit any answer by hand
 * without spending a second day's quota.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env.local loader -- same one `list-models.mts` uses. */
function loadEnv() {
  for (const name of ['.env.local', '.env']) {
    try {
      const text = readFileSync(resolve(process.cwd(), name), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) continue;
        const [, key, rawValue] = m;
        if (process.env[key]) continue;
        const value = rawValue.trim().replace(/^["'](.*)["']$/, '$1');
        if (value) process.env[key] = value;
      }
    } catch {
      /* file absent -- fine */
    }
  }
}
loadEnv();

const { GRID_TOOLS, runTool, toolDeclarations, ToolError } = await import('../src/lib/ai/grid-tools');
const { resolveDistrict, resolveFacility } = await import('../src/lib/ai/resolve-place');
const { DISTRICTS_BY_CODE } = await import('../src/lib/domain/geo');
const { isConfigured, backend, modelId } = await import('../src/lib/ai/client');

const OFFLINE = process.argv.includes('--offline');
const DISTRICT = 'DST-09-LUCKNOW';
const detail = JSON.parse(readFileSync(resolve(process.cwd(), 'src/data/districts', DISTRICT + '.json'), 'utf8'));

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detailText = '') {
  if (ok) pass++;
  else fail++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detailText && !ok ? '  -> ' + detailText : ''));
}

/**
 * Anything shaped like one of this system's identifiers.
 *
 * District codes and facility ids both start `DST-`; drug ids are uppercase
 * with a digit-or-hyphen tail like `PARA-500-TAB` or `ATT-4FDC`. If any of
 * these appears in something the model is shown, the model can echo it.
 */
const ID_PATTERN = /\bDST-\d{2}-[A-Z0-9]+|\b[A-Z]{3,}-[A-Z0-9.]*\d[A-Z0-9.-]*\b/;

const ctx = { districtCode: DISTRICT };

// ---------------------------------------------------------------------------
console.log('\n=== 1. District resolution ===');

check('exact name resolves', resolveDistrict('Lucknow').best?.district.code === DISTRICT);
check('name + state resolves', resolveDistrict('Lucknow, Uttar Pradesh').best?.district.code === DISTRICT);
check('lowercase resolves', resolveDistrict('lucknow').best?.district.code === DISTRICT);
check('alias: Bangalore -> Bengaluru Urban', resolveDistrict('Bangalore').best?.district.name === 'Bengaluru Urban');
check('alias: Allahabad -> Prayagraj', resolveDistrict('Allahabad').best?.district.name === 'Prayagraj');
check('alias: Vizag -> Visakhapatnam', resolveDistrict('Vizag').best?.district.name === 'Visakhapatnam');
check('alias: Guwahati -> Kamrup Metropolitan', resolveDistrict('Guwahati').best?.district.name === 'Kamrup Metropolitan');

const fabricated = resolveDistrict('DST-99-NOWHERE');
check('fabricated code is rejected as an identifier', fabricated.rejectedAsIdentifier && fabricated.best === null);
check('real code still resolves', resolveDistrict(DISTRICT).best?.district.code === DISTRICT);

const nonsense = resolveDistrict('Springfield');
check(
  'a district that does not exist does not resolve confidently',
  nonsense.best === null || nonsense.needsConfirmation,
  'got ' + nonsense.best?.district.name + ' @ ' + nonsense.best?.confidence,
);

// Every alias key must be a real district code, or the alias silently does nothing.
const aliasKeysValid = (() => {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/ai/resolve-place.ts'), 'utf8');
  const keys = [...src.matchAll(/'(DST-\d{2}-[A-Z0-9]+)':/g)].map((m) => m[1]);
  const bad = keys.filter((k) => !DISTRICTS_BY_CODE[k]);
  if (bad.length) console.log('        dead alias keys: ' + bad.join(', '));
  return bad.length === 0 && keys.length > 0;
})();
check('every district alias key is a real district code', aliasKeysValid);

// ---------------------------------------------------------------------------
console.log('\n=== 2. Facility resolution (within one district) ===');

const roster = detail.facilities.map((f: { id: string; name: string; type: string }) => ({
  id: f.id,
  name: f.name,
  type: f.type,
}));
const someFacility = detail.facilities[0];

check('exact facility name resolves', resolveFacility(someFacility.name, roster).best?.facility.id === someFacility.id);
check(
  'fabricated facility id is rejected',
  resolveFacility('DST-09-LUCKNOW-PHC-999', roster).rejectedAsIdentifier,
);
check(
  'a facility from another district does not resolve',
  (() => {
    const r = resolveFacility('CHC Bastar-02', roster);
    return r.best === null || r.needsConfirmation;
  })(),
);

// ---------------------------------------------------------------------------
console.log('\n=== 3. Tool declarations ===');

const declarations = toolDeclarations();
check('every tool is declared', declarations.length === GRID_TOOLS.length && declarations.length >= 9);
check('every declaration has a name and description', declarations.every((d) => !!d.name && (d.description?.length ?? 0) > 40));
check('every declaration carries a JSON schema', declarations.every((d) => !!d.parametersJsonSchema));

const declText = JSON.stringify(declarations);
check('no $ref in declarations (Gemini does not follow them)', !declText.includes('"$ref"'));
check('no $schema keyword', !declText.includes('"$schema"'));
check('no additionalProperties', !declText.includes('"additionalProperties"'));
check(
  'no argument is called districtCode / facilityId / drugId',
  !/districtCode|facilityId|drugId/.test(declText),
  'the model must only ever be offered NAME arguments',
);

// ---------------------------------------------------------------------------
console.log('\n=== 4. Tools return real numbers, and no identifiers ===');

async function callTool(name: string, args: Record<string, unknown>) {
  return runTool(name, args, ctx);
}

const status = await callTool('district_status', {});
const statusText = JSON.stringify(status.data);
check('district_status returns the district', (status.data as Record<string, unknown>).district === 'Lucknow');
check(
  'district_status critical count matches the file exactly',
  (status.data as Record<string, unknown>).criticalPositions === detail.district.criticalPositions,
);
check(
  'district_status plan economics match the file exactly',
  JSON.stringify((status.data as { plan: { transportCostInr: number; netBenefitInr: number; unservedReceivers: number } }).plan.transportCostInr) ===
    JSON.stringify(detail.economics.transportCostInr) &&
    (status.data as { plan: { netBenefitInr: number } }).plan.netBenefitInr === detail.economics.netBenefitInr &&
    (status.data as { plan: { unservedReceivers: number } }).plan.unservedReceivers === detail.economics.unservedReceivers,
);
check('district_status carries the as-of stamp', (status.data as Record<string, unknown>).asOf === detail.asOf);
check('district_status leaks no identifier', !ID_PATTERN.test(statusText), statusText.slice(0, 200));

const positions = await callTool('list_positions', { severity: 'critical', limit: 5 });
const posData = positions.data as { positions: Record<string, unknown>[]; matched: number };
const worstInFile = detail.positions.filter((p: { severity: string }) => p.severity === 'critical')[0];
check('list_positions returns rows', posData.positions.length === 5);
check(
  'list_positions row 1 is the worst critical position in the file',
  posData.positions[0].facility === worstInFile.facilityName && posData.positions[0].drug === worstInFile.drugName,
);
check(
  'list_positions copies on-hand and shortfall verbatim',
  posData.positions[0].onHand === worstInFile.onHand &&
    posData.positions[0].expectedShortfallUnits === worstInFile.expectedShortfallUnits,
);
check('list_positions leaks no identifier', !ID_PATTERN.test(JSON.stringify(posData)));
check('list_positions caps at its declared limit', (await callTool('list_positions', { limit: 15 })).rows <= 15);

const orders = await callTool('list_dispatch_orders', { limit: 3 });
const orderData = orders.data as { orders: { rationale: string; batches: unknown[]; quantity: number }[] };
check('list_dispatch_orders returns orders', orderData.orders.length === 3);
check(
  'the optimiser rationale is passed through verbatim',
  detail.orders.some((o: { rationale: string }) => o.rationale === orderData.orders[0].rationale),
);
check('orders carry a batch pick list', orderData.orders.every((o) => o.batches.length > 0));
check('list_dispatch_orders leaks no identifier', !ID_PATTERN.test(JSON.stringify(orderData).replace(/"batchNo":"[^"]*"/g, '')));

const unmet = await callTool('explain_unmet_need', { limit: 4 });
const unmetData = unmet.data as { reasonHistogram: Record<string, number>; needs: { reason: string; reasonMeaning: string }[] };
check(
  'explain_unmet_need histogram matches the file exactly',
  JSON.stringify(unmetData.reasonHistogram) === JSON.stringify(detail.economics.reasonHistogram),
);
check('every unmet need carries a plain-English reason', unmetData.needs.every((n) => n.reasonMeaning.length > 30));

const facility = await callTool('facility_snapshot', { facility: someFacility.name });
check('facility_snapshot resolves by name', (facility.data as { facility: { name: string } }).facility.name === someFacility.name);
check('facility_snapshot leaks no identifier', !ID_PATTERN.test(JSON.stringify(facility.data).replace(/"batchNo":"[^"]*"/g, '')));

const forecast = await callTool('explain_forecast', {});
const forecastData = forecast.data as { weeklyHistory: unknown[]; censoredDays: number; fittedDailyDemand: number };
check('explain_forecast downsamples the 365-day series', forecastData.weeklyHistory.length <= 53 && forecastData.weeklyHistory.length >= 52);
check('explain_forecast copies the fitted demand verbatim', forecastData.fittedDailyDemand === detail.probe.fittedDailyDemand);
check(
  'explain_forecast counts censored days from the mask',
  forecastData.censoredDays === detail.probe.censored.filter(Boolean).length,
);

const national = await callTool('national_overview', { rankBy: 'risk', limit: 3 });
const nationalData = national.data as { totals: Record<string, number>; topDistricts: unknown[] };
check('national_overview returns totals', nationalData.totals.districts === 128);
check('national_overview respects its limit', nationalData.topDistricts.length === 3);
check('national_overview leaks no identifier', !ID_PATTERN.test(JSON.stringify(nationalData)));

const drug = await callTool('drug_reference', { name: 'lal goli' });
check(
  'drug_reference resolves a vernacular name',
  (drug.data as { drug: string }).drug.toLowerCase().includes('iron'),
  JSON.stringify(drug.data).slice(0, 160),
);
check('drug_reference leaks no drug id', !ID_PATTERN.test(JSON.stringify(drug.data)));

// ---------------------------------------------------------------------------
console.log('\n=== 5. Tools refuse rather than guess ===');

async function expectRefusal(name: string, args: Record<string, unknown>, label: string) {
  try {
    await callTool(name, args);
    check(label, false, 'the tool answered instead of refusing');
  } catch (e) {
    check(label, e instanceof ToolError, e instanceof Error ? e.message : String(e));
  }
}

await expectRefusal('district_status', { district: 'DST-99-NOWHERE' }, 'a fabricated district code is refused');
await expectRefusal('district_status', { district: 'Atlantis' }, 'a district that does not exist is refused');
await expectRefusal('facility_snapshot', { facility: 'the moon base' }, 'a facility that does not exist is refused');
await expectRefusal('list_positions', { drug: 'unobtainium' }, 'a drug that does not exist is refused');
await expectRefusal('not_a_real_tool', {}, 'an unregistered tool name is refused');
await expectRefusal('list_positions', { limit: 500 }, 'an out-of-range limit is refused by Zod');
await expectRefusal('list_positions', { severity: 'apocalyptic' }, 'an invalid enum value is refused by Zod');


// ---------------------------------------------------------------------------
/*
 * The live half, run against a district the offline half never touches.
 *
 * Bastar rather than Lucknow, deliberately. Every assertion above is written
 * against Lucknow's snapshot, so a live suite on the same district could be
 * satisfied by numbers that leaked into this file rather than out of the tools.
 * Bastar is also smaller -- 22 facilities, 15 dispatch orders, 70 tracked
 * positions -- which means the model has no long tail to hide a fabricated
 * figure in: every number it states is checkable against a file small enough
 * for a person to read.
 */
const LIVE_DISTRICT = 'DST-22-BASTAR';
const liveCtx = { districtCode: LIVE_DISTRICT };

/** Where the captured runs are written, so groundedness can be audited without spending quota twice. */
const outFlag = process.argv.indexOf('--out');
const OUT_PATH = outFlag >= 0 ? process.argv[outFlag + 1] : resolve(process.cwd(), 'agent-run-capture.json');

/*
 * `--only <substring>` runs just the scenarios whose label contains it.
 *
 * Not a convenience. The free tier allows twenty requests a day per model and
 * one full pass of this suite is around thirty, so re-testing a single fixed
 * scenario by running all eight is how a key runs dry before the fix has been
 * confirmed. Case-insensitive, because the labels carry punctuation nobody
 * wants to retype.
 */
const onlyFlag = process.argv.indexOf('--only');
const ONLY = onlyFlag >= 0 ? (process.argv[onlyFlag + 1] ?? '').toLowerCase() : '';
const selected = (label: string) => !ONLY || label.toLowerCase().includes(ONLY);

interface CapturedCall {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  elapsedMs: number;
  /** The payload the model was actually handed, recovered by replaying the call. */
  payload: unknown;
}

interface CapturedRun {
  label: string;
  kind: 'ask' | 'brief';
  language: string;
  question: string;
  calls: CapturedCall[];
  text: string[];
  citedFacilities: string[];
  citedDrugs: string[];
  droppedCitations: string[];
  dataGaps: string;
  turns: number;
  model: string;
  elapsedMs: number;
}

const captured: CapturedRun[] = [];

type TraceLike = {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  elapsedMs: number;
};

/*
 * Recover exactly what the model saw.
 *
 * The trace records the tool and its validated arguments but not the payload,
 * because a payload is tens of kilobytes and the trace is rendered in a
 * browser. The tools are pure functions of a file on disk, so replaying the
 * same call with the same arguments reproduces that payload byte for byte --
 * free, and without a second round trip. This is what the number audit in
 * section 7 checks the prose against, and it is the difference between
 * believing the answer and being able to prove it.
 */
async function replay(trace: TraceLike[]): Promise<CapturedCall[]> {
  const calls: CapturedCall[] = [];
  for (const t of trace) {
    let payload: unknown = null;
    try {
      payload = (await runTool(t.tool, t.args, liveCtx)).data;
    } catch (e) {
      payload = { error: e instanceof Error ? e.message : String(e) };
    }
    calls.push({ ...t, payload });
  }
  return calls;
}

if (OFFLINE || !isConfigured()) {
  console.log('\n=== 6. Live agent — SKIPPED (' + (OFFLINE ? '--offline' : 'no backend configured') + ') ===');
} else {
  console.log('\n=== 6. Live agent on Bastar, Chhattisgarh (' + backend() + ', ' + modelId() + ') ===');
  const { askGrid, briefDistrict } = await import('../src/lib/ai/grid-agent');

  function printTrace(calls: CapturedCall[]) {
    for (const t of calls) {
      console.log(
        '        ' + t.step + '. ' + (t.ok ? '' : '! ') + t.tool + '(' + JSON.stringify(t.args) + ') ' +
          t.elapsedMs + 'ms — ' + t.summary,
      );
    }
  }

  /*
   * The language assertion exists because its absence hid a real defect.
   *
   * The first Bastar run asked for Hindi and got a briefing written entirely in
   * English, and every other assertion passed -- the numbers were right, the
   * citations were clean, nothing leaked. A suite that only checks arithmetic
   * cannot notice that the answer is unreadable to the person it was written
   * for, and an officer who asked in Hindi and received English has been handed
   * a correct document they will not act on.
   */
  const DEVANAGARI = /[ऀ-ॿ]/;

  function checkLanguage(label: string, language: string, text: string) {
    if (language === 'hi') {
      check(label + ': answered in Hindi (Devanagari)', DEVANAGARI.test(text), text.slice(0, 160));
    } else {
      // Latin script for both English and Hinglish; a stray Devanagari word in
      // an English answer is the same failure pointing the other way.
      check(label + ': answered in Latin script', !DEVANAGARI.test(text), text.slice(0, 160));
    }
  }

  function assertRun(label: string, run: CapturedRun, opts: { mustCallTools: boolean }) {
    check(label + ': every trace entry is a registered tool', run.calls.every((t) => GRID_TOOLS.some((g) => g.name === t.tool)));
    check(label + ': no identifier in the prose', !ID_PATTERN.test(run.text.join(' ')), run.text.join(' ').slice(0, 200));
    check(label + ': no citation was invented', run.droppedCitations.length === 0, 'dropped: ' + run.droppedCitations.join(', '));
    checkLanguage(label, run.language, run.text.join(' '));
    if (opts.mustCallTools) check(label + ': called at least one tool', run.calls.some((t) => t.ok));
  }

  /*
   * Pace the live cases.
   *
   * The free tier allows five requests per minute per model and one agent run
   * is three to five of them, so firing eight scenarios back to back measures
   * the quota rather than the agent. The agent retries a throttle once on its
   * own; this suite is not written to lean on that.
   */
  const PACE_MS = Number(process.env.AGENT_TEST_PACE_MS ?? 30_000);
  const pace = () => new Promise((done) => setTimeout(done, PACE_MS));

  // --- 1 and 2: the morning briefing, in both languages --------------------
  for (const language of ['en', 'hi'] as const) {
    const label = 'Briefing · ' + language;
    if (!selected(label)) continue;
    console.log('\n  --- ' + label + ' — briefDistrict(Bastar)');
    const b = await briefDistrict({ districtCode: LIVE_DISTRICT, language });
    const calls = await replay(b.trace);
    printTrace(calls);
    console.log('        HEADLINE: ' + b.headline);
    for (const line of b.willFail) console.log('        FAIL:     ' + line);
    for (const line of b.dispatchToday) console.log('        DISPATCH: ' + line);
    for (const line of b.escalate) console.log('        ESCALATE: ' + line);
    if (b.dataGaps) console.log('        GAPS:     ' + b.dataGaps);
    console.log(
      '        cited ' + b.citedFacilities.length + ' facilities, ' + b.citedDrugs.length + ' drugs; dropped ' +
        b.droppedCitations.length + '; ' + calls.length + ' calls, ' + b.turns + ' turns, ' +
        b.elapsedMs + 'ms on ' + b.model,
    );

    const run: CapturedRun = {
      label,
      kind: 'brief',
      language,
      question: 'morning briefing',
      calls,
      text: [b.headline, ...b.willFail, ...b.dispatchToday, ...b.escalate],
      citedFacilities: b.citedFacilities,
      citedDrugs: b.citedDrugs,
      droppedCitations: b.droppedCitations,
      dataGaps: b.dataGaps,
      turns: b.turns,
      model: b.model,
      elapsedMs: b.elapsedMs,
    };
    captured.push(run);
    assertRun(label, run, { mustCallTools: true });
    check(label + ': briefing called several tools', calls.filter((t) => t.ok).length >= 3);
    check(label + ': all three sections are filled', b.willFail.length > 0 && b.dispatchToday.length > 0 && b.escalate.length > 0);
    await pace();
  }

  // --- 3 to 8: six questions across the tool surface ------------------------
  const questions: { label: string; question: string; language: 'en' | 'hi' | 'hinglish'; expect: 'answer' | 'decline' }[] = [
    {
      label: 'Vital drugs at risk',
      question: 'Which facilities will run out of a Vital drug in the next two weeks?',
      language: 'en',
      expect: 'answer',
    },
    {
      label: 'Dispatch and cost',
      question: 'What should I dispatch today, and what will it cost?',
      language: 'en',
      expect: 'answer',
    },
    {
      label: 'Hindi · which centre',
      question: 'Bastar mein kaun se centre par dawa khatam hone wali hai?',
      language: 'hi',
      expect: 'answer',
    },
    {
      /*
       * The case that matters most.
       *
       * Nothing in this system models a budget. There is a transport cost and
       * an indicative unit price, and a model willing to build a budget out of
       * those two is a model that will eventually build a stock figure out of
       * them too. The only correct answer is that the data does not exist.
       */
      label: 'Out of scope · budget',
      question: "What is the district's budget for next year?",
      language: 'en',
      expect: 'decline',
    },
    {
      label: 'Combined · risk + catalogue + transfer',
      question:
        'Which medicine has the worst stock-out risk in Bastar right now, does it need cold chain, and can anyone in the district send some?',
      language: 'en',
      expect: 'answer',
    },
    {
      label: 'Combined · national context + method',
      question: 'How does Bastar compare with the worst districts in the country, and how was its forecast actually worked out?',
      language: 'en',
      expect: 'answer',
    },
  ];

  for (const q of questions) {
    if (!selected(q.label)) continue;
    console.log('\n  --- ' + q.label + ' [' + q.language + ']: "' + q.question + '"');
    const a = await askGrid({ districtCode: LIVE_DISTRICT, question: q.question, language: q.language });
    const calls = await replay(a.trace);
    printTrace(calls);
    console.log('        ANSWER: ' + a.answer.replace(/\n/g, '\n                '));
    if (a.dataGaps) console.log('        GAPS:   ' + a.dataGaps);
    if (a.followUps.length) console.log('        NEXT:   ' + a.followUps.join(' | '));
    console.log(
      '        cited ' + a.citedFacilities.length + ' facilities, ' + a.citedDrugs.length + ' drugs; dropped ' +
        a.droppedCitations.length + '; ' + calls.length + ' calls, ' + a.turns + ' turns, ' +
        a.elapsedMs + 'ms on ' + a.model,
    );

    const run: CapturedRun = {
      label: q.label,
      kind: 'ask',
      language: q.language,
      question: q.question,
      calls,
      text: [a.answer],
      citedFacilities: a.citedFacilities,
      citedDrugs: a.citedDrugs,
      droppedCitations: a.droppedCitations,
      dataGaps: a.dataGaps,
      turns: a.turns,
      model: a.model,
      elapsedMs: a.elapsedMs,
    };
    captured.push(run);
    assertRun(q.label, run, { mustCallTools: q.expect === 'answer' });

    if (q.expect === 'decline') {
      /*
       * "Declined" is not "used the word cannot". It is: named the gap, and
       * left no figure in the prose that reads as an answer. A reply of "I
       * cannot give you the budget, but transport costs Rs 20,957" has not
       * declined -- it has answered a different question with a number the
       * officer will take for theirs.
       */
      check(
        q.label + ': the gap is stated',
        a.dataGaps.trim().length > 0 || /cannot|do not have|not available|no data|unable/i.test(a.answer),
      );
      check(
        q.label + ': no budget figure was offered',
        !/(budget|allocation|crore|lakh)[^.]{0,60}(₹|rs\.?\s*)?\d/i.test(a.answer),
        a.answer.slice(0, 300),
      );
    }
    await pace();
  }
}

// ---------------------------------------------------------------------------
/*
 * The number audit: the only check that can catch a confident fabrication.
 *
 * Citation checking already proves the model named no facility and no medicine
 * a tool did not return, but a name is the easy half. The dangerous failure is
 * a real facility, a real medicine and a QUANTITY that came from nowhere -- an
 * officer cannot tell that apart from a correct answer, which is exactly why a
 * person reading the output is not sufficient and it has to be machine-checked.
 *
 * So: every numeric token in the prose is matched against every number that
 * appeared anywhere in the payloads the model was handed, including numbers
 * embedded in the optimiser's rationale sentences. A token with no source is
 * printed with its context and fails the suite. Devanagari digits are folded to
 * Latin first, because a Hindi answer that writes १५ is stating the same
 * quantity and is held to the same standard.
 */
console.log('\n=== 7. Number audit — every figure in the prose traced to a payload ===');

function foldDigits(text: string): string {
  return text.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}

/** One canonical form per value, so 1,701 and 1701 and 1701.0 are one number. */
function numKey(n: number): string {
  return String(Number(n.toFixed(4)));
}

const NUMBER_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

function harvest(value: unknown, into: Set<string>): void {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) into.add(numKey(value));
    return;
  }
  if (typeof value === 'string') {
    for (const m of foldDigits(value).matchAll(NUMBER_TOKEN)) {
      const n = Number(m[0].replace(/,/g, ''));
      if (Number.isFinite(n)) into.add(numKey(n));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) harvest(v, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) harvest(v, into);
  }
}

if (captured.length === 0) {
  console.log('  (no live runs captured — nothing to audit)');
} else {
  for (const run of captured) {
    const sourced = new Set<string>();
    for (const call of run.calls) harvest(call.payload, sourced);
    // The officer's own words are a legitimate source for a number in the reply.
    harvest(run.question, sourced);

    const unsourced: { token: string; context: string }[] = [];
    for (const line of [...run.text, run.dataGaps]) {
      const folded = foldDigits(line);
      for (const m of folded.matchAll(NUMBER_TOKEN)) {
        const n = Number(m[0].replace(/,/g, ''));
        if (!Number.isFinite(n) || sourced.has(numKey(n))) continue;
        const at = m.index ?? 0;
        unsourced.push({
          token: m[0],
          context: folded.slice(Math.max(0, at - 45), at + m[0].length + 30).replace(/\s+/g, ' '),
        });
      }
    }

    check(run.label + ': every number in the prose came from a payload', unsourced.length === 0, unsourced.length + ' unsourced');
    for (const u of unsourced) console.log('          UNSOURCED ' + u.token + '  in: …' + u.context + '…');
  }

  writeFileSync(OUT_PATH, JSON.stringify(captured, null, 2), 'utf8');
  console.log('\n  captured ' + captured.length + ' runs -> ' + OUT_PATH);
}

// ---------------------------------------------------------------------------
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
