/**
 * Where dispatch tickets live between requests.
 *
 * Same shape as `overlay/store.ts`, and deliberately the same shape: a
 * module-scope `Symbol.for` registry entry that survives HMR, a monotonic
 * sequence that doubles as an SSE cursor, and a durable log behind it that a
 * restart folds back into memory. Two stores that solved the same problem two
 * different ways would be two things to reason about at 2 a.m. on the 29th.
 *
 * WHY THE STATE IS A FOLD, NOT A ROW
 * ----------------------------------
 * BigQuery holds one row per TRANSITION, never one row per ticket, and this
 * store rebuilds each ticket by replaying its transitions in order. That is not
 * purity for its own sake: an append-only log cannot drift from the state it
 * describes, because there is nothing else to drift from. A `tickets` table
 * updated in place plus an `audit` table appended to is two records of one
 * event, and the day they disagree is the day neither can be trusted.
 *
 * It also means the restore has no special case for a ticket that was
 * mid-flight when the container died: the fold simply stops where the log
 * stops.
 */
import type { DispatchTicket } from './ticket';

/** Tickets kept in the replay buffer. A district plans tens of orders, not thousands. */
const MAX_TICKETS = 500;

interface TicketState {
  tickets: Map<string, DispatchTicket>;
  /** Monotonic; every mutation takes the next one. Doubles as the SSE cursor. */
  seq: number;
}

const TICKETS = Symbol.for('aarogya.tickets');
type TicketHost = typeof globalThis & { [TICKETS]?: TicketState };

function blank(): TicketState {
  return { tickets: new Map(), seq: 0 };
}

function state(): TicketState {
  const host = globalThis as TicketHost;
  if (!host[TICKETS]) host[TICKETS] = blank();
  return host[TICKETS];
}

export function ticketSeq(): number {
  return state().seq;
}

/** The next sequence number. Taken before a ticket is built, so it can carry it. */
export function nextTicketSeq(): number {
  return ++state().seq;
}

export function getTicket(ticketId: string): DispatchTicket | undefined {
  return state().tickets.get(ticketId);
}

export function putTicket(ticket: DispatchTicket): DispatchTicket {
  const s = state();
  s.tickets.set(ticket.ticketId, ticket);
  if (s.seq < ticket.seq) s.seq = ticket.seq;
  // Oldest-first eviction by insertion order. A ticket that falls off is still
  // in BigQuery; what is lost is only the in-memory copy, and the mount fetch
  // would no longer show it. At a district's order volume this never fires.
  if (s.tickets.size > MAX_TICKETS) {
    const oldest = s.tickets.keys().next();
    if (!oldest.done) s.tickets.delete(oldest.value);
  }
  return ticket;
}

/** Every ticket, newest change first. */
export function allTickets(): DispatchTicket[] {
  return [...state().tickets.values()].sort((a, b) => b.seq - a.seq);
}

export function ticketsForDistrict(districtCode: string): DispatchTicket[] {
  // A cross-district order belongs to the district that planned it AND to both
  // endpoints: a receiving officer must see an order coming from elsewhere, or
  // the only person who can confirm a delivery cannot find it.
  return allTickets().filter(
    (t) =>
      t.districtCode === districtCode ||
      t.from.districtCode === districtCode ||
      t.to.districtCode === districtCode,
  );
}

/** Tickets changed after `lastSeq`, for the SSE poll. */
export function ticketsSince(lastSeq: number): { tickets: DispatchTicket[]; seq: number } {
  const s = state();
  if (lastSeq >= s.seq) return { tickets: [], seq: s.seq };
  return {
    tickets: allTickets()
      .filter((t) => t.seq > lastSeq)
      .sort((a, b) => a.seq - b.seq),
    seq: s.seq,
  };
}

/** Replace the whole set from a restored log. `tickets` must already be folded. */
export function hydrateTickets(tickets: DispatchTicket[]): { tickets: number; seq: number } {
  const s = state();
  s.tickets = new Map();
  let highest = 0;
  for (const t of [...tickets].sort((a, b) => a.seq - b.seq)) {
    s.tickets.set(t.ticketId, t);
    if (t.seq > highest) highest = t.seq;
  }
  s.seq = Math.max(s.seq, highest);
  return { tickets: s.tickets.size, seq: s.seq };
}

/** Test-only. Never called by a route. */
export function resetTickets(): void {
  (globalThis as TicketHost)[TICKETS] = blank();
}
