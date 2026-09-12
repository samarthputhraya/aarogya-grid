'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Facility } from '@/lib/domain/types';
import type { DraftStockReport, DraftEntry } from '@/lib/ai/stock-report';
import { DurabilityChip, EmptyState, FOCUS_RING } from './ui/primitives';
import { count, FACILITY_LABEL } from '@/lib/format';
import { toBase64, MAX_MEDIA_BYTES } from '@/lib/base64';
import { useGridEvents, positionKey } from '@/lib/hooks/useGridEvents';
import type { StockEvent } from '@/lib/overlay/store';

/**
 * Field capture console.
 *
 * The demo surface for the part of the system that attacks data GENESIS rather
 * than data presentation. Everything here ends in a DRAFT that a human approves
 * -- there is deliberately no path from "the model heard something" to "the
 * ledger changed".
 */

type Mode = 'text' | 'audio' | 'register';

/** How a report reached us. Stamped on the committed event and shown in the audit trail. */
type CommitSource = 'voice' | 'photo' | 'typed';

/** What `POST /api/commit` answers with. Mirrors the route; nothing is inferred. */
interface CommitResponse {
  facilityId: string;
  facilityName: string;
  committed: StockEvent[];
  rejected: { drugName: string; reason: string; suggestion?: string; confidence?: number }[];
  recomputeMs: number;
  durability: string;
}

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
    id: number;
    draft: DraftStockReport;
    model: string;
    elapsedMs: number;
    source: CommitSource;
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
        // The source is decided here rather than in the draft: it is a fact
        // about how the report reached us, and the audit trail needs it to say
        // "a person spoke this" rather than "a client claimed it was spoken".
        const source: CommitSource =
          payload.kind === 'audio' ? 'voice' : payload.kind === 'register' ? 'photo' : 'typed';
        setResult({ ...json, id: Date.now(), source });
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
        // Nothing outside this handler can catch what it throws -- it is called
        // by the browser, not awaited by us -- so every failure between the
        // microphone and the request has to surface from in here or it does not
        // surface at all.
        try {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
          const buf = await blob.arrayBuffer();
          if (buf.byteLength > MAX_MEDIA_BYTES) {
            setError(
              'That recording is too long to send (' +
                (buf.byteLength / 1024 / 1024).toFixed(1) +
                ' MB). Record the shelf a few drugs at a time.',
            );
            return;
          }
          await submit({
            kind: 'audio',
            mediaBase64: toBase64(buf),
            mimeType: recorder.mimeType.split(';')[0],
          });
        } catch (e) {
          setBusy(false);
          setError(
            'Could not encode the recording: ' + (e instanceof Error ? e.message : String(e)),
          );
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError('Microphone permission denied or unavailable in this browser.');
    }
  }

  async function onFile(file: File) {
    // A phone camera clears 6 MB without trying, and the proxy rejects the
    // request on Content-Length before any handler sees it. Saying so here
    // costs nothing; finding out from a 413 costs the upload.
    if (file.size > MAX_MEDIA_BYTES) {
      setError(
        'That photo is ' +
          (file.size / 1024 / 1024).toFixed(1) +
          ' MB, over the ' +
          (MAX_MEDIA_BYTES / 1024 / 1024).toFixed(1) +
          ' MB limit. Retake it at a lower resolution.',
      );
      return;
    }
    const buf = await file.arrayBuffer();
    await submit({ kind: 'register', mediaBase64: toBase64(buf), mimeType: file.type });
  }

  const facility = facilities.find((f) => f.id === facilityId);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/95 backdrop-blur">
        <div className="mx-auto max-w-[1200px] px-4 py-3 flex items-center gap-4">
          <Link
            href="/console"
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

        {result && (
          <DraftView key={result.id} result={result} facilityId={facilityId} />
        )}
      </main>
    </div>
  );
}

