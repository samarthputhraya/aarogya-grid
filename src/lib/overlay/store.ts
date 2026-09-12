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
 * WHAT THIS IS NOT
 * ----------------
 * It is not durable and it is not shared between instances. A container restart
 * empties it, and with more than one instance a commit landing on A is invisible
 * to an SSE client on B. Both are known and bounded: the service runs with
 * `--max-instances=1` for exactly this reason, and durability is a separate
 * BigQuery write that is explicitly allowed to fail without failing the commit.
 * The event carries `durable` so the UI can say which it got, rather than
 * implying a permanence this layer does not provide.
 */

/** Where a corrected number came from. Shown in the audit trail. */
export type StockEventSource = 'voice' | 'photo' | 'typed' | 'dispatch';

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
  /** False when the durable write failed. The commit still succeeded. */
  durable: boolean;
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

interface OverlayState {
  /** `facilityId|drugId` -> the correction in force. */
  entries: Map<string, OverlayEntry>;
  events: StockEvent[];
  seq: number;
}

const OVERLAY = Symbol.for('aarogya.overlay');
type OverlayHost = typeof globalThis & { [OVERLAY]?: OverlayState };

function state(): OverlayState {
  const host = globalThis as OverlayHost;
  if (!host[OVERLAY]) {
    host[OVERLAY] = { entries: new Map(), events: [], seq: 0 };
  }
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
  input: Omit<StockEvent, 'seq' | 'at'> & { at?: string },
): StockEvent {
  const s = state();
  const event: StockEvent = {
    ...input,
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
} {
  const s = state();
  return {
    seq: s.seq,
    events: [...s.events].reverse(),
    entries: [...s.entries.entries()].map(([k, v]) => {
      const [facilityId, drugId] = k.split('|');
      return { facilityId, drugId, onHand: v.onHand, at: v.at, source: v.source };
    }),
  };
}

/** Test-only: empty the store. Never called by a route. */
export function resetOverlay(): void {
  const host = globalThis as OverlayHost;
  host[OVERLAY] = { entries: new Map(), events: [], seq: 0 };
}
