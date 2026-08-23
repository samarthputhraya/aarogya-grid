'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Facility } from '@/lib/domain/types';
import type { DraftStockReport, DraftEntry } from '@/lib/ai/stock-report';
import { EmptyState, FOCUS_RING } from './ui/primitives';
import { count, FACILITY_LABEL } from '@/lib/format';

/**
 * Field capture console.
 *
 * The demo surface for the part of the system that attacks data GENESIS rather
 * than data presentation. Everything here ends in a DRAFT that a human approves
 * -- there is deliberately no path from "the model heard something" to "the
 * ledger changed".
 */

type Mode = 'text' | 'audio' | 'register';

const SAMPLES: { label: string; language: string; text: string; note: string }[] = [
  {
    label: 'Hindi · routine report',
    language: 'हिन्दी',
    text: 'Namaste, PHC se bol rahe hain. Aaj paracetamol pachas tablet bache hain, ORS ke sau packet hain, aur lal goli do sau. Anti snake venom bilkul khatam ho gaya hai, monsoon mein zaroorat padegi.',
    note: 'Mixed Hindi-English, Indian number words, a vernacular drug name, and a note that is not a stock figure.',
  },
  {
    label: 'English · clipped',
    language: 'English',
    text: 'We have two thousand paracetamol, 150 ORS sachets, zinc 300 tablets. Monocef is finished since Tuesday.',
    note: 'Brand name (Monocef = Ceftriaxone) and an implicit zero.',
  },
  {
    label: 'Marathi · with a problem',
    language: 'मराठी',
    text: 'Paracetamol dedh sau tablet, ORS chaalis packet, ani oxytocin chaar ampoule urle aahet. Fridge don divas band aahe.',
    note: 'A broken refrigerator matters for cold-chain items and belongs in notes, not in a stock figure.',
  },
  {
    label: 'Deliberately wrong',
    language: 'English',
    text: 'Paracetamol fifty thousand tablets left, and three strips of zinc.',
    note: 'An order-of-magnitude error and a container-unit ambiguity. Both should be caught, not accepted.',
  },
];

