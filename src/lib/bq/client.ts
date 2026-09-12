/**
 * BigQuery over the REST API.
 *
 * WHY REST AND NOT THE `bq` CLI OR `@google-cloud/bigquery`
 * ---------------------------------------------------------
 * The forecasting path sends the demand history itself INSIDE the SQL text (see
 * `series.ts` for why). That makes the statement hundreds of kilobytes long, and
 * that is where both of the obvious routes fall over:
 *
 *   - `bq query "<sql>"` dies on Windows with a hard `Argument list too long`
 *     at ~425 KB. Not truncation -- the process never starts.
 *   - `@google-cloud/bigquery` would work, but it is a large dependency tree for
 *     three endpoints, and `google-auth-library` is already resolved in this
 *     project (transitively, via `@google/genai`) and exports everything the
 *     auth half needs.
 *
 * So this file talks to three endpoints directly: `jobs.insert`,
 * `jobs.getQueryResults`, and `jobs.insert` again in dry-run mode.
 *
 * AUTHENTICATION
 * --------------
 * Application Default Credentials only. This project's GCP org blocks BOTH API
 * keys ("Your organization's security policy disallows API keys") and service
 * account keys ("Key creation is not allowed on this service account"), so ADC
 * is not a convenience here, it is the only door. Locally that means
 * `gcloud auth application-default login`; on Cloud Run it is the attached
 * workload identity and no secret exists anywhere.
 */
import { GoogleAuth } from 'google-auth-library';

const BQ_BASE = 'https://bigquery.googleapis.com/bigquery/v2';

/**
 * BigQuery's documented ceiling on an unresolved standard SQL statement.
 *
 * The server states it as "1024.00K characters", and it is enforced on the
 * query text, not on the request body. Measured against this API: 957 KB of SQL
 * returns 200; ~1.03 MB returns
 * `400 maximum standard SQL query length is 1024.00K characters`.
 */
export const MAX_QUERY_CHARS = 1024 * 1024;

/** The only region this project runs in. Vertex and BigQuery both live here. */
export const DEFAULT_LOCATION = 'asia-south1';

/** Thrown when `AAROGYA_NO_BQ=1` is set. Callers fall back rather than fail. */
export class BigQueryDisabledError extends Error {
  constructor() {
    super('BigQuery is disabled (AAROGYA_NO_BQ=1)');
    this.name = 'BigQueryDisabledError';
  }
}

/** Thrown by the pre-flight length check, before anything is sent. */
export class QueryTooLongError extends Error {
  constructor(
    readonly chars: number,
    readonly limit: number,
  ) {
    super(
      'SQL is ' +
        chars.toLocaleString('en-IN') +
        ' characters, over the ' +
        limit.toLocaleString('en-IN') +
        ' character limit. Reduce the batch size.',
    );
    this.name = 'QueryTooLongError';
  }
}

/** A BigQuery API error, with the fields worth branching on kept intact. */
export class BigQueryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | undefined,
    readonly jobId?: string,
  ) {
    super(message);
    this.name = 'BigQueryError';
  }
}

/**
 * Whether the BigQuery path is available at all.
 *
 * `AAROGYA_NO_BQ=1` is the switch that proves the fallback works: the snapshot
 * build must produce a valid artefact with no network at all, using the
 * committed forecast cache and Croston. It is checked in the build, so the
 * fallback cannot quietly rot.
 */
export function bigQueryEnabled(): boolean {
  return process.env.AAROGYA_NO_BQ !== '1';
}

/**
 * Character count as BigQuery counts it.
 *
 * Exported so the chunker can budget against exactly the number the server will
 * measure, rather than a byte length that disagrees on any non-ASCII identifier.
 */
export function sqlLength(sql: string): number {
  return sql.length;
}

let authSingleton: GoogleAuth | null = null;

function auth(): GoogleAuth {
  if (!authSingleton) {
    authSingleton = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  return authSingleton;
}

let projectPromise: Promise<string> | null = null;

/**
 * Resolve the billing / quota project for the job.
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
      const fromAdc = await auth().getProjectId();
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

function resolveLocation(explicit?: string): string {
  return explicit ?? process.env.GOOGLE_CLOUD_LOCATION?.trim() ?? DEFAULT_LOCATION;
}

export interface RunQueryOptions {
  location?: string;
  /** Fail the job server-side after this many ms. */
  jobTimeoutMs?: number;
  /** How long each `getQueryResults` call blocks server-side. Default 10 s. */
  pollTimeoutMs?: number;
  /** Rows per result page. Default 20,000. */
  pageSize?: number;
  /** Give up after this long in total. Default 15 minutes. */
  deadlineMs?: number;
  /**
   * Let BigQuery serve a cached result for an identical statement. Default true.
   *
   * The runtime ladder sets this false, and must: it runs the same statement
   * repeatedly to measure a band, and a cache hit would return in milliseconds
   * and report that as the forecast's speed.
   */
  useQueryCache?: boolean;
  /** Attached to the job in BigQuery's UI, for tracing a run after the fact. */
  jobLabel?: string;
}

