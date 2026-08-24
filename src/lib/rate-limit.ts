/**
 * Fixed-window rate limiting for the public AI endpoints.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/api/ask` and `/api/capture` are unauthenticated, public, and each POST buys
 * real Gemini generations on a BILLED Vertex project -- a single `ask` runs the
 * agent loop across several model turns plus tool calls. Nothing in the app
 * stopped one script from spending the trial credit in an afternoon, and the
 * credit is what keeps the submission's live link alive until judging.
 *
 * This is deliberately NOT authentication. It is a spend ceiling. The threat
 * model is "someone finds the URL and hammers it", not "a determined attacker
 * wants in". Authentication would cost days and buy nothing on this rubric;
 * a bill ceiling costs an afternoon and protects the deployment.
 *
 * WHY FIXED-WINDOW AND NOT A TOKEN BUCKET
 * ---------------------------------------
 * A fixed window admits a burst of up to 2x the limit across a window boundary.
 * That is a real and well-known flaw, and it is irrelevant here: the number that
 * matters is the ceiling on generations per hour, and 2x a small number is still
 * a small number. Fixed-window is the variant whose behaviour a reader can
 * verify by inspection, and every bound in this file is chosen to be legible
 * rather than clever.
 *
 * TWO LAYERS, ON PURPOSE
 * ----------------------
 * Per-client limiting keys on `x-forwarded-for`, which a client can forge. So
 * there is a second, GLOBAL counter that no header can influence. Forging the
 * first buys an attacker nothing once the second is spent. See `pickClientKey`
 * in `src/proxy.ts` for the header handling.
 *
 * MEMORY IS BOUNDED
 * -----------------
 * A naive Map keyed on client IP is itself a denial-of-service vector: distinct
 * forged keys would grow it without limit. Entries are swept on expiry from the
 * front of the Map (insertion order is window-start order, maintained by the
 * delete-then-set in `check`), and a hard `maxKeys` cap evicts the oldest
 * windows. Both are amortised O(1) per call.
 */

export interface RateLimitRule {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * Maximum distinct keys tracked at once. Beyond this the oldest windows are
   * evicted, which fails OPEN for the evicted key. That is the correct
   * direction to fail: a limiter that runs the process out of memory has
   * caused the outage it existed to prevent.
   */
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** The rule's ceiling, echoed so a caller can set `RateLimit-Limit`. */
  limit: number;
  /** Requests still permitted in the current window, never below zero. */
  remaining: number;
  /** Epoch ms at which the current window ends. */
  resetAtMs: number;
  /** Whole seconds until the window ends, at least 1. For `Retry-After`. */
  retryAfterSeconds: number;
}

interface Window {
  /** Epoch ms when this window opened. */
  startedAtMs: number;
  count: number;
}

const DEFAULT_MAX_KEYS = 20_000;

export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(rule: RateLimitRule) {
    if (!Number.isFinite(rule.limit) || rule.limit < 1) {
      throw new Error('rate limit must be a positive integer');
    }
    if (!Number.isFinite(rule.windowMs) || rule.windowMs < 1) {
      throw new Error('rate limit window must be a positive number of milliseconds');
    }
    this.limit = Math.floor(rule.limit);
    this.windowMs = Math.floor(rule.windowMs);
    this.maxKeys = Math.max(1, Math.floor(rule.maxKeys ?? DEFAULT_MAX_KEYS));
  }

  /** Keys currently tracked. Exposed for tests and for the health probe. */
  get size(): number {
    return this.windows.size;
  }

  /**
   * Count one request against `key` and say whether it is permitted.
   *
   * `now` is injected rather than read from the clock so the behaviour at a
   * window boundary can be asserted rather than slept through.
   */
  check(key: string, now: number = Date.now()): RateLimitResult {
    this.sweep(now);

    const existing = this.windows.get(key);

    // A window is live only if `now` falls inside it. Anything older is a new
    // window, and it is re-inserted (delete first) so that Map insertion order
    // stays ordered by window start -- which is what makes `sweep` correct.
    if (!existing || now - existing.startedAtMs >= this.windowMs) {
      if (existing) this.windows.delete(key);
      this.evictIfFull();
      const fresh: Window = { startedAtMs: now, count: 1 };
      this.windows.set(key, fresh);
      return this.result(true, fresh, now);
    }

    existing.count += 1;
    return this.result(existing.count <= this.limit, existing, now);
  }

  /**
   * Read the current state for `key` WITHOUT counting a request against it.
   *
   * Used by the proxy to attach headers to responses it is letting through for
   * a reason other than the limiter -- reporting a budget it did not spend.
   */
  peek(key: string, now: number = Date.now()): RateLimitResult {
    const existing = this.windows.get(key);
    if (!existing || now - existing.startedAtMs >= this.windowMs) {
      return {
        allowed: true,
        limit: this.limit,
        remaining: this.limit,
        resetAtMs: now + this.windowMs,
        retryAfterSeconds: Math.ceil(this.windowMs / 1000),
      };
    }
    return this.result(existing.count <= this.limit, existing, now);
  }

  /** Drop all state. Tests only. */
  reset(): void {
    this.windows.clear();
  }

  private result(allowed: boolean, w: Window, now: number): RateLimitResult {
    const resetAtMs = w.startedAtMs + this.windowMs;
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - w.count),
      resetAtMs,
      // At least 1: a `Retry-After: 0` invites an immediate retry, which is the
      // opposite of what a limiter is asking for.
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
    };
  }

  /**
   * Drop expired windows from the front of the Map.
   *
   * Insertion order is window-start order, so the first entry that is still
   * live means every entry after it is too, and the walk stops. Amortised O(1):
   * each entry is inserted once and removed once.
   */
  private sweep(now: number): void {
    for (const [key, w] of this.windows) {
      if (now - w.startedAtMs < this.windowMs) break;
      this.windows.delete(key);
    }
  }

  /** Make room for one more key, evicting the oldest window if at the cap. */
  private evictIfFull(): void {
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) return;
      this.windows.delete(oldest.value);
    }
  }
}

