import { admissibilityForEndpoints } from '@/lib/optimize/admissibility';
import 'server-only';
import { DISTRICTS_BY_CODE } from '@/lib/domain/geo';
import { loadDistrictDetail, DistrictNotBuiltError } from '@/lib/district-cache';
import type { DispatchOrder } from '@/lib/district-detail';
import {
  recomputePosition,
  ledgerOnHand,
  UnknownFacilityError,
  UnstockedDrugError,
  type RecomputedPosition,
} from '@/lib/overlay/recompute';
import { overlayFor, recordStockEvent, type StockEvent } from '@/lib/overlay/store';
import {
  RUNTIME_FORECAST_CACHE,
  RUNTIME_FORECAST_METHOD,
} from '@/lib/overlay/runtime-forecast';
import {
  persistStockEvents,
  persistTicketTransitions,
  durabilityEnabled,
} from '@/lib/durable/sink';
import {
  applyTransition,
  assertTransition,
  resolveUnits,
  type DispatchTicket,
  type TicketAction,
  type TicketEffect,
  type TicketEndpoint,
} from './ticket';
import { getTicket, putTicket, nextTicketSeq } from './store';
import { ticketAuthority, transitionTicket, ticketVersion } from './authority';

/**
 * Turning a ticket transition into something that actually moved.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 * `ticket.ts` is the state machine and knows nothing about stock. This is the
 * part that reads the planned order off disk, decides what a transition does to
 * two facilities' shelves, and writes it into the same live overlay a voice
 * report writes into -- so an approved-and-delivered dispatch and a health
 * worker's phone call reach the console by exactly one path.
 *
 * THE ORDER IS READ SERVER-SIDE. ALWAYS.
 * --------------------------------------
 * The client is rendering the order card already, so it would be easy to let it
 * post the quantity, the donor and the drug. That is the same hole
 * `/api/commit` refuses: a route that accepts a client's copy of a plan lets
 * anything that can POST move any quantity between any two facilities, with the
 * client's own JSON as the only authority. So the district payload is loaded
 * here and the order is looked up by id; the request supplies an id, an action,
 * and at most a smaller number of units.
 *
 * WHY DISPATCH AND RECEIPT ARE TWO SEPARATE STOCK MOVEMENTS
 * ---------------------------------------------------------
 * Stock leaves the donor when it is dispatched and arrives when it is received,
 * and in between it is on a vehicle and on nobody's shelf. Writing both at
 * approval -- the obvious simplification -- would show the same units in two
 * places for as long as the journey takes, which is precisely the error the
 * paper process makes and precisely what a real-time view is for.
 *
 * EVERY TRANSITION IS CONDITIONAL
 * -------------------------------
 * With more than one instance, two requests can read the same ticket at the
 * same moment on different containers. So the decision -- is this transition
 * legal, how many units, what does it do to both shelves -- is made against the
 * ticket as the authority holds it, and written only if nobody moved it in the
 * meantime (`./authority.ts`). Stock events are recorded AFTER that write
 * succeeds, never before: a dispatch that lost the race must not have emptied a
 * shelf on the way to being refused.
 */

const SETUP = { cache: RUNTIME_FORECAST_CACHE, method: RUNTIME_FORECAST_METHOD };

export class UnknownOrderError extends Error {}
export class OrderNotExecutableError extends Error {}

export interface TicketActionResult {
  ticket: DispatchTicket;
  /** Overlay events this transition produced. Empty for approve and cancel. */
  stockEvents: StockEvent[];
  /** Wall clock for the whole action, including reading the district payload. */
  elapsedMs: number;
  /**
   * Slowest single re-score. This is the figure the 100 ms WS2 budget is about;
   * the rest of `elapsedMs` is a cached file read and some JSON.
   */
  recomputeMs: number;
}

/**
 * What is on the shelf right now.
 *
 * The overlay wins over the ledger: if a health worker reported this morning
 * that the cupboard holds 40, the dispatch must be decided against 40 and not
 * against what last night's batch believed.
 */
export function currentOnHand(facilityId: string, drugId: string): number {
  const correction = overlayFor(facilityId, drugId);
  if (correction) return correction.onHand;
  return ledgerOnHand(facilityId, drugId);
}

function endpoint(o: DispatchOrder['from']): TicketEndpoint {
  return {
    facilityId: o.id,
    facilityName: o.name,
    facilityType: o.type,
    districtCode: o.districtCode,
    districtName: o.districtName,
  };
}

