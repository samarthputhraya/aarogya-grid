'use client';

import { useEffect, useState } from 'react';
import { count } from '@/lib/format';
import { EmptyState, FOCUS_RING } from './ui/primitives';

/**
 * Observed surveillance: the one layer on the console that is not simulated.
 *
 * WHY THIS PANEL EXISTS
 * ---------------------
 * Everything else on this page describes a simulated network, and says so. This
 * panel is the exception, and it has to say THAT just as plainly: the signals
 * here come from notified disease cases that Kerala's State Surveillance Unit
 * published in its IDSP daily bulletins, read out of the PDFs deterministically
 * and passed through the same detector and the same tuned rule as the simulated
 * feed. Each row links the bulletin its last day came from.
 *
 * It also says the uncomfortable part: the rule's precision and lead time were
 * measured on simulated surges, and there is no record of past Kerala outbreaks
 * here to measure it against. A signal on two cases of hepatitis A against an
 * expected 1.6 is shown as exactly that, with the numbers, rather than as an
 * alarm.
 *
 * Read from `/api/indicators?provenance=observed` at request time, so the
 * nightly batch that ingests new bulletins reaches it without a redeploy.
 */

interface ObservedSignal {
  id: string;
  hazardLabel: string;
  area: { name: string; population: number };
  observedFrom: string;
  observedTo: string;
  metric: string;
  observedValue: number;
  expectedUpperBound: number;
  exceedanceRatio: number;
  confidence: string;
  sourceDocument?: { url: string; sha256: string };
}

interface ObservedFeed {
  sources: { provenance: string; description: string; dataThrough: string; signals: number }[];
  signals: ObservedSignal[];
  method: { detector: string; consecutiveDays: number; excessAboveUpperBound: number };
}

const fmtDay = (iso: string) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export default function ObservedSurveillancePanel() {
  const [feed, setFeed] = useState<ObservedFeed | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/indicators?provenance=observed')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => live && setFeed(d as ObservedFeed))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const source = feed?.sources.find((s) => s.provenance === 'observed');

  return (
    <section className="panel" aria-labelledby="observed-surveillance">
      <div className="panel-head">
        <span id="observed-surveillance">
          Observed surveillance · Kerala IDSP{' '}
          <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded border border-sev-low/40 bg-sev-low/10 text-sev-low normal-case tracking-normal">
            real data
          </span>
        </span>
        <span className="text-mist-500 normal-case tracking-normal">
          {source ? 'bulletins through ' + fmtDay(source.dataThrough) : failed ? 'feed unavailable' : '…'}
        </span>
      </div>

      <p className="px-3 pt-2.5 text-[11px] leading-relaxed text-mist-400 max-w-4xl">
        {source ? source.description + ' ' : ''}
        The same {feed?.method.detector ?? 'detector'} and the same rule as the simulated feed ({feed?.method.consecutiveDays ?? 2}{' '}
        consecutive days above the model&rsquo;s upper bound by at least{' '}
        {Math.round((feed?.method.excessAboveUpperBound ?? 0.1) * 100)}%). Its precision and lead time were measured on
        simulated surges; nothing here validates them on Kerala&rsquo;s own history.
      </p>

      {feed && feed.signals.length === 0 ? (
        <EmptyState message="No district is above its expected range in the latest bulletins." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs mt-2">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-mist-500 border-b border-ink-800">
                <th className="px-3 py-1.5 font-medium">District</th>
                <th className="px-3 py-1.5 font-medium">What rose</th>
                <th className="px-3 py-1.5 font-medium">Days</th>
                <th className="px-3 py-1.5 font-medium text-right">Reported</th>
                <th className="px-3 py-1.5 font-medium text-right">Expected at most</th>
                <th className="px-3 py-1.5 font-medium">Confidence</th>
                <th className="px-3 py-1.5 font-medium">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {(feed?.signals ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-1.5 text-mist-100">{s.area.name}</td>
                  <td className="px-3 py-1.5 text-mist-300">{s.hazardLabel.replace(/ above the expected range$/, '')}</td>
                  <td className="px-3 py-1.5 text-mist-400 tnum">
                    {fmtDay(s.observedFrom)}–{fmtDay(s.observedTo)}
                  </td>
                  <td className="px-3 py-1.5 text-right tnum text-mist-100">{count(s.observedValue)}</td>
                  {/* One decimal for a small bound: "2 reported, 2 expected" reads as
                      nothing happening when the model's bound was 1.6. */}
                  <td className="px-3 py-1.5 text-right tnum text-mist-400">
                    {s.expectedUpperBound < 10 ? s.expectedUpperBound.toFixed(1) : count(Math.round(s.expectedUpperBound))}
                  </td>
                  <td className="px-3 py-1.5 text-mist-400">{s.confidence}</td>
                  <td className="px-3 py-1.5">
                    {s.sourceDocument && (
                      <a
                        href={s.sourceDocument.url}
                        target="_blank"
                        rel="noreferrer"
                        title={'SHA-256 ' + s.sourceDocument.sha256}
                        className={'text-brand underline decoration-dotted rounded ' + FOCUS_RING}
                      >
                        bulletin
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-3 py-2 text-[10px] text-mist-600">
        Counts over the days shown, summed. Every signal is in the interoperable feed at{' '}
        <a href="/api/indicators?provenance=observed" className="underline decoration-dotted">
          /api/indicators?provenance=observed
        </a>
        .
      </p>
    </section>
  );
}
