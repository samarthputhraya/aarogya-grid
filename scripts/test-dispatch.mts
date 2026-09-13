/**
 * The dispatch ticket state machine, and the fold that rebuilds it.
 *
 * Run with:  npx tsx scripts/test-dispatch.mts   (part of `npm test`)
 *
 * Offline and pure. The HTTP round trip -- approve, dispatch short, receive
 * shorter, watch two risk scores move -- is exercised against a real running
 * server by `scripts/rehearse-dispatch.mjs`, because what breaks there (reading
 * the order server-side, the overlay, the stream, a 409 on a stale tab) cannot
 * be reproduced by calling functions.
 *
 * WHAT THIS FILE IS DEFENDING
 * ---------------------------
 * Two things, and they fail differently.
 *
 * The state machine's job is to REFUSE. An approve on an already-approved
 * ticket is a double submit; a receipt larger than the dispatch is a counting
 * error somebody should be told about. Both are trivially easy to "fix" by
 * making the code accept them, and the system is worth less every time that
 * happens, so each refusal is pinned here with the reason it exists.
 *
 * The fold's job is to be the ONLY definition of a ticket's state. If replaying
 * the log ever disagreed with the ticket the process was holding, the audit
 * trail would stop being evidence -- so the round trip (act, serialise, replay)
 * is checked field by field rather than by a shape assertion.
 */
import {
  applyTransition,
  assertTransition,
  allowedActions,
  resolveUnits,
  TicketTransitionError,
  TERMINAL_STATES,
  type DispatchTicket,
  type TicketAction,
  type TicketEffect,
} from '../src/lib/dispatch/ticket';
import { foldTicketLog, type TicketLogRow } from '../src/lib/dispatch/fold';
import { toDispatchCsv } from '../src/lib/dispatch/csv';
import type { DispatchOrder } from '../src/lib/district-detail';
import {
  resetTickets,
  putTicket,
  getTicket,
  ticketsSince,
  ticketsForDistrict,
  hydrateTickets,
  nextTicketSeq,
} from '../src/lib/dispatch/store';
import {
  processAuthority,
  transitionTicket,
  setTicketAuthority,
  ticketVersion,
  TicketConflictError,
  type TicketAuthority,
} from '../src/lib/dispatch/authority';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  -- ' + detail : ''));
  }
}

/** Runs `fn` and reports the TicketTransitionError it should have thrown. */
function refusal(fn: () => unknown): TicketTransitionError | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof TicketTransitionError ? e : null;
  }
}

const AT = '2026-09-20T06:00:00.000Z';

function ticket(over: Partial<DispatchTicket> = {}): DispatchTicket {
  return {
    ticketId: 'DST-10-PURNIA:ORD-1',
    districtCode: 'DST-10-PURNIA',
    orderId: 'ORD-1',
    state: 'proposed',
    from: {
      facilityId: 'F-DONOR',
      facilityName: 'SC Bhagalpur-10',
      facilityType: 'SC',
      districtCode: 'DST-10-BHAGALP',
      districtName: 'Bhagalpur',
    },
    to: {
      facilityId: 'F-RECV',
      facilityName: 'CHC Purnia-01',
      facilityType: 'CHC',
      districtCode: 'DST-10-PURNIA',
      districtName: 'Purnia',
    },
    drugId: 'ORS-SACHET',
    drugName: 'Oral Rehydration Salts',
    unit: 'sachet',
    plannedUnits: 168,
    dispatchedUnits: null,
    receivedUnits: null,
    varianceUnits: null,
    crossDistrict: true,
    // Two districts in one state: the ladder's middle rung. Overridable per
    // case, because the countersign gate is one of the things under test.
    admissibility: 'requires_district_countersign',
    escalateTo: 'district',
    admissibilityNote: 'Crosses a district boundary.',
    history: [{ at: AT, action: 'propose', from: 'proposed', to: 'proposed', actor: 'planner' }],
    effects: [],
    createdAt: AT,
    updatedAt: AT,
    seq: 1,
    ...over,
  };
}

const effect = (over: Partial<TicketEffect> = {}): TicketEffect => ({
  role: 'donor',
  facilityId: 'F-DONOR',
  facilityName: 'SC Bhagalpur-10',
  districtCode: 'DST-10-BHAGALP',
  onHandBefore: 400,
  onHandAfter: 232,
  stockoutBefore: 0.02,
  stockoutAfter: 0.08,
  severityBefore: 'low',
  severityAfter: 'moderate',
  daysOfCoverAfter: 18.4,
  projected: false,
  forecastSource: 'timesfm',
  ...over,
});

