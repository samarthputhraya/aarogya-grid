import type { AdmissibilityStatus } from '@/lib/optimize/admissibility';
import type { Durability } from '@/lib/overlay/store';
/**
 * The dispatch ticket: a plan turning into a thing that happened.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now the planner produced dispatch orders and the console printed them.
 * That is a recommendation engine, and a recommendation engine is where most
 * projects like this stop -- the interesting half is what a district officer
 * does next, and whether the system finds out. An order that is approved, sent
 * short, and received shorter still is the normal case in a real supply chain,
 * and a dashboard that cannot represent it will always be describing a network
 * that does not exist.
 *
 * So a ticket is a small state machine over one planned order, and the log of
 * its transitions IS the audit trail: there is no separate audit table, because
 * a second record of the same events is a second thing that can disagree.
 *
 * THE STATES, AND WHY PHYSICAL MOVEMENT IS NOT AT APPROVAL
 * --------------------------------------------------------
 *
 *   proposed --approve--> approved --dispatch--> dispatched --receive--> received
 *      |                     |
 *      +-------cancel--------+--> cancelled
 *
 * Approval commits nothing physical. Stock leaves the donor's shelf when it is
 * DISPATCHED and arrives on the receiver's when it is RECEIVED, and those are
 * the only two transitions that move a number. Modelling approval as the moment
 * both facilities change would make the board show stock in two places at once
 * for however long the vehicle takes -- which is exactly the error the paper
 * process makes today.
 *
 * What approval does do is re-score both ends at the quantity the order names,
 * as a PROJECTION, so the officer signing it can see what it will do to the
 * donor as well as to the receiver. Those projections are labelled as
 * projections on the ticket and never touch the overlay.
 *
 * CANCELLATION STOPS AT DISPATCH ON PURPOSE
 * -----------------------------------------
 * Once stock is on a vehicle, undoing it is a return, which is a different
 * physical process with its own paperwork and its own risks. Pretending
 * `cancel` can reach into a dispatched ticket would let the system record an
 * outcome nobody performed.
 *
 * SHORT RECEIPTS ARE FIRST-CLASS
 * ------------------------------
 * `receive` takes the units that actually arrived, which may be fewer than were
 * sent. The difference is kept as `varianceUnits` rather than smoothed away,
 * and the receiver's risk recovers only by what arrived. Three lines of code,
 * and the most honest thing in the demo.
 */

export type TicketState = 'proposed' | 'approved' | 'dispatched' | 'received' | 'cancelled';

export type TicketAction = 'countersign' | 'approve' | 'dispatch' | 'receive' | 'cancel';

/** States from which nothing further can happen. */
export const TERMINAL_STATES: ReadonlySet<TicketState> = new Set<TicketState>([
  'received',
  'cancelled',
]);

interface TransitionRule {
  from: readonly TicketState[];
  to: TicketState;
  /** What the action means to somebody holding a clipboard. */
  describes: string;
}

export const TRANSITIONS: Record<TicketAction, TransitionRule> = {
  /*
   * The one transition that changes no state.
   *
   * An order that crosses a district or a state line cannot be signed off by
   * the officer looking at the screen -- not because the software says so, but
   * because no requisition procedure lets them. `countersign` records the other
   * jurisdiction agreeing, and `approve` refuses until that row exists. Both
   * rows are in the same append-only history as everything else, so "who
   * allowed this" is answered by the audit trail rather than by a policy
   * document nobody can produce afterwards.
   *
   * It stays in `proposed` on purpose. A `countersigned` state would double the
   * state machine for one bit of information that belongs on the log, and the
   * fold would have to learn a state that behaves exactly like the one before
   * it.
   */
  countersign: {
    from: ['proposed'],
    to: 'proposed',
    describes: 'the other jurisdiction agrees the order may be raised',
  },
  approve: {
    from: ['proposed'],
    to: 'approved',
    describes: 'a district officer signs the order off',
  },
  dispatch: {
    from: ['approved'],
    to: 'dispatched',
    describes: 'the donor storekeeper picks the batches and the stock leaves the shelf',
  },
  receive: {
    from: ['dispatched'],
    to: 'received',
    describes: 'the receiving facility counts what arrived',
  },
  cancel: {
    from: ['proposed', 'approved'],
    to: 'cancelled',
    describes: 'the order is abandoned before anything physically moves',
  },
};

/** One entry in the append-only history. This is the audit trail. */
export interface TicketTransition {
  at: string;
  action: TicketAction | 'propose';
  from: TicketState;
  to: TicketState;
  /**
   * Who says they did it.
   *
   * There is no authentication in this build and this field does not pretend
   * otherwise: it records a CLAIMED actor, not a verified one. In a deployment
   * it would carry the identity the request was authenticated as. Saying so
   * here is cheaper than a reviewer discovering it.
   */
  actor: string;
  /** Units named by this action -- dispatched, or received. */
  units?: number;
  note?: string;
}

