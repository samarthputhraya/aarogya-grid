import {
  eventsSince,
  currentSeq,
  durabilitySince,
  durabilityMap,
} from '@/lib/overlay/store';
import { ensureRestored } from '@/lib/durable/sink';
import { ticketsSince, ticketSeq } from '@/lib/dispatch/store';

/**
 * Server-Sent Events: the live delta stream the consoles subscribe to.
 *
 * WHY SSE AND NOT A WEBSOCKET
 * ---------------------------
 * The traffic is one-directional -- the server tells clients what changed, and
 * clients never push back over this channel. SSE is plain HTTP, so it survives
 * Cloud Run's load balancer without an upgrade negotiation, reconnects on its
 * own with `EventSource`, and replays from `Last-Event-ID` for free. A WebSocket
 * would add a protocol upgrade and a keepalive story for no capability we need.
 *
 * THE FOUR DETAILS THAT MAKE IT SURVIVE A REAL DEPLOYMENT
 * ------------------------------------------------------
 *   - `X-Accel-Buffering: no`. Any proxy that buffers will hold the whole
 *     stream until it closes, and the symptom is a demo where nothing arrives
 *     until you navigate away.
 *   - A 15-second heartbeat comment. Idle connections get reaped by
 *     intermediaries; a comment line is not an event, so it costs a client
 *     nothing but keeps the socket alive.
 *   - `retry: 5000`, so a dropped connection comes back on its own.
 *   - `Last-Event-ID` replay. A client that reconnects gets what it missed
 *     rather than a silent gap -- and when the gap is bigger than the ring
 *     buffer it is TOLD, with a `refetch` event, instead of being left
 *     confidently out of date.
 *
 * THREE CURSORS, NOT ONE
 * ----------------------
 * Stock events carry `seq`, which is what the browser returns as
 * `Last-Event-ID`. Durability changes -- an append landing a few hundred
 * milliseconds after the commit it belongs to -- travel on their own cursor and
 * are sent WITHOUT an `id:`. If they consumed a stock `seq`, a reconnecting
 * client would ask to resume from a number that never named an event, and the
 * events either side of it would be replayed or skipped.
 *
 * Dispatch tickets carry a third cursor for the same reason: a ticket moving
 * from approved to dispatched is not a stock event and must not consume a stock
 * sequence number, even though it usually produces one alongside itself.
 *
 * A stream also sends the current durability of everything still in the replay
 * buffer when it opens. Without that, a client that was offline while an event
 * went from `pending` to `durable` shows "queued, not yet durable" forever: the
 * event is behind its cursor so it is never replayed, and the update that would
 * have corrected it is long gone.
 *
 * ONE INSTANCE, AND THAT IS A DECISION
 * ------------------------------------
 * The overlay is in-process. With more than one container, a commit landing on
 * A is invisible to a stream held open on B. The service runs with
 * `--max-instances=1` for exactly this reason; the scale-out step is a
 * subscriber on the `aarogya-events` topic the commit path already publishes to.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Cloud Run caps a request at 60 minutes; the client reconnects on its own. */
export const maxDuration = 3600;

const HEARTBEAT_MS = 15_000;
/** How often the store is checked for new events. */
const POLL_MS = 250;

function frame(event: string, data: unknown, id?: number): string {
  return (
    (id === undefined ? '' : 'id: ' + id + '\n') +
    'event: ' + event + '\n' +
    'data: ' + JSON.stringify(data) + '\n\n'
  );
}

export async function GET(request: Request): Promise<Response> {
  // A stream opened on a freshly started container must see the restored log,
  // or its first `hello` would announce a cursor of 0 against a client holding
  // a much larger one.
  await ensureRestored();

  const url = new URL(request.url);
  // `Last-Event-ID` is what the browser resends automatically on reconnect; the
  // query parameter is for the mount-time handoff, where the client already
  // knows its cursor from `GET /api/overlay` and wants no overlap.
  const header = request.headers.get('last-event-id');
  const query = url.searchParams.get('since');
  const parsed = Number.parseInt(header ?? query ?? '0', 10);
  let cursor = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      send('retry: 5000\n\n');

      // An immediate hello does two jobs: it flushes any proxy that is deciding
      // whether to buffer, and it gives the client its cursor so a `since` of 0
      // does not mean "replay everything ever".
      const initial = eventsSince(cursor);
      if (initial.gap) {
        // Honest rather than convenient: the client asked for history that has
        // fallen off the ring buffer, so tell it to refetch instead of handing
        // it a partial replay it would believe was complete.
        send(frame('refetch', { reason: 'cursor older than the retained history' }));
        cursor = initial.seq;
      } else {
        for (const event of initial.events) {
          send(frame('stock', event, event.seq));
          cursor = event.seq;
        }
      }
      send(frame('hello', { seq: cursor, serverSeq: currentSeq() }));

      // The durability of every retained event, so a reconnecting client cannot
      // be left showing a stale chip. No `id:` -- this is not a stock event.
      const opening = durabilityMap();
      let durabilityCursor = opening.id;
      if (opening.updates.length > 0) send(frame('durability', opening.updates));

      // The client seeded its tickets from `/api/overlay` and handed us that
      // cursor with `?tickets=`; anything newer is sent straight away.
      const ticketParam = Number.parseInt(url.searchParams.get('tickets') ?? '0', 10);
      let ticketCursor = Number.isFinite(ticketParam) && ticketParam > 0 ? ticketParam : 0;
      const openingTickets = ticketsSince(ticketCursor);
      if (openingTickets.tickets.length > 0) send(frame('ticket', openingTickets.tickets));
      ticketCursor = openingTickets.seq;

      const poll = setInterval(() => {
        if (closed) return;
        const next = eventsSince(cursor);
        if (next.gap) {
          send(frame('refetch', { reason: 'cursor older than the retained history' }));
          cursor = next.seq;
          return;
        }
        for (const event of next.events) {
          send(frame('stock', event, event.seq));
          cursor = event.seq;
        }
        const durable = durabilitySince(durabilityCursor);
        if (durable.updates.length > 0) {
          send(frame('durability', durable.updates));
          durabilityCursor = durable.id;
        }
        if (ticketSeq() > ticketCursor) {
          const next = ticketsSince(ticketCursor);
          if (next.tickets.length > 0) send(frame('ticket', next.tickets));
          ticketCursor = next.seq;
        }
      }, POLL_MS);

      const beat = setInterval(() => {
        if (closed) return;
        // A comment line, not an event: keeps intermediaries from reaping the
        // socket without waking any client handler.
        send(': heartbeat\n\n');
      }, HEARTBEAT_MS);

      const shutdown = () => {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        clearInterval(beat);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime. Nothing to do.
        }
      };

      request.signal.addEventListener('abort', shutdown);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      // Without this, a buffering proxy holds every byte until the stream ends.
      'X-Accel-Buffering': 'no',
    },
  });
}
