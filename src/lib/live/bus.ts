import 'server-only';
import { googleRequest, resolveProjectId, asGoogleApiError } from '@/lib/gcp/request';
import { bigQueryEnabled } from '@/lib/bq/client';
import { PUBSUB_TOPIC, LIVE_SUBSCRIPTION_PREFIX } from '@/lib/durable/schema';
import { invalidateRun } from '@/lib/run-store';
import { INSTANCE_ID, maxInstances } from './instance';
import { applyBusMessage } from './apply';

/**
 * The fan-out listener: how a commit on one instance reaches every other.
 *
 * WHY EACH INSTANCE OWNS A SUBSCRIPTION
 * -------------------------------------
 * A Pub/Sub subscription delivers each message to ONE of its consumers. That
 * is a work queue, and it is the wrong shape here: a report committed on
 * instance A has to reach B *and* C, because each holds its own overlay and its
 * own open consoles. So every instance creates a subscription of its own on the
 * shared topic when it starts, filtered to exclude the messages it published
 * itself, and deletes it on shutdown. One that is never deleted -- a container
 * killed without SIGTERM -- expires on its own after a day without a consumer.
 *
 * A push subscription to the service URL would have been less code and does
 * not work: Cloud Run load-balances the push to one instance.
 *
 * WHAT IS GUARANTEED, AND WHAT IS NOT
 * -----------------------------------
 * The origin publishes a report AFTER its BigQuery append settles, with the
 * outcome on the message. An instance creates its subscription BEFORE it reads
 * the log back. Together: any report whose append landed before the restore
 * query is in the restore, and any report published after the subscription
 * existed is delivered -- so a new instance misses nothing that was durable.
 * Duplicates between the two are dropped by `eventId`.
 *
 * What is not guaranteed: a publish that fails twice never fans out. The
 * origin's console shows that event as unpublished, and the other instances
 * pick it up at their next restart, from the log. Stated rather than hidden.
 *
 * Tickets are different in kind, and do not depend on this. A transition is
 * made conditionally against the ticket authority (`dispatch/authority.ts`), so
 * two instances cannot both approve an order however late the fan-out is; this
 * only carries the result to consoles open elsewhere.
 *
 * THE LAG IS THE APPEND
 * ---------------------
 * On the instance that took a commit, the change streams at once. Elsewhere it
 * arrives after the append (a few hundred milliseconds) plus delivery. That is
 * the price of the guarantee above, and `scripts/rehearse-scale.mjs` measures it.
 */

const PS = 'https://pubsub.googleapis.com/v1';

/** Minimum Pub/Sub allows. A subscription idle this long has no instance left. */
const EXPIRE_AFTER = '86400s';
/** Also the minimum. A restarted instance restores from the log, not from here. */
const RETAIN = '600s';
/** Messages per pull. A demo produces a handful; a busy district a few dozen. */
const MAX_MESSAGES = 256;

export interface BusStatus {
  enabled: boolean;
  instanceId: string;
  maxInstances: number;
  subscription: string | null;
  state: 'disabled' | 'starting' | 'listening' | 'failed' | 'stopped';
  error: string | null;
  received: number;
  applied: number;
  duplicates: number;
  ignored: number;
  lastMessageAt: string | null;
  /** Milliseconds from the origin's publish to this instance applying it, last message. */
  lastLagMs: number | null;
}

interface BusState {
  status: BusStatus;
  started: Promise<void> | null;
  looping: boolean;
  stopping: boolean;
}

const BUS = Symbol.for('aarogya.live.bus');
type BusHost = typeof globalThis & { [BUS]?: BusState };

/** On only where durability is -- including its rule that the project must be named. */
export function busEnabled(): boolean {
  return (
    bigQueryEnabled() &&
    process.env.AAROGYA_NO_BUS !== '1' &&
    process.env.AAROGYA_NO_DURABLE !== '1' &&
    Boolean(process.env.GOOGLE_CLOUD_PROJECT?.trim())
  );
}

function bus(): BusState {
  const host = globalThis as BusHost;
  if (!host[BUS]) {
    host[BUS] = {
      status: {
        enabled: busEnabled(),
        instanceId: INSTANCE_ID,
        maxInstances: maxInstances(),
        subscription: null,
        state: busEnabled() ? 'starting' : 'disabled',
        error: null,
        received: 0,
        applied: 0,
        duplicates: 0,
        ignored: 0,
        lastMessageAt: null,
        lastLagMs: null,
      },
      started: null,
      looping: false,
      stopping: false,
    };
  }
  return host[BUS];
}

export function busStatus(): BusStatus {
  return { ...bus().status };
}

/** A subscription id Pub/Sub accepts: letters, digits and dashes, under 255. */
function subscriptionId(): string {
  return (LIVE_SUBSCRIPTION_PREFIX + INSTANCE_ID.toLowerCase().replace(/[^a-z0-9-]/g, '-')).slice(0, 250);
}