/** What a transition did to a facility's risk. */
export interface TicketEffect {
  role: 'donor' | 'receiver';
  facilityId: string;
  facilityName: string;
  districtCode: string;
  onHandBefore: number;
  onHandAfter: number;
  stockoutBefore: number;
  stockoutAfter: number;
  severityBefore: string;
  severityAfter: string;
  daysOfCoverAfter: number;
  /**
   * True when this is what the order WOULD do, not what it has done.
   *
   * Approval produces two projections; dispatch and receipt each produce one
   * real effect. A card that showed them identically would claim a donor's
   * shelf had emptied at the moment a form was signed.
   */
  projected: boolean;
  forecastSource: string;
}

export interface TicketEndpoint {
  facilityId: string;
  facilityName: string;
  facilityType: string;
  districtCode: string;
  districtName: string;
}

export interface DispatchTicket {
  /** `districtCode:orderId`. Stable, because the order id is. */
  ticketId: string;
  /** The district whose plan produced the order -- not necessarily the donor's. */
  districtCode: string;
  orderId: string;
  state: TicketState;
  from: TicketEndpoint;
  to: TicketEndpoint;
  drugId: string;
  drugName: string;
  unit: string;
  /** What the planner asked for. Read from the payload, never from the client. */
  plannedUnits: number;
  dispatchedUnits: number | null;
  receivedUnits: number | null;
  /**
   * `dispatchedUnits - receivedUnits`. Positive is a short receipt.
   *
   * Null until a receipt exists, because zero and "not yet known" are different
   * facts and a chart that plots them the same way is lying about coverage.
   */
  varianceUnits: number | null;
  crossDistrict: boolean;
  /**
   * Whether anyone has the authority to issue this order, from the planner.
   *
   * Copied onto the ticket rather than recomputed here: the classification is a
   * property of the order the planner made, and a ticket that re-derived it
   * could disagree with the card the officer is looking at. See
   * `src/lib/optimize/admissibility.ts`.
   */
  admissibility: AdmissibilityStatus;
  /** Who must countersign before `approve` is legal, or null. */
  escalateTo: 'district' | 'state' | null;
  /** One line for the card and the dispatch note. */
  admissibilityNote: string;
  history: TicketTransition[];
  /** What the most recent action did. Replaced, not appended -- history is above. */
  effects: TicketEffect[];
  createdAt: string;
  updatedAt: string;
  /** Monotonic within the process, so the stream and its clients share a cursor. */
  seq: number;
  /**
   * Whether the LATEST transition reached the durable log.
   *
   * `pending` while the append is in flight, `durable` once it lands, `failed`
   * if both attempts failed, `disabled` when the service has no dataset. The
   * append is fire-and-forget, so without this a ticket that will not survive a
   * restart looked byte-identical to one that will -- and for a cross-district
   * order the `countersign` row is the only answer to "who allowed this". The
   * same four states a stock event carries. A ticket folded back out of the log
   * is `durable` by construction.
   */
  durability?: Durability;
  /**
   * Which conditional write produced this version. Minted per attempt by
   * `transitionTicket`, so an instance whose write landed but whose response was
   * lost can recognise its own write on re-read. Not part of the audit log.
   */
  writeId?: string;
}

/** Refusals a caller must be able to distinguish. `code` maps to an HTTP status. */
export class TicketTransitionError extends Error {
  constructor(
    message: string,
    readonly code: 'illegal_transition' | 'invalid_units' | 'requires_countersign',
    readonly state: TicketState,
    readonly allowed: TicketAction[],
  ) {
    super(message);
    this.name = 'TicketTransitionError';
  }
}

/** Actions legal from a given state. Sent with every refusal, so a client can recover. */
export function allowedActions(state: TicketState): TicketAction[] {
  return (Object.keys(TRANSITIONS) as TicketAction[]).filter((a) =>
    TRANSITIONS[a].from.includes(state),
  );
}

/**
 * Check a transition without performing it.
 *
 * Separate from `applyTransition` because the route has to decide its status
 * code and run an expensive recompute BETWEEN the two -- and a 409 must be
 * returned before any of that work, not after it.
 *
 * An illegal transition is an error, never a silent no-op. Re-approving an
 * already-approved ticket looks harmless and is not: it is usually a double
 * submit, and answering 200 teaches a client that its retry worked.
 */
