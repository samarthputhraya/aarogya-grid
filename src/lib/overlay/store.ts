/**
 * The live overlay: what has changed since the batch job ran.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The snapshot is a nightly artefact. A facility that reports its stock at
 * 11 a.m. should not have to wait until tomorrow to appear on the board -- the
 * brief asks for real-time visibility, and a dashboard that is always one night
 * stale is the thing every state already has.
 *
 * So committed reports live here, in front of the snapshot: a small map of
 * (facility, drug) -> corrected on-hand, plus an ordered event log. Every
 * consumer -- the recompute, the SSE stream, the mount-time fetch -- reads this
 * one store, so there is exactly one answer to "what is true right now".
 *
 * WHY A MODULE-SCOPE SYMBOL AND NOT A MODULE-SCOPE `let`
 * -----------------------------------------------------
 * `src/lib/rate-limit.ts` already solves this and the pattern is copied
 * deliberately. In development Next re-evaluates modules on every edit, so a
 * plain module-level `Map` is silently replaced and every committed report
 * vanishes mid-demo. Hanging the state off `Symbol.for('aarogya.overlay')` puts
 * it on the realm's global registry, which survives module replacement.
 *
 * WHAT THIS IS AND IS NOT, AFTER WS2 DURABILITY
 * ---------------------------------------------
 * This is still RAM: it is the fast path, and it is not shared between
 * instances. A commit landing on instance A is invisible to an SSE client on B,
 * which is why the service runs with `--max-instances=1`.
 *
 * What changed on day 8 is that it is no longer the only copy. Every committed
 * event is also appended to BigQuery, and `hydrate()` below reads that log back
 * on container start -- so a restart now costs a one-off restore query rather
 * than every correction anyone made. The durable write is deliberately NOT on
 * the commit's critical path: it happens after the response, and each event
 * carries its own `durability` so the UI can say "queued", "durable" or "not
 * durable" truthfully at every instant rather than implying a permanence it has
 * not yet earned.
 */

/** Where a corrected number came from. Shown in the audit trail. */
export type StockEventSource = 'voice' | 'photo' | 'typed' | 'dispatch';

/**
 * How far a committed event has got towards being durable.
 *
 * FOUR STATES, BECAUSE A BOOLEAN WOULD HAVE TO LIE AT LEAST ONCE
 * --------------------------------------------------------------
 * The commit responds in ~15 ms and the BigQuery append takes a few hundred, so
 * there is a real window in which the honest answer is "not yet". A boolean
 * would have to report that window as either `true` (a claim the row survives a
 * restart, before it does) or `false` (indistinguishable from a write that
 * actually failed). Neither is true, so neither is used.
 *
 *   pending   -- accepted, append in flight
 *   durable   -- BigQuery acknowledged the row
 *   failed    -- the append failed after its retry; the commit still stands
 *   disabled  -- no durable sink configured (AAROGYA_NO_BQ=1, or no dataset)
 */
export type Durability = 'pending' | 'durable' | 'failed' | 'disabled';

/** The risk figures after recompute, carried on the event so clients need no second call. */
export interface OverlayRisk {
  onHand: number;
  previousOnHand: number;
  stockoutProbability: number;
  previousStockoutProbability: number;
  riskScore: number;
  previousRiskScore: number;
  severity: string;
  previousSeverity: string;
  daysOfCover: number;
  reorderPoint: number;
  expectedShortfallUnits: number;
  forecastSource: string;
}

export interface StockEvent {
  /** Monotonic, starts at 1. Doubles as the SSE `id:` for replay. */
  seq: number;
  at: string;
  facilityId: string;
  facilityName: string;
  districtCode: string;
  drugId: string;
  drugName: string;
  onHand: number;
  source: StockEventSource;
  /** How far the durable append has got. See `Durability`. */
  durability: Durability;
  /** Why it failed, when it did. Shown rather than swallowed. */
  durabilityDetail?: string;
  /** True once the event reached Pub/Sub -- the fan-out copy of the audit trail. */
  published: boolean;
  /** True when this event came back from BigQuery rather than from a live commit. */
  restored?: boolean;
  risk: OverlayRisk;
  /** Milliseconds the server spent re-scoring this position. */
  recomputeMs: number;
}

export interface OverlayEntry {
  onHand: number;
  at: string;
  source: StockEventSource;
  seq: number;
}

/**
 * Events kept for replay.
 *
 * An SSE client that drops its connection reconnects with `Last-Event-ID` and
 * expects everything it missed. 200 events is far more than a demo produces and
 * a trivial amount of memory; past that the oldest are dropped and a reconnecting
 * client is told to refetch rather than being handed a silent gap.
 */
const MAX_EVENTS = 200;

/** What the last restore attempt did. Reported by `GET /api/overlay`. */
export interface RestoreReport {
  attempted: boolean;
  ok: boolean;
  at: string | null;
  /** Events put back into the replay buffer. */
  events: number;
  /** Positions whose correction was put back in force. */
  entries: number;
  elapsedMs: number;
  error: string | null;
  /**
   * True when the log held duplicate sequence numbers and they were reassigned.
   * That can only happen if a restore once failed and a later one succeeded, so
   * it is worth surfacing rather than silently repairing.
   */
  renumbered: boolean;
}