async function createSubscription(projectId: string, id: string): Promise<void> {
  const url = PS + '/projects/' + projectId + '/subscriptions/' + id;
  try {
    await googleRequest(url, {
      method: 'PUT',
      attempts: 3,
      timeoutMs: 15_000,
      data: {
        topic: 'projects/' + projectId + '/topics/' + PUBSUB_TOPIC,
        ackDeadlineSeconds: 10,
        messageRetentionDuration: RETAIN,
        expirationPolicy: { ttl: EXPIRE_AFTER },
        // Everything this instance publishes, it has already applied.
        filter: 'attributes.instanceId != "' + INSTANCE_ID + '"',
        labels: { app: 'aarogya-grid', role: 'live-fanout' },
      },
    });
  } catch (e) {
    // 409: this instance id already has one -- a module re-evaluated in dev.
    if (asGoogleApiError(e).status !== 409) throw e;
  }
}

interface PullResponse {
  receivedMessages?: {
    ackId: string;
    message: { data?: string; attributes?: Record<string, string>; publishTime?: string };
  }[];
}

async function pullLoop(projectId: string, id: string): Promise<void> {
  const b = bus();
  const base = PS + '/projects/' + projectId + '/subscriptions/' + id;
  let backoffMs = 1_000;
  // Listening from the moment the first pull is outstanding: on a quiet topic
  // that pull may not return for a minute, and the instance is hearing
  // everyone the whole time.
  b.status.state = 'listening';
  while (!b.stopping) {
    try {
      // A synchronous pull holds the request open until messages arrive or the
      // server gives up; an empty answer is normal and the loop simply asks again.
      const res = await googleRequest<PullResponse>(base + ':pull', {
        method: 'POST',
        attempts: 1,
        timeoutMs: 90_000,
        data: { maxMessages: MAX_MESSAGES },
      });
      const received = res.receivedMessages ?? [];
      if (received.length > 0) {
        for (const r of received) {
          b.status.received++;
          let body: unknown = null;
          try {
            body = r.message.data ? JSON.parse(Buffer.from(r.message.data, 'base64').toString('utf8')) : null;
          } catch {
            body = null;
          }
          const outcome = applyBusMessage(r.message.attributes, body, (runId) => {
            void invalidateRun().catch(() => undefined);
            void runId;
          });
          if (outcome.applied) b.status.applied++;
          else if (outcome.duplicate) b.status.duplicates++;
          else b.status.ignored++;
          b.status.lastMessageAt = new Date().toISOString();
          if (r.message.publishTime) b.status.lastLagMs = Date.now() - Date.parse(r.message.publishTime);
        }
        // Acknowledged after applying, so a crash mid-batch redelivers rather
        // than loses; redelivery is harmless because application is idempotent.
        await googleRequest(base + ':acknowledge', {
          method: 'POST',
          attempts: 3,
          timeoutMs: 10_000,
          data: { ackIds: received.map((r) => r.ackId) },
        });
      }
      b.status.state = 'listening';
      b.status.error = null;
      backoffMs = 1_000;
    } catch (e) {
      const err = asGoogleApiError(e);
      if (b.stopping) break;
      b.status.error = err.message;
      if (err.status === 404) {
        // Expired or deleted underneath us. Recreate and carry on; anything
        // published meanwhile is in the log for the next restart.
        try {
          await createSubscription(projectId, id);
        } catch {
          // Reported on the next pass.
        }
      }
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }
  b.status.state = 'stopped';
}

/**
 * Create this instance's subscription. Resolves once it exists.
 *
 * Called by `ensureRestored` BEFORE the log is read back -- that ordering is
 * the guarantee described above. Never throws: an instance that cannot
 * subscribe still serves its own commits, and says why it is not hearing
 * anyone else's.
 */
export function ensureSubscribed(): Promise<void> {
  const b = bus();
  if (!b.status.enabled) return Promise.resolve();
  if (!b.started) {
    b.started = (async () => {
      try {
        const projectId = await resolveProjectId();
        const id = subscriptionId();
        await createSubscription(projectId, id);
        b.status.subscription = id;
        const stop = () => {
          if (b.stopping) return;
          b.stopping = true;
          // Best effort, and bounded: Cloud Run allows ten seconds after SIGTERM.
          void googleRequest(PS + '/projects/' + projectId + '/subscriptions/' + id, {
            method: 'DELETE',
            attempts: 1,
            timeoutMs: 5_000,
          }).catch(() => undefined);
        };
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
      } catch (e) {
        b.status.state = 'failed';
        b.status.error = asGoogleApiError(e).message;
      }
    })();
  }
  return b.started;
}

/** Start consuming. Called after the restore, so foreign events land on a restored store. */
export function startListening(): void {
  const b = bus();
  if (!b.status.enabled || !b.status.subscription || b.looping) return;
  b.looping = true;
  const id = b.status.subscription;
  void resolveProjectId().then((projectId) => pullLoop(projectId, id));
}
