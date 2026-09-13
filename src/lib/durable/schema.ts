/**
 * The shape of the durable event log, in one place.
 *
 * WHY THE SCHEMA LIVES IN THE APP AND NOT IN A CONSOLE CLICK-PATH
 * ---------------------------------------------------------------
 * Every other Google resource this project uses is created by the API call that
 * uses it -- an `AI.FORECAST` over an inline subquery needs no table, so nothing
 * had to be provisioned by hand. Durability is the first thing that does, and a
 * dataset that exists only because somebody once clicked "Create" in the console
 * is a dependency nobody can reproduce. `npm run provision:cloud` reads this
 * file and creates exactly what is described here, idempotently, so a reviewer
 * can stand the whole backend up in one command against their own project.
 *
 * PARTITIONING AND CLUSTERING ARE NOT PREMATURE HERE
 * --------------------------------------------------
 * They cost nothing to declare and they change the bill's shape rather than its
 * size: every restore query filters to recent rows and every audit query filters
 * by facility. At this volume the table is measured in kilobytes either way --
 * the point is that the design does not have to change when it is not.
 */
import type { BqField } from '@/lib/bq/client';

/** The dataset both durable tables live in. asia-south1, like everything else. */
export const DATASET = process.env.AAROGYA_BQ_DATASET?.trim() || 'aarogya_grid';

/** Committed stock corrections -- the live overlay's durable backing. */
export const STOCK_EVENTS_TABLE = 'stock_events';

/** Every dispatch-ticket transition, append-only. This IS the audit log (WS2B). */
export const DISPATCH_TICKETS_TABLE = 'dispatch_tickets';

/**
 * The fan-out topic. Every report and ticket transition is published here once
 * its durable append settles; every instance subscribes to it to hear the
 * others (`src/lib/live/bus.ts`), and a district's own systems can subscribe to
 * it to receive the audit trail.
 */
export const PUBSUB_TOPIC = process.env.AAROGYA_PUBSUB_TOPIC?.trim() || 'aarogya-events';

/**
 * Per-instance fan-out subscriptions are named with this prefix and the
 * instance id. They are created by the instance, not by provisioning, because
 * an instance is the unit that needs one.
 */
export const LIVE_SUBSCRIPTION_PREFIX = 'aarogya-live-';

/**
 * The subscription a consumer would own, created up front on purpose.
 *
 * Pub/Sub retains a message only for subscriptions that existed when it was
 * published. A subscription created after the fact is empty however much
 * traffic the topic has carried -- so provisioning it late would make the
 * audit trail look broken at exactly the moment somebody went to check it.
 */
export const PUBSUB_SUBSCRIPTION =
  process.env.AAROGYA_PUBSUB_SUBSCRIPTION?.trim() || 'aarogya-events-audit';

export interface TableSpec {
  name: string;
  description: string;
  fields: BqField[];
  /** Column to partition by day on. */
  partitionField?: string;
  clustering?: string[];
}

const RISK_FIELDS: BqField[] = [
  { name: 'on_hand', type: 'FLOAT64' },
  { name: 'previous_on_hand', type: 'FLOAT64' },
  { name: 'stockout_probability', type: 'FLOAT64' },
  { name: 'previous_stockout_probability', type: 'FLOAT64' },
  { name: 'risk_score', type: 'FLOAT64' },
  { name: 'previous_risk_score', type: 'FLOAT64' },
  { name: 'severity', type: 'STRING' },
  { name: 'previous_severity', type: 'STRING' },
  { name: 'days_of_cover', type: 'FLOAT64' },
  { name: 'reorder_point', type: 'FLOAT64' },
  { name: 'expected_shortfall_units', type: 'FLOAT64' },
  { name: 'forecast_source', type: 'STRING' },
];

export const STOCK_EVENTS_SPEC: TableSpec = {
  name: STOCK_EVENTS_TABLE,
  description:
    'Confirmed stock corrections from the capture console. Append-only; the ' +
    'newest row per (facility_id, drug_id) is the correction in force.',
  partitionField: 'at',
  clustering: ['facility_id', 'drug_id'],
  fields: [
    // The writing instance's cursor at the time of the write. With
    // `instance_id` it is the event's identity (`<instance_id>:<seq>`), which
    // every instance and every restore agrees on; the stream cursor a restored
    // event gets is assigned afresh by the instance that restores it.
    { name: 'seq', type: 'INT64', mode: 'REQUIRED' },
    { name: 'at', type: 'TIMESTAMP', mode: 'REQUIRED' },
    // Which container wrote it: the other half of the event's identity.
    { name: 'instance_id', type: 'STRING' },
    { name: 'facility_id', type: 'STRING', mode: 'REQUIRED' },
    { name: 'facility_name', type: 'STRING' },
    { name: 'district_code', type: 'STRING' },
    { name: 'drug_id', type: 'STRING', mode: 'REQUIRED' },
    { name: 'drug_name', type: 'STRING' },
    { name: 'on_hand', type: 'INT64', mode: 'REQUIRED' },
    { name: 'source', type: 'STRING' },
    // Who confirmed the number, as authenticated. Masked and pseudonymous by
    // construction (src/lib/auth/token.ts); NULL on rows from before sign-in.
    { name: 'actor', type: 'STRING' },
    { name: 'actor_id', type: 'STRING' },
    { name: 'actor_auth', type: 'STRING' },
    { name: 'recompute_ms', type: 'INT64' },
    { name: 'risk', type: 'RECORD', fields: RISK_FIELDS },
  ],
};