export interface QueryStats {
  jobId: string;
  location: string;
  /** Wall clock from first request to last row, measured on this side. */
  elapsedMs: number;
  totalBytesProcessed: number;
  totalSlotMs: number;
  cacheHit: boolean;
  rowCount: number;
  /** Characters of SQL sent. */
  sqlChars: number;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  stats: QueryStats;
}

export interface BqField {
  name: string;
  type: string;
  mode?: string;
  fields?: BqField[];
}

interface BqCell {
  v: unknown;
}

/** Decode one REST row (`{f:[{v}]}`) into a plain object keyed by column name. */
function decodeRow(fields: BqField[], cells: BqCell[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i++) {
    out[fields[i].name] = decodeCell(fields[i], cells[i]?.v);
  }
  return out;
}

/**
 * Decode a single cell.
 *
 * BigQuery's REST surface returns every scalar as a STRING, including numbers
 * and including TIMESTAMP (as epoch seconds with a fractional part). Converting
 * here rather than at each call site is what keeps the forecast decoder free of
 * `Number(row.forecast_value as string)` noise.
 */
function decodeCell(field: BqField, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (field.mode === 'REPEATED' && Array.isArray(v)) {
    return v.map((item) => decodeCell({ ...field, mode: 'NULLABLE' }, (item as BqCell)?.v));
  }
  switch (field.type) {
    case 'INTEGER':
    case 'INT64':
    case 'FLOAT':
    case 'FLOAT64':
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return Number(v);
    case 'BOOLEAN':
    case 'BOOL':
      return v === 'true' || v === true;
    case 'TIMESTAMP': {
      // Epoch seconds, as a string, sometimes fractional.
      const seconds = Number(v);
      return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : String(v);
    }
    case 'RECORD':
    case 'STRUCT':
      return decodeRow(field.fields ?? [], ((v as { f?: BqCell[] }).f ?? []) as BqCell[]);
    default:
      return String(v);
  }
}

interface ApiError {
  code?: number;
  message?: string;
  errors?: { reason?: string; message?: string }[];
  status?: string;
}

function asBigQueryError(e: unknown, jobId?: string): BigQueryError {
  const res = (e as { response?: { status?: number; data?: { error?: ApiError } } }).response;
  const err = res?.data?.error;
  const status = err?.code ?? res?.status ?? 0;
  const reason = err?.errors?.[0]?.reason;
  const message = err?.message ?? (e as Error).message ?? 'BigQuery request failed';
  return new BigQueryError(message, status, reason, jobId);
}

/** Errors worth trying again: transient server-side, not anything we sent. */
const RETRYABLE_REASONS = new Set([
  'rateLimitExceeded',
  'backendError',
  'internalError',
  'jobRateLimitExceeded',
]);

function isRetryable(e: BigQueryError): boolean {
  if (e.status >= 500) return true;
  if (e.status === 429) return true;
  return e.reason !== undefined && RETRYABLE_REASONS.has(e.reason);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(
  url: string,
  init: { method?: 'GET' | 'POST'; data?: unknown; params?: Record<string, string | number> },
  attempts = 4,
): Promise<T> {
  const client = await auth().getClient();
  let lastError: BigQueryError | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await client.request<T>({
        url,
        method: init.method ?? 'GET',
        data: init.data,
        params: init.params,
      });
      return res.data;
    } catch (e) {
      lastError = asBigQueryError(e);
      if (attempt === attempts - 1 || !isRetryable(lastError)) throw lastError;
      // Exponential backoff with jitter, so a set of parallel queries that all
      // hit the same rate limit do not all come back at the same instant.
      await sleep(2 ** attempt * 500 + Math.random() * 250);
    }
  }
  throw lastError ?? new Error('unreachable');
}

/**
 * Cost and validity check without running anything.
 *
 * Every inline-subquery forecast in this project dry-runs at 0 bytes processed,
 * which is the whole reason the design needs no BigQuery dataset: there is no
 * table to scan, so there is nothing to bill for scanning.
 */
export async function dryRunQuery(
  sql: string,
  opts: { location?: string } = {},
): Promise<{ bytesProcessed: number; fields: BqField[] }> {
  if (!bigQueryEnabled()) throw new BigQueryDisabledError();
  const chars = sqlLength(sql);
  if (chars > MAX_QUERY_CHARS) throw new QueryTooLongError(chars, MAX_QUERY_CHARS);

  const projectId = await resolveProjectId();
  const location = resolveLocation(opts.location);
  const data = await request<{
    statistics: { totalBytesProcessed?: string; query?: { schema?: { fields?: BqField[] } } };
  }>(BQ_BASE + '/projects/' + projectId + '/jobs', {
    method: 'POST',
    data: {
      configuration: { dryRun: true, query: { query: sql, useLegacySql: false } },
      jobReference: { projectId, location },
    },
  });
  return {
    bytesProcessed: Number(data.statistics?.totalBytesProcessed ?? 0),
    fields: data.statistics?.query?.schema?.fields ?? [],
  };
}

