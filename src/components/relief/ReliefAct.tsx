'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import ReliefStage from './ReliefStage';
import {
  actPosition,
  anchorFor,
  BEAT_COUNT,
  type GaugeStop,
} from '@/lib/relief/act';
import type { Beat } from '@/lib/relief/field';

/**
 * The act: one pinned section the whole national plan plays inside.
 *
 * The relief owns the entire viewport, scroll composes the beat, and the copy
 * arrives as annotation ON the plan rather than in a column beside a picture of it.
 * There is exactly ONE pinned section on the page; pinning more than one fights the
 * native scroll and wrecks touch.
 *
 *
 * THE BEAT IS COMPOSED, NEVER SCRUBBED — and this is the fix for "not smooth"
 * ---------------------------------------------------------------------------
 * The previous version called `setProgress(p)` inside its rAF, unconditionally,
 * every frame. That is a full React re-render of the act — five caption blocks, the
 * stage, the upgrade gate and deck.gl's entire layer set — sixty times a second,
 * against a float that never repeats. Profiled on the deployed build under a 4x CPU
 * throttle it produced a p90 frame of 166ms and dropped 32% of frames, with
 * `bufferSubData` / `bindBuffer` churn visible in the sample as deck re-uploaded
 * attributes for 128 columns and 244 arcs on every one of those renders.
 *
 * So the rAF no longer writes React state at all. It writes ONE CSS custom property
 * — `--act-p` — which the gauge resolves entirely in CSS, and it sets state only
 * when the discrete beat index actually changes. Five renders per act instead of
 * sixty per second.
 *
 * The second half of the fix is `lib/relief/act.ts`: progress is shaped so each
 * beat HOLDS for most of its span and moves decisively across the remainder. A
 * scrubbed act leaves the reader permanently between two states — nothing is ever
 * composed, and a fast flick blows through all five. Holding means the beat-3 copy
 * is on screen while the camera is genuinely at beat 3.
 *
 * EVERYTHING IS STILL A PURE FUNCTION OF SCROLL POSITION, never of an event
 * sequence. This project learned that lesson expensively: the first scroll reveal
 * was an IntersectionObserver that hid each block and cleared it on intersection,
 * and anything the reader jumped past stayed invisible for good, leaving 29 of 34
 * blocks blank. Ctrl+End here lands on the last beat, fully drawn, because that is
 * simply what `progress = 1` evaluates to.
 *
 * The pin is `position: sticky`, so native scrolling is never intercepted — no
 * wheel handler, no scroll-jacking, no scroll-snap, no input swallowed on entry.
 * The scrollbar keeps its real meaning and the reader can always leave.
 */

export interface BeatCopy {
  /** `THE FAILURE` — the subject, second field of the eyebrow. */
  subject: string;
  /** `1,206 CRITICAL` — the magnitude, third field. Always a real figure. */
  magnitude: string;
  headline: React.ReactNode;
  body: React.ReactNode;
  /** What the gauge reads while this beat is composed. */
  gauge: GaugeStop;
}

export interface ReliefActProps {
  copy: BeatCopy[];
  /** Rendered inside the stage as the non-WebGL fallback. */
  fallback: React.ReactNode;
  ledgerHref: string;
  consoleHref: string;
}

/** Milliseconds the corridors take to draw in, once beat 3 is composed. */
const DRAW_MS = 1200;
/** Quantisation of the draw-in. 24 renders total, not one per frame. */
const DRAW_STEPS = 24;

