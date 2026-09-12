import { applyTransition, type DispatchTicket, type TicketAction, type TicketEffect } from './ticket';

/**
 * Rebuilding tickets from the audit log.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * It lives here, and not next to the BigQuery query that produces the rows,
 * because `durable/sink.ts` is marked `server-only` -- which throws outside a
 * bundler, so anything that imports it can never be exercised by a plain Node
 * test. The same lesson cost a real bug once already: writing a test for the
 * Tier-1 recompute is what found that an unknown drug id produced a 500 rather
 * than a typed refusal, and that test was only possible because the expensive
 * dependency was injected rather than imported.
 *
 * The fold is the part worth testing. The query around it is four lines of SQL.
 *
 * THE STATE IS THE FOLD
 * ---------------------
 * There is no table of current ticket states. A ticket IS its transitions
 * replayed in order, so the log cannot drift from the state it describes --
 * there is nothing else for it to drift from. Every row is self-describing, so
 * a ticket whose earliest rows have aged out of the query's window still folds
 * from whatever survives.
 */

/** One audit row, already decoded out of BigQuery's string-shaped REST surface. */
export interface TicketLogRow {
  ticketId: string;
  seq: number;
  at: string;
  action: string;
  actor: string;
  units: number | null;
  note?: string;
  effects: TicketEffect[];
  /** The order, denormalised onto every row. */
  districtCode: string;
  orderId: string;
  plannedUnits: number;
  crossDistrict: boolean;
  from: DispatchTicket['from'];
  to: DispatchTicket['to'];
  drugId: string;
  drugName: string;
  unit: string;
}

const ACTIONS: ReadonlySet<string> = new Set(['approve', 'dispatch', 'receive', 'cancel']);

function baseTicket(row: TicketLogRow): DispatchTicket {
  return {
    ticketId: row.ticketId,
    districtCode: row.districtCode,
    orderId: row.orderId,
    state: 'proposed',
    from: row.from,
    to: row.to,
    drugId: row.drugId,
    drugName: row.drugName,
    unit: row.unit,
    plannedUnits: row.plannedUnits,
    dispatchedUnits: null,
    receivedUnits: null,
    varianceUnits: null,
    crossDistrict: row.crossDistrict,
    history: [
      { at: row.at, action: 'propose', from: 'proposed', to: 'proposed', actor: 'planner' },
    ],
    effects: [],
    createdAt: row.at,
    updatedAt: row.at,
    seq: row.seq,
  };
}

/**
 * Replay rows, oldest first, into the tickets they describe.
 *
 * Rows whose action is not one this build knows are skipped rather than
 * throwing: an audit log outlives the code that wrote it, and a restart that
 * refuses to start because a future version once wrote a fifth action would
 * turn a forwards-compatibility question into an outage.
 */
export function foldTicketLog(rows: TicketLogRow[]): DispatchTicket[] {
  const byTicket = new Map<string, DispatchTicket>();

  for (const row of rows) {
    if (row.action === 'propose') {
      if (!byTicket.has(row.ticketId)) byTicket.set(row.ticketId, baseTicket(row));
      continue;
    }
    if (!ACTIONS.has(row.action)) continue;

    const current = byTicket.get(row.ticketId) ?? baseTicket(row);
    byTicket.set(
      row.ticketId,
      applyTransition(current, row.action as TicketAction, {
        at: row.at,
        actor: row.actor,
        units: row.units ?? 0,
        note: row.note,
        effects: row.effects,
        seq: row.seq,
      }),
    );
  }

  return [...byTicket.values()];
}
