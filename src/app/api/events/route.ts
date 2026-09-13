import {
  eventsSince,
  currentSeq,
  durabilitySince,
  durabilityMap,
  overlaySnapshot,
} from '@/lib/overlay/store';
import { ensureRestored } from '@/lib/durable/sink';
import { ticketsSince, ticketSeq, allTickets } from '@/lib/dispatch/store';
import { INSTANCE_ID, splitScoped } from '@/lib/live/instance';

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
 *     rather than a silent gap -- and when it cannot be given that, it is sent
 *     the whole current state in a `reset` frame instead of being left
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
 * MORE THAN ONE INSTANCE
 * ----------------------
 * Every instance holds its own overlay, fed by its own commits and by the
 * fan-out listener (`src/lib/live/bus.ts`) with everyone else's, so a stream
 * on B carries a commit taken on A. What does NOT carry over is a cursor: seq 40
 * on A and seq 40 on B are different events. So every `id:` this route sends
 * is `<instance>:<seq>`, and a client that reconnects with a cursor issued by
 * a different instance -- Cloud Run routed the reconnect elsewhere, or the
 * container it was talking to was replaced -- is sent a `reset` frame: the
 * whole current overlay and ticket set, on the stream it already has open.
 *
 * On the stream rather than as "go and refetch": a second HTTP request is free
 * to land on yet another instance, and a client could chase cursors between
 * containers indefinitely. A reset in-band cannot miss.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Cloud Run caps a request at 60 minutes; the client reconnects on its own. */
export const maxDuration = 3600;

const HEARTBEAT_MS = 15_000;
/** How often the store is checked for new events. */
const POLL_MS = 250;

/** An SSE frame. `id` is a seq on THIS instance and is sent scoped to it. */
function frame(event: string, data: unknown, id?: number): string {
  return (
    (id === undefined ? '' : 'id: ' + INSTANCE_ID + ':' + id + '\n') +
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
  // query parameters are for the mount-time handoff, where the client already
  // knows its cursor and instance from `GET /api/overlay` and wants no overlap.
  const header = splitScoped(request.headers.get('last-event-id'));
  const fromQuery = {
    instance: url.searchParams.get('instance'),
    seq: splitScoped(url.searchParams.get('since')).seq,
  };
  const claimed = header.seq > 0 || header.instance ? header : fromQuery;
  let cursor = claimed.seq;
  // A cursor is only meaningful on the instance that issued it. A client that
  // names its instance is reset if that is not this one; a client that names
  // none is reset if it claims any history at all.
  const foreign = claimed.instance ? claimed.instance !== INSTANCE_ID : cursor > 0;

  const encoder = new TextEncoder();

  /*
   * ONE cleanup, reachable three ways, and wired before anything is scheduled.
   *
   * The abort listener used to be added at the END of `start`, after the
   * `ensureRestored()` await above -- which on a cold container is two BigQuery
   * jobs, about a second. A reload in that second aborts the request before the
   * listener exists, and an `abort` listener added to an already-aborted signal
   * never fires, so the poll and heartbeat intervals were orphaned for the life
   * of the container. So: check `aborted` up front, clean up from `cancel()` when
   * the consumer goes away without an abort, and treat a failed enqueue as the
   * stream being gone rather than merely flagging it.
   */
  let poll: ReturnType<typeof setInterval> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    if (poll !== undefined) clearInterval(poll);
    if (beat !== undefined) clearInterval(beat);
    request.signal.removeEventListener('abort', shutdown);
    try {
      streamController?.close();
    } catch {
      // Already closed or errored by the runtime. Nothing to do.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      shutdown();
    },
    start(controller) {
      streamController = controller;
      if (request.signal.aborted) {
        shutdown();
        return;
      }
      request.signal.addEventListener('abort', shutdown);

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          shutdown();
        }
      };

      send('retry: 5000\n\n');

      /*
       * The whole current state, in one frame, with every cursor moved to now.
       * Sent when the client's cursor was issued by another instance, and when
       * its history has fallen off this instance's ring buffer -- in both cases a
       * replay would be partial and the client could not tell.
       */
      let ticketCursor = 0;
      let durabilityCursor = 0;
      const reset = (reason: string) => {
        const overlay = overlaySnapshot();
        send(
          frame(
            'reset',
            { reason, instanceId: INSTANCE_ID, overlay, tickets: allTickets(), ticketSeq: ticketSeq() },
            overlay.seq,
          ),
        );
        cursor = overlay.seq;
        ticketCursor = ticketSeq();
        durabilityCursor = durabilitySince(Number.MAX_SAFE_INTEGER).id;
      };

      // The client seeded its tickets from `/api/overlay` and handed us that
      // cursor with `?tickets=`. Like the stock cursor, it belongs to an instance.
      if (!foreign) {
        const ticketParam = Number.parseInt(url.searchParams.get('tickets') ?? '0', 10);
        ticketCursor = Number.isFinite(ticketParam) && ticketParam > 0 ? ticketParam : 0;
      }

      const initial = eventsSince(cursor);
      if (foreign) {
        reset('cursor issued by another instance');
      } else if (initial.gap) {
        reset('cursor older than the retained history');
      } else {
        for (const event of initial.events) {
          send(frame('stock', event, event.seq));
          cursor = event.seq;
        }
        // The durability of every retained event, so a reconnecting client cannot
        // be left showing a stale chip. No stock cursor moves.
        const opening = durabilityMap();
        durabilityCursor = opening.id;
        if (opening.updates.length > 0) send(frame('durability', opening.updates));

        const openingTickets = ticketsSince(ticketCursor);
        if (openingTickets.tickets.length > 0) send(frame('ticket', openingTickets.tickets));
        ticketCursor = openingTickets.seq;
      }

      // An immediate hello does two jobs: it flushes any proxy that is deciding
      // whether to buffer, and it tells the client which instance it is talking
      // to. It carries an `id:` too, so a reconnect that happens before any
      // stock event resumes with a cursor that names THIS instance.
      send(frame('hello', { seq: cursor, serverSeq: currentSeq(), instanceId: INSTANCE_ID }, cursor));

      poll = setInterval(() => {
        if (closed) return;
        const next = eventsSince(cursor);
        if (next.gap) {
          reset('cursor older than the retained history');
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

      beat = setInterval(() => {
        if (closed) return;
        // A comment line, not an event: keeps intermediaries from reaping the
        // socket without waking any client handler.
        send(': heartbeat\n\n');
      }, HEARTBEAT_MS);

      // A send that failed during the opening burst closed the stream before the
      // intervals existed; do not leave them running against it.
      if (closed) shutdownTimersOnly();
    },
  });

  function shutdownTimersOnly() {
    if (poll !== undefined) clearInterval(poll);
    if (beat !== undefined) clearInterval(beat);
  }

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
