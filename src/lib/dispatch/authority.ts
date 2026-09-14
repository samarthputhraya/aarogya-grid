import { randomUUID } from 'node:crypto';
import { googleRequest, googleRequestWithHeaders, asGoogleApiError } from '@/lib/gcp/request';
import { getTicket, putTicket } from './store';
import type { DispatchTicket } from './ticket';

/**
 * Who decides whether a ticket transition happened.
 *
 * WHY THIS EXISTS
 * ---------------
 * A ticket's state machine refuses a second `approve`, a `dispatch` before
 * approval, a receipt larger than the consignment. Every one of those refusals
 * is a read followed by a write, and with one instance the process was the only
 * writer, so nothing could happen in between. With two, it can: an officer on
 * instance A and a stale tab on instance B both read `proposed`, both pass the
 * check, and both write `approved` -- or worse, both `dispatch`, and the donor's
 * shelf is emptied twice for one order.
 *
 * So the write is conditional. A transition is only recorded if the ticket is
 * still in the version it was read at; otherwise it is re-read and the whole
 * check runs again against what actually happened, which for a double submit
 * produces exactly the 409 the single-instance build produced.
 *
 * TWO AUTHORITIES
 * ---------------
 *   process   this process's ticket store. Correct for one instance, and what
 *             the tests and an offline laptop use.
 *   gcs       one object per ticket in a Cloud Storage bucket, written with
 *             `ifGenerationMatch` -- Cloud Storage's own compare-and-set, which
 *             is strongly consistent. No database to operate, in the same
 *             region as everything else.
 *
 * WHAT IS NOT MOVED HERE
 * ----------------------
 * The BigQuery transition log is still the audit trail and is still appended
 * to after every transition. The bucket holds each ticket's CURRENT fold so a
 * write can be made conditional on it; the log is what somebody reads to find
 * out who did what. A ticket whose append failed says so on its `durability`,
 * exactly as before.
 */

export interface AuthorityRead {
  ticket: DispatchTicket | null;
  /** Opaque version token the next write is conditional on. */
  token: string;
}

export interface TicketAuthority {
  readonly kind: 'process' | 'gcs';
  read(ticketId: string): Promise<AuthorityRead>;
  /** Store `ticket` if it is still at `token`. The new token, or null on a conflict. */
  write(ticket: DispatchTicket, token: string): Promise<string | null>;
  /** Every ticket the authority holds. Used to restore a fresh instance. */
  list(): Promise<DispatchTicket[]>;
}

/** The version a ticket is at: how many transitions it has, the planner's `propose` included. */
export const ticketVersion = (t: DispatchTicket | null | undefined): number => t?.history.length ?? 0;

/** One instance: the process's own store, compared and swapped without an await in between. */
export const processAuthority: TicketAuthority = {
  kind: 'process',
  async read(ticketId) {
    const ticket = getTicket(ticketId) ?? null;
    return { ticket, token: String(ticketVersion(ticket)) };
  },
  async write(ticket, token) {
    if (String(ticketVersion(getTicket(ticket.ticketId))) !== token) return null;
    putTicket(ticket);
    return String(ticketVersion(ticket));
  },
  async list() {
    return [];
  },
};

const GCS = 'https://storage.googleapis.com/storage/v1/b/';
const GCS_UPLOAD = 'https://storage.googleapis.com/upload/storage/v1/b/';
const PREFIX = 'tickets/';

const objectName = (ticketId: string) => PREFIX + encodeURIComponent(ticketId) + '.json';

/** What is stored: the fold, without the fields that belong to one process. */
function stored(ticket: DispatchTicket): Omit<DispatchTicket, 'seq'> {
  const { seq: _seq, ...rest } = ticket;
  void _seq;
  return rest;
}

