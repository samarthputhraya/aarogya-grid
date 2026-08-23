'use client';

import { useState } from 'react';
import type { GridAnswer, GridBriefing, GridLanguage, ToolTraceEntry } from '@/lib/ai/grid-agent';

/**
 * The grid assistant panel.
 *
 * WHAT IS ON SCREEN AND WHY
 * -------------------------
 * Two things, side by side and equally prominent: the answer, and the list of
 * tool calls that produced it. The trace is not a developer affordance hidden
 * behind a chevron. An officer is being told to send 19 doses of a vaccine 27
 * km down a road, and the only reason to believe that instruction is that the
 * number came out of the optimiser rather than out of a language model. So the
 * evidence sits next to the claim, always, with the arguments the model passed
 * and a one-line summary of what came back -- both written by the server, never
 * by the model.
 *
 * The suggested questions include Hindi because the officer this is for is more
 * likely to type "kaunsi dawa khatam ho rahi hai" than to type anything at all,
 * and a language toggle nobody presses is not multilingual support.
 */

const SUGGESTIONS: { label: string; question: string; language: GridLanguage; note: string }[] = [
  {
    label: 'What is failing?',
    question: 'What am I about to run out of in the next two weeks, and how bad is each one?',
    language: 'en',
    note: 'Spans the position table, the risk model and the VED classification.',
  },
  {
    label: 'What do I move today?',
    question: 'What should I physically dispatch today? Tell me who ships what to whom and off which batch.',
    language: 'en',
    note: 'Reads the optimiser\'s dispatch orders, including the batch pick list.',
  },
  {
    label: 'क्या भेजना है आज?',
    question: 'Aaj kaunsi dawa kahan bhejni hai? Batch number ke saath bataiye.',
    language: 'hi',
    note: 'The same question in Hinglish, answered in Hindi. The numbers are identical — only the prose changes.',
  },
  {
    label: 'What cannot be fixed?',
    question: 'Which needs could not be met by moving stock, and why? What do I have to escalate?',
    language: 'en',
    note: 'The honest question: the reason histogram is the most interesting number in the district and nothing else surfaces it.',
  },
  {
    label: 'How was this forecast made?',
    question: 'Explain how the forecast for the worked example was produced, and why it might be wrong.',
    language: 'en',
    note: 'Croston, censoring and the Monte Carlo reorder point, narrated without the model owning a single arithmetic step.',
  },
];

const LANGUAGES: { id: GridLanguage; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'हिन्दी' },
  { id: 'hinglish', label: 'Hinglish' },
];

type Mode = 'ask' | 'brief';

interface AskResponse extends GridAnswer {
  mode: 'ask';
  backend: string;
}
interface BriefResponse extends GridBriefing {
  mode: 'brief';
  backend: string;
}
type Result = AskResponse | BriefResponse;