export default function CaptureConsole({
  facilities,
}: {
  facilities: Facility[];
}) {
  /*
   * Backend availability, settled at REQUEST time.
   *
   * This page is prerendered, so an `isConfigured()` computed in the server
   * component ran during `next build` -- in a container with none of the
   * deployment's environment -- and the live console announced
   * "GEMINI_API_KEY NOT SET" while the service was authenticating to Vertex
   * perfectly well. Exactly the trap /api/ask fell into, in a second place.
   *
   * Optimistic until the server contradicts it: a false alarm on a working
   * system is more expensive than a click that returns a clean 503.
   */
  const [liveConfigured, setLiveConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/capture', { method: 'GET', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setLiveConfigured(Boolean(d.configured));
      })
      // Failing to ask is not an answer. Leave the optimistic default alone.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const configured = liveConfigured ?? true;
  /** Only a confirmed negative justifies the warning. */
  const knownUnconfigured = liveConfigured === false;

  const [mode, setMode] = useState<Mode>('text');
  const [facilityId, setFacilityId] = useState(facilities[0]?.id ?? '');
  const [text, setText] = useState(SAMPLES[0].text);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    draft: DraftStockReport;
    model: string;
    elapsedMs: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function submit(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facilityId, ...payload }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? 'Request failed');
      } else {
        setResult(json);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const buf = await blob.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        await submit({ kind: 'audio', mediaBase64: b64, mimeType: recorder.mimeType.split(';')[0] });
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError('Microphone permission denied or unavailable in this browser.');
    }
  }

  async function onFile(file: File) {
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    await submit({ kind: 'register', mediaBase64: btoa(binary), mimeType: file.type });
  }

  const facility = facilities.find((f) => f.id === facilityId);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/95 backdrop-blur">
        <div className="mx-auto max-w-[1200px] px-4 py-3 flex items-center gap-4">
          <Link
            href="/"
            className={'text-mist-400 hover:text-mist-100 text-xs rounded px-1 -mx-1 ' + FOCUS_RING}
          >
            ← Grid
          </Link>
          <div className="h-6 w-px bg-ink-700" />
          <div>
            <h1 className="text-sm font-semibold leading-none">Field capture</h1>
            <p className="text-[10px] text-mist-400 mt-1 leading-none">
              Speak it, or photograph the register. Nothing commits without review.
            </p>
          </div>
          <div className="flex-1" />
          {knownUnconfigured && (
            <span className="text-[10px] px-2 py-1 rounded border border-sev-high/40 bg-sev-high/10 text-sev-high">
              GEMINI_API_KEY NOT SET
            </span>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-4 py-4 space-y-4">
        {/* why this exists */}
        <section className="panel p-4">
          <h2 className="text-xs font-semibold text-mist-100 mb-2">
            Why the data is missing in the first place
          </h2>
          <p className="text-[11px] text-mist-300 leading-relaxed max-w-3xl">
            India&rsquo;s primary health network does not lack dashboards. It lacks the
            keystrokes that would fill one. The person who knows what is on the shelf is an
            ANM at a sub-centre with a paper register, a feature phone, and six other jobs.
            Every reporting system that asks her to open a laptop and type inherits the
            same silence. So this layer removes the keyboard: she says the numbers in her
            own language, or photographs the page she already fills in by hand.
          </p>
        </section>

        {/* facility + mode */}
        <section className="panel p-4 space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <label className="flex-1 min-w-[280px]">
              <span className="block text-[10px] uppercase tracking-wider text-mist-400 mb-1">
                Reporting facility
              </span>
              <select
                value={facilityId}
                onChange={(e) => setFacilityId(e.target.value)}
                disabled={facilities.length === 0}
                className={
                  'w-full bg-ink-850 border border-ink-600 rounded px-2 py-1.5 text-xs ' +
                  'text-mist-100 disabled:opacity-50 ' +
                  FOCUS_RING
                }
              >
                {facilities.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} — {f.districtName}, {f.stateName}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex gap-1">
              {(['text', 'audio', 'register'] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={
                    'px-3 py-1.5 rounded text-[11px] border transition-colors ' +
                    FOCUS_RING +
                    ' ' +
                    (mode === m
                      ? 'border-brand/50 bg-brand/10 text-brand'
                      : 'border-ink-600 text-mist-400 hover:text-mist-200 hover:border-ink-500')
                  }
                >
                  {m === 'text' ? 'Type' : m === 'audio' ? 'Speak' : 'Register photo'}
                </button>
              ))}
            </div>
          </div>

          {facility ? (
            <p className="text-[10px] text-mist-500">
              {FACILITY_LABEL[facility.type]} · catchment {count(facility.population)} ·
              resupply from parent every ~{facility.type === 'SC' ? 14 : 10} days
            </p>
          ) : (
            /* No roster means nothing can be attributed, so say that here rather
               than leaving an empty select over a live Extract button. */
            <p className="text-[10px] text-sev-high">
              No facility roster is available, so a report has nothing to be filed against.
            </p>
          )}

          {/* --- text mode --- */}
          {mode === 'text' && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {SAMPLES.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => setText(s.text)}
                    title={s.note}
                    aria-pressed={s.text === text}
                    className={
                      'text-[10px] px-2 py-1 rounded border transition-colors ' +
                      FOCUS_RING +
                      ' ' +
                      (s.text === text
                        ? 'border-brand/50 bg-brand/10 text-brand'
                        : 'border-ink-600 text-mist-400 hover:text-mist-100 hover:border-ink-500')
                    }
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                className={
                  'w-full bg-ink-850 border border-ink-600 rounded px-3 py-2 text-xs ' +
                  'text-mist-100 font-mono leading-relaxed focus:border-brand/50 ' +
                  FOCUS_RING
                }
                placeholder="Type what a health worker would say..."
              />
              <button
                onClick={() => submit({ kind: 'text', text })}
                disabled={busy || !configured || !facilityId}
                className={
                  'px-4 py-2 rounded bg-brand/15 border border-brand/50 text-brand text-xs ' +
                  'hover:bg-brand/25 disabled:opacity-40 disabled:cursor-not-allowed ' +
                  'transition-colors ' +
                  FOCUS_RING
                }
              >
                {busy ? 'Extracting…' : 'Extract stock report'}
              </button>
            </>
          )}

          {/* --- audio mode --- */}
          {mode === 'audio' && (
            <div className="space-y-2">
              <p className="text-[11px] text-mist-400">
                Record a stock report in any Indian language. Audio goes to Gemini as-is —
                transcription, translation and extraction happen in one pass.
              </p>
              <button
                onClick={toggleRecording}
                disabled={busy || !configured || !facilityId}
                className={
                  'px-4 py-2 rounded text-xs border transition-colors disabled:opacity-40 ' +
                  FOCUS_RING +
                  ' ' +
                  (recording
                    ? 'bg-sev-critical/15 border-sev-critical/50 text-sev-critical'
                    : 'bg-brand/15 border-brand/50 text-brand hover:bg-brand/25')
                }
              >
                {recording ? '◼ Stop and extract' : '● Start recording'}
              </button>
            </div>
          )}

          {/* --- register mode --- */}
          {mode === 'register' && (
            <div className="space-y-2">
              <p className="text-[11px] text-mist-400">
                Photograph a handwritten stock register page. Rows are extracted verbatim —
                the arithmetic is checked separately, never silently corrected.
              </p>
              <input
                type="file"
                accept="image/*"
                disabled={busy || !configured || !facilityId}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                }}
                className={
                  'text-xs text-mist-300 file:mr-3 file:px-3 file:py-1.5 file:rounded ' +
                  'file:border file:border-brand/50 file:bg-brand/15 file:text-brand ' +
                  'file:text-xs file:cursor-pointer ' +
                  FOCUS_RING
                }
              />
            </div>
          )}
        </section>

        {busy && (
          <div className="panel p-4 text-xs text-mist-400">Sending to Gemini…</div>
        )}

        {error && (
          <div className="panel p-4 border-sev-critical/40">
            <p className="text-xs text-sev-critical font-semibold mb-1">Capture failed</p>
            <p className="text-[11px] text-mist-300">{error}</p>
          </div>
        )}

        {result && <DraftView result={result} />}
      </main>
    </div>
  );
}

