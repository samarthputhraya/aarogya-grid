/**
 * One authenticated HTTP path to every Google API this project touches.
 *
 * WHY THIS IS SHARED RATHER THAN PER-SERVICE
 * ------------------------------------------
 * Three services are now called over REST -- BigQuery (forecasting, and from
 * WS2 the durable event log), Pub/Sub (the fan-out that makes the audit trail
 * leave the process), and the provisioning calls that create both. They differ
 * only in URL. The auth handshake, the retry policy and the error decoding are
 * identical, and three copies of them would drift: the first time a 429 needed
 * different backoff, only one copy would get it.
 *
 * AUTHENTICATION IS APPLICATION DEFAULT CREDENTIALS, AND THAT IS NOT A CHOICE
 * --------------------------------------------------------------------------
 * This project's GCP org blocks BOTH API keys ("Your organization's security
 * policy disallows API keys") and service-account keys ("Key creation is not
 * allowed on this service account"). So ADC is the only door: locally that is
 * `gcloud auth application-default login`, and on Cloud Run it is the attached
 * workload identity. No secret exists anywhere in this repo or its image.
 */
import { GoogleAuth } from 'google-auth-library';

/** The only region this project runs in. Vertex, BigQuery and Cloud Run all live here. */
export const DEFAULT_LOCATION = 'asia-south1';

/** A Google API error, with the fields worth branching on kept intact. */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | undefined,
    readonly jobId?: string,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

let authSingleton: GoogleAuth | null = null;

export function googleAuth(): GoogleAuth {
  if (!authSingleton) {
    authSingleton = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  return authSingleton;
}

let projectPromise: Promise<string> | null = null;

/**
 * Resolve the billing / quota project.
 *
 * ORDER MATTERS AND THE FALLBACK IS NOT OPTIONAL. Scripts run under `tsx` do
 * not load `.env.local` -- only Next does -- so `GOOGLE_CLOUD_PROJECT` is
 * frequently unset on the command line even though the app sees it. Without the
 * ADC fallback the URL becomes `.../projects/undefined/jobs`, and Google answers
 * that with a genuinely baffling
 * `403 Permission denied: Consumer 'projects/316838101533' has been suspended.`
 * -- a real, suspended, unrelated project, and nothing whatsoever to do with
 * this one. Half an hour was lost to that once.
 */
export function resolveProjectId(): Promise<string> {
  if (!projectPromise) {
    projectPromise = (async () => {
      const fromEnv = process.env.GOOGLE_CLOUD_PROJECT?.trim();
      if (fromEnv) return fromEnv;
      const fromAdc = await googleAuth().getProjectId();
      if (!fromAdc) {
        throw new Error(
          'No GCP project. Set GOOGLE_CLOUD_PROJECT or run `gcloud auth application-default login`.',
        );
      }
      return fromAdc;
    })();
  }
  return projectPromise;
}

export function resolveLocation(explicit?: string): string {
  return explicit ?? process.env.GOOGLE_CLOUD_LOCATION?.trim() ?? DEFAULT_LOCATION;
}

interface ApiErrorBody {
  code?: number;
  message?: string;
  errors?: { reason?: string; message?: string }[];
  status?: string;
}

export function asGoogleApiError(e: unknown, jobId?: string): GoogleApiError {
  if (e instanceof GoogleApiError) return e;
  const res = (e as { response?: { status?: number; data?: { error?: ApiErrorBody } } }).response;
  const err = res?.data?.error;
  const status = err?.code ?? res?.status ?? 0;
  // No response at all: keep the socket's error code (EPIPE, ECONNRESET...) as
  // the reason, so a caller can tell a dropped connection from a refusal.
  const socketCode = (e as { code?: unknown }).code;
  const reason =
    err?.errors?.[0]?.reason ?? err?.status ?? (!res && typeof socketCode === 'string' ? socketCode : undefined);
  const message = err?.message ?? (e as Error).message ?? 'Google API request failed';
  return new GoogleApiError(message, status, reason, jobId);
}

/** Errors worth trying again: transient server-side, not anything we sent. */
const RETRYABLE_REASONS = new Set([
  'rateLimitExceeded',
  'backendError',
  'internalError',
  'jobRateLimitExceeded',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
]);

/**
 * The connection failed before any answer came back. Whether the request took
 * effect is unknown, so these are retried only for requests that are safe to
 * repeat -- see `GoogleRequestInit.idempotent`.
 */
const CONNECTION_FAILURES = new Set(['EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET']);

export function isRetryable(e: GoogleApiError, idempotent = false): boolean {
  if (e.status >= 500) return true;
  if (e.status === 429) return true;
  if (idempotent && e.status === 0 && e.reason !== undefined && CONNECTION_FAILURES.has(e.reason)) return true;
  return e.reason !== undefined && RETRYABLE_REASONS.has(e.reason);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GoogleRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  data?: unknown;
  params?: Record<string, string | number>;
  /** Total attempts including the first. Default 4. */
  attempts?: number;
  /** Abandon a single attempt after this long. */
  timeoutMs?: number;
  /** Extra request headers, e.g. the content type of a media upload. */
  headers?: Record<string, string>;
  /**
   * Repeating the request is harmless -- a read, or writing the same bytes to
   * the same object name. Only then is a connection that died without an answer
   * retried; a BigQuery append or a Pub/Sub publish repeated blind could land twice.
   */
  idempotent?: boolean;
}

export async function googleRequest<T>(url: string, init: GoogleRequestInit = {}): Promise<T> {
  return (await googleRequestWithHeaders<T>(url, init)).data;
}

/**
 * The same request, with the response headers kept.
 *
 * Cloud Storage returns an object's generation -- the token a conditional write
 * is made against -- as `x-goog-generation` on a media read, not in the body.
 * A compare-and-set that could not see it would have to read twice.
 */
export async function googleRequestWithHeaders<T>(
  url: string,
  init: GoogleRequestInit = {},
): Promise<{ data: T; headers: Record<string, string> }> {
  const client = await googleAuth().getClient();
  const attempts = init.attempts ?? 4;
  let lastError: GoogleApiError | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await client.request<T>({
        url,
        method: init.method ?? 'GET',
        data: init.data,
        params: init.params,
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.timeoutMs ? { timeout: init.timeoutMs } : {}),
      });
      const headers: Record<string, string> = {};
      const raw = res.headers as unknown;
      if (raw && typeof (raw as Headers).forEach === 'function') {
        (raw as Headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
      } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) headers[k.toLowerCase()] = String(v);
      }
      return { data: res.data, headers };
    } catch (e) {
      lastError = asGoogleApiError(e);
      if (attempt === attempts - 1 || !isRetryable(lastError, init.idempotent)) throw lastError;
      // Exponential backoff with jitter, so a set of parallel requests that all
      // hit the same rate limit do not all come back at the same instant.
      await sleep(2 ** attempt * 500 + Math.random() * 250);
    }
  }
  throw lastError ?? new Error('unreachable');
}