/**
 * The draft, and the decision.
 *
 * WHAT CHANGED ON DAY 8, AND WHY IT MATTERS MORE THAN IT LOOKS
 * -----------------------------------------------------------
 * Until now the commit control was deliberately inert and said so: there was no
 * ledger behind this build, and a live-looking button that silently did nothing
 * would have undermined the whole argument the page exists to make.
 *
 * There is a ledger now -- the live overlay in front of the snapshot, backed by
 * an append-only BigQuery log -- so the button commits, and the "also
 * considered" chips are real controls instead of evidence. A human who thinks
 * the matcher picked the wrong drug can pick the right one and the report goes
 * through; a human who thinks the quantity was misheard can correct it.
 *
 * THE CLIENT DECIDES NOTHING
 * --------------------------
 * What travels to `/api/commit` is a drug NAME and a quantity -- never a drug
 * id, never a status. The server resolves the name against the catalogue, the
 * facility's formulary and the same confidence threshold the draft used. That
 * is the security boundary of the feature and it is on the far side of this
 * file: a human picking from the alternatives here is supplying a catalogue
 * name the resolver will match exactly, not overriding the resolver.
 */
function DraftView({
  result,
  facilityId,
}: {
  result: { draft: DraftStockReport; model: string; elapsedMs: number; source: CommitSource };
  facilityId: string;
}) {
  const { draft, model, elapsedMs } = result;
  const accepted = draft.entries.filter((e) => e.status === 'auto_accept').length;
  const confirm = draft.entries.filter((e) => e.status === 'needs_confirmation').length;
  const rejected = draft.entries.filter((e) => e.status === 'rejected').length;

  /** Catalogue name per row -- what actually gets sent. */
  const [chosen, setChosen] = useState<Record<number, string>>(() => {
    const out: Record<number, string> = {};
    draft.entries.forEach((e, i) => {
      if (e.drug) out[i] = e.drug.name;
    });
    return out;
  });
  const [qty, setQty] = useState<Record<number, number>>(() => {
    const out: Record<number, number> = {};
    draft.entries.forEach((e, i) => {
      out[i] = Math.max(0, Math.round(e.quantity));
    });
    return out;
  });
  /**
   * Ticked rows. Only what the model was sure of starts ticked: a flagged row
   * is exactly the case where a human decision is the product, so pre-ticking
   * it would turn the review into a formality.
   */
  const [picked, setPicked] = useState<Set<number>>(
    () => new Set(draft.entries.map((e, i) => (e.status === 'auto_accept' ? i : -1)).filter((i) => i >= 0)),
  );

  const [committing, setCommitting] = useState(false);
  const [outcome, setOutcome] = useState<CommitResponse | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  // Live, so the durability chip on a committed row stops saying "queued" by
  // itself. The same hook the consoles use; the same two sources.
  const live = useGridEvents(outcome !== null);

  const committable = (i: number) => Boolean(chosen[i]) && Number.isFinite(qty[i]) && qty[i] >= 0;
  const selected = [...picked].filter(committable).sort((a, b) => a - b);

  async function commit() {
    setCommitting(true);
    setCommitError(null);
    try {
      const res = await fetch('/api/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId,
          source: result.source,
          entries: selected.map((i) => ({ drugName: chosen[i], onHand: qty[i] })),
        }),
      });
      const json = (await res.json()) as CommitResponse & { error?: string };
      if (!res.ok && res.status !== 207) {
        // 422 still carries the per-entry reasons, and those are the useful part.
        if (!json.rejected) {
          setCommitError(json.error ?? 'Commit failed with ' + res.status);
          return;
        }
      }
      setOutcome(json);
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  }

  const committedByName = new Map((outcome?.committed ?? []).map((e) => [e.drugName, e]));
  const rejectedByName = new Map((outcome?.rejected ?? []).map((r) => [r.drugName, r]));

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
            {draft.entries.map((e, i) => {
              const name = chosen[i];
              const event = name ? committedByName.get(name) : undefined;
              return (
                <EntryRow
                  key={i}
                  entry={e}
                  chosenName={name}
                  quantity={qty[i]}
                  checked={picked.has(i)}
                  locked={outcome !== null || committing}
                  committed={
                    event
                      ? live.byPosition.get(positionKey(event.facilityId, event.drugId)) ?? event
                      : undefined
                  }
                  refused={name ? rejectedByName.get(name) : undefined}
                  onToggle={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                  onQuantity={(v) => setQty((prev) => ({ ...prev, [i]: v }))}
                  onPickDrug={(n) => {
                    setChosen((prev) => ({ ...prev, [i]: n }));
                    // Choosing a drug IS the confirmation; leaving the row
                    // unticked afterwards would just be a second click for the
                    // same decision.
                    setPicked((prev) => new Set(prev).add(i));
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      {commitError && (
        <div className="panel p-4 border-sev-critical/40">
          <p className="text-xs text-sev-critical font-semibold mb-1">Commit failed</p>
          <p className="text-[11px] text-mist-300">{commitError}</p>
        </div>
      )}

      {outcome ? (
        <div className="panel p-3 space-y-2">
          <p className="text-xs text-mist-100">
            <span className="text-sev-low font-semibold">
              {count(outcome.committed.length)} position
              {outcome.committed.length === 1 ? '' : 's'} committed
            </span>
            {outcome.rejected.length > 0 && (
              <span className="text-sev-critical">
                {' '}· {count(outcome.rejected.length)} refused by the server
              </span>
            )}
            <span className="text-mist-500"> · re-scored in {outcome.recomputeMs} ms</span>
          </p>
          <p className="text-[10px] text-mist-500 leading-relaxed">
            The risk board has already changed. Every console open on this grid was told over
            the event stream, and a reload will show it too — the correction is read back from
            the durable log, not held in the page.
          </p>
          <div className="flex gap-2 flex-wrap">
            <Link
              href="/console"
              className={
                'px-3 py-1.5 rounded bg-brand/15 border border-brand/50 text-brand text-xs ' +
                FOCUS_RING
              }
            >
              See it on the national board →
            </Link>
            {outcome.committed[0] && (
              <Link
                href={'/district/' + outcome.committed[0].districtCode}
                className={
                  'px-3 py-1.5 rounded border border-ink-700 text-mist-300 text-xs ' + FOCUS_RING
                }
              >
                Open {outcome.committed[0].districtCode.split('-').slice(2).join(' ')} →
              </Link>
            )}
          </div>
        </div>
      ) : (
        <div className="panel p-3 flex items-center gap-3 flex-wrap">
          <button
            onClick={commit}
            disabled={committing || selected.length === 0}
            title={
              selected.length === 0
                ? 'Tick the entries to commit. A flagged row needs a drug chosen first.'
                : 'Writes ' + selected.length + ' position(s) and re-scores them'
            }
            className={
              'px-4 py-2 rounded bg-brand/15 border border-brand/50 text-brand text-xs ' +
              'disabled:opacity-30 disabled:cursor-not-allowed ' +
              FOCUS_RING
            }
          >
            {committing
              ? 'Committing…'
              : 'Commit ' + selected.length + ' entr' + (selected.length === 1 ? 'y' : 'ies')}
          </button>
          <p className="text-[10px] text-mist-500 flex-1 min-w-[240px] leading-relaxed">
            {confirm + rejected > 0
              ? 'Flagged entries need a human decision — pick the right drug, or correct the number. ' +
                'This is the point of the design: a model that is unsure must say so rather than write ' +
                'a number into a national inventory.'
              : 'Every entry cleared automatically. Committing writes the position to the live grid, ' +
                're-scores it against the TimesFM forecast, and appends it to the durable log.'}
          </p>
        </div>
      )}
    </section>
  );
}

function EntryRow({
  entry,
  chosenName,
  quantity,
  checked,
  locked,
  committed,
  refused,
  onToggle,
  onQuantity,
  onPickDrug,
}: {
  entry: DraftEntry;
  chosenName?: string;
  quantity: number;
  checked: boolean;
  locked: boolean;
  committed?: StockEvent;
  refused?: { reason: string };
  onToggle: () => void;
  onQuantity: (v: number) => void;
  onPickDrug: (name: string) => void;
}) {
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
        <input
          type="checkbox"
          checked={checked}
          disabled={locked || !chosenName}
          onChange={onToggle}
          aria-label={'Commit ' + (chosenName ?? entry.spokenText)}
          className={'mt-0.5 accent-brand shrink-0 disabled:opacity-30 ' + FOCUS_RING}
        />
        <span className={'text-[10px] px-1.5 py-0.5 rounded border shrink-0 ' + statusClass}>
          {statusLabel}
        </span>

        <div className="flex-1 min-w-[200px]">
          <div className="text-xs text-mist-100">
            {chosenName ? (
              <>
                {chosenName}{' '}
                <span className="text-mist-500">{entry.drug?.strength}</span>
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
          <input
            type="number"
            min={0}
            step={1}
            value={Number.isFinite(quantity) ? quantity : 0}
            disabled={locked}
            onChange={(e) => onQuantity(Math.max(0, Math.floor(Number(e.target.value))))}
            aria-label={'Quantity for ' + (chosenName ?? entry.spokenText)}
            className={
              'w-24 bg-ink-900 border border-ink-700 rounded px-2 py-1 text-sm text-right ' +
              'tnum text-mist-100 disabled:opacity-50 ' + FOCUS_RING
            }
          />
          <div className="text-[10px] text-mist-500 mt-0.5">
            {entry.drug?.unit ?? entry.unitGuess} · {entry.kind.replace(/_/g, ' ')}
          </div>
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
        The runners-up from the drug resolver, as CONTROLS now rather than as
        evidence. They used to be <button>s with no handler -- a row of things
        that highlighted on hover and did nothing -- because a human's choice
        had nowhere to travel to. It has somewhere now: picking one sets the
        catalogue name this row will send, and the server resolves that name
        exactly as it resolves any other.
      */}
      {entry.resolution.alternatives.length > 0 && entry.status !== 'auto_accept' && !locked && (
        <div className="mt-2 flex gap-1.5 flex-wrap items-center">
          <span className="text-[10px] text-mist-500">also considered:</span>
          {entry.resolution.alternatives.slice(0, 3).map((alt) => (
            <button
              key={alt.drug.id}
              onClick={() => onPickDrug(alt.drug.name)}
              className={
                'text-[10px] px-1.5 py-0.5 rounded border transition-colors ' +
                (chosenName === alt.drug.name
                  ? 'border-brand/60 bg-brand/15 text-brand'
                  : 'border-ink-700 text-mist-400 hover:border-brand/40 hover:text-mist-100 ') +
                FOCUS_RING
              }
            >
              {alt.drug.name}{' '}
              <span className="tnum text-mist-500">{(alt.confidence * 100).toFixed(0)}%</span>
            </button>
          ))}
        </div>
      )}

      {committed && (
        <div className="mt-2 text-[10px] border-l-2 border-sev-low/50 pl-2 text-mist-300 leading-relaxed">
          committed · P(out){' '}
          <span className="tnum">
            {(committed.risk.previousStockoutProbability * 100).toFixed(0)}%
          </span>{' '}
          →{' '}
          <span className="tnum text-mist-100">
            {(committed.risk.stockoutProbability * 100).toFixed(0)}%
          </span>{' '}
          · {committed.risk.previousSeverity} → {committed.risk.severity} ·{' '}
          {committed.risk.forecastSource} · {committed.recomputeMs} ms ·{' '}
          <DurabilityChip event={committed} />
        </div>
      )}

      {refused && (
        <div className="mt-2 text-[10px] border-l-2 border-sev-critical/50 pl-2 text-sev-critical leading-relaxed">
          refused by the server: {refused.reason}
        </div>
      )}
    </div>
  );
}
