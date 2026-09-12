import type { DispatchOrder } from '@/lib/district-detail';
import type { DispatchTicket } from './ticket';

/**
 * The dispatch plan as a stock-issue CSV.
 *
 * WHY A CSV IS NOT A CONSOLATION PRIZE
 * ------------------------------------
 * Every Indian state already runs a drug logistics system -- DVDMS in most,
 * e-Aushadhi in several -- and none of them is going to be replaced by a
 * hackathon entry, nor should it be. This project's honest position is that it
 * is a DECISION layer over those systems: it reads what they hold, works out
 * what should move, and hands the movement back in a shape their storekeepers
 * already work in.
 *
 * That makes this file the difference between "a dashboard" and "something a
 * district could pilot next month". It is about thirty lines. The gap it closes
 * is the one that kills pilots.
 *
 * ONE ROW PER BATCH, NOT PER ORDER
 * --------------------------------
 * A stock issue is recorded batch-wise, because that is how a storekeeper picks
 * and how expiry is tracked. An order for 168 sachets drawn from two batches is
 * two lines with a shared indent number -- exactly what the pick list on the
 * card already shows, and exactly what a system on the other end expects to
 * receive. Collapsing them to one row with a single batch number would produce
 * a file that reconciles against nothing.
 *
 * QUANTITIES ARE THREE COLUMNS, NOT ONE
 * -------------------------------------
 * Indented, issued and received are different numbers and the difference is the
 * point. A file that carried only the planned quantity would describe a supply
 * chain in which nothing ever goes missing. Where a ticket exists, the issued
 * and received columns are what actually happened, apportioned across the
 * batches in pick order; where none does, they are blank rather than zero --
 * "not yet issued" and "issued nothing" are different facts.
 */

/** Columns, in the order a storekeeper reads them. */
const HEADER = [
  'indent_no',
  'indent_date',
  'status',
  'from_facility_code',
  'from_facility_name',
  'from_facility_type',
  'from_district',
  'to_facility_code',
  'to_facility_name',
  'to_facility_type',
  'to_district',
  'item_code',
  'item_name',
  'item_strength',
  'ved_class',
  'cold_chain',
  'uom',
  'batch_no',
  'expiry_date',
  'qty_indented',
  'qty_issued',
  'qty_received',
  'variance',
  'distance_km',
  'transport_inr',
  'approved_by',
  'issued_by',
  'received_by',
  'remarks',
] as const;

/**
 * RFC 4180 quoting.
 *
 * Facility names in this network contain hyphens and digits, and district names
 * in India contain commas, apostrophes and ampersands. A file that only quoted
 * "when it looked necessary" is the standard way a CSV silently gains a column
 * halfway down and stops importing.
 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s === '') return '';
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Split a total across the pick list, in order, without losing a unit.
 *
 * A short issue comes off the batches in the order they were picked -- earliest
 * expiry first -- so the shortfall lands on the LAST batch rather than being
 * spread evenly. Spreading would produce fractional units and a file that
 * disagrees with the physical shelves.
 */
function apportion(total: number, lines: { quantity: number }[]): number[] {
  let left = total;
  return lines.map((l) => {
    const take = Math.min(left, l.quantity);
    left -= take;
    return take;
  });
}

function actorFor(ticket: DispatchTicket | undefined, action: string): string | null {
  const hit = ticket?.history.find((h) => h.action === action);
  return hit ? hit.actor : null;
}

export interface CsvMeta {
  districtCode: string;
  districtName: string;
  /** The date the plan was built, as the indent date. */
  indentDate: string;
}

export function toDispatchCsv(
  orders: DispatchOrder[],
  ticketsByOrderId: Map<string, DispatchTicket>,
  meta: CsvMeta,
): string {
  const rows: string[] = [HEADER.join(',')];

  for (const order of orders) {
    const ticket = ticketsByOrderId.get(order.id);
    const issued = ticket?.dispatchedUnits ?? null;
    const received = ticket?.receivedUnits ?? null;
    const issuedPer = issued === null ? null : apportion(issued, order.lines);
    const receivedPer = received === null ? null : apportion(received, order.lines);

    order.lines.forEach((line, i) => {
      const qIssued = issuedPer ? issuedPer[i] : null;
      const qReceived = receivedPer ? receivedPer[i] : null;
      rows.push(
        [
          // The order id is already unique per donor x receiver x drug, which is
          // what an indent number has to be. Reusing it means a row in this file
          // and a ticket in the audit log name the same thing.
          cell(order.id),
          cell(meta.indentDate),
          cell(ticket?.state ?? 'proposed'),
          cell(order.from.id),
          cell(order.from.name),
          cell(order.from.type),
          cell(order.from.districtName),
          cell(order.to.id),
          cell(order.to.name),
          cell(order.to.type),
          cell(order.to.districtName),
          cell(order.drugId),
          cell(order.drugName),
          cell(order.drugStrength),
          cell(order.ved),
          cell(order.coldChain ? 'Y' : 'N'),
          cell(order.unit),
          cell(line.batchNo),
          cell(line.expiryDate),
          cell(line.quantity),
          cell(qIssued),
          cell(qReceived),
          cell(qIssued !== null && qReceived !== null ? qIssued - qReceived : null),
          cell(order.distanceKm.toFixed(1)),
          cell(Math.round(order.estimatedCostInr)),
          cell(actorFor(ticket, 'approve')),
          cell(actorFor(ticket, 'dispatch')),
          cell(actorFor(ticket, 'receive')),
          cell(
            ticket?.history
              .map((h) => h.note)
              .filter(Boolean)
              .join('; ') || null,
          ),
        ].join(','),
      );
    });
  }

  // CRLF, because that is what RFC 4180 says and what Excel on a district
  // computer expects. A trailing newline so the last row is a complete record.
  return rows.join('\r\n') + '\r\n';
}