/**
 * Run a query to completion and return every row.
 *
 * `jobs.insert` then `jobs.getQueryResults`, rather than the synchronous
 * `jobs.query`, because an `AI.FORECAST` over a couple of thousand series runs
 * for tens of seconds and the synchronous endpoint's own timeout would just
 * hand back a job reference to poll anyway. Going straight to the job makes the
 * wall clock -- which is a WS1 acceptance number -- unambiguous.
 *
 * `getQueryResults` blocks server-side for `pollTimeoutMs`, so waiting costs one
 * request per 10 seconds rather than a busy loop.
 */
export async function runQuery<T = Record<string, unknown>>(
  sql: string,
  opts: RunQueryOptions = {},
): Promise<QueryResult<T>> {
  if (!bigQueryEnabled()) throw new BigQueryDisabledError();
  const sqlChars = sqlLength(sql);
  if (sqlChars > MAX_QUERY_CHARS) throw new QueryTooLongError(sqlChars, MAX_QUERY_CHARS);

  const projectId = await resolveProjectId();
  const location = resolveLocation(opts.location);
  const pollTimeoutMs = opts.pollTimeoutMs ?? 10_000;
  const pageSize = opts.pageSize ?? 20_000;
  const deadlineMs = opts.deadlineMs ?? 15 * 60_000;
  const deadline = Date.now() + deadlineMs;
  const started = Date.now();

  const insert = await request<{ jobReference: { jobId: string } }>(
    BQ_BASE + '/projects/' + projectId + '/jobs',
    {
      method: 'POST',
      data: {
        jobReference: { projectId, location },
        configuration: {
          query: {
            query: sql,
            useLegacySql: false,
            ...(opts.useQueryCache === false ? { useQueryCache: false } : {}),
            ...(opts.jobTimeoutMs ? { timeoutMs: opts.jobTimeoutMs } : {}),
          },
          ...(opts.jobLabel ? { labels: { script: opts.jobLabel } } : {}),
        },
      },
    },
  );
  const jobId = insert.jobReference.jobId;

  const rows: T[] = [];
  let fields: BqField[] = [];
  let pageToken: string | undefined;
  let totalBytesProcessed = 0;
  let totalSlotMs = 0;
  let cacheHit = false;

  for (;;) {
    if (Date.now() > deadline) {
      throw new BigQueryError(
        'Query exceeded the ' + Math.round(deadlineMs / 1000) + 's client deadline',
        0,
        'clientDeadline',
        jobId,
      );
    }

    const page = await request<{
      jobComplete?: boolean;
      schema?: { fields?: BqField[] };
      rows?: { f: BqCell[] }[];
      pageToken?: string;
      totalBytesProcessed?: string;
      cacheHit?: boolean;
      errors?: { message?: string; reason?: string }[];
    }>(BQ_BASE + '/projects/' + projectId + '/queries/' + jobId, {
      params: {
        location,
        timeoutMs: pollTimeoutMs,
        maxResults: pageSize,
        ...(pageToken ? { pageToken } : {}),
      },
    });

    // `jobComplete: false` is not an error -- the server-side wait expired
    // before the job did. Ask again; the deadline above is what bounds this.
    if (!page.jobComplete) continue;

    if (page.errors?.length) {
      const first = page.errors[0];
      throw new BigQueryError(first.message ?? 'Query failed', 400, first.reason, jobId);
    }

    if (page.schema?.fields) fields = page.schema.fields;
    if (page.totalBytesProcessed) totalBytesProcessed = Number(page.totalBytesProcessed);
    if (page.cacheHit) cacheHit = true;

    for (const row of page.rows ?? []) {
      rows.push(decodeRow(fields, row.f) as T);
    }

    if (!page.pageToken) break;
    pageToken = page.pageToken;
  }

  // Slot time is only on the job resource, not on the results pages. It is the
  // number that says whether a slow query was queued or actually working.
  try {
    const job = await request<{ statistics?: { query?: { totalSlotMs?: string } } }>(
      BQ_BASE + '/projects/' + projectId + '/jobs/' + jobId,
      { params: { location } },
    );
    totalSlotMs = Number(job.statistics?.query?.totalSlotMs ?? 0);
  } catch {
    // Diagnostic only. A failure here must not fail a query that returned rows.
  }

  return {
    rows,
    stats: {
      jobId,
      location,
      elapsedMs: Date.now() - started,
      totalBytesProcessed,
      totalSlotMs,
      cacheHit,
      rowCount: rows.length,
      sqlChars,
    },
  };
}