const step = (t: DispatchTicket, action: TicketAction, units: number, seq: number) =>
  applyTransition(t, action, { at: AT, actor: 'test', units, effects: [effect()], seq });

console.log('\nlegal transitions');
{
  const proposed = ticket();
  check('a proposed ticket can be countersigned, approved or cancelled',
    allowedActions('proposed').join(',') === 'countersign,approve,cancel',
    allowedActions('proposed').join(','));
  check('an approved ticket can be dispatched or cancelled',
    allowedActions('approved').join(',') === 'dispatch,cancel',
    allowedActions('approved').join(','));
  check('a dispatched ticket can only be received',
    allowedActions('dispatched').join(',') === 'receive',
    allowedActions('dispatched').join(','));
  check('a received ticket can do nothing', allowedActions('received').length === 0);
  check('received and cancelled are the terminal states',
    TERMINAL_STATES.has('received') && TERMINAL_STATES.has('cancelled') &&
      !TERMINAL_STATES.has('dispatched'));

  const approved = step(proposed, 'approve', 0, 2);
  check('approve moves proposed -> approved', approved.state === 'approved');
  check('and appends to the history rather than replacing it', approved.history.length === 2);
  check('the transition records where it came from', approved.history[1].from === 'proposed');
  check('approval moves no stock', approved.dispatchedUnits === null);

  const dispatched = step(approved, 'dispatch', 168, 3);
  check('dispatch moves approved -> dispatched', dispatched.state === 'dispatched');
  check('and records what left the shelf', dispatched.dispatchedUnits === 168);
  check('variance is still unknown, not zero', dispatched.varianceUnits === null);

  const received = step(dispatched, 'receive', 168, 4);
  check('receive moves dispatched -> received', received.state === 'received');
  check('a full receipt has zero variance', received.varianceUnits === 0);
  check('the history holds all four entries', received.history.length === 4);
}

console.log('\nillegal transitions are refused, never quietly absorbed');
{
  // A double submit or a stale tab. Answering 200 would teach the client its
  // retry worked, and the next bug of this shape is a duplicate delivery.
  const approved = step(ticket(), 'approve', 0, 2);
  const again = refusal(() => assertTransition(approved, 'approve'));
  check('approving an approved ticket throws', again !== null);
  check('the refusal is typed as an illegal transition', again?.code === 'illegal_transition');
  check('it reports the state the ticket is actually in', again?.state === 'approved');
  check('and what the client could do instead',
    (again?.allowed ?? []).join(',') === 'dispatch,cancel', (again?.allowed ?? []).join(','));
  check('a double submit is reported as a double submit, not as a policy problem',
    again?.code === 'illegal_transition');

  check('a proposed ticket cannot be dispatched',
    refusal(() => assertTransition(ticket(), 'dispatch')) !== null);
  check('a proposed ticket cannot be received',
    refusal(() => assertTransition(ticket(), 'receive')) !== null);

  // Once stock is on a vehicle, undoing it is a return -- a different physical
  // process. Letting `cancel` reach a dispatched ticket would record an
  // outcome nobody performed.
  const dispatched = step(step(ticket(), 'approve', 0, 2), 'dispatch', 168, 3);
  const late = refusal(() => assertTransition(dispatched, 'cancel'));
  check('a dispatched ticket cannot be cancelled', late !== null);
  check('and the message says it is not a final state', !/final state/.test(late?.message ?? ''));

  const received = step(dispatched, 'receive', 160, 4);
  const dead = refusal(() => assertTransition(received, 'approve'));
  check('a received ticket refuses everything', dead !== null);
  check('and says so as a final state', /final state/.test(dead?.message ?? ''));
}