const NO_RESTORE: RestoreReport = {
  attempted: false,
  ok: false,
  at: null,
  events: 0,
  entries: 0,
  elapsedMs: 0,
  error: null,
  renumbered: false,
};

/**
 * A change to an event's durability, after the event itself was sent.
 *
 * These need their own cursor. Durability arrives out of band -- a few hundred
 * milliseconds after the commit -- and it must not consume a stock `seq`, or an
 * SSE client's `Last-Event-ID` would advance past events it never received.
 */
export interface DurabilityUpdate {
  id: number;
  seq: number;
  durability: Durability;
  detail?: string;
  published: boolean;
}

interface OverlayState {
  /** `facilityId|drugId` -> the correction in force. */
  entries: Map<string, OverlayEntry>;
  events: StockEvent[];
  seq: number;
  durabilityUpdates: DurabilityUpdate[];
  durabilityId: number;
  restore: RestoreReport;
}

const OVERLAY = Symbol.for('aarogya.overlay');
type OverlayHost = typeof globalThis & { [OVERLAY]?: OverlayState };

function blank(): OverlayState {
  return {
    entries: new Map(),
    events: [],
    seq: 0,
    durabilityUpdates: [],
    durabilityId: 0,
    restore: { ...NO_RESTORE },
  };
}

function state(): OverlayState {
  const host = globalThis as OverlayHost;
  if (!host[OVERLAY]) host[OVERLAY] = blank();
  return host[OVERLAY];
}

const key = (facilityId: string, drugId: string) => facilityId + '|' + drugId;

/** The highest sequence number issued. 0 means nothing has been committed. */
export function currentSeq(): number {
  return state().seq;
}

/**
 * Record a committed correction and return the event.
 *
 * The caller supplies the recomputed risk: this module deliberately does not
 * import the pipeline, so the store stays cheap to pull into any route while the
 * expensive part stays in `recompute.ts`.
 */
export function recordStockEvent(
  input: Omit<StockEvent, 'seq' | 'at' | 'published'> & { at?: string; published?: boolean },
): StockEvent {
  const s = state();
  const event: StockEvent = {
    ...input,
    published: input.published ?? false,
    seq: ++s.seq,
    at: input.at ?? new Date().toISOString(),
  };
  s.entries.set(key(event.facilityId, event.drugId), {
    onHand: event.onHand,
    at: event.at,
    source: event.source,
    seq: event.seq,
  });
  s.events.push(event);
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  return event;
}

/**
 * Put the durable log back in front of the snapshot after a restart.
 *
 * WHY THE STORED `seq` IS KEPT RATHER THAN REASSIGNED
 * ---------------------------------------------------
 * `seq` is what an SSE client sends back as `Last-Event-ID`. If a restart
 * renumbered the log, every client that reconnected would be asking for a
 * position in a sequence that no longer means what it meant -- silently
 * replaying events it already had, or skipping ones it did not. So the number
 * written at commit time is the number restored.
 *
 * The one case that can break that is a restore which FAILED: the instance
 * starts counting from 1 again and writes rows whose seq collides with older
 * ones. That is detectable -- duplicate seqs -- and when it is detected the log
 * is renumbered and `renumbered` is reported, because at that point a stale
 * cursor is already meaningless and a quiet repair would hide the fact that a
 * write path had been broken.
 */
export function hydrate(
  events: StockEvent[],
  opts: { maxSeq?: number; elapsedMs?: number } = {},
): RestoreReport {
  const s = state();
  const ordered = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));

  const seen = new Set<number>();
  let renumbered = false;
  for (const e of ordered) {
    if (seen.has(e.seq)) {
      renumbered = true;
      break;
    }
    seen.add(e.seq);
  }
  if (renumbered) ordered.forEach((e, i) => (e.seq = i + 1));

  s.entries = new Map();
  for (const e of ordered) {
    s.entries.set(key(e.facilityId, e.drugId), {
      onHand: e.onHand,
      at: e.at,
      source: e.source,
      seq: e.seq,
    });
  }
  // The replay buffer holds the newest `MAX_EVENTS`; the entries map above is
  // built from everything restored, so a position whose last correction is
  // older than the buffer is still in force.
  s.events = ordered.slice(-MAX_EVENTS);
  const highest = ordered.length > 0 ? ordered[ordered.length - 1].seq : 0;
  s.seq = Math.max(s.seq, renumbered ? ordered.length : (opts.maxSeq ?? highest), highest);

  s.restore = {
    attempted: true,
    ok: true,
    at: new Date().toISOString(),
    events: s.events.length,
    entries: s.entries.size,
    elapsedMs: opts.elapsedMs ?? 0,
    error: null,
    renumbered,
  };
  return s.restore;
}

