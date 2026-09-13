/**
 * Which container this is.
 *
 * `K_REVISION` is Cloud Run's own revision name, so anything this process
 * writes can be traced to the deployment that produced it. The random suffix
 * separates two instances of the same revision -- which is the ordinary case
 * once `--max-instances` is above one, and the thing every cross-instance
 * mechanism in `src/lib/live/` keys on:
 *
 *   - a stock event's `eventId` is `<instance>:<seq>`, so two instances can
 *     both issue seq 7 without the fan-out mistaking one for the other;
 *   - an SSE cursor is scoped to the instance that issued it, so a client
 *     whose reconnect lands on a different container is resynchronised rather
 *     than replayed from a number that means nothing there;
 *   - this instance's Pub/Sub subscription filters out its own messages.
 *
 * Deliberately not `server-only`: the overlay store stamps event ids with it,
 * and the store's tests run in plain Node.
 */
export const INSTANCE_ID =
  (process.env.K_REVISION ?? 'local') + '-' + Math.random().toString(36).slice(2, 8);

/** The instance an `<instance>:<seq>` identifier or cursor was issued by. */
export function splitScoped(value: string | null | undefined): { instance: string | null; seq: number } {
  if (!value) return { instance: null, seq: 0 };
  const at = value.lastIndexOf(':');
  const instance = at > 0 ? value.slice(0, at) : null;
  const seq = Number.parseInt(at >= 0 ? value.slice(at + 1) : value, 10);
  return { instance, seq: Number.isFinite(seq) && seq > 0 ? seq : 0 };
}

/**
 * Upper bound on concurrently running instances, as deployed.
 *
 * Read from `AAROGYA_MAX_INSTANCES`, which the deploy command sets to the same
 * value it passes as `--max-instances`. Anything that has to divide a budget
 * between instances -- the rate limiter's global ceiling -- divides by this.
 */
export function maxInstances(): number {
  const n = Number.parseInt(process.env.AAROGYA_MAX_INSTANCES ?? '1', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
