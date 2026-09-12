import 'server-only';
import { runQuery, bigQueryEnabled, BigQueryDisabledError } from '@/lib/bq/client';
import { googleRequest, resolveProjectId, asGoogleApiError } from '@/lib/gcp/request';
import {
  DATASET,
  STOCK_EVENTS_TABLE,
  PUBSUB_TOPIC,
  tableRef,
} from '@/lib/durable/schema';
import {
  hydrate,
  markDurability,
  noteRestoreFailure,
  noteRestoreDisabled,
  restoreReport,
  type StockEvent,
  type RestoreReport,
} from '@/lib/overlay/store';

/**
 * The durable half of the live loop.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: A DURABLE WRITE MAY NEVER FAIL A COMMIT
 * -----------------------------------------------------------------------------
 * A health worker at a sub-centre has already done the hard part -- they said
 * the number. If BigQuery is slow, or the dataset was deleted, or the service
 * account lost a role, the right outcome is still that the board changes and
 * somebody is told the row is not yet safe. The wrong outcome is a red error on
 * a phone in a village because a warehouse in another region was busy.
 *
 * So every call in here is:
 *   - started AFTER the response has been built, never awaited by the handler;
 *   - retried exactly once, because a second failure is information, not noise;
 *   - reported through `markDurability`, which the SSE stream forwards, so the
 *     chip on screen goes queued -> durable (or -> not durable) on its own.
 *
 * WHY `insertAll` AND NOT AN `INSERT` STATEMENT
 * ---------------------------------------------
 * A DML insert is a query job: a second or two, a slot, and a quota that is
 * counted in table-modifications per day. `tabledata.insertAll` is a plain REST
 * append that acknowledges in a few hundred milliseconds and whose rows are
 * queryable immediately -- which is exactly what a restore needs. It cannot
 * update or delete, and this log never wants to.
 *
 * WHAT PUB/SUB IS FOR, GIVEN ONE INSTANCE
 * ---------------------------------------
 * Nothing, today, and that is stated rather than hidden. With
 * `--max-instances=1` there is no second container to fan out to. The publish
 * side is built because it is the seam the scale-out step needs and because the
 * topic IS the audit trail a district would subscribe its own systems to -- a
 * DVDMS connector is a subscription, not an integration project. The subscriber
 * is deliberately not built: it would be dead code guarded by a flag nobody
 * flips before 30 September.
 */

const BQ = 'https://bigquery.googleapis.com/bigquery/v2';
const PS = 'https://pubsub.googleapis.com/v1';

/**
 * Which container wrote a row.
 *
 * `K_REVISION` is Cloud Run's own revision name, so a row can be traced back to
 * the deployment that produced it. The random suffix separates two instances of
 * the same revision -- impossible today at `--max-instances=1`, and exactly the
 * thing that would become unreadable the day that changes.
 */
export const INSTANCE_ID =
  (process.env.K_REVISION ?? 'local') + '-' + Math.random().toString(36).slice(2, 8);

/** Whether there is a durable sink at all. `AAROGYA_NO_BQ=1` turns it off. */
export function durabilityEnabled(): boolean {
  return bigQueryEnabled() && process.env.AAROGYA_NO_DURABLE !== '1';
}

export function durabilityConfig(): {
  enabled: boolean;
  dataset: string;
  table: string;
  topic: string;
  instanceId: string;
} {
  return {
    enabled: durabilityEnabled(),
    dataset: DATASET,
    table: STOCK_EVENTS_TABLE,
    topic: PUBSUB_TOPIC,
    instanceId: INSTANCE_ID,
  };
}

// ------------------------------------------------------------------ encoding

/** The BigQuery row for one event. Snake case, because the table is SQL. */
function rowFor(event: StockEvent): Record<string, unknown> {
  return {
    seq: event.seq,
    at: event.at,
    instance_id: INSTANCE_ID,
    facility_id: event.facilityId,
    facility_name: event.facilityName,
    district_code: event.districtCode,
    drug_id: event.drugId,
    drug_name: event.drugName,
    on_hand: event.onHand,
    source: event.source,
    recompute_ms: Math.round(event.recomputeMs),
    risk: {
      on_hand: event.risk.onHand,
      previous_on_hand: event.risk.previousOnHand,
      stockout_probability: event.risk.stockoutProbability,
      previous_stockout_probability: event.risk.previousStockoutProbability,
      risk_score: event.risk.riskScore,
      previous_risk_score: event.risk.previousRiskScore,
      severity: event.risk.severity,
      previous_severity: event.risk.previousSeverity,
      days_of_cover: event.risk.daysOfCover,
      reorder_point: event.risk.reorderPoint,
      expected_shortfall_units: event.risk.expectedShortfallUnits,
      forecast_source: event.risk.forecastSource,
    },
  };
}