export default function ReliefAct({
  copy,
  fallback,
  ledgerHref,
  consoleHref,
}: ReliefActProps) {
  const actRef = useRef<HTMLElement>(null);
  const gaugeRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLSpanElement>(null);

  // The ONLY scroll-derived React state. An integer, 0..4.
  const [beat, setBeat] = useState(0);
  const [released, setReleased] = useState(false);
  const [reduced, setReduced] = useState(false);
  // Below the relief's viewport gate there is no canvas to choreograph, so the act
  // would be five screens of scroll driving a static SVG — all of the cost of a
  // sequence and none of the sequence. Narrow viewports get the collapsed form.
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // The same gate the relief probe uses, so the two can never disagree about
  // whether there is a canvas to drive.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setNarrow(!mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const flat = reduced || released || narrow;
  const effectiveBeat: Beat = (flat ? BEAT_COUNT - 1 : beat) as Beat;

  /**
   * One clock.
   *
   * A single rAF owns progress, the custom property and the gauge readout. There is
   * no scroll listener alongside it, no second loop, and no smoothing applied twice
   * — the camera's damping in `ReliefCanvas` is the only inertia in the system.
   * Smoothing the scroll AND easing the tween AND lerping the map is what produces
   * mush.
   *
   * Gated by an IntersectionObserver so the loop is not running at all once the
   * reader is past the act.
   */
  useEffect(() => {
    const el = actRef.current;
    if (!el || flat) return;

    let raf = 0;
    let running = false;
    let lastBeat = -1;
    let lastValue = '';

    const tick = () => {
      const rect = el.getBoundingClientRect();
      const travel = rect.height - window.innerHeight;
      const raw = travel > 0 ? -rect.top / travel : 0;
      const { beat: b, p } = actPosition(raw);

      // The gauge is 48 squares and a tab; all of it resolves from this one number
      // in CSS, so nothing here touches React.
      //
      // WRITTEN ON THE GAUGE, NOT ON THE ACT — and the difference is enormous.
      // A custom property invalidates style on the whole subtree beneath the
      // element it is set on. The act element is the root of everything: five
      // caption blocks, the stage, the upgrade gate and the deck.gl container. So
      // writing `--act-p` there re-resolved style for the entire scene sixty times
      // a second, which is a worse version of the per-frame React render this
      // rewrite existed to remove. Scoped to the gauge, the invalidated subtree is
      // 49 elements that are 7px square.
      gaugeRef.current?.style.setProperty('--act-p', p.toFixed(4));

      if (b !== lastBeat) {
        lastBeat = b;
        setBeat(b);
        const next = copy[b]?.gauge.value ?? '';
        if (next !== lastValue && tabRef.current) {
          lastValue = next;
          tabRef.current.textContent = next;
        }
      }

      raf = requestAnimationFrame(tick);
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        // The gauge is `position: fixed`, so without this it stays welded to the
        // right margin for the entire rest of the page — a position readout for a
        // sequence the reader left four sections ago. Driven from the same
        // observer that owns the loop, as an attribute rather than as state, so
        // showing and hiding it costs nothing and cannot disagree with whether the
        // act is actually running.
        gaugeRef.current?.setAttribute(
          'data-live',
          entry.isIntersecting ? 'true' : 'false',
        );

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
  }, [flat, copy]);

  /**
   * The corridor draw-in runs on its own clock, not on the wheel.
   *
   * Tying it to scroll position meant 244 corridors drew at whatever speed the
   * reader happened to be scrolling — slowly for someone reading, instantly for
   * someone flicking, and backwards for anyone who scrolled up. It is a fixed
   * 1.2-second event that begins when beat 3 composes, quantised to 24 steps so it
   * costs 24 renders in total rather than one per frame.
   */
  const [draw, setDraw] = useState(0);
  useEffect(() => {
    if (reduced || flat) {
      setDraw(effectiveBeat >= 3 ? 1 : 0);
      return;
    }
    if (beat < 3) {
      setDraw(0);
      return;
    }
    let raf = 0;
    let start: number | null = null;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const k = Math.min(1, (ts - start) / DRAW_MS);
      const q = Math.round(k * DRAW_STEPS) / DRAW_STEPS;
      setDraw((prev) => (prev === q ? prev : q));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [beat, reduced, flat, effectiveBeat]);

  /** Scroll to the position that composes a given beat. Native, smooth, escapable. */
  const goToBeat = useCallback((target: number) => {
    const el = actRef.current;
    if (!el) return;
    const clamped = Math.min(BEAT_COUNT - 1, Math.max(0, target));
    const travel = el.offsetHeight - window.innerHeight;
    if (travel <= 0) return;
    window.scrollTo({
      top: el.offsetTop + anchorFor(clamped) * travel,
      behavior: 'smooth',
    });
  }, []);

  /**
   * The gauge is a real control.
   *
   * The reference this borrows from locks scroll on entry and releases only on a
   * wheel gesture past a boundary — which is a keyboard trap, and it scored that
   * site its lowest accessibility mark. This takes the step semantics and refuses
   * the trap: native scroll is untouched, and the gauge simply offers the five
   * anchors to anyone arriving by keyboard.
   */
  const onGaugeKey = useCallback(
    (e: React.KeyboardEvent) => {
      const map: Record<string, number> = {
        ArrowDown: beat + 1,
        ArrowRight: beat + 1,
        PageDown: beat + 1,
        ArrowUp: beat - 1,
        ArrowLeft: beat - 1,
        PageUp: beat - 1,
        Home: 0,
        End: BEAT_COUNT - 1,
      };
      const next = map[e.key];
      if (next === undefined) return;
      e.preventDefault();
      goToBeat(next);
    },
    [beat, goToBeat],
  );

  const skip = useCallback(() => {
    setReleased(true);
    // Leave the pin behind rather than stranding the reader mid-act with a released
    // map above them and four screens of empty scroll below.
    actRef.current?.nextElementSibling?.scrollIntoView({
      block: 'start',
      behavior: 'smooth',
    });
  }, []);

  const active = copy[effectiveBeat];

  return (
    <section
      ref={actRef}
      style={{ height: flat ? 'auto' : `${BEAT_COUNT * 100}svh` }}
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
        {/* The plan, full bleed. Not a picture beside the argument — the argument. */}
        <div className="absolute inset-0">
          <ReliefStage
            ratio="16 / 9"
            className="!absolute inset-0 h-full w-full"
            beat={effectiveBeat}
            t={draw}
            interactive={flat}
            onSeize={() => setReleased(true)}
            minWidth={1024}
          >
            {fallback}
          </ReliefStage>
        </div>

        {/* Readability scrim for the copy column.
            A hard-edged linear ramp, not a blur and not a frosted panel: a
            `backdrop-filter` here would make the compositor read back the live
            WebGL texture underneath on every frame it draws, which is precisely
            where mid-range hardware falls over. */}
        <div
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(96deg,rgba(1,4,9,0.95)_0%,rgba(1,4,9,0.86)_28%,rgba(1,4,9,0.35)_48%,rgba(1,4,9,0)_66%)]"
          aria-hidden="true"
        />

        {/* ---- the granularity gauge ----
            Position readout, keyed to a real axis rather than to scroll percent.
            Every square resolves from `--act-p` in CSS; nothing here re-renders. */}
        {!flat ? (
          <div
            ref={gaugeRef}
            className="gauge"
            // Starts hidden. The IntersectionObserver above turns it on when the
            // act is genuinely on screen and off again when it is not.
            data-live="false"
            role="slider"
            tabIndex={0}
            aria-label="Sequence position"
            aria-valuemin={1}
            aria-valuemax={BEAT_COUNT}
            aria-valuenow={effectiveBeat + 1}
            aria-valuetext={`Beat ${effectiveBeat + 1} of ${BEAT_COUNT} — ${active?.gauge.label ?? ''}`}
            onKeyDown={onGaugeKey}
          >
            <span className="gauge-tab chamfer" aria-hidden="true">
              <span ref={tabRef} className="gauge-readout">
                {copy[0]?.gauge.value}
              </span>
            </span>
            {Array.from({ length: 48 }, (_, i) => (
              <span
                key={i}
                className="gauge-cell"
                style={{ ['--i' as string]: i }}
                aria-hidden="true"
              />
            ))}
          </div>
        ) : null}

        {/* ---- captions ----
            Laid on the page grid, in the same columns the static sections below use,
            rather than inside a floating panel. That is the difference between a map
            with a tooltip stuck on it and one instrument whose readout happens to
            sit over the terrain.

            Every beat stays in the DOM at all times, opacity-animated rather than
            conditionally rendered, so a crawler and a reader who skipped both get
            the whole argument. Under reduced motion they stack and read at once. */}
        <div
          className={
            flat
              ? 'pointer-events-none relative z-10'
              : 'pointer-events-none absolute inset-0 z-10 flex items-center'
          }
        >
          <div className="mx-auto w-full max-w-[102em] px-[3.5em]">
            <div className={flat ? 'space-y-[4em] py-[6em]' : 'relative'}>
              {copy.map((c, i) => {
                const on = flat || i === effectiveBeat;
                return (
                  <div
                    key={c.subject}
                    className={
                      flat
                        ? 'max-w-[36em]'
                        : `max-w-[36em] transition-opacity duration-[425ms] ${
                            i === 0 ? '' : 'absolute inset-x-0 top-1/2 -translate-y-1/2'
                          } ${on ? 'opacity-100' : 'pointer-events-none opacity-0'}`
                    }
                    style={
                      flat
                        ? undefined
                        : { transitionTimingFunction: 'cubic-bezier(0.2,0.65,0.47,0.96)' }
                    }
                    aria-hidden={!on || undefined}
                  >
                    <p className="eyebrow">
                      <span className="eyebrow-mark" aria-hidden="true" />
                      <span>Beat {String(i + 1).padStart(2, '0')}</span>
                      <span aria-hidden="true">·</span>
                      <span className="eyebrow-sub">{c.subject}</span>
                      <span aria-hidden="true">·</span>
                      <span className="eyebrow-mag fig">{c.magnitude}</span>
                    </p>
                    <h2 className="display display-lg mt-[0.65em]">{c.headline}</h2>
                    <div className="mt-[1.4em] max-w-[30em] text-[0.9375em] leading-[1.65] text-mist-300">
                      {c.body}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ---- controls ----
            The skip is a real button, always rendered rather than hover-revealed,
            and it is the first focusable thing in the stage so a keyboard reader
            meets it before the map. */}
        <div
          className={`act-controls z-30 mx-auto flex max-w-[102em] items-end justify-between gap-[1em] px-[3.5em] ${
            flat ? 'relative pb-[4em]' : 'absolute bottom-[2em] left-0 right-0'
          }`}
        >
          <div className="flex flex-wrap items-center gap-[0.5em]">
            <Link href={consoleHref} className="btn btn-primary chamfer">
              Open the live console
            </Link>
            <a href={ledgerHref} className="btn btn-ghost chamfer">
              Read the honest ledger
            </a>
          </div>

          {!flat ? (
            <button type="button" onClick={skip} className="btn btn-ghost chamfer">
              ↳ Skip
            </button>
          ) : (
            <p className="hidden font-mono text-[0.6875em] uppercase tracking-[0.1em] text-mist-500 lg:block">
              Drag to orbit · Tab into the map to move by keyboard
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
