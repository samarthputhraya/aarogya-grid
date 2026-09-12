'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  StockEvent,
  DurabilityUpdate,
  RestoreReport,
} from '@/lib/overlay/store';
import type { DispatchTicket } from '@/lib/dispatch/ticket';

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
 *   1. `GET /api/overlay` on mount -- everything committed so far, every
 *      dispatch ticket, and the cursor for each.
 *   2. `EventSource /api/events?since=seq&tickets=ticketSeq` -- everything from
 *      there on.
 *
 * Handing the stream the cursor from step 1 is what stops the two overlapping:
 * without it the stream would replay events the fetch already applied, and with
 * a naive cursor it would skip the ones that landed between them.
 *
 * A `refetch` event means the server's replay buffer no longer reaches this
 * client's cursor. Rather than apply a partial history it cannot detect the
 * holes in, the hook simply redoes step 1.
 *
 * THE THIRD FRAME TYPE: DURABILITY
 * --------------------------------
 * A commit answers before its BigQuery append does, so an event arrives
 * `pending` and is corrected to `durable` (or `failed`) a moment later on a
 * `durability` frame. Those frames carry no `id:` and must not move the cursor:
 * they describe events the client already has. Applying them in place is what
 * lets a row say "queued, not yet durable" and then stop saying it, without a
 * reload and without ever having claimed something untrue.
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
  /** What the server's own restore did, when it had a durable log to read. */
  restore: RestoreReport | null;
  /** `ticketId` -> its current state. Seeded on mount, then streamed. */
  tickets: Map<string, DispatchTicket>;
}

export const positionKey = (facilityId: string, drugId: string) => facilityId + '|' + drugId;

/** Activity rows kept in memory. The server's own buffer is the real history. */
const MAX_RECENT = 50;

interface OverlayResponse {
  seq: number;
  events: StockEvent[];
  restore?: RestoreReport;
  tickets?: DispatchTicket[];
  ticketSeq?: number;
}

export function useGridEvents(enabled = true): LiveGrid {
  const [state, setState] = useState<LiveGrid>({
    connected: false,
    seq: 0,
    byPosition: new Map(),
    recent: [],
    error: null,
    restore: null,
    tickets: new Map(),
  });

  // Held in refs as well as in state: the SSE handler needs the current cursors
  // without re-subscribing every time a number changes.
  const seqRef = useRef(0);
  const ticketSeqRef = useRef(0);

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

    /**
     * Apply durability changes to events already held.
     *
     * Every collection the hook keeps holds the SAME object identity per event,
     * so a new object has to be written into each of them -- mutating in place
     * would change the data without changing the reference React re-renders on.
     */
    const applyDurability = (updates: DurabilityUpdate[]) => {
      if (updates.length === 0) return;
      setState((prev) => {
        const bySeq = new Map(updates.map((u) => [u.seq, u]));
        const patch = (e: StockEvent): StockEvent => {
          const u = bySeq.get(e.seq);
          if (!u) return e;
          return {
            ...e,
            durability: u.durability,
            durabilityDetail: u.detail,
            published: u.published,
          };
        };
        const byPosition = new Map<string, StockEvent>();
        for (const [k, e] of prev.byPosition) byPosition.set(k, patch(e));
        return { ...prev, byPosition, recent: prev.recent.map(patch) };
      });
    };

    const subscribe = () => {
      if (cancelled) return;
      source?.close();
      source = new EventSource(
        '/api/events?since=' + seqRef.current + '&tickets=' + ticketSeqRef.current,
      );

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
      source.addEventListener('durability', (ev) => {
        if (cancelled) return;
        try {
          applyDurability(JSON.parse((ev as MessageEvent).data) as DurabilityUpdate[]);
        } catch {
          // A malformed frame must not take the console down with it.
        }
      });
      source.addEventListener('ticket', (ev) => {
        if (cancelled) return;
        try {
          const incoming = JSON.parse((ev as MessageEvent).data) as DispatchTicket[];
          if (incoming.length === 0) return;
          setState((prev) => {
            const tickets = new Map(prev.tickets);
            for (const t of incoming) tickets.set(t.ticketId, t);
            ticketSeqRef.current = Math.max(
              ticketSeqRef.current,
              ...incoming.map((t) => t.seq),
            );
            return { ...prev, tickets };
          });
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
        ticketSeqRef.current = data.ticketSeq ?? 0;
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
            restore: data.restore ?? null,
            tickets: new Map((data.tickets ?? []).map((t) => [t.ticketId, t])),
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