export function gcsAuthority(bucket: string): TicketAuthority {
  const read = async (name: string): Promise<AuthorityRead> => {
    try {
      const { data, headers } = await googleRequestWithHeaders<unknown>(
        GCS + bucket + '/o/' + encodeURIComponent(name) + '?alt=media',
        { attempts: 3, timeoutMs: 10_000, idempotent: true },
      );
      const parsed = (typeof data === 'string' ? JSON.parse(data) : data) as Omit<DispatchTicket, 'seq'>;
      return {
        ticket: { ...parsed, seq: 0 },
        token: headers['x-goog-generation'] ?? '0',
      };
    } catch (e) {
      // `ifGenerationMatch=0` is Cloud Storage's "only if it does not exist yet".
      if (asGoogleApiError(e).status === 404) return { ticket: null, token: '0' };
      throw e;
    }
  };

  return {
    kind: 'gcs',
    read: (ticketId) => read(objectName(ticketId)),
    async write(ticket, token) {
      try {
        const meta = await googleRequest<{ generation?: string }>(
          GCS_UPLOAD + bucket + '/o',
          {
            method: 'POST',
            params: { uploadType: 'media', name: objectName(ticket.ticketId), ifGenerationMatch: token },
            data: stored(ticket),
            // One attempt. A retried conditional write whose first attempt DID land
            // answers 412 against itself; the caller resolves that by re-reading,
            // which is the only place that can tell "someone else" from "us".
            attempts: 1,
            timeoutMs: 10_000,
          },
        );
        return meta.generation ?? token;
      } catch (e) {
        if (asGoogleApiError(e).status === 412) return null;
        throw e;
      }
    },
    async list() {
      const names: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await googleRequest<{ items?: { name: string }[]; nextPageToken?: string }>(
          GCS + bucket + '/o',
          {
            params: { prefix: PREFIX, fields: 'items(name),nextPageToken', ...(pageToken ? { pageToken } : {}) },
            idempotent: true,
          },
        );
        for (const item of page.items ?? []) names.push(item.name);
        pageToken = page.nextPageToken;
      } while (pageToken);
      const tickets: DispatchTicket[] = [];
      // A district acts on tens of orders, so this is tens of reads; eight at a
      // time keeps a cold start from opening a socket per ticket.
      for (let i = 0; i < names.length; i += 8) {
        const batch = await Promise.all(names.slice(i, i + 8).map(read));
        for (const r of batch) if (r.ticket) tickets.push(r.ticket);
      }
      return tickets;
    },
  };
}

/** The bucket tickets are kept in, when one is configured. */
export function ticketBucket(): string | null {
  if (process.env.AAROGYA_NO_BQ === '1') return null;
  return process.env.AAROGYA_STATE_BUCKET?.trim() || process.env.AAROGYA_RUN_BUCKET?.trim() || null;
}

let configured: TicketAuthority | null = null;

export function ticketAuthority(): TicketAuthority {
  if (!configured) {
    const bucket = ticketBucket();
    configured = bucket ? gcsAuthority(bucket) : processAuthority;
  }
  return configured;
}

/** Test-only: use a particular authority. */
export function setTicketAuthority(authority: TicketAuthority | null): void {
  configured = authority;
}

/** Raised when a transition kept losing the race. The route answers 409. */
export class TicketConflictError extends Error {
  readonly code = 'concurrent_update';
  constructor(readonly ticketId: string, readonly attempts: number) {
    super(
      'Ticket ' + ticketId + ' kept changing while this action was being applied (' + attempts +
        ' attempts). Reload it and try again.',
    );
    this.name = 'TicketConflictError';
  }
}

/**
 * Whether `stored` is the very write `mine` attempted.
 *
 * Compared by a write id minted per attempt, not by the transition's fields:
 * two officers approving the same order in the same millisecond produce
 * identical transitions, and mistaking the other one's write for ours would
 * report success to both.
 */
function alreadyApplied(stored: DispatchTicket | null, mine: DispatchTicket): boolean {
  return !!stored && !!mine.writeId && stored.writeId === mine.writeId;
}

/**
 * Read, decide, write-if-unchanged; on a lost race, decide again.
 *
 * `decide` is handed the ticket as it stands (or null, for an order nobody has
 * acted on) and returns the ticket it wants written. It may throw -- a
 * `TicketTransitionError` from a re-read is the correct outcome of a double
 * submit -- and it must be synchronous, so nothing it reads can change between
 * deciding and the write that is conditional on it.
 */
export async function transitionTicket<R>(
  authority: TicketAuthority,
  ticketId: string,
  decide: (current: DispatchTicket | null) => { next: DispatchTicket; result: R },
  maxAttempts = 4,
): Promise<{ ticket: DispatchTicket; token: string; result: R; conflicts: number }> {
  let conflicts = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { ticket: current, token } = await authority.read(ticketId);
    const decided = decide(current);
    const next: DispatchTicket = { ...decided.next, writeId: randomUUID() };
    const result = decided.result;
    const written = await authority.write(next, token);
    if (written !== null) return { ticket: next, token: written, result, conflicts };
    conflicts++;
    const after = await authority.read(ticketId);
    if (alreadyApplied(after.ticket, next)) return { ticket: next, token: after.token, result, conflicts };
  }
  throw new TicketConflictError(ticketId, maxAttempts);
}