/**
 * The limits the deployment actually runs.
 *
 * Sized against the demo, not against a production tenant: a judge exploring the
 * console might reasonably ask the assistant a dozen questions in ten minutes,
 * and will never ask sixty. `AAROGYA_RATE_LIMIT` and `AAROGYA_RATE_WINDOW_S`
 * override per-client without a redeploy; the global ceiling is deliberately not
 * overridable from the environment, because it is the bill's last line.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const PER_CLIENT_RULE: RateLimitRule = {
  limit: envInt('AAROGYA_RATE_LIMIT', 20),
  windowMs: envInt('AAROGYA_RATE_WINDOW_S', 600) * 1000,
  maxKeys: 20_000,
};

/**
 * Every metered request from every client, in one bucket.
 *
 * This is the number that bounds the bill. 240 model-backed POSTs in ten
 * minutes is far more traffic than a hackathon demo will ever see and still a
 * spend a trial credit absorbs. Unlike the per-client key, nothing in the
 * request can influence which bucket a request lands in.
 */
export const GLOBAL_RULE: RateLimitRule = {
  limit: 240,
  windowMs: 600 * 1000,
  maxKeys: 1,
};

export const GLOBAL_KEY = '__all__';

/**
 * Largest request body accepted on a metered endpoint, in bytes.
 *
 * A register photograph arrives as base64, which inflates by 4/3, so this
 * admits roughly a 4.5 MB image. The check exists because both route handlers
 * call `await request.json()`, which buffers the WHOLE body into heap before
 * Zod ever sees it -- so a size cap enforced inside the handler is already too
 * late to prevent the memory spike. It has to happen at the edge, on
 * `Content-Length`, before the body is read.
 */
export const MAX_BODY_BYTES = 6 * 1024 * 1024;

/**
 * Process-wide limiter instances.
 *
 * Held on `globalThis` rather than in module scope because Next's dev server
 * re-evaluates modules on change, and a limiter that resets on every hot reload
 * cannot be tested by hand. In production this is a plain singleton.
 *
 * IN-MEMORY STATE IS A DELIBERATE CHOICE, AND IT HAS A COST: it is per-instance,
 * so N container instances permit N times the per-client limit. The deployment
 * pins `--max-instances` precisely so that multiplier is a known, small integer
 * rather than an autoscaling surprise. A shared store (Redis, Firestore) would
 * make the limit exact and would add a network dependency in front of every
 * request on a service whose entire value is that it has no runtime
 * dependencies. Not worth it at this scale; documented so the tradeoff is a
 * decision rather than an oversight.
 */
const LIMITERS = Symbol.for('aarogya.rate-limiters');

interface LimiterBundle {
  perClient: FixedWindowLimiter;
  global: FixedWindowLimiter;
}

type LimiterHost = typeof globalThis & { [LIMITERS]?: LimiterBundle };

export function limiters(): LimiterBundle {
  const host = globalThis as LimiterHost;
  if (!host[LIMITERS]) {
    host[LIMITERS] = {
      perClient: new FixedWindowLimiter(PER_CLIENT_RULE),
      global: new FixedWindowLimiter(GLOBAL_RULE),
    };
  }
  return host[LIMITERS];
}
