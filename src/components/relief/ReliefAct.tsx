'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import ReliefStage from './ReliefStage';
import type { Beat } from '@/lib/relief/field';

/**
 * The act: one pinned section the whole national plan plays inside.
 *
 * This is the piece that makes the page an instrument rather than a brochure. The
 * relief owns the entire viewport, scroll drives the camera and the data state, and
 * the copy arrives as annotation ON the plan instead of in a column beside a picture
 * of it. There is exactly ONE pinned section on the page, because pinning more than
 * one or two fights the native scroll and wrecks touch.
 *
 * EVERYTHING IS A PURE FUNCTION OF SCROLL POSITION, never of an event sequence.
 * This project already learned that lesson expensively: the first scroll reveal was
 * an IntersectionObserver that hid each block and cleared it on intersection, and
 * anything the reader jumped past -- an anchor link, Ctrl+End, a fast flick --
 * stayed invisible for good, leaving 29 of 34 blocks blank. A progress-derived beat
 * has no such failure mode. Ctrl+End lands on the last beat, fully drawn, because
 * that is simply what `progress = 1` evaluates to.
 *
 * The pin is `position: sticky`, so native scrolling is never intercepted -- no wheel
 * handler, no scroll-jacking, no scroll-snap. The scrollbar keeps its real meaning and
 * the reader can always leave.
 */

interface BeatCopy {
  eyebrow: string;
  headline: React.ReactNode;
  body: React.ReactNode;
}

export interface ReliefActProps {
  copy: BeatCopy[];
  /** Rendered inside the stage as the non-WebGL fallback. */
  fallback: React.ReactNode;
  ledgerHref: string;
  consoleHref: string;
}

const BEAT_COUNT = 5;

