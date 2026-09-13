import 'server-only';
import { runQuery, bigQueryEnabled, BigQueryDisabledError } from '@/lib/bq/client';
import { googleRequest, resolveProjectId, asGoogleApiError } from '@/lib/gcp/request';
import {
  DATASET,
  STOCK_EVENTS_TABLE,
  DISPATCH_TICKETS_TABLE,
  PUBSUB_TOPIC,
  tableRef,
} from '@/lib/durable/schema';
import type { DispatchTicket, TicketEffect } from '@/lib/dispatch/ticket';
import { foldTicketLog, type TicketLogRow } from '@/lib/dispatch/fold';
import { hydrateTickets, nextTicketSeq } from '@/lib/dispatch/store';
import { ticketAuthority } from '@/lib/dispatch/authority';
import { INSTANCE_ID as LIVE_INSTANCE_ID } from '@/lib/live/instance';
import { ensureSubscribed, startListening, busStatus } from '@/lib/live/bus';
import {
  hydrate,
  markDurability,
  noteRestoreFailure,
  noteRestoreDisabled,
  restoreReport,
  type StockEvent,
  type RestoreReport,
  type Durability,
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
 * WHAT PUB/SUB IS FOR
 * -------------------
 * Two readers of one topic. Every other instance of the service subscribes to
 * it to hear commits and ticket transitions it did not take itself
 * (`src/lib/live/bus.ts`) -- which is what lets the service run more than one
 * instance. And the topic IS the audit trail a district would subscribe its own
 * systems to: a DVDMS connector is a subscription, not an integration project.
 *
 * Messages are published AFTER the append settles, carrying its outcome. That
 * costs the other instances a few hundred milliseconds and buys the property
 * the listener's restore depends on: nothing durable is published before it
 * can be read back.
 */

const BQ = 'https://bigquery.googleapis.com/bigquery/v2';
const PS = 'https://pubsub.googleapis.com/v1';

/** Which container wrote a row. Defined in `src/lib/live/instance.ts`. */
export const INSTANCE_ID = LIVE_INSTANCE_ID;

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
  ticketAuthority: 'process' | 'gcs';
  fanout: ReturnType<typeof busStatus>;
} {
  return {
    enabled: durabilityEnabled(),
    dataset: DATASET,
    table: STOCK_EVENTS_TABLE,
    topic: PUBSUB_TOPIC,
    instanceId: INSTANCE_ID,
    ticketAuthority: ticketAuthority().kind,
    fanout: busStatus(),
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
  instance_id: string | null;
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
}

function eventFrom(row: RestoredRow): StockEvent {
  const r = (row.risk ?? {}) as Record<string, number & string>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  // Rows written before the fan-out existed carry no instance; their seq was
  // unique within the one instance there was.
  const origin = row.instance_id ?? 'restored';
  return {
    seq: row.seq,
    eventId: origin + ':' + row.seq,
    origin,
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
async function appendOnce(
  projectId: string,
  table: string,
  rows: { insertId: string; json: Record<string, unknown> }[],
): Promise<void> {
  const url =
    BQ + '/projects/' + projectId + '/datasets/' + DATASET + '/tables/' + table + '/insertAll';

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
      rows,
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
 * The insertAll envelope for a batch of rows.
 *
 * `insertId` is best-effort de-duplication, in case a retry lands after a
 * response that was lost on the way back. It is unique across instances because
 * the instance id is, and unique within one because the sequence is.
 */
function envelope(kind: string, seq: number, json: Record<string, unknown>) {
  return { insertId: INSTANCE_ID + ':' + kind + ':' + seq, json };
}

/**
 * Publish to Pub/Sub. Best effort, and its failure never changes durability.
 *
 * Durability is what BigQuery acknowledged. A topic that is unreachable means
 * the fan-out is behind, not that the row is at risk, and conflating the two
 * would put "not durable" on screen for a healthy write.
 */
async function publishMessages(
  projectId: string,
  messages: { attributes: Record<string, string>; body: unknown }[],
): Promise<void> {
  const url = PS + '/projects/' + projectId + '/topics/' + PUBSUB_TOPIC + ':publish';
  await googleRequest(url, {
    method: 'POST',
    attempts: 1,
    timeoutMs: 10_000,
    data: {
      messages: messages.map((m) => ({
        // Attributes are what a subscriber filters on without decoding a body.
        attributes: { ...m.attributes, instanceId: INSTANCE_ID },
        data: Buffer.from(JSON.stringify(m.body)).toString('base64'),
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

    const rows = events.map((e) => envelope('stock', e.seq, rowFor(e)));
    try {
      await appendOnce(projectId, STOCK_EVENTS_TABLE, rows);
      durable = true;
    } catch (first) {
      // Exactly one retry. A single transient 503 is common; two in a row
      // against a regional endpoint means something is actually wrong, and
      // hammering it would only delay the honest answer on screen.
      await new Promise((r) => setTimeout(r, 400));
      try {
        await appendOnce(projectId, STOCK_EVENTS_TABLE, rows);
        durable = true;
      } catch (second) {
        detail =
          asGoogleApiError(second).message || asGoogleApiError(first).message || 'append failed';
      }
    }

    // Published only now, with the append's outcome on it: see the header.
    const settled: Durability = durable ? 'durable' : 'failed';
    const messages = events.map((e) => ({
      attributes: {
        type: 'stock.committed',
        eventId: e.eventId,
        facilityId: e.facilityId,
        districtCode: e.districtCode,
        drugId: e.drugId,
        source: e.source,
      },
      body: {
        type: 'stock.committed',
        event: { ...e, durability: settled, durabilityDetail: detail, published: true },
      },
    }));
    let published = false;
    for (let attempt = 0; attempt < 2 && !published; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 300));
        await publishMessages(projectId, messages);
        published = true;
      } catch {
        // Not in the response: it shows up as a missing `published` flag on the
        // event, which the console renders, and other instances pick the event
        // up from the log at their next restart.
      }
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

// ------------------------------------------------------------------- tickets

function effectRows(effects: TicketEffect[]): Record<string, unknown>[] {
  return effects.map((e) => ({
    role: e.role,
    facility_id: e.facilityId,
    facility_name: e.facilityName,
    district_code: e.districtCode,
    on_hand_before: e.onHandBefore,
    on_hand_after: e.onHandAfter,
    stockout_before: e.stockoutBefore,
    stockout_after: e.stockoutAfter,
    severity_before: e.severityBefore,
    severity_after: e.severityAfter,
    days_of_cover_after: e.daysOfCoverAfter,
    projected: e.projected,
    forecast_source: e.forecastSource,
  }));
}

/**
 * Append the transitions this request added. One row each.
 *
 * Fire-and-forget, exactly like a stock event: a storekeeper who has already
 * put boxes on a vehicle must not be told the dispatch failed because a
 * warehouse in another region was busy. If the append never lands, the ticket
 * survives only in memory and a restart loses it -- which is bounded, and made
 * visible: the promise resolves to what happened, and the caller re-issues the
 * ticket with that `durability` so every open console can say so.
 */
export function persistTicketTransitions(
  ticket: DispatchTicket,
  fromIndex: number,
): Promise<Durability> {
  if (!durabilityEnabled()) return Promise.resolve('disabled');
  const added = ticket.history.slice(fromIndex);
  if (added.length === 0) return Promise.resolve(ticket.durability ?? 'durable');

  return (async (): Promise<Durability> => {
    let outcome: Durability = 'failed';
    const projectId = await resolveProjectId();
    const rows = added.map((h, i) =>
      envelope('ticket', ticket.seq * 100 + fromIndex + i, {
        ticket_id: ticket.ticketId,
        seq: ticket.seq,
        at: h.at,
        instance_id: INSTANCE_ID,
        district_code: ticket.districtCode,
        order_id: ticket.orderId,
        action: h.action,
        from_state: h.from,
        to_state: h.to,
        actor_claimed: h.actor,
        note: h.note ?? null,
        planned_units: ticket.plannedUnits,
        units: h.units ?? null,
        dispatched_units: ticket.dispatchedUnits,
        received_units: ticket.receivedUnits,
        variance_units: ticket.varianceUnits,
        cross_district: ticket.crossDistrict,
        from_facility_id: ticket.from.facilityId,
        from_facility_name: ticket.from.facilityName,
        from_facility_type: ticket.from.facilityType,
        from_district_code: ticket.from.districtCode,
        from_district_name: ticket.from.districtName,
        to_facility_id: ticket.to.facilityId,
        to_facility_name: ticket.to.facilityName,
        to_facility_type: ticket.to.facilityType,
        to_district_code: ticket.to.districtCode,
        to_district_name: ticket.to.districtName,
        drug_id: ticket.drugId,
        drug_name: ticket.drugName,
        unit: ticket.unit,
        // Only the last transition produced effects; earlier rows in the same
        // batch (a `propose` written alongside its `approve`) carry none, which
        // is true rather than convenient.
        effects: i === added.length - 1 ? effectRows(ticket.effects) : [],
      }),
    );

    try {
      await appendOnce(projectId, DISPATCH_TICKETS_TABLE, rows);
      outcome = 'durable';
    } catch {
      await new Promise((r) => setTimeout(r, 400));
      try {
        await appendOnce(projectId, DISPATCH_TICKETS_TABLE, rows);
        outcome = 'durable';
      } catch {
        // Bounded and visible: the ticket lives in memory, a restart loses it,
        // and the caller marks it `failed` on every open console. Failing the
        // storekeeper's action instead would be worse.
      }
    }

    // After the append, with its outcome, like a stock event. Other instances
    // apply the ticket from the LAST message -- it carries the whole fold -- and
    // ignore any copy that is not ahead of what they hold.
    try {
      await publishMessages(
        projectId,
        added.map((h) => ({
          attributes: {
            type: 'dispatch.' + h.action,
            ticketId: ticket.ticketId,
            districtCode: ticket.districtCode,
            fromFacilityId: ticket.from.facilityId,
            toFacilityId: ticket.to.facilityId,
            drugId: ticket.drugId,
          },
          body: { type: 'dispatch.' + h.action, transition: h, ticket: { ...ticket, durability: outcome } },
        })),
      );
    } catch {
      // The fan-out is best effort; see `publishMessages`.
    }
    return outcome;
  })().catch((): Durability => 'failed');
}

interface TicketRow {
  ticket_id: string;
  seq: number;
  at: string;
  district_code: string | null;
  order_id: string | null;
  action: string;
  from_state: string | null;
  to_state: string | null;
  actor_claimed: string | null;
  note: string | null;
  planned_units: number | null;
  units: number | null;
  cross_district: boolean | null;
  from_facility_id: string | null;
  from_facility_name: string | null;
  from_facility_type: string | null;
  from_district_code: string | null;
  from_district_name: string | null;
  to_facility_id: string | null;
  to_facility_name: string | null;
  to_facility_type: string | null;
  to_district_code: string | null;
  to_district_name: string | null;
  drug_id: string | null;
  drug_name: string | null;
  unit: string | null;
  effects: Record<string, unknown>[] | null;
}

function effectsFrom(row: TicketRow): TicketEffect[] {
  return (row.effects ?? []).map((e) => {
    const r = e as Record<string, string & number & boolean>;
    return {
      role: (r.role === 'donor' ? 'donor' : 'receiver') as TicketEffect['role'],
      facilityId: String(r.facility_id ?? ''),
      facilityName: String(r.facility_name ?? ''),
      districtCode: String(r.district_code ?? ''),
      onHandBefore: Number(r.on_hand_before ?? 0),
      onHandAfter: Number(r.on_hand_after ?? 0),
      stockoutBefore: Number(r.stockout_before ?? 0),
      stockoutAfter: Number(r.stockout_after ?? 0),
      severityBefore: String(r.severity_before ?? 'unknown'),
      severityAfter: String(r.severity_after ?? 'unknown'),
      daysOfCoverAfter: Number(r.days_of_cover_after ?? 0),
      projected: Boolean(r.projected),
      forecastSource: String(r.forecast_source ?? 'croston'),
    };
  });
}

function logRowFrom(row: TicketRow): TicketLogRow {
  return {
    ticketId: row.ticket_id,
    seq: row.seq,
    at: row.at,
    action: row.action,
    actor: row.actor_claimed ?? 'unknown',
    units: row.units,
    note: row.note ?? undefined,
    effects: effectsFrom(row),
    districtCode: row.district_code ?? '',
    orderId: row.order_id ?? '',
    plannedUnits: row.planned_units ?? 0,
    crossDistrict: Boolean(row.cross_district),
    from: {
      facilityId: row.from_facility_id ?? '',
      facilityName: row.from_facility_name ?? '',
      facilityType: row.from_facility_type ?? '',
      districtCode: row.from_district_code ?? '',
      districtName: row.from_district_name ?? '',
    },
    to: {
      facilityId: row.to_facility_id ?? '',
      facilityName: row.to_facility_name ?? '',
      facilityType: row.to_facility_type ?? '',
      districtCode: row.to_district_code ?? '',
      districtName: row.to_district_name ?? '',
    },
    drugId: row.drug_id ?? '',
    drugName: row.drug_name ?? '',
    unit: row.unit ?? 'unit',
  };
}

/**
 * Rebuild every ticket by replaying its transitions.
 *
 * THE STATE IS THE FOLD, AND THAT IS THE WHOLE POINT. There is no table of
 * current ticket states to read back, because an append-only log plus a mutable
 * projection is two records of one event and they can disagree. Replaying also
 * means a ticket that was mid-flight when the container died needs no special
 * case: the fold simply stops where the log stops.
 */
export async function restoreTicketsFromLog(): Promise<{
  ok: boolean;
  tickets: number;
  rows: number;
  elapsedMs: number;
  error: string | null;
  source: 'log' | 'authority';
}> {
  const started = Date.now();
  if (!durabilityEnabled()) {
    return { ok: true, tickets: 0, rows: 0, elapsedMs: 0, error: null, source: 'log' };
  }

  /*
   * With a shared ticket authority, a fresh instance reads tickets from it: it
   * is what every transition is conditional on, so it is what the next
   * transition on this instance will be checked against. The log remains the
   * audit trail and the restore for a single-instance deployment.
   */
  const authority = ticketAuthority();
  if (authority.kind === 'gcs') {
    try {
      const listed = await authority.list();
      const ordered = [...listed].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
      const restored = hydrateTickets(
        ordered.map((t) => ({ ...t, seq: nextTicketSeq(), durability: t.durability ?? 'durable' })),
      );
      return { ok: true, tickets: restored.tickets, rows: listed.length, elapsedMs: Date.now() - started, error: null, source: 'authority' };
    } catch (e) {
      return { ok: false, tickets: 0, rows: 0, elapsedMs: Date.now() - started, error: asGoogleApiError(e).message, source: 'authority' };
    }
  }

  try {
    const projectId = await resolveProjectId();
    // Newest 2,000 rows, then read forwards. A district plans tens of orders,
    // so this is the whole log in practice; the cap exists so that a table left
    // running for a year cannot make a cold start unbounded. If it ever bites,
    // the oldest tickets lose their earliest rows and fold from whatever row
    // survives -- which is why every row is self-describing.
    const sql =
      'SELECT * FROM (\n' +
      '  SELECT * FROM ' + tableRef(projectId, DISPATCH_TICKETS_TABLE) + '\n' +
      '  ORDER BY `at` DESC, seq DESC\n' +
      '  LIMIT 2000\n' +
      ')\n' +
      'ORDER BY `at` ASC, seq ASC';

    const { rows } = await runQuery<TicketRow>(sql, {
      jobLabel: 'ticket_restore',
      deadlineMs: 30_000,
      pollTimeoutMs: 5_000,
    });

    // Folded out of the log, so durable by construction.
    const restored = hydrateTickets(
      foldTicketLog(rows.map(logRowFrom)).map((t) => ({ ...t, durability: 'durable' as const })),
    );
    return {
      ok: true,
      tickets: restored.tickets,
      rows: rows.length,
      elapsedMs: Date.now() - started,
      error: null,
      source: 'log',
    };
  } catch (e) {
    if (e instanceof BigQueryDisabledError) {
      return { ok: true, tickets: 0, rows: 0, elapsedMs: Date.now() - started, error: null, source: 'log' };
    }
    return {
      ok: false,
      tickets: 0,
      rows: 0,
      elapsedMs: Date.now() - started,
      error: asGoogleApiError(e).message,
      source: 'log',
    };
  }
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
      '    seq, `at`, instance_id, facility_id, facility_name, district_code, drug_id, drug_name,\n' +
      '    on_hand, source, recompute_ms, risk,\n' +
      '    ROW_NUMBER() OVER (PARTITION BY facility_id, drug_id ORDER BY `at` DESC, instance_id DESC, seq DESC) AS rn_pos,\n' +
      '    ROW_NUMBER() OVER (ORDER BY `at` DESC, instance_id DESC, seq DESC) AS rn_all\n' +
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

    return hydrate(rows.map(eventFrom), { elapsedMs: Date.now() - started });
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
 * So the first request that needs the overlay pays for it: once per instance.
 *
 * THE ORDER IS THE GUARANTEE
 * --------------------------
 * Subscribe, then read the log back, then start consuming. A report published
 * after the subscription existed is delivered; one published before it was
 * durable before it, so the restore reads it. Swapping the first two steps
 * opens a window in which a report is in neither.
 */
export interface FullRestore {
  stock: RestoreReport;
  tickets: Awaited<ReturnType<typeof restoreTicketsFromLog>>;
}

const RESTORE = Symbol.for('aarogya.overlay.restore');
type RestoreHost = typeof globalThis & { [RESTORE]?: Promise<FullRestore> };

export function ensureRestored(): Promise<FullRestore> {
  const host = globalThis as RestoreHost;
  if (!host[RESTORE]) {
    // Both logs, concurrently: they are independent queries and a cold
    // container should pay for them once, side by side, rather than in series.
    host[RESTORE] = ensureSubscribed()
      .then(() => Promise.all([restoreOverlay(), restoreTicketsFromLog()]))
      .then(([stock, tickets]) => {
        startListening();
        return { stock, tickets };
      });
  }
  return host[RESTORE];
}

/** Test-only: allow a second restore in the same process. */
export function resetRestore(): void {
  delete (globalThis as RestoreHost)[RESTORE];
}

export { restoreReport };
