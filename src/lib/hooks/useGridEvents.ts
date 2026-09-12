'use client';

import { useEffect, useRef, useState } from 'react';
import type { StockEvent } from '@/lib/overlay/store';

/**
 * Live stock corrections, merged from two sources that must both be present.
 *
 * THE MOUNT FETCH IS NOT OPTIONAL, AND FORGETTING IT LOOKS LIKE SUCCESS
 * ---------------------------------------------------------------------
 * `/console` statically imports the snapshot and `/district/[code]` is
 * `dynamicParams = false, revalidate = false`. Both are prerendered at BUILD
 * time. So a committed report can never appear in freshly served HTML, however
 * correct the server-side recompute is.
 *
 * Subscribing to Server-Sent Events alone produces a demo that WORKS: the delta
 * arrives, the number changes, everyone is pleased. Then someone reloads the
 * page and every committed change vanishes, because the reload serves the
 * prerendered HTML again and the stream only carries what happens next.
 *
 * So this hook does both, in order:
 *
 *   1. `GET /api/overlay` on mount -- everything committed so far, plus `seq`.
 *   2. `EventSource /api/events?since=seq` -- everything from there on.
 *
 * Handing the stream the cursor from step 1 is what stops the two overlapping:
 * without it the stream would replay events the fetch already applied, and with
 * a naive cursor it would skip the ones that landed between them.
 *
 * A `refetch` event means the server's replay buffer no longer reaches this
 * client's cursor. Rather than apply a partial history it cannot detect the
 * holes in, the hook simply redoes step 1.
 */

export interface LiveGrid {
  /** True while the SSE stream is open. */
  connected: boolean;
  /** Highest event sequence applied. 0 means nothing has been committed. */
  seq: number;
  /** `facilityId|drugId` -> the most recent correction for that position. */
  byPosition: Map<string, StockEvent>;
  /** Newest first, for an activity feed. Bounded. */
  recent: StockEvent[];
  /** Set when the initial fetch failed; the console can say so rather than lying. */
  error: string | null;
}

export const positionKey = (facilityId: string, drugId: string) => facilityId + '|' + drugId;

/** Activity rows kept in memory. The server's own buffer is the real history. */
const MAX_RECENT = 50;

interface OverlayResponse {
  seq: number;
  events: StockEvent[];
}

export function useGridEvents(enabled = true): LiveGrid {
  const [state, setState] = useState<LiveGrid>({
    connected: false,
    seq: 0,
    byPosition: new Map(),
    recent: [],
    error: null,
  });

  // Held in a ref as well as in state: the SSE handler needs the current cursor
  // without re-subscribing every time a number changes.
  const seqRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let source: EventSource | null = null;

    const apply = (events: StockEvent[]) => {
      if (events.length === 0) return;
      setState((prev) => {
        const byPosition = new Map(prev.byPosition);
        // Oldest first, so the newest correction for a position wins.
        const ordered = [...events].sort((a, b) => a.seq - b.seq);
        for (const e of ordered) byPosition.set(positionKey(e.facilityId, e.drugId), e);
        const recent = [...ordered].reverse().concat(prev.recent).slice(0, MAX_RECENT);
        const seq = Math.max(prev.seq, ordered[ordered.length - 1].seq);
        seqRef.current = seq;
        return { ...prev, byPosition, recent, seq };
      });
    };

    const subscribe = () => {
      if (cancelled) return;
      source?.close();
      source = new EventSource('/api/events?since=' + seqRef.current);

      source.addEventListener('open', () => {
        if (!cancelled) setState((prev) => ({ ...prev, connected: true, error: null }));
      });
      source.addEventListener('stock', (ev) => {
        if (cancelled) return;
        try {
          apply([JSON.parse((ev as MessageEvent).data) as StockEvent]);
        } catch {
          // A malformed frame must not take the console down with it.
        }
      });
      source.addEventListener('refetch', () => {
        if (!cancelled) void seed();
      });
      source.addEventListener('error', () => {
        // `EventSource` reconnects on its own using the `retry:` the server
        // sent; this only reflects the state so the UI can show it.
        if (!cancelled) setState((prev) => ({ ...prev, connected: false }));
      });
    };

    const seed = async () => {
      try {
        const res = await fetch('/api/overlay', { cache: 'no-store' });
        if (!res.ok) throw new Error('overlay ' + res.status);
        const data = (await res.json()) as OverlayResponse;
        if (cancelled) return;
        seqRef.current = data.seq;
        setState((prev) => {
          const byPosition = new Map<string, StockEvent>();
          // The route returns newest first; walking it in reverse leaves the
          // newest correction per position in place.
          for (const e of [...data.events].reverse()) {
            byPosition.set(positionKey(e.facilityId, e.drugId), e);
          }
          return {
            ...prev,
            byPosition,
            recent: data.events.slice(0, MAX_RECENT),
            seq: data.seq,
            error: null,
          };
        });
      } catch (e) {
        if (!cancelled) {
          setState((prev) => ({ ...prev, error: (e as Error).message }));
        }
      }
    };

    // Seed first, then subscribe from the cursor the seed returned.
    void seed().then(subscribe);

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [enabled]);

  return state;
}