export default function GridAssistant({
  districtCode,
  districtName,
  configured,
}: {
  districtCode: string;
  districtName: string;
  configured: boolean;
}) {
  const [question, setQuestion] = useState(SUGGESTIONS[0].question);
  const [language, setLanguage] = useState<GridLanguage>('en');
  const [busy, setBusy] = useState<Mode | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(mode: Mode, overrides: { question?: string; language?: GridLanguage } = {}) {
    setBusy(mode);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          districtCode,
          language: overrides.language ?? language,
          ...(mode === 'ask' ? { question: overrides.question ?? question } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) setError(json.message ?? 'Request failed');
      else setResult(json as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel" data-print="hide">
      <div className="panel-head">
        <span>Grid assistant · {districtName}</span>
        <span className="normal-case tracking-normal text-mist-500">
          Gemini plans the query · every number comes from a tool call
        </span>
      </div>

      <div className="p-3 space-y-3">
        <p className="text-[11px] text-mist-400 leading-relaxed max-w-3xl">
          This district&rsquo;s computed picture is {' '}
          <span className="text-mist-200">140 stock positions, 36 dispatch orders and 40 needs the
          optimiser declined</span>, and nobody reads a table that size at 8am. The model does not
          forecast anything and cannot do arithmetic here — it decides which rows answer the question
          and says so in your language. The audit trail below is what it actually read.
        </p>

        {!configured && (
          <p className="text-[10px] px-2 py-1 rounded border border-sev-high/40 bg-sev-high/10 text-sev-high inline-block">
            NO GEMINI BACKEND CONFIGURED — set GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT
          </p>
        )}

        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              title={s.note}
              onClick={() => {
                setQuestion(s.question);
                setLanguage(s.language);
              }}
              className="text-[10px] px-2 py-1 rounded border border-ink-600 text-mist-400 hover:text-mist-100 hover:border-ink-500 transition-colors"
            >
              {s.label}
            </button>
          ))}
        </div>

        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          disabled={!configured}
          className="w-full bg-ink-850 border border-ink-600 rounded px-3 py-2 text-xs text-mist-100 leading-relaxed disabled:opacity-50"
          placeholder="Ask about stock, dispatches or unmet need…"
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => run('ask')}
            disabled={!configured || busy !== null || !question.trim()}
            className="px-4 py-2 rounded bg-brand/15 border border-brand/50 text-brand text-xs hover:bg-brand/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy === 'ask' ? 'Working…' : 'Ask the grid'}
          </button>

          <button
            onClick={() => run('brief')}
            disabled={!configured || busy !== null}
            className="px-4 py-2 rounded border border-ink-600 text-mist-300 text-xs hover:text-mist-100 hover:border-ink-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="What fails, what to dispatch, what to escalate — grounded in tool output"
          >
            {busy === 'brief' ? 'Writing…' : 'Morning briefing'}
          </button>

          <div className="flex gap-1 ml-auto">
            {LANGUAGES.map((l) => (
              <button
                key={l.id}
                onClick={() => setLanguage(l.id)}
                className={
                  'px-2 py-1 rounded text-[10px] border transition-colors ' +
                  (language === l.id
                    ? 'border-brand/50 bg-brand/10 text-brand'
                    : 'border-ink-600 text-mist-400 hover:text-mist-200')
                }
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {busy && (
          <p className="text-[11px] text-mist-400">
            {busy === 'brief'
              ? 'Reading the position table, the dispatch plan and the unserved needs…'
              : 'Planning which tools answer this…'}
          </p>
        )}

        {error && (
          <div className="border border-sev-critical/40 rounded p-3">
            <p className="text-xs text-sev-critical font-semibold mb-1">The assistant could not answer</p>
            <p className="text-[11px] text-mist-300">{error}</p>
          </div>
        )}

        {result && <ResultView result={result} />}
      </div>
    </section>
  );
}

function ResultView({ result }: { result: Result }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.618fr)_minmax(0,1fr)] items-start">
        <div className="space-y-3">
          {result.mode === 'brief' ? <BriefingBody brief={result} /> : <AnswerBody answer={result} />}

          {result.dataGaps && (
            <p className="text-[11px] text-sev-moderate border-l-2 border-sev-moderate/40 pl-2 leading-relaxed">
              Not answerable from the computed data: {result.dataGaps}
            </p>
          )}

          {/*
            A non-empty dropped list means the model named something no tool
            returned. It is filtered out of the citations and shown here rather
            than hidden, because the failure it represents is the only one that
            matters in this product.
          */}
          {result.droppedCitations.length > 0 && (
            <p className="text-[11px] text-sev-critical border-l-2 border-sev-critical/40 pl-2">
              Dropped {result.droppedCitations.length} citation
              {result.droppedCitations.length === 1 ? '' : 's'} the tools never returned:{' '}
              {result.droppedCitations.join(', ')}
            </p>
          )}

          {(result.citedFacilities.length > 0 || result.citedDrugs.length > 0) && (
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] text-mist-500">grounded in:</span>
              {result.citedFacilities.map((f) => (
                <span key={f} className="text-[10px] px-1.5 py-0.5 rounded border border-ink-600 text-mist-300">
                  {f}
                </span>
              ))}
              {result.citedDrugs.map((d) => (
                <span key={d} className="text-[10px] px-1.5 py-0.5 rounded border border-brand/30 text-brand/90">
                  {d}
                </span>
              ))}
            </div>
          )}
        </div>

        <TraceView result={result} />
      </div>
    </div>
  );
}