/** Record a restore that was tried and did not work. The overlay stays empty. */
export function noteRestoreFailure(error: string, elapsedMs: number): RestoreReport {
  const s = state();
  s.restore = {
    attempted: true,
    ok: false,
    at: new Date().toISOString(),
    events: 0,
    entries: 0,
    elapsedMs,
    error,
    renumbered: false,
  };
  return s.restore;
}

/** Record that there is no durable sink to restore from. Not a failure. */
export function noteRestoreDisabled(): RestoreReport {
  const s = state();
  s.restore = { ...NO_RESTORE, attempted: true, ok: true, at: new Date().toISOString() };
  return s.restore;
}

export function restoreReport(): RestoreReport {
  return state().restore;
}

/**
 * Move an event's durability on, and queue the change for the stream.
 *
 * Returns undefined when the event has already fallen out of the replay buffer
 * -- there is nobody left to tell, and inventing an update for an event no
 * client still holds would be noise.
 */
export function markDurability(
  seq: number,
  durability: Durability,
  opts: { detail?: string; published?: boolean } = {},
): DurabilityUpdate | undefined {
  const s = state();
  const event = s.events.find((e) => e.seq === seq);
  if (!event) return undefined;
  event.durability = durability;
  event.durabilityDetail = opts.detail;
  if (opts.published !== undefined) event.published = opts.published;
  const update: DurabilityUpdate = {
    id: ++s.durabilityId,
    seq,
    durability,
    detail: opts.detail,
    published: event.published,
  };
  s.durabilityUpdates.push(update);
  if (s.durabilityUpdates.length > MAX_EVENTS) {
    s.durabilityUpdates.splice(0, s.durabilityUpdates.length - MAX_EVENTS);
  }
  return update;
}

/** Durability changes after `lastId`, for the SSE poll. */
export function durabilitySince(lastId: number): { updates: DurabilityUpdate[]; id: number } {
  const s = state();
  if (lastId >= s.durabilityId) return { updates: [], id: s.durabilityId };
  return { updates: s.durabilityUpdates.filter((u) => u.id > lastId), id: s.durabilityId };
}

/**
 * The durability of every retained event, as it stands now.
 *
 * Sent once when a stream opens. A client that was disconnected while an event
 * went from `pending` to `durable` would otherwise show "queued, not yet
 * durable" forever: the stock event is behind its cursor so it is never
 * replayed, and the durability update that would have corrected it may itself
 * have aged out.
 */
export function durabilityMap(): { updates: DurabilityUpdate[]; id: number } {
  const s = state();
  return {
    updates: s.events.map((e) => ({
      id: 0,
      seq: e.seq,
      durability: e.durability,
      detail: e.durabilityDetail,
      published: e.published,
    })),
    id: s.durabilityId,
  };
}

/** The correction in force for one position, if any. */
export function overlayFor(facilityId: string, drugId: string): OverlayEntry | undefined {
  return state().entries.get(key(facilityId, drugId));
}

/**
 * The lookup `buildStates` accepts.
 *
 * Shaped as a function rather than as the Map itself so the pipeline has no
 * opinion about where corrections come from -- a BigQuery-backed reader would
 * slot in here unchanged.
 */
export function overlayLookup(): (facilityId: string, drugId: string) => { onHand?: number } {
  const entries = state().entries;
  return (facilityId, drugId) => {
    const hit = entries.get(key(facilityId, drugId));
    return hit ? { onHand: hit.onHand } : {};
  };
}

export interface OverlaySince {
  events: StockEvent[];
  /** True when the requested cursor has fallen off the ring buffer. */
  gap: boolean;
  seq: number;
}

/**
 * Events after `lastSeq`.
 *
 * `gap` is the honest answer to a reconnect that asks for more history than is
 * held. Replaying only what survives would leave the client quietly missing
 * rows it believes it has; telling it to refetch is correct and cheap.
 */
export function eventsSince(lastSeq: number): OverlaySince {
  const s = state();
  if (lastSeq >= s.seq) return { events: [], gap: false, seq: s.seq };
  const oldest = s.events.length > 0 ? s.events[0].seq : s.seq + 1;
  const gap = lastSeq > 0 && lastSeq < oldest - 1;
  return { events: s.events.filter((e) => e.seq > lastSeq), gap, seq: s.seq };
}

/** Every correction in force, newest first. Served by `GET /api/overlay`. */
export function overlaySnapshot(): {
  seq: number;
  events: StockEvent[];
  entries: { facilityId: string; drugId: string; onHand: number; at: string; source: string }[];
  restore: RestoreReport;
} {
  const s = state();
  return {
    seq: s.seq,
    events: [...s.events].reverse(),
    entries: [...s.entries.entries()].map(([k, v]) => {
      const [facilityId, drugId] = k.split('|');
      return { facilityId, drugId, onHand: v.onHand, at: v.at, source: v.source };
    }),
    restore: s.restore,
  };
}

/** Test-only: empty the store. Never called by a route. */
export function resetOverlay(): void {
  const host = globalThis as OverlayHost;
  host[OVERLAY] = blank();
}