console.log('\nquantities: arithmetic, not policy');
{
  const approved = step(ticket(), 'approve', 0, 2);

  check('dispatch defaults to the planned quantity',
    resolveUnits(approved, 'dispatch', undefined, 400) === 168);
  check('a storekeeper may send less', resolveUnits(approved, 'dispatch', 100, 400) === 100);

  const over = refusal(() => resolveUnits(approved, 'dispatch', 200, 400));
  check('but never more than the order', over?.code === 'invalid_units');
  check('and the message says to re-plan rather than over-ship',
    /re-plan/i.test(over?.message ?? ''), over?.message);

  // The donor cannot send stock it does not have. This is arithmetic; the
  // POLICY gate -- how much of its own cover a donor may give away -- is WS6C
  // and lives elsewhere on purpose, so the two refusals do not read alike.
  const short = refusal(() => resolveUnits(approved, 'dispatch', 168, 40));
  check('a donor cannot send stock it does not hold', short?.code === 'invalid_units');
  check('and the message names what is on the shelf', /holds 40/.test(short?.message ?? ''),
    short?.message);

  check('a fractional quantity is refused',
    refusal(() => resolveUnits(approved, 'dispatch', 10.5, 400))?.code === 'invalid_units');
  check('a zero dispatch is refused -- nothing left the shelf',
    refusal(() => resolveUnits(approved, 'dispatch', 0, 400))?.code === 'invalid_units');

  const dispatched = step(approved, 'dispatch', 150, 3);
  check('receipt defaults to what was dispatched',
    resolveUnits(dispatched, 'receive', undefined, 400) === 150);
  check('a zero receipt is legal -- the consignment never arrived',
    resolveUnits(dispatched, 'receive', 0, 400) === 0);

  const tooMany = refusal(() => resolveUnits(dispatched, 'receive', 168, 400));
  check('more cannot arrive than was sent', tooMany?.code === 'invalid_units');
  check('and the fix named is the dispatch note, not the receipt',
    /dispatch note/.test(tooMany?.message ?? ''), tooMany?.message);
}

console.log('\nthe short receipt, which is the honest case');
{
  const dispatched = step(step(ticket(), 'approve', 0, 2), 'dispatch', 168, 3);
  const short = step(dispatched, 'receive', 140, 4);
  check('variance is what went missing', short.varianceUnits === 28, String(short.varianceUnits));
  check('the receipt is recorded as what arrived', short.receivedUnits === 140);
  check('the dispatch still says what was sent', short.dispatchedUnits === 168);
  check('the units are on the transition, not just on the ticket',
    short.history[3].units === 140);

  const nothing = step(dispatched, 'receive', 0, 4);
  check('a consignment that never arrived is a variance of the whole order',
    nothing.varianceUnits === 168);
}

console.log('\nthe store: cursors and district visibility');
{
  resetTickets();
  const a = putTicket(ticket({ ticketId: 'A', seq: nextTicketSeq() }));
  const b = putTicket(
    ticket({
      ticketId: 'B',
      seq: nextTicketSeq(),
      from: { ...ticket().from, districtCode: 'DST-22-RAIPUR' },
      to: { ...ticket().to, districtCode: 'DST-22-RAIPUR' },
      districtCode: 'DST-22-RAIPUR',
    }),
  );
  check('the sequence is monotonic', a.seq === 1 && b.seq === 2, a.seq + ',' + b.seq);
  check('a cursor returns only what followed', ticketsSince(1).tickets.length === 1);
  check('replay is oldest-first, so the newest state wins on apply',
    ticketsSince(0).tickets[0].seq === 1);
  check('a ticket reads back by id', getTicket('A')?.ticketId === 'A');

  // A cross-district order must be visible to the RECEIVING district too, or
  // the only officer who can confirm the delivery cannot find the ticket.
  check('the planning district sees its ticket',
    ticketsForDistrict('DST-10-PURNIA').some((t) => t.ticketId === 'A'));
  check('the donor district sees it as well',
    ticketsForDistrict('DST-10-BHAGALP').some((t) => t.ticketId === 'A'));
  check('an unrelated district does not',
    !ticketsForDistrict('DST-22-BASTAR').some((t) => t.ticketId === 'A'));
}