/** One restored row, back in the shape the overlay speaks. */
interface RestoredRow {
  seq: number;
  at: string;
  facility_id: string;
  facility_name: string | null;
  district_code: string | null;
  drug_id: string;
  drug_name: string | null;
  on_hand: number;
  source: string | null;
  recompute_ms: number | null;
  risk: Record<string, unknown> | null;
  rn_pos: number;
  rn_all: number;
  max_seq: number;
}

function eventFrom(row: RestoredRow): StockEvent {
  const r = (row.risk ?? {}) as Record<string, number & string>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    seq: row.seq,
    at: row.at,
    facilityId: row.facility_id,
    facilityName: row.facility_name ?? row.facility_id,
    districtCode: row.district_code ?? '',
    drugId: row.drug_id,
    drugName: row.drug_name ?? row.drug_id,
    onHand: row.on_hand,
    source: (row.source ?? 'typed') as StockEvent['source'],
    // It came back from the log, so by definition it survived.
    durability: 'durable',
    published: false,
    restored: true,
    recomputeMs: num(row.recompute_ms),
    risk: {
      onHand: num(r.on_hand),
      previousOnHand: num(r.previous_on_hand),
      stockoutProbability: num(r.stockout_probability),
      previousStockoutProbability: num(r.previous_stockout_probability),
      riskScore: num(r.risk_score),
      previousRiskScore: num(r.previous_risk_score),
      severity: String(r.severity ?? 'unknown'),
      previousSeverity: String(r.previous_severity ?? 'unknown'),
      daysOfCover: num(r.days_of_cover),
      reorderPoint: num(r.reorder_point),
      expectedShortfallUnits: num(r.expected_shortfall_units),
      forecastSource: String(r.forecast_source ?? 'croston'),
    },
  };
}

// -------------------------------------------------------------------- append

interface InsertAllResponse {
  insertErrors?: { index: number; errors: { reason?: string; message?: string }[] }[];
}

/**
 * Append rows, once. Throws on anything that is not a clean accept.
 *
 * `insertAll` answers 200 even when individual rows were rejected, with the
 * failures in `insertErrors`. Treating that as success is the classic way to
 * lose data silently, so a partial accept is raised as an error here and the
 * events it covers are marked `failed`.
 */
async function appendOnce(projectId: string, rows: StockEvent[]): Promise<void> {
  const url =
    BQ + '/projects/' + projectId + '/datasets/' + DATASET +
    '/tables/' + STOCK_EVENTS_TABLE + '/insertAll';

  const res = await googleRequest<InsertAllResponse>(url, {
    method: 'POST',
    // One attempt here: the retry policy for this path is the deliberate single
    // retry in `persistStockEvents`, not the generic backoff ladder, because a
    // commit's durability should settle in about a second either way.
    attempts: 1,
    timeoutMs: 10_000,
    data: {
      // A row that does not match the schema must be rejected, not silently
      // half-written: this log is the audit trail.
      skipInvalidRows: false,
      ignoreUnknownValues: false,
      rows: rows.map((e) => ({
        // Best-effort de-duplication, in case a retry lands after a response
        // that was lost on the way back. Unique across instances because the
        // instance id is.
        insertId: INSTANCE_ID + ':' + e.seq,
        json: rowFor(e),
      })),
    },
  });

  if (res.insertErrors?.length) {
    const first = res.insertErrors[0];
    throw new Error(
      res.insertErrors.length +
        ' of ' + rows.length + ' rows rejected: ' +
        (first.errors?.[0]?.message ?? first.errors?.[0]?.reason ?? 'unknown reason'),
    );
  }
}

// ------------------------------------------------------------------- publish

/**
 * Publish to Pub/Sub. Best effort, and its failure never changes durability.
 *
 * Durability is what BigQuery acknowledged. A topic that is unreachable means
 * the fan-out is behind, not that the row is at risk, and conflating the two
 * would put "not durable" on screen for a healthy write.
 */
async function publishOnce(projectId: string, events: StockEvent[]): Promise<void> {
  const url = PS + '/projects/' + projectId + '/topics/' + PUBSUB_TOPIC + ':publish';
  await googleRequest(url, {
    method: 'POST',
    attempts: 1,
    timeoutMs: 10_000,
    data: {
      messages: events.map((e) => ({
        // Attributes are what a subscriber filters on without decoding a body.
        attributes: {
          type: 'stock.committed',
          facilityId: e.facilityId,
          districtCode: e.districtCode,
          drugId: e.drugId,
          source: e.source,
          instanceId: INSTANCE_ID,
        },
        data: Buffer.from(JSON.stringify({ type: 'stock.committed', event: e })).toString('base64'),
      })),
    },
  });
}

/**
 * Make a set of committed events durable, after the response has gone out.
 *
 * Never throws: it is called with `void` from a request handler, and an
 * unhandled rejection there would take the process down on a path whose whole
 * contract is that it cannot affect the request.
 */
