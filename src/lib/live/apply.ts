import { applyForeignStockEvent, type StockEvent } from '@/lib/overlay/store';
import { applyForeignTicket } from '@/lib/dispatch/store';
import type { DispatchTicket } from '@/lib/dispatch/ticket';
import { INSTANCE_ID } from './instance';

/**
 * What a message from another instance does to this one.
 *
 * Separated from `bus.ts`, which owns the subscription and the network, so the
 * part that decides what a message MEANS can be tested in plain Node -- the
 * de-duplication, the ordering and the refusal of this instance's own echoes
 * are exactly the things that go wrong quietly.
 *
 * THE MESSAGES
 * ------------
 * Everything arrives on the one topic the commit path always published to
 * (`aarogya-events`), so the audit subscription and the fan-out read the same
 * stream:
 *
 *   stock.committed     { event }            a report, after its durable append settled
 *   dispatch.<action>   { transition, ticket } a ticket transition, after its append settled
 *   batch.published     { runId }            the scheduled batch published a new run
 *
 * Anything else is counted and ignored: a topic outlives the code reading it.
 */

export interface ApplyOutcome {
  kind: 'stock' | 'ticket' | 'batch' | 'own' | 'ignored' | 'malformed';
  applied: boolean;
  duplicate?: boolean;
  runId?: string;
}

export function applyBusMessage(
  attributes: Record<string, string> | undefined,
  body: unknown,
  onBatch?: (runId: string) => void,
): ApplyOutcome {
  // The subscription filters this instance's own messages out; a message that
  // gets through anyway (a filter edited by hand, a subscription reused across
  // a restart) must still not be applied twice.
  if (attributes?.instanceId === INSTANCE_ID) return { kind: 'own', applied: false };

  const type = attributes?.type ?? (body as { type?: string } | null)?.type ?? '';
  const b = (body ?? {}) as Record<string, unknown>;

  if (type === 'stock.committed') {
    const event = b.event as StockEvent | undefined;
    if (!event || typeof event.eventId !== 'string' || typeof event.facilityId !== 'string') {
      return { kind: 'malformed', applied: false };
    }
    const r = applyForeignStockEvent(event);
    return { kind: 'stock', applied: !r.duplicate, duplicate: r.duplicate };
  }

  if (type.startsWith('dispatch.')) {
    const ticket = b.ticket as DispatchTicket | undefined;
    if (!ticket || typeof ticket.ticketId !== 'string' || !Array.isArray(ticket.history)) {
      return { kind: 'malformed', applied: false };
    }
    const r = applyForeignTicket(ticket);
    return { kind: 'ticket', applied: r.applied, duplicate: !r.applied };
  }

  if (type === 'batch.published') {
    const runId = typeof b.runId === 'string' ? b.runId : undefined;
    if (!runId) return { kind: 'malformed', applied: false };
    onBatch?.(runId);
    return { kind: 'batch', applied: true, runId };
  }

  return { kind: 'ignored', applied: false };
}