console.log('\nthe fold: replaying the log reproduces the ticket');
{
  // Build a ticket the way a request would, serialise its history the way the
  // audit table does, then replay. The two must agree field for field, because
  // the log is the only record and the fold is the only reader.
  const live = step(step(step(ticket(), 'approve', 0, 2), 'dispatch', 168, 3), 'receive', 140, 4);

  const rows: TicketLogRow[] = live.history.map((h, i) => ({
    ticketId: live.ticketId,
    seq: i + 1,
    at: h.at,
    action: h.action,
    actor: h.actor,
    units: h.units ?? null,
    note: h.note,
    effects: i === live.history.length - 1 ? live.effects : [],
    districtCode: live.districtCode,
    orderId: live.orderId,
    plannedUnits: live.plannedUnits,
    crossDistrict: live.crossDistrict,
    from: live.from,
    to: live.to,
    drugId: live.drugId,
    drugName: live.drugName,
    unit: live.unit,
  }));

  const [folded] = foldTicketLog(rows);
  check('the folded state matches', folded.state === live.state, folded.state);
  check('dispatched units match', folded.dispatchedUnits === live.dispatchedUnits);
  check('received units match', folded.receivedUnits === live.receivedUnits);
  check('the variance survives the round trip', folded.varianceUnits === 28,
    String(folded.varianceUnits));
  check('so does the whole history', folded.history.length === live.history.length);
  check('and the order it describes', folded.plannedUnits === 168 && folded.drugId === 'ORS-SACHET');
  check('the last effects are carried', folded.effects.length === 1);

  // Every row is self-describing, so a ticket whose earliest rows have aged out
  // of the query window still folds from whatever survives.
  const truncated = foldTicketLog(rows.slice(2));
  check('a log missing its opening rows still folds', truncated.length === 1);
  check('and reaches the right final state', truncated[0].state === 'received',
    truncated[0].state);
  check('with the order intact, because each row carries it',
    truncated[0].from.facilityName === 'SC Bhagalpur-10');

  // An audit log outlives the code that wrote it. A restart that refused to
  // start because a future version once wrote a fifth action would turn a
  // compatibility question into an outage.
  const withFuture = foldTicketLog([
    ...rows.slice(0, 2),
    { ...rows[2], action: 'teleport' },
    ...rows.slice(2),
  ]);
  check('an unknown action is skipped rather than thrown on',
    withFuture[0].state === 'received', withFuture[0].state);

  resetTickets();
  const hydrated = hydrateTickets(foldTicketLog(rows));
  check('hydrating puts the tickets back', hydrated.tickets === 1);
  check('and resumes the sequence from the log', hydrated.seq === 4, String(hydrated.seq));
}


console.log('\nan order nobody may sign is refused, and told how to unblock it');
{
  // The ladder's three rungs, as tickets. WS6C: a plan full of orders nobody
  // has the authority to issue is not an ambitious plan, it is one that gets
  // ignored -- so the ticket refuses rather than the officer discovering it
  // three weeks later.
  const inDistrict = ticket({
    admissibility: 'permitted',
    escalateTo: null,
    admissibilityNote: 'Within one district.',
  });
  check('an in-district order needs no countersign', refusal(() => assertTransition(inDistrict, 'approve')) === null);

  const crossDistrict = ticket();
  const blocked = refusal(() => assertTransition(crossDistrict, 'approve'));
  check('a cross-district order cannot be approved outright', blocked !== null);
  check('and the refusal says why, in its own code', blocked?.code === 'requires_countersign');
  check('and names the action that unblocks it',
    (blocked?.allowed ?? []).includes('countersign'), (blocked?.allowed ?? []).join(','));
  check('the message names the instrument, not the rule number',
    (blocked?.message ?? '').includes('countersign'), blocked?.message);

  const countersigned = applyTransition(crossDistrict, 'countersign', {
    at: AT, actor: 'donor district officer', units: 0, effects: [], seq: 2,
  });
  check('countersigning leaves the ticket proposed', countersigned.state === 'proposed');
  check('and is on the audit trail', countersigned.history.some((h) => h.action === 'countersign'));
  check('and approval is then legal', refusal(() => assertTransition(countersigned, 'approve')) === null);

  const crossState = ticket({
    admissibility: 'requires_inter_state_agreement',
    escalateTo: 'state',
    admissibilityNote: 'Crosses a state line.',
  });
  const stateBlocked = refusal(() => assertTransition(crossState, 'approve'));
  check('a cross-state order is refused too', stateBlocked?.code === 'requires_countersign');
  check('and says an inter-state agreement is what is missing',
    (stateBlocked?.message ?? '').includes('inter-state'), stateBlocked?.message);
  check('cancelling never needs a countersign',
    refusal(() => assertTransition(crossState, 'cancel')) === null);
}