export function assertTransition(ticket: DispatchTicket, action: TicketAction): void {
  const rule = TRANSITIONS[action];

  if (!rule.from.includes(ticket.state)) {
    throw new TicketTransitionError(
      'Cannot ' + action + ' a ticket that is ' + ticket.state +
        (TERMINAL_STATES.has(ticket.state)
          ? ' -- that is a final state.'
          : '. Allowed from here: ' + (allowedActions(ticket.state).join(', ') || 'nothing') + '.'),
      'illegal_transition',
      ticket.state,
      allowedActions(ticket.state),
    );
  }

  /*
   * The administrative gate, checked AFTER the state machine.
   *
   * A cross-boundary order is a legal transition -- the ticket IS in
   * `proposed` -- and still not something this officer may do, so refusing it
   * as an illegal transition would produce an error message that reads like a
   * bug. The refusal names the instrument that is missing and the action that
   * supplies it, because an officer who is told "no" and not told "and here is
   * what unblocks it" will work around the system rather than through it.
   *
   * Ordered after the state check on purpose. Approving an ALREADY approved
   * ticket is a double submit, and it must report itself as one; running the
   * administrative gate first would answer a stale tab with "this needs a
   * countersign", which is true of the order and irrelevant to what just
   * happened.
   */
  if (action === 'approve' && ticket.escalateTo !== null) {
    const countersigned = ticket.history.some((h) => h.action === 'countersign');
    if (!countersigned) {
      throw new TicketTransitionError(
        'This order ' +
          (ticket.escalateTo === 'state'
            ? 'crosses a state line and needs an inter-state supply agreement'
            : 'crosses a district boundary and needs the donor district to countersign') +
          ' before a district officer can approve it.',
        'requires_countersign',
        ticket.state,
        ['countersign', 'cancel'],
      );
    }
  }
}

/**
 * How many units this action moves, and whether the number is admissible.
 *
 * This is arithmetic, not policy. The donor cannot send stock it does not have,
 * and the receiver cannot count in more than was sent -- an over-receipt means
 * the dispatch note was wrong, and the fix for that is to correct the note, not
 * to let the ledger absorb a discrepancy nobody will ever look at again.
 *
 * The POLICY gate -- how much of its cover a donor may give away, and which
 * administrative boundaries a transfer may cross -- is WS6C and lives
 * elsewhere, deliberately: mixing "you do not have that many" with "you are not
 * allowed to" produces error messages that cannot be acted on.
 */
export function resolveUnits(
  ticket: DispatchTicket,
  action: TicketAction,
  requested: number | undefined,
  donorOnHand: number,
): number {
  if (action === 'dispatch') {
    const units = requested ?? ticket.plannedUnits;
    if (!Number.isInteger(units) || units <= 0) {
      throw new TicketTransitionError(
        'Dispatch quantity must be a positive whole number of ' + ticket.unit + 's.',
        'invalid_units',
        ticket.state,
        allowedActions(ticket.state),
      );
    }
    if (units > ticket.plannedUnits) {
      throw new TicketTransitionError(
        'The order is for ' + ticket.plannedUnits + ' ' + ticket.unit + 's; ' + units +
          ' would exceed it. Re-plan rather than over-ship.',
        'invalid_units',
        ticket.state,
        allowedActions(ticket.state),
      );
    }
    if (units > donorOnHand) {
      throw new TicketTransitionError(
        ticket.from.facilityName + ' holds ' + donorOnHand + ' ' + ticket.unit +
          's, so it cannot send ' + units + '. Dispatch what is on the shelf.',
        'invalid_units',
        ticket.state,
        allowedActions(ticket.state),
      );
    }
    return units;
  }

  if (action === 'receive') {
    const sent = ticket.dispatchedUnits ?? ticket.plannedUnits;
    const units = requested ?? sent;
    if (!Number.isInteger(units) || units < 0) {
      throw new TicketTransitionError(
        'Received quantity must be a whole number of ' + ticket.unit + 's, or zero.',
        'invalid_units',
        ticket.state,
        allowedActions(ticket.state),
      );
    }
    if (units > sent) {
      throw new TicketTransitionError(
        'Only ' + sent + ' ' + ticket.unit + 's were dispatched; ' + units +
          ' cannot arrive. Correct the dispatch note rather than the receipt.',
        'invalid_units',
        ticket.state,
        allowedActions(ticket.state),
      );
    }
    return units;
  }

  return 0;
}

/**
 * Fold one transition onto a ticket. Pure: returns a new object.
 *
 * The effects of the action are supplied by the caller because computing them
 * needs the pipeline, and keeping this function free of that is what lets the
 * whole state machine be tested without a forecast cache, a network or a build.
 */
export function applyTransition(
  ticket: DispatchTicket,
  action: TicketAction,
  input: { at: string; actor: string; units: number; note?: string; effects: TicketEffect[]; seq: number },
): DispatchTicket {
  const rule = TRANSITIONS[action];
  const transition: TicketTransition = {
    at: input.at,
    action,
    from: ticket.state,
    to: rule.to,
    actor: input.actor,
    ...(action === 'dispatch' || action === 'receive' ? { units: input.units } : {}),
    ...(input.note ? { note: input.note } : {}),
  };

  const dispatchedUnits = action === 'dispatch' ? input.units : ticket.dispatchedUnits;
  const receivedUnits = action === 'receive' ? input.units : ticket.receivedUnits;

  return {
    ...ticket,
    state: rule.to,
    dispatchedUnits,
    receivedUnits,
    varianceUnits:
      receivedUnits === null || dispatchedUnits === null ? null : dispatchedUnits - receivedUnits,
    history: [...ticket.history, transition],
    effects: input.effects,
    updatedAt: input.at,
    seq: input.seq,
  };
}