/** A ticket in its initial state, from the planned order. */
export function proposeTicket(
  order: DispatchOrder,
  districtCode: string,
  at: string,
  seq: number,
): DispatchTicket {
  return {
    ticketId: districtCode + ':' + order.id,
    districtCode,
    orderId: order.id,
    state: 'proposed',
    from: endpoint(order.from),
    to: endpoint(order.to),
    drugId: order.drugId,
    drugName: order.drugName,
    unit: order.unit,
    plannedUnits: order.quantity,
    dispatchedUnits: null,
    receivedUnits: null,
    varianceUnits: null,
    crossDistrict: order.crossDistrict,
    ...(() => {
      const rule = admissibilityForEndpoints(endpoint(order.from), endpoint(order.to));
      return {
        admissibility: rule.status,
        escalateTo: rule.escalateTo,
        admissibilityNote: rule.note,
      };
    })(),
    history: [
      {
        at,
        action: 'propose',
        from: 'proposed',
        to: 'proposed',
        actor: 'planner',
      },
    ],
    effects: [],
    createdAt: at,
    updatedAt: at,
    seq,
  };
}

/**
 * Score one end of a transfer at a new position.
 *
 * `baseline` is the current position rather than the ledger's, so the
 * before/after a card shows is the movement THIS action caused -- not that
 * movement plus every correction anybody made earlier today.
 */
function scoreEffect(
  role: 'donor' | 'receiver',
  end: TicketEndpoint,
  drugId: string,
  before: number,
  after: number,
  projected: boolean,
): { effect: TicketEffect; scored: RecomputedPosition } {
  const result = recomputePosition(end.facilityId, drugId, after, {
    ...SETUP,
    baseline: before,
  });
  return {
    scored: result,
    effect: {
      role,
      facilityId: end.facilityId,
      facilityName: end.facilityName,
      districtCode: end.districtCode,
      onHandBefore: before,
      onHandAfter: after,
      stockoutBefore: +result.previousRisk.stockoutProbability.toFixed(4),
      stockoutAfter: +result.risk.stockoutProbability.toFixed(4),
      severityBefore: result.previousRisk.severity,
      severityAfter: result.risk.severity,
      daysOfCoverAfter: Number.isFinite(result.risk.daysOfCover)
        ? +result.risk.daysOfCover.toFixed(1)
        : -1,
      projected,
      forecastSource: result.forecastSource,
    },
  };
}

/** The overlay event a real (non-projected) movement produces. */
function emitStockEvent(
  end: TicketEndpoint,
  drugId: string,
  drugName: string,
  effect: TicketEffect,
  scored: RecomputedPosition,
): StockEvent {
  return recordStockEvent({
    facilityId: end.facilityId,
    facilityName: end.facilityName,
    districtCode: end.districtCode,
    drugId,
    drugName,
    onHand: effect.onHandAfter,
    // The same overlay a voice report writes into, tagged with how it got there.
    source: 'dispatch',
    durability: durabilityEnabled() ? 'pending' : 'disabled',
    recomputeMs: scored.elapsedMs,
    risk: {
      onHand: effect.onHandAfter,
      previousOnHand: effect.onHandBefore,
      stockoutProbability: effect.stockoutAfter,
      previousStockoutProbability: effect.stockoutBefore,
      riskScore: scored.risk.riskScore,
      previousRiskScore: scored.previousRisk.riskScore,
      severity: effect.severityAfter,
      previousSeverity: effect.severityBefore,
      daysOfCover: effect.daysOfCoverAfter,
      reorderPoint: Math.round(scored.risk.reorderPoint),
      expectedShortfallUnits: +scored.risk.expectedShortfallUnits.toFixed(1),
      forecastSource: effect.forecastSource,
    },
  });
}

export interface TicketActionInput {
  districtCode: string;
  orderId: string;
  action: TicketAction;
  units?: number;
  actor: string;
  note?: string;
}

/**
 * Perform one transition. Throws `TicketTransitionError` on a refusal.
 *
 * Never partially applies: everything that can be refused -- the transition,
 * the quantity, the facilities, the formulary -- is checked before the ticket
 * is written or a single overlay event is recorded.
 */