console.log('\nconditional transitions: two writers, one ticket');
{
  // With more than one instance, two requests can read the same ticket at the
  // same moment. The state machine's refusals are only worth anything if the
  // write is conditional on the version the decision was made against.
  const permitted = () =>
    ticket({ admissibility: 'permitted', escalateTo: null, admissibilityNote: 'Within one district.' });
  const approve = (current: DispatchTicket | null) => {
    const t = current ?? permitted();
    assertTransition(t, 'approve');
    return { next: step(t, 'approve', 0, nextTicketSeq()), result: null };
  };
  const settle = async <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

  // One instance: the process's own store.
  resetTickets();
  setTicketAuthority(null);
  const [a, b] = await Promise.all([
    settle(transitionTicket(processAuthority, permitted().ticketId, approve)),
    settle(transitionTicket(processAuthority, permitted().ticketId, approve)),
  ]);
  const winners = [a, b].filter((r) => r.ok).length;
  const loser = [a, b].find((r) => !r.ok) as { ok: false; e: unknown } | undefined;
  check('a double submit in one process approves once', winners === 1, String(winners));
  check('and the other is refused as the double submit it is',
    loser?.e instanceof TicketTransitionError && loser.e.code === 'illegal_transition');
  check('the stored ticket carries exactly one approval',
    getTicket(permitted().ticketId)?.history.filter((h) => h.action === 'approve').length === 1);

  // Two instances: a shared authority with generations, and a write that yields
  // before it lands, so both requests have read before either writes.
  const shared = new Map<string, { ticket: DispatchTicket; gen: number }>();
  let writes = 0;
  const bucket: TicketAuthority = {
    kind: 'gcs',
    async read(id) {
      const hit = shared.get(id);
      return { ticket: hit ? structuredClone(hit.ticket) : null, token: String(hit?.gen ?? 0) };
    },
    async write(t, token) {
      await new Promise((r) => setTimeout(r, 5));
      writes++;
      const hit = shared.get(t.ticketId);
      if (String(hit?.gen ?? 0) !== token) return null;
      shared.set(t.ticketId, { ticket: structuredClone(t), gen: (hit?.gen ?? 0) + 1 });
      return String((hit?.gen ?? 0) + 1);
    },
    async list() {
      return [...shared.values()].map((x) => x.ticket);
    },
  };
  const id = permitted().ticketId;
  const [x, y] = await Promise.all([
    settle(transitionTicket(bucket, id, approve)),
    settle(transitionTicket(bucket, id, approve)),
  ]);
  check('two instances approving the same order: exactly one succeeds', [x, y].filter((r) => r.ok).length === 1);
  check('the loser re-read and was refused, not silently overwritten',
    [x, y].some((r) => !r.ok && r.e instanceof TicketTransitionError && r.e.code === 'illegal_transition'));
  check('the authority holds one approval', shared.get(id)?.ticket.history.filter((h) => h.action === 'approve').length === 1);
  check('and the version moved once past the planner\'s proposal', ticketVersion(shared.get(id)?.ticket) === 2);
  check('both requests did reach the write', writes === 2, String(writes));

  // A conditional write whose response was lost answers 412 against itself on
  // the retry; re-reading is how "someone else" is told apart from "us".
  shared.clear();
  let lost = true;
  const flaky: TicketAuthority = {
    ...bucket,
    async write(t, token) {
      const written = await bucket.write(t, token);
      if (lost && written !== null) {
        lost = false;
        return null;
      }
      return written;
    },
  };
  const recovered = await settle(transitionTicket(flaky, id, approve));
  check('a write that landed but reported a conflict is recognised as ours',
    recovered.ok && recovered.v.conflicts === 1 && ticketVersion(shared.get(id)?.ticket) === 2);

  const never: TicketAuthority = { ...bucket, write: async () => null, read: async () => ({ ticket: null, token: '0' }) };
  const exhausted = await settle(transitionTicket(never, 'X:1', approve, 3));
  check('a transition that keeps losing gives up with a typed conflict',
    !exhausted.ok && exhausted.e instanceof TicketConflictError && exhausted.e.attempts === 3);
  resetTickets();
}