/**
 * Every dispatch-ticket transition, one row each. THIS IS THE AUDIT LOG.
 *
 * There is no companion `tickets` table holding current state, on purpose. A
 * ticket's state is a fold over these rows, so there is exactly one record of
 * what happened and nothing for it to disagree with. Each row is fully
 * self-describing -- the facilities, the drug, the planned quantity -- because
 * an audit row that can only be read by joining to something else is an audit
 * row that stops being readable the first time the something else changes.
 */
export const DISPATCH_TICKETS_SPEC: TableSpec = {
  name: DISPATCH_TICKETS_TABLE,
  description:
    'Append-only dispatch ticket transitions: propose, approve, dispatch, ' +
    'receive, cancel. A ticket is the fold of its rows in (at, seq) order.',
  partitionField: 'at',
  clustering: ['district_code', 'ticket_id'],
  fields: [
    { name: 'ticket_id', type: 'STRING', mode: 'REQUIRED' },
    { name: 'seq', type: 'INT64', mode: 'REQUIRED' },
    { name: 'at', type: 'TIMESTAMP', mode: 'REQUIRED' },
    { name: 'instance_id', type: 'STRING' },
    { name: 'district_code', type: 'STRING' },
    { name: 'order_id', type: 'STRING' },
    { name: 'action', type: 'STRING', mode: 'REQUIRED' },
    { name: 'from_state', type: 'STRING' },
    { name: 'to_state', type: 'STRING' },
    // The ROLE the actor said they acted in. Still claimed: there is sign-in
    // now, but no role directory. Rows from before sign-in hold the only actor
    // there was, which was claimed too.
    { name: 'actor_claimed', type: 'STRING' },
    // Who acted, as authenticated: a display label, a pseudonymous id the
    // four-eyes rule compares, and how they signed in (google | operator).
    { name: 'actor', type: 'STRING' },
    { name: 'actor_id', type: 'STRING' },
    { name: 'actor_auth', type: 'STRING' },
    { name: 'note', type: 'STRING' },
    { name: 'planned_units', type: 'INT64' },
    { name: 'units', type: 'INT64' },
    { name: 'dispatched_units', type: 'INT64' },
    { name: 'received_units', type: 'INT64' },
    { name: 'variance_units', type: 'INT64' },
    { name: 'cross_district', type: 'BOOL' },
    { name: 'from_facility_id', type: 'STRING' },
    { name: 'from_facility_name', type: 'STRING' },
    { name: 'from_facility_type', type: 'STRING' },
    { name: 'from_district_code', type: 'STRING' },
    { name: 'from_district_name', type: 'STRING' },
    { name: 'to_facility_id', type: 'STRING' },
    { name: 'to_facility_name', type: 'STRING' },
    { name: 'to_facility_type', type: 'STRING' },
    { name: 'to_district_code', type: 'STRING' },
    { name: 'to_district_name', type: 'STRING' },
    { name: 'drug_id', type: 'STRING' },
    { name: 'drug_name', type: 'STRING' },
    { name: 'unit', type: 'STRING' },
    {
      name: 'effects',
      type: 'RECORD',
      mode: 'REPEATED',
      fields: [
        { name: 'role', type: 'STRING' },
        { name: 'facility_id', type: 'STRING' },
        { name: 'facility_name', type: 'STRING' },
        { name: 'district_code', type: 'STRING' },
        { name: 'on_hand_before', type: 'FLOAT64' },
        { name: 'on_hand_after', type: 'FLOAT64' },
        { name: 'stockout_before', type: 'FLOAT64' },
        { name: 'stockout_after', type: 'FLOAT64' },
        { name: 'severity_before', type: 'STRING' },
        { name: 'severity_after', type: 'STRING' },
        { name: 'days_of_cover_after', type: 'FLOAT64' },
        { name: 'projected', type: 'BOOL' },
        { name: 'forecast_source', type: 'STRING' },
      ],
    },
  ],
};

export const TABLE_SPECS: TableSpec[] = [STOCK_EVENTS_SPEC, DISPATCH_TICKETS_SPEC];

/** `project.dataset.table`, backticked for embedding in SQL. */
export function tableRef(projectId: string, table: string): string {
  return '`' + projectId + '.' + DATASET + '.' + table + '`';
}
