'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { probeRelief, type ReliefCapability } from '@/lib/relief/probe';
import type { Beat } from '@/lib/relief/field';

/**
 * The gate.
 *
 * Small on purpose -- this is the only new JavaScript that reaches a visitor whose
 * machine is going to be shown the SVG. It runs the probe, and if the probe passes it
 * pulls in the renderer. It deliberately does NOT import `@deck.gl/*`, directly or
 * transitively, so that weight stays behind the dynamic boundary.
 *
 * The SVG underneath is never unmounted, only hidden, for three separate reasons:
 * it is the print target, it is where we fall back to if the GL context is lost
 * mid-session, and tearing 244 paths out of the DOM is a layout and paint on the main
 * thread at precisely the moment the GPU is compiling shaders.
 */
const ReliefCanvas = dynamic(() => import('./ReliefCanvas'), {
  ssr: false,
  // The SVG is the loading state, and it is already on screen underneath. A skeleton
  // here would be a third visual state nobody asked for.
  loading: () => null,
});

export interface ReliefUpgradeProps {
  beat: Beat;
  t: number;
  interactive: boolean;
  selected: string | null;
  onSelect: (code: string) => void;
  onHover?: (code: string | null) => void;
  minWidth?: number;
  onSeize?: () => void;
  /** Told to the parent so it can hide the SVG only once there is something to hide it for. */
  onPromoted?: (promoted: boolean) => void;
}

export default function ReliefUpgrade({
  beat,
  t,
  interactive,
  selected,
  onSelect,
  onHover,
  minWidth = 1024,
  onSeize,
  onPromoted,
}: ReliefUpgradeProps) {
  const [cap, setCap] = useState<ReliefCapability | null>(null);
  const [ready, setReady] = useState(false);
  const [lost, setLost] = useState(false);

  // Probe on idle, not on mount.
  //
  // On the landing page the map is above the fold, so an intersection trigger would
  // fire instantly and race the largest contentful paint -- and the entire point is
  // to lose that race deliberately. Waiting for idle also means the chunk never
  // competes with the three self-hosted font faces the headline needs.
  //
  // The setState lives inside the callback rather than the effect body, which is both
  // what React 19 wants and what actually expresses the intent: this is a
  // subscription to "the browser has a spare moment", not a synchronous derivation.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) setCap(probeRelief({ minWidth }));
    };

    const ric = (
      window as Window & {
        requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      }
    ).requestIdleCallback;

    if (typeof ric === 'function') {
      const id = ric(run, { timeout: 2500 });
      return () => {
        cancelled = true;
        (
          window as Window & { cancelIdleCallback?: (h: number) => void }
        ).cancelIdleCallback?.(id);
      };
    }

    // Safari before 16.4, and anything else without rIC.
    const id = window.setTimeout(run, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [minWidth]);

  const promoted = cap?.mode === 'gl' && ready && !lost;

  useEffect(() => {
    onPromoted?.(promoted);
  }, [promoted, onPromoted]);

  // A lost context leaves a blank rectangle where the map was -- Chrome drops them
  // when a machine sleeps or the GPU process restarts, which in a live demo is
  // exactly when it would happen. Reverting is one state change, and the SVG is
  // still mounted underneath waiting for it.
  const handleLost = useCallback((event: Event) => {
    event.preventDefault();
    setLost(true);
  }, []);

  useEffect(() => {
    if (!promoted) return;
    const canvas = document.querySelector('canvas[data-relief-canvas]');
    if (!canvas) return;
    canvas.addEventListener('webglcontextlost', handleLost);
    return () => canvas.removeEventListener('webglcontextlost', handleLost);
  }, [promoted, handleLost]);

  if (cap?.mode !== 'gl' || lost) return null;

  return (
    <div
      // Fades in only once a frame genuinely exists. Under reduced motion the
      // transition duration is zeroed globally by globals.css, so this simply swaps.
      className="absolute inset-0 transition-opacity duration-200"
      style={{ opacity: ready ? 1 : 0 }}
      data-relief-canvas-wrap=""
    >
      <ReliefCanvas
        beat={beat}
        t={t}
        interactive={interactive}
        selected={selected}
        onSelect={onSelect}
        onHover={onHover}
        staticCamera={cap.motion === 'static'}
        onSeize={onSeize}
        onReady={() => setReady(true)}
        className="absolute inset-0"
      />
    </div>
  );
}