console.log('\nthe stock-issue CSV');
{
  // A district name with a comma in it, because Indian district names have
  // them and a file that only quotes "when it looks necessary" is the standard
  // way a CSV silently gains a column halfway down.
  const order = {
    id: 'ORD-1',
    from: {
      id: 'F-DONOR', name: 'SC Bhagalpur-10', type: 'SC', lat: 25.2, lon: 87,
      districtCode: 'DST-10-BHAGALP', districtName: 'Bhagalpur, East',
    },
    to: {
      id: 'F-RECV', name: 'CHC Purnia-01', type: 'CHC', lat: 25.7, lon: 87.4,
      districtCode: 'DST-10-PURNIA', districtName: 'Purnia',
    },
    drugId: 'ORS-SACHET',
    drugName: 'Oral Rehydration Salts (WHO formula)',
    drugStrength: '20.5 g',
    unit: 'sachet',
    ved: 'V',
    coldChain: false,
    quantity: 168,
    lines: [
      { batchNo: 'B-001', quantity: 100, expiryDate: '2027-03-01', daysToExpiry: 152 },
      { batchNo: 'B-002', quantity: 68, expiryDate: '2027-09-01', daysToExpiry: 336 },
    ],
    distanceKm: 61.42,
    estimatedCostInr: 1234.6,
    standaloneCostInr: 4000,
    corridorId: 'F-DONOR|F-RECV',
    rideAlong: false,
    coldUpgradeInr: 0,
    crossDistrict: true,
    wasteAvertedUnits: 0,
    riskReduction: 0.8,
    receiverOnHandBefore: 0,
    receiverStockoutProbBefore: 1,
    rationale: 'Receiver at zero; donor holds surplus above its reorder point.',
  } as unknown as DispatchOrder;

  const untouched = toDispatchCsv([order], new Map(), {
    districtCode: 'DST-10-PURNIA',
    districtName: 'Purnia',
    indentDate: '2026-09-30',
  });
  const lines = untouched.trimEnd().split('\r\n');

  check('the file is CRLF-terminated as RFC 4180 requires', untouched.endsWith('\r\n'));
  check('one row per BATCH, not per order', lines.length === 3, String(lines.length));
  check('the header names the three quantity columns',
    lines[0].includes('qty_indented,qty_issued,qty_received,variance'), lines[0]);
  check('a name containing a comma is quoted',
    lines[1].includes('"Bhagalpur, East"'), lines[1].slice(0, 120));
  check('the batch numbers are the pick list, in order',
    lines[1].includes('B-001') && lines[2].includes('B-002'));
  check('an order nobody has acted on is "proposed"', lines[1].split(',')[2] === 'proposed');

  // Blank, not zero: "not yet issued" and "issued nothing" are different facts,
  // and a file that writes them the same way describes a supply chain in which
  // nothing is ever outstanding.
  const cols = (row: string) => row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const head = cols(lines[0]);
  const issuedAt = head.indexOf('qty_issued');
  const receivedAt = head.indexOf('qty_received');
  const varianceAt = head.indexOf('variance');
  check('issued is blank until something is issued', cols(lines[1])[issuedAt] === '');
  check('received is blank too', cols(lines[1])[receivedAt] === '');
  check('and so is the variance', cols(lines[1])[varianceAt] === '');

  // Now the same order, short-shipped and short-received.
  const acted = step(
    step(step(ticket({ orderId: 'ORD-1', plannedUnits: 168 }), 'approve', 0, 2), 'dispatch', 150, 3),
    'receive',
    120,
    4,
  );
  const after = toDispatchCsv([order], new Map([['ORD-1', acted]]), {
    districtCode: 'DST-10-PURNIA',
    districtName: 'Purnia',
    indentDate: '2026-09-30',
  });
  const rows = after.trimEnd().split('\r\n').slice(1).map(cols);

  check('the state travels with the file', rows[0][2] === 'received', rows[0][2]);

  // A short issue comes off the batches in PICK order -- earliest expiry
  // first -- so the shortfall lands on the last batch. Spreading it evenly
  // would invent fractional units and disagree with the physical shelves.
  check('the first batch is issued in full', rows[0][issuedAt] === '100', rows[0][issuedAt]);
  check('the shortfall lands on the last batch', rows[1][issuedAt] === '50', rows[1][issuedAt]);
  check('issued quantities sum to what was dispatched',
    Number(rows[0][issuedAt]) + Number(rows[1][issuedAt]) === 150);
  check('received quantities sum to what arrived',
    Number(rows[0][receivedAt]) + Number(rows[1][receivedAt]) === 120);
  check('the variance column sums to the missing 30',
    Number(rows[0][varianceAt]) + Number(rows[1][varianceAt]) === 30);

  const approvedBy = head.indexOf('approved_by');
  const receivedBy = head.indexOf('received_by');
  check('who approved it is in the file', rows[0][approvedBy] === 'test', rows[0][approvedBy]);
  check('and who received it', rows[0][receivedBy] === 'test', rows[0][receivedBy]);
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + '  ' + (checks - failures) + '/' + checks + ' checks');
process.exit(failures === 0 ? 0 : 1);