export function persistStockEvents(events: StockEvent[]): Promise<void> {
  if (events.length === 0) return Promise.resolve();
  if (!durabilityEnabled()) {
    for (const e of events) markDurability(e.seq, 'disabled');
    return Promise.resolve();
  }

  return (async () => {
    const projectId = await resolveProjectId();
    let durable = false;
    let detail: string | undefined;

    try {
      await appendOnce(projectId, events);
      durable = true;
    } catch (first) {
      // Exactly one retry. A single transient 503 is common; two in a row
      // against a regional endpoint means something is actually wrong, and
      // hammering it would only delay the honest answer on screen.
      await new Promise((r) => setTimeout(r, 400));
      try {
        await appendOnce(projectId, events);
        durable = true;
      } catch (second) {
        detail =
          asGoogleApiError(second).message || asGoogleApiError(first).message || 'append failed';
      }
    }

    let published = false;
    try {
      await publishOnce(projectId, events);
      published = true;
    } catch {
      // Deliberately silent in the response: see `publishOnce`. It shows up as
      // a missing `published` flag on the event, which the console renders.
    }

    for (const e of events) {
      markDurability(e.seq, durable ? 'durable' : 'failed', { detail, published });
    }
  })().catch((e) => {
    for (const ev of events) {
      markDurability(ev.seq, 'failed', { detail: (e as Error).message });
    }
  });
}

// ------------------------------------------------------------------- restore

/**
 * Read the log back into the overlay.
 *
 * ONE QUERY, TWO ANSWERS. The overlay needs two different slices of the same
 * table and they do not nest: the correction IN FORCE for every position
 * (however old), and the most recent 200 events (whatever positions they touch).
 * Two queries would be two scans and a window where they disagree, so one query
 * labels each row with both row numbers and the caller splits it.
 *
 * This is the ONLY query in the project that processes bytes. Everything in the
 * forecasting path is an `AI.FORECAST` over an inline subquery, which scans no
 * table at all -- so the "0 bytes billed" figure in the forecast artefacts is
 * about forecasting, and this path is reported separately and honestly.
 */
export async function restoreOverlay(): Promise<RestoreReport> {
  const started = Date.now();
  if (!durabilityEnabled()) return noteRestoreDisabled();

  try {
    const projectId = await resolveProjectId();
    const sql =
      'SELECT * FROM (\n' +
      '  SELECT\n' +
      '    seq, `at`, facility_id, facility_name, district_code, drug_id, drug_name,\n' +
      '    on_hand, source, recompute_ms, risk,\n' +
      '    ROW_NUMBER() OVER (PARTITION BY facility_id, drug_id ORDER BY `at` DESC, seq DESC) AS rn_pos,\n' +
      '    ROW_NUMBER() OVER (ORDER BY `at` DESC, seq DESC) AS rn_all,\n' +
      '    MAX(seq) OVER () AS max_seq\n' +
      '  FROM ' + tableRef(projectId, STOCK_EVENTS_TABLE) + '\n' +
      ')\n' +
      'WHERE rn_pos = 1 OR rn_all <= 200\n' +
      'ORDER BY `at` ASC, seq ASC';

    const { rows } = await runQuery<RestoredRow>(sql, {
      jobLabel: 'overlay_restore',
      // A restore that has not answered in half a minute is a restore that must
      // not keep the first request of a cold container waiting any longer.
      deadlineMs: 30_000,
      pollTimeoutMs: 5_000,
    });

    const events = rows.map(eventFrom);
    const maxSeq = rows.length > 0 ? Math.max(...rows.map((r) => r.max_seq || 0)) : 0;
    return hydrate(events, { maxSeq, elapsedMs: Date.now() - started });
  } catch (e) {
    if (e instanceof BigQueryDisabledError) return noteRestoreDisabled();
    return noteRestoreFailure(asGoogleApiError(e).message, Date.now() - started);
  }
}

/**
 * Restore once per process, and never twice concurrently.
 *
 * WHY THIS IS LAZY RATHER THAN DONE AT MODULE LOAD
 * ------------------------------------------------
 * Route modules are evaluated during `next build`, in a container with no
 * credentials and often with `AAROGYA_NO_BQ=1` set on purpose. A network call
 * at module scope would run there -- turning a build into something that needs
 * a working BigQuery, which is precisely the dependency the rest of this
 * project went out of its way not to have.
 *
 * So the first request that needs the overlay pays for it. On a service with
 * `min-instances=1` that is one request per deployment.
 */
const RESTORE = Symbol.for('aarogya.overlay.restore');
type RestoreHost = typeof globalThis & { [RESTORE]?: Promise<RestoreReport> };

export function ensureRestored(): Promise<RestoreReport> {
  const host = globalThis as RestoreHost;
  if (!host[RESTORE]) host[RESTORE] = restoreOverlay();
  return host[RESTORE];
}

/** Test-only: allow a second restore in the same process. */
export function resetRestore(): void {
  delete (globalThis as RestoreHost)[RESTORE];
}

export { restoreReport };