function DraftView({
  result,
}: {
  result: { draft: DraftStockReport; model: string; elapsedMs: number };
}) {
  const { draft, model, elapsedMs } = result;
  const accepted = draft.entries.filter((e) => e.status === 'auto_accept').length;
  const confirm = draft.entries.filter((e) => e.status === 'needs_confirmation').length;
  const rejected = draft.entries.filter((e) => e.status === 'rejected').length;

  return (
    <section className="space-y-4">
      {(draft.transcript || draft.transcriptEnglish) && (
        <div className="panel">
          <div className="panel-head">
            <span>Transcript</span>
            <span className="normal-case tracking-normal text-mist-500">
              {draft.language} · {model} · {elapsedMs}ms
            </span>
          </div>
          <div className="p-3 space-y-2">
            {draft.transcript && (
              <p className="text-xs text-mist-100 leading-relaxed">{draft.transcript}</p>
            )}
            {draft.transcriptEnglish && draft.transcriptEnglish !== draft.transcript && (
              <p className="text-[11px] text-mist-400 italic leading-relaxed border-l-2 border-ink-600 pl-2">
                {draft.transcriptEnglish}
              </p>
            )}
            {draft.notes && (
              <p className="text-[11px] text-sev-moderate border-l-2 border-sev-moderate/40 pl-2">
                Noted: {draft.notes}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <span>Extracted stock entries</span>
          <span className="normal-case tracking-normal flex gap-2 tnum">
            <span className={accepted > 0 ? 'text-sev-low' : 'text-mist-500'}>{accepted} auto</span>
            <span className={confirm > 0 ? 'text-sev-moderate' : 'text-mist-500'}>
              {confirm} to confirm
            </span>
            <span className={rejected > 0 ? 'text-sev-critical' : 'text-mist-500'}>
              {rejected} rejected
            </span>
          </span>
        </div>
        {draft.entries.length === 0 ? (
          <EmptyState
            message="No stock figure was found in this report."
            detail="The model heard something, and none of it resolved to a quantity against a drug in the catalogue. Nothing is written; the transcript above is the whole of what came back."
          />
        ) : (
          <div className="divide-y divide-ink-800">
            {draft.entries.map((e, i) => (
              <EntryRow key={i} entry={e} />
            ))}
          </div>
        )}
      </div>

      <div className="panel p-3 flex items-center gap-3 flex-wrap">
        {/*
         * The commit control is deliberately inert, and now says so on the
         * button rather than only in the paragraph beside it. There is no stock
         * ledger behind this build, and a live-looking button that silently
         * does nothing is the one thing on this page that would undermine the
         * argument it exists to make.
         */}
        <button
          disabled
          title={
            rejected > 0 || confirm > 0
              ? 'Flagged entries would have to be resolved before this could commit'
              : 'No stock ledger is connected in this build'
          }
          className="px-4 py-2 rounded bg-brand/15 border border-brand/50 text-brand text-xs disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Commit {accepted} entr{accepted === 1 ? 'y' : 'ies'} to ledger
        </button>
        <p className="text-[10px] text-mist-500 flex-1 min-w-[240px] leading-relaxed">
          {rejected > 0 || confirm > 0
            ? 'Flagged entries need a human decision. This is the point of the design: a model that is unsure must say so rather than write a number into a national inventory.'
            : 'Every entry cleared automatically. In production this posts to the stock ledger and re-runs the risk model for this facility; no ledger is connected here, so the button is inert by construction rather than by oversight.'}
        </p>
      </div>
    </section>
  );
}

function EntryRow({ entry }: { entry: DraftEntry }) {
  const statusClass =
    entry.status === 'auto_accept'
      ? 'border-sev-low/40 text-sev-low bg-sev-low/10'
      : entry.status === 'needs_confirmation'
        ? 'border-sev-moderate/40 text-sev-moderate bg-sev-moderate/10'
        : 'border-sev-critical/40 text-sev-critical bg-sev-critical/10';

  const statusLabel =
    entry.status === 'auto_accept'
      ? 'AUTO'
      : entry.status === 'needs_confirmation'
        ? 'CONFIRM'
        : 'REJECTED';

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start gap-3 flex-wrap">
        <span className={'text-[10px] px-1.5 py-0.5 rounded border shrink-0 ' + statusClass}>
          {statusLabel}
        </span>

        <div className="flex-1 min-w-[200px]">
          <div className="text-xs text-mist-100">
            {entry.drug ? (
              <>
                {entry.drug.name}{' '}
                <span className="text-mist-500">{entry.drug.strength}</span>
              </>
            ) : (
              <span className="text-sev-critical">unmatched</span>
            )}
          </div>
          <div className="text-[10px] text-mist-500 italic mt-0.5">
            heard: &ldquo;{entry.spokenText}&rdquo;
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="tnum text-sm text-mist-100">
            {count(entry.quantity)}
            <span className="text-[10px] text-mist-500 ml-1">
              {entry.drug?.unit ?? entry.unitGuess}
            </span>
          </div>
          <div className="text-[10px] text-mist-500">{entry.kind.replace(/_/g, ' ')}</div>
        </div>

        <div className="text-right shrink-0 w-20">
          <div className="text-[10px] text-mist-400">
            match{' '}
            <span className="tnum">
              {entry.resolution.best ? (entry.resolution.best.confidence * 100).toFixed(0) : 0}%
            </span>
          </div>
          <div className="text-[10px] text-mist-500">
            heard <span className="tnum">{(entry.modelConfidence * 100).toFixed(0)}%</span>
          </div>
        </div>
      </div>

      {entry.flags.length > 0 && (
        <ul className="mt-2 space-y-1 pl-1">
          {entry.flags.map((f, i) => (
            <li
              key={i}
              className={
                'text-[10px] leading-relaxed border-l-2 pl-2 ' +
                (f.severity === 'block'
                  ? 'border-sev-critical/50 text-sev-critical'
                  : f.severity === 'warn'
                    ? 'border-sev-moderate/50 text-sev-moderate'
                    : 'border-ink-600 text-mist-400')
              }
            >
              {f.message}
            </li>
          ))}
        </ul>
      )}

      {/*
        The runners-up from the drug resolver, as evidence rather than as
        controls. They were <button>s that took no handler -- a row of things
        that highlight on hover, look exactly like the sample chips above, and
        do nothing when pressed. Since the resolution a human picks would have
        to travel back to the ledger, and nothing in this build has a ledger,
        the honest rendering is the one that does not offer a choice it cannot
        keep: this is what else the matcher considered, and how close it came.
      */}
      {entry.resolution.alternatives.length > 0 && entry.status !== 'auto_accept' && (
        <div className="mt-2 flex gap-1.5 flex-wrap items-center">
          <span className="text-[10px] text-mist-500">also considered:</span>
          {entry.resolution.alternatives.slice(0, 3).map((alt) => (
            <span
              key={alt.drug.id}
              className="text-[10px] px-1.5 py-0.5 rounded border border-ink-700 text-mist-400"
            >
              {alt.drug.name}{' '}
              <span className="tnum text-mist-500">{(alt.confidence * 100).toFixed(0)}%</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