export async function actOnTicket(input: TicketActionInput): Promise<TicketActionResult> {
  const started = Date.now();

  const district = DISTRICTS_BY_CODE[input.districtCode];
  if (!district) throw new UnknownOrderError('Unknown district: ' + input.districtCode);

  let detail;
  try {
    detail = await loadDistrictDetail(input.districtCode);
  } catch (e) {
    if (e instanceof DistrictNotBuiltError) {
      throw new UnknownOrderError(
        'No computed plan exists for ' + district.name + '. The nightly build has not covered it.',
      );
    }
    throw e;
  }

  const order = detail.orders.find((o) => o.id === input.orderId);
  if (!order) {
    throw new UnknownOrderError(
      'No dispatch order ' + input.orderId + ' in ' + district.name + "'s plan.",
    );
  }

  const at = new Date().toISOString();
  const ticketId = input.districtCode + ':' + order.id;
  const authority = ticketAuthority();

  interface Decision {
    existing: DispatchTicket | null;
    units: number;
    effects: TicketEffect[];
    scored: { role: 'donor' | 'receiver'; effect: TicketEffect; scored: RecomputedPosition }[];
    slowestMs: number;
  }

  const { ticket: updated, token, result: decision } = await transitionTicket<Decision>(
    authority,
    ticketId,
    (stored) => {
      // A ticket is created the first time somebody acts on the order, not when
      // the plan is built: 23,070 tickets nobody has looked at would be a table,
      // not an audit trail. The `propose` row is written with the first action,
      // so the log still opens with the state the planner produced.
      const ticket = stored ?? proposeTicket(order, input.districtCode, at, 0);

      assertTransition(ticket, input.action);

      let donorOnHand: number;
      let receiverOnHand: number;
      try {
        donorOnHand = currentOnHand(ticket.from.facilityId, ticket.drugId);
        receiverOnHand = currentOnHand(ticket.to.facilityId, ticket.drugId);
      } catch (e) {
        if (e instanceof UnknownFacilityError || e instanceof UnstockedDrugError) {
          throw new OrderNotExecutableError((e as Error).message);
        }
        throw e;
      }

      const units = resolveUnits(ticket, input.action, input.units, donorOnHand);
      const scored: Decision['scored'] = [];

      if (input.action === 'approve') {
        // Projections only. Nothing has moved; the officer is being shown what
        // signing this will do to BOTH ends, which is the thing a dispatch note
        // never tells them.
        const donor = scoreEffect('donor', ticket.from, ticket.drugId, donorOnHand, Math.max(0, donorOnHand - ticket.plannedUnits), true);
        const receiver = scoreEffect('receiver', ticket.to, ticket.drugId, receiverOnHand, receiverOnHand + ticket.plannedUnits, true);
        scored.push({ role: 'donor', ...donor }, { role: 'receiver', ...receiver });
      } else if (input.action === 'dispatch') {
        const donor = scoreEffect('donor', ticket.from, ticket.drugId, donorOnHand, donorOnHand - units, false);
        scored.push({ role: 'donor', ...donor });
      } else if (input.action === 'receive') {
        const receiver = scoreEffect('receiver', ticket.to, ticket.drugId, receiverOnHand, receiverOnHand + units, false);
        scored.push({ role: 'receiver', ...receiver });
      }

      const effects = scored.map((x) => x.effect);
      const next: DispatchTicket = {
        ...applyTransition(ticket, input.action, {
          at,
          actor: input.actor,
          units,
          note: input.note,
          effects,
          seq: nextTicketSeq(),
        }),
        // Exactly as a stock event is stamped, and for the same reason.
        durability: durabilityEnabled() ? 'pending' : 'disabled',
      };
      return {
        next,
        result: {
          existing: stored,
          units,
          effects,
          scored,
          slowestMs: Math.max(0, ...scored.map((x) => x.scored.elapsedMs)),
        },
      };
    },
  );
  putTicket(updated);

  // Only now does anything physical get recorded: the write above is what made
  // this transition the one that happened.
  const stockEvents: StockEvent[] = [];
  if (input.action === 'dispatch' || input.action === 'receive') {
    for (const x of decision.scored) {
      const end = x.role === 'donor' ? updated.from : updated.to;
      stockEvents.push(emitStockEvent(end, updated.drugId, updated.drugName, x.effect, x.scored));
    }
  }
  const slowestMs = decision.slowestMs;
  const existing = decision.existing;

  // Deliberately not awaited, for the same reason a commit's append is not: a
  // slow warehouse in another region must not slow down, or fail, an action a
  // storekeeper has already performed.
  //
  // The transitions added by THIS request are appended, which for a first
  // action is two rows -- the `propose` the planner implied and the action that
  // woke the ticket up -- so the log always opens with the state the plan
  // produced rather than with somebody's signature on nothing.
  //
  // When it settles, the ticket is re-issued with what actually happened, on a
  // new sequence number, so the ticket frame on every open stream carries the
  // chip change. Only if no later action has replaced it: a newer transition
  // reports its own durability, and must not be overwritten by this one's.
  void persistTicketTransitions(updated, existing ? existing.history.length : 0).then(async (durability) => {
    const current = getTicket(updated.ticketId);
    if (!current || ticketVersion(current) !== ticketVersion(updated) || current.durability === durability) return;
    const settled = { ...current, durability, seq: nextTicketSeq() };
    putTicket(settled);
    // Recorded on the authority too, so an instance that restores from it does
    // not show a settled transition as still pending. Conditional on the version
    // just written: a newer transition reports its own durability and wins.
    if (authority.kind === 'gcs') await authority.write(settled, token).catch(() => null);
  });
  if (stockEvents.length > 0) void persistStockEvents(stockEvents);

  return {
    ticket: updated,
    stockEvents,
    elapsedMs: Date.now() - started,
    recomputeMs: slowestMs,
  };
}
