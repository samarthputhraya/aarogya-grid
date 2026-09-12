import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureRestored } from '@/lib/durable/sink';
import {
  actOnTicket,
  UnknownOrderError,
  OrderNotExecutableError,
} from '@/lib/dispatch/service';
import { TicketTransitionError } from '@/lib/dispatch/ticket';
import { ticketsForDistrict, allTickets, ticketSeq } from '@/lib/dispatch/store';

/**
 * Approve -> Execute -> Monitor, over HTTP.
 *
 * WHAT THIS ROUTE IS FOR
 * ----------------------
 * The planner produces dispatch orders and the console prints them. That is
 * where most systems of this shape stop, and it is the reason so many of them
 * are described as "dashboards": nothing that happens afterwards ever comes
 * back. This route is the loop closing -- an officer approves, a storekeeper
 * dispatches what is actually on the shelf, the receiving facility counts what
 * actually arrived, and every one of those changes a risk score in the same
 * live overlay a health worker's voice report writes into.
 *
 * ILLEGAL TRANSITIONS ARE 409, NEVER A QUIET 200
 * ----------------------------------------------
 * Approving an already-approved ticket looks harmless. It is usually a double
 * submit or a stale tab, and answering 200 teaches the client that its retry
 * worked -- so the next bug of this shape arrives as a duplicate delivery
 * rather than as an error message. The refusal carries the current state and
 * the actions that ARE legal from it, so a client can correct itself rather
 * than guess.
 *
 * THE QUANTITY IS THE ONLY THING THE CLIENT MAY CHOOSE, AND ONLY DOWNWARDS
 * -----------------------------------------------------------------------
 * Everything else -- which facilities, which drug, how many units were planned
 * -- is read from the district payload server-side, exactly as `/api/commit`
 * resolves a drug name rather than accepting a drug id. A route that accepted
 * the client's copy of a plan would let anything that can POST move any
 * quantity between any two facilities.
 *
 * THERE IS NO AUTHENTICATION IN THIS BUILD
 * ----------------------------------------
 * `actor` is a claimed name, recorded as such -- the column is
 * `actor_claimed`. In a deployment it would be the identity the request was
 * authenticated as. Saying so is cheaper than a reviewer finding out.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  districtCode: z.string().min(3).max(64),
  orderId: z.string().min(1).max(120),
  action: z.enum(['countersign', 'approve', 'dispatch', 'receive', 'cancel']),
  /** Fewer units than planned. Never more -- the server refuses that. */
  units: z.number().int().min(0).max(10_000_000).optional(),
  actor: z.string().min(1).max(80).default('district officer'),
  note: z.string().max(400).optional(),
});

/**
 * Tickets for a district, or all of them.
 *
 * Prerendered pages cannot carry a ticket any more than they can carry a
 * committed stock report, so the consoles read this on mount as well as
 * subscribing to the stream. (`/api/overlay` returns the same set, so the
 * consoles need only one mount fetch; this exists so the ticket surface is
 * usable on its own -- by a script, or by a district's own system.)
 */
export async function GET(request: Request): Promise<Response> {
  await ensureRestored();
  const districtCode = new URL(request.url).searchParams.get('districtCode');
  const tickets = districtCode ? ticketsForDistrict(districtCode) : allTickets();
  return NextResponse.json(
    { tickets, seq: ticketSeq() },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  await ensureRestored();

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid request', detail: e instanceof z.ZodError ? e.issues : String(e) },
      { status: 400 },
    );
  }

  try {
    const result = await actOnTicket(parsed);
    return NextResponse.json({
      ticket: result.ticket,
      /** The overlay events this produced, so a caller sees the risk move. */
      stockEvents: result.stockEvents,
      recomputeMs: result.recomputeMs,
      elapsedMs: result.elapsedMs,
    });
  } catch (e) {
    if (e instanceof TicketTransitionError) {
      return NextResponse.json(
        {
          error: e.message,
          code: e.code,
          state: e.state,
          allowed: e.allowed,
        },
        // 409 for "not from here", 422 for "not that many": a client can retry
        // the second with a different number and must not retry the first.
        // 409 for both refusals a client can recover from by doing something
        // else first -- a stale tab retrying an action, and an order that needs
        // the other jurisdiction to sign before this one can. 422 is reserved
        // for a request whose NUMBERS are wrong, which no retry fixes.
        { status: e.code === 'invalid_units' ? 422 : 409 },
      );
    }
    if (e instanceof UnknownOrderError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    if (e instanceof OrderNotExecutableError) {
      return NextResponse.json({ error: e.message, code: 'not_executable' }, { status: 422 });
    }
    throw e;
  }
}