export default function ReliefAct({
  copy,
  fallback,
  ledgerHref,
  consoleHref,
}: ReliefActProps) {
  const actRef = useRef<HTMLElement>(null);
  const [progress, setProgress] = useState(0);
  const [released, setReleased] = useState(false);
  const [reduced, setReduced] = useState(false);
  // Below the relief's viewport gate there is no canvas to choreograph, so the act
  // would be five screens of scroll driving a static SVG -- all of the cost of a
  // sequence and none of the sequence. Narrow viewports get the collapsed form
  // instead: one screen, every caption stacked and readable at once.
  const [narrow, setNarrow] = useState(false);

  // Reduced motion collapses the act to a single screen at its final state. The copy
  // is not lost -- every beat still renders, stacked, it just stops being paced by
  // scroll. A media query cannot reach a WebGL draw, so this is read in JS and
  // subscribed to, because a reader can toggle it mid-session.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Same gate the relief probe uses, so the two can never disagree about whether
  // there is a canvas to drive.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setNarrow(!mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Collapsed form: no canvas to choreograph (narrow), no motion wanted (reduced), or
  // the reader has taken control (released). Declared above the scroll loop because
  // that loop is gated on it.
  const flat = reduced || released || narrow;

  // A rAF loop, gated by an IntersectionObserver so it is not running at all once the
  // reader is past the act. One rect read per frame, no scroll listener.
  useEffect(() => {
    const el = actRef.current;
    if (!el || flat) return;

    let raf = 0;
    let running = false;

    const tick = () => {
      const rect = el.getBoundingClientRect();
      const travel = rect.height - window.innerHeight;
      const p = travel > 0 ? Math.min(1, Math.max(0, -rect.top / travel)) : 0;
      setProgress(p);
      raf = requestAnimationFrame(tick);
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !running) {
          running = true;
          raf = requestAnimationFrame(tick);
        } else if (!entry.isIntersecting && running) {
          running = false;
          cancelAnimationFrame(raf);
        }
      },
      { threshold: 0 },
    );

    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [flat]);

  const beatFloat = progress * BEAT_COUNT;
  const beat = Math.min(BEAT_COUNT - 1, Math.floor(beatFloat)) as Beat;
  const t = Math.min(1, beatFloat - beat);
  const effectiveBeat: Beat = flat ? 4 : beat;

  const skip = useCallback(() => {
    setReleased(true);
    // Leave the pin behind rather than stranding the reader mid-act with a released
    // map above them and four screens of empty scroll below.
    const next = actRef.current?.nextElementSibling;
    next?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  // Collapsed: the stage sizes to its content instead of pinning a viewport.
  const actHeight = flat ? 'auto' : `${BEAT_COUNT * 100}svh`;

  return (
    <section
      ref={actRef}
      style={{ height: actHeight }}
      className="relative"
      data-relief-act=""
      data-beat={effectiveBeat}
    >
      <div
        className={
          flat
            ? 'relative min-h-svh overflow-hidden'
            : 'sticky top-0 h-svh overflow-hidden'
        }
      >
        {/* The plan, full bleed. Not a picture beside the argument -- the argument. */}
        <div className="absolute inset-0">
          <ReliefStage
            ratio="16 / 9"
            className="!absolute inset-0 h-full w-full"
            beat={effectiveBeat}
            t={t}
            interactive={flat}
            onSeize={() => setReleased(true)}
            minWidth={1024}
          >
            {fallback}
          </ReliefStage>
        </div>

        {/* Vignette so type over the plot stays readable at every camera angle,
            without dimming the plot itself into mud. */}
        <div
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(100deg,rgba(1,4,9,0.92)_0%,rgba(1,4,9,0.72)_26%,rgba(1,4,9,0.18)_46%,rgba(1,4,9,0)_62%)]"
          aria-hidden="true"
        />

        {/* ---- chapter rail ---- */}
        <ol
          className="pointer-events-none absolute left-5 top-1/2 z-20 hidden -translate-y-1/2 space-y-3 lg:block"
          aria-hidden="true"
        >
          {copy.map((c, i) => (
            <li key={c.eyebrow} className="flex items-center gap-3">
              <span
                className={`block h-px transition-all duration-500 ${
                  i === effectiveBeat ? 'w-8 bg-brand' : 'w-3 bg-ink-600'
                }`}
              />
              <span
                className={`text-[10px] uppercase tracking-[0.16em] transition-colors duration-500 ${
                  i === effectiveBeat ? 'text-brand' : 'text-mist-500/60'
                }`}
              >
                {c.eyebrow}
              </span>
            </li>
          ))}
        </ol>

        {/* ---- captions ----
            Every beat stays in the DOM at all times, opacity-animated rather than
            conditionally rendered, so a crawler and a reader who skipped both get the
            whole argument. Under reduced motion they stack and all read at once. */}
        <div
          className={
            flat
              ? 'pointer-events-none relative z-10'
              : 'pointer-events-none absolute inset-0 z-10 flex items-center'
          }
        >
          <div className="mx-auto w-full max-w-[1180px] px-5 lg:pl-28">
            <div className={flat ? 'space-y-10 py-24' : 'relative'}>
              {copy.map((c, i) => {
                const active = flat || i === effectiveBeat;
                return (
                  <div
                    key={c.eyebrow}
                    className={
                      flat
                        ? 'max-w-[34rem]'
                        : `max-w-[34rem] transition-all duration-700 ${
                            i === 0 ? '' : 'absolute inset-x-0 top-1/2 -translate-y-1/2'
                          } ${active ? 'opacity-100 blur-0' : 'pointer-events-none opacity-0 blur-[2px]'}`
                    }
                    aria-hidden={!active || undefined}
                  >
                    <p className="eyebrow mb-4">{c.eyebrow}</p>
                    <h2 className="display text-[2.5rem] text-mist-100 sm:text-[3.25rem] lg:text-[3.75rem]">
                      {c.headline}
                    </h2>
                    <div className="mt-6 text-[15px] leading-relaxed text-mist-300">
                      {c.body}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ---- controls ----
            The skip is a real button, always rendered rather than hover-revealed, and
            it is the first focusable thing in the stage so a keyboard reader meets it
            before the map. */}
        <div
          className={`z-30 mx-auto flex max-w-[1180px] items-end justify-between gap-4 px-5 ${
            flat ? 'relative pb-16' : 'absolute bottom-5 left-0 right-0'
          }`}
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <Link
              href={consoleHref}
              className="inline-flex min-h-11 items-center rounded-lg bg-brand px-5 text-[13px] font-semibold text-ink-950 transition-transform hover:-translate-y-0.5"
            >
              Open the live console →
            </Link>
            <a
              href={ledgerHref}
              className="inline-flex min-h-11 items-center rounded-lg border border-ink-600 bg-ink-950/70 px-5 text-[13px] font-medium text-mist-200 backdrop-blur-sm transition-colors hover:border-ink-500 hover:text-mist-100"
            >
              Read the honest ledger
            </a>
          </div>

          {!flat ? (
            <button
              type="button"
              onClick={skip}
              className="inline-flex min-h-11 items-center rounded-lg border border-ink-700 bg-ink-950/70 px-4 text-[12px] text-mist-400 backdrop-blur-sm transition-colors hover:border-ink-500 hover:text-mist-100"
            >
              Skip the sequence ↓
            </button>
          ) : (
            <p className="hidden text-[11px] text-mist-500 lg:block">
              Drag to orbit · Tab into the map to move by keyboard
            </p>
          )}
        </div>

        {/* Scroll hint, only on the first beat. */}
        <div
          className={`pointer-events-none absolute bottom-20 left-1/2 z-20 -translate-x-1/2 transition-opacity duration-500 ${
            effectiveBeat === 0 && !flat ? 'opacity-100' : 'opacity-0'
          }`}
          aria-hidden="true"
        >
          <span className="text-[10px] uppercase tracking-[0.2em] text-mist-500">
            Scroll
          </span>
        </div>
      </div>
    </section>
  );
}