function AnswerBody({ answer }: { answer: AskResponse }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-mist-100 leading-relaxed whitespace-pre-wrap">{answer.answer}</p>
      {answer.followUps.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {answer.followUps.map((f) => (
            <span
              key={f}
              className="text-[10px] px-2 py-1 rounded border border-ink-700 text-mist-500"
            >
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function BriefingBody({ brief }: { brief: BriefResponse }) {
  const sections: { title: string; lines: string[]; accent: string }[] = [
    { title: 'Will fail', lines: brief.willFail, accent: 'border-sev-critical/50' },
    { title: 'Dispatch today', lines: brief.dispatchToday, accent: 'border-brand/50' },
    { title: 'Escalate — no transfer can fix this', lines: brief.escalate, accent: 'border-sev-moderate/50' },
  ];

  return (
    <div className="space-y-3">
      <p className="text-xs text-mist-100 leading-relaxed font-semibold">{brief.headline}</p>
      {sections.map((s) => (
        <div key={s.title}>
          <p className="text-[10px] uppercase tracking-wider text-mist-400 mb-1">{s.title}</p>
          <ul className="space-y-1">
            {s.lines.map((line, i) => (
              <li
                key={i}
                className={'text-[11px] text-mist-200 leading-relaxed border-l-2 pl-2 ' + s.accent}
              >
                {line}
              </li>
            ))}
            {s.lines.length === 0 && (
              <li className="text-[11px] text-mist-500 pl-2">Nothing in this section.</li>
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * The audit trail.
 *
 * Every row is written server-side: the tool name came from our registry, the
 * arguments survived a Zod schema, and the summary was produced by the tool
 * itself. Nothing here is the model's account of what it did -- in testing it
 * reported calling a tool with a namespace prefix it had invented.
 */
function TraceView({ result }: { result: Result }) {
  const ok = result.trace.filter((t) => t.ok).length;

  return (
    <div className="border border-ink-700 rounded bg-ink-950/40">
      <div className="panel-head border-b border-ink-700">
        <span>Audit trail</span>
        <span className="normal-case tracking-normal text-mist-500 tnum">
          {ok}/{result.trace.length} calls · {result.turns} turns · {result.elapsedMs}ms
        </span>
      </div>

      <ol className="divide-y divide-ink-800">
        {result.trace.map((entry) => (
          <TraceRow key={entry.step} entry={entry} />
        ))}
        {result.trace.length === 0 && (
          <li className="px-3 py-2.5 text-[11px] text-sev-moderate">
            No tool was called. Nothing in the answer above is grounded in computed data.
          </li>
        )}
      </ol>

      <div className="px-3 py-2 border-t border-ink-800 text-[10px] text-mist-500 leading-relaxed">
        {result.model} · {result.backend === 'vertex' ? 'Vertex AI' : 'Gemini API'} · the model was
        shown no district codes, facility ids or drug codes, and performed no arithmetic.
      </div>
    </div>
  );
}

function TraceRow({ entry }: { entry: ToolTraceEntry }) {
  const args = Object.entries(entry.args);

  return (
    <li className="px-3 py-2 row-hover">
      <div className="flex items-baseline gap-2">
        <span className="tnum text-[10px] text-mist-500 w-4 shrink-0">{entry.step}</span>
        <span
          className={
            'text-[11px] font-medium ' + (entry.ok ? 'text-brand' : 'text-sev-critical')
          }
        >
          {entry.tool}
        </span>
        <span className="text-[10px] text-mist-500 tnum ml-auto shrink-0">{entry.elapsedMs}ms</span>
      </div>

      {args.length > 0 && (
        <div className="pl-6 mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
          {args.map(([key, value]) => (
            <span key={key} className="text-[10px] text-mist-500">
              {key}=<span className="text-mist-300">{JSON.stringify(value)}</span>
            </span>
          ))}
        </div>
      )}

      <p
        className={
          'pl-6 mt-0.5 text-[10px] leading-relaxed ' +
          (entry.ok ? 'text-mist-400' : 'text-sev-critical/80')
        }
      >
        {entry.ok ? '→ ' : '✕ '}
        {entry.summary}
      </p>
    </li>
  );
}
