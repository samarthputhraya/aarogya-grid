'use client';

import { useState } from 'react';
import { FOCUS_RING } from './ui/primitives';
import { count } from '@/lib/format';
import type { DispatchTicket, TicketAction } from '@/lib/dispatch/ticket';
import { useSession, signInHref } from './auth/useSession';

/**
 * Approve -> Execute -> Monitor, on the card.
 *
 * WHY THIS IS ON THE ORDER CARD AND NOT IN A SEPARATE "WORKFLOW" PANEL
 * --------------------------------------------------------------------
 * The person who approves a transfer is reading the pick list when they decide.
 * Putting the action anywhere else means the decision and the evidence for it
 * are on different parts of the screen, and the thing that gets clicked is
 * whatever is nearest the top.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * It does not hide the quantity fields behind an "advanced" disclosure, and it
 * does not default a receipt to "all of it" without letting the number be
 * changed. A short receipt is the normal case in a real supply chain; an
 * interface that makes the honest answer harder to enter than the convenient
 * one produces a dataset in which nothing ever goes missing.
 *
 * It also does not decide anything. Every refusal -- an illegal transition, a
 * quantity larger than the shelf -- comes back from the server with its reason,
 * and is shown verbatim. The client cannot know whether an approval is legal,
 * because another officer may have acted on the same ticket a second ago.
 */

interface Props {
  districtCode: string;
  orderId: string;
  plannedUnits: number;
  unit: string;
  ticket?: DispatchTicket;
  /**
   * The order's own governance, from the planner.
   *
   * Passed in rather than derived here because the strip renders before any
   * ticket exists -- and a card that only learned its own governance after the
   * first click would offer Approve on an order the server is about to refuse.
   */
  orderEscalateTo?: 'district' | 'state' | null;
  orderAdmissibilityNote?: string;
}

const STATE_STYLE: Record<string, string> = {
  proposed: 'border-ink-600 text-mist-400',
  approved: 'border-brand/40 text-brand bg-brand/10',
  dispatched: 'border-sev-moderate/40 text-sev-moderate bg-sev-moderate/10',
  received: 'border-sev-low/40 text-sev-low bg-sev-low/10',
  cancelled: 'border-ink-600 text-mist-500',
};

export default function DispatchTicketStrip({
  districtCode,
  orderId,
  plannedUnits,
  unit,
  ticket,
  orderEscalateTo,
  orderAdmissibilityNote,
}: Props) {
  const [busy, setBusy] = useState<TicketAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useSession();
  /** A 401 carries the sign-in link for this page; the error text alone would be a dead end. */
  const [signIn, setSignIn] = useState<string | null>(null);
  /**
   * The server's answer, kept until the stream catches up.
   *
   * The ticket arrives over SSE a few hundred milliseconds after the response
   * that created it. Without this the card would snap back to its previous
   * state for that moment, which reads as a failed click.
   */
  const [echo, setEcho] = useState<DispatchTicket | null>(null);

  const current =
    ticket && echo ? (ticket.seq >= echo.seq ? ticket : echo) : (ticket ?? echo ?? undefined);
  const state = current?.state ?? 'proposed';

  const [dispatchUnits, setDispatchUnits] = useState(plannedUnits);
  const [receiveUnits, setReceiveUnits] = useState<number | null>(null);
  const sent = current?.dispatchedUnits ?? plannedUnits;
  const receiving = receiveUnits ?? sent;

  async function act(action: TicketAction, units?: number) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          districtCode,
          orderId,
          action,
          ...(units === undefined ? {} : { units }),
          role: ROLE[action],
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? json.error ?? 'Request failed with ' + res.status);
        setSignIn(res.status === 401 ? (json.signIn ?? signInHref()) : null);
        return;
      }
      setSignIn(null);
      setEcho(json.ticket as DispatchTicket);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Whether a district officer may sign this one on their own.
   *
   * Read off the ticket when one exists and off the order otherwise, because
   * the strip renders before anybody has acted: a card that only learned its
   * own governance after the first click would offer Approve on an order the
   * server is about to refuse.
   */
  const escalateTo = current?.escalateTo ?? orderEscalateTo ?? null;
  const needsCountersign = escalateTo !== null;
  const countersigned = (current?.history ?? []).some((h) => h.action === 'countersign');

  const button = (
    action: TicketAction,
    label: string,
    tone: 'primary' | 'quiet',
    units?: number,
    blocked = false,
  ) => (
    <button
      title={blocked ? current?.admissibilityNote ?? orderAdmissibilityNote : undefined}
      onClick={() => act(action, units)}
      disabled={busy !== null || blocked || !session.signedIn}
      className={
        'text-[10px] px-2 py-1 rounded border transition-colors normal-case tracking-normal ' +
        'disabled:opacity-40 disabled:cursor-not-allowed ' +
        (tone === 'primary'
          ? 'border-brand/50 text-brand bg-brand/10 hover:bg-brand/20'
          : 'border-ink-600 text-mist-400 hover:text-mist-200 hover:border-ink-500') +
        ' ' +
        FOCUS_RING
      }
    >
      {busy === action ? '…' : label}
    </button>
  );

  const numberInput = (value: number, onChange: (v: number) => void, max: number, label: string) => (
    <input
      type="number"
      min={0}
      max={max}
      step={1}
      value={value}
      aria-label={label}
      disabled={busy !== null}
      onChange={(e) => onChange(Math.max(0, Math.min(max, Math.floor(Number(e.target.value)))))}
      className={
        'w-16 bg-ink-900 border border-ink-700 rounded px-1.5 py-0.5 text-[11px] text-right ' +
        'tnum text-mist-100 disabled:opacity-50 ' + FOCUS_RING
      }
    />
  );

  return (
    <div
      data-print="hide"
      className="px-3 pb-2.5 pt-1 border-t border-ink-800 flex items-center gap-2 flex-wrap"
    >
      {/* Signed out, the actions stay visible -- they are the evidence of what the
          loop does -- and disabled, with the one link that enables them. */}
      {session.loaded && !session.signedIn && state !== 'received' && state !== 'cancelled' && (
        <a href={signInHref()} className={'text-[10px] text-brand underline decoration-dotted rounded ' + FOCUS_RING}>
          sign in to act
        </a>
      )}
      <span
        className={'text-[10px] px-1.5 py-0.5 rounded border ' + (STATE_STYLE[state] ?? '')}
        title={current ? 'Updated ' + new Date(current.updatedAt).toLocaleString('en-IN') : undefined}
      >
        {state.toUpperCase()}
      </span>

      {state === 'proposed' && (
        <>
          {/*
           * An order that crosses a boundary cannot be approved by the officer
           * looking at this card, and the interface says so BEFORE they click
           * rather than after. The countersign button is the other jurisdiction
           * agreeing; until it has been pressed, Approve is disabled and the
           * reason is on the badge next to it.
           *
           * The server refuses the same thing with a 409 regardless -- this is
           * the courtesy, not the control.
           */}
          {needsCountersign && !countersigned && (
            <>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded border border-sev-moderate/40 bg-sev-moderate/10 text-sev-moderate"
                title={current?.admissibilityNote}
              >
                {escalateTo === 'state' ? 'Inter-state agreement' : 'District countersign'}
              </span>
              {button('countersign', escalateTo === 'state' ? 'Record agreement' : 'Countersign', 'quiet')}
            </>
          )}
          {needsCountersign && countersigned && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-sev-low/40 text-sev-low">
              countersigned
            </span>
          )}
          {button('approve', 'Approve', 'primary', undefined, needsCountersign && !countersigned)}
          {button('cancel', 'Cancel order', 'quiet')}
        </>
      )}

      {state === 'approved' && (
        <>
          <span className="text-[10px] text-mist-500">issue</span>
          {numberInput(dispatchUnits, setDispatchUnits, plannedUnits, 'Units to dispatch')}
          <span className="text-[10px] text-mist-500">of {count(plannedUnits)} {unit}</span>
          {button('dispatch', 'Dispatch', 'primary', dispatchUnits)}
          {button('cancel', 'Cancel', 'quiet')}
        </>
      )}

      {state === 'dispatched' && (
        <>
          <span className="text-[10px] text-mist-500">received</span>
          {numberInput(receiving, setReceiveUnits, sent, 'Units received')}
          <span className="text-[10px] text-mist-500">of {count(sent)} sent</span>
          {button('receive', 'Confirm receipt', 'primary', receiving)}
        </>
      )}

      {current && current.varianceUnits !== null && (
        <span
          className={
            'text-[10px] ' + (current.varianceUnits > 0 ? 'text-sev-high' : 'text-sev-low')
          }
          title={
            current.varianceUnits > 0
              ? 'Dispatched ' + current.dispatchedUnits + ', received ' + current.receivedUnits +
                '. The receiver was re-scored on what arrived, not on what was sent.'
              : 'Everything sent was received.'
          }
        >
          {current.varianceUnits > 0
            ? count(current.varianceUnits) + ' ' + unit + (current.varianceUnits === 1 ? '' : 's') + ' short on arrival'
            : 'received in full'}
        </span>
      )}

      {/* Only said when it matters: an action that will not survive a restart
          must not look identical to one that will. */}
      {current && (current.durability === 'failed' || current.durability === 'disabled') && (
        <span
          className="text-[10px] text-sev-high"
          title={
            current.durability === 'failed'
              ? 'The durable log did not acknowledge this action. It is held in memory only, and a restart would lose it.'
              : 'This service has no durable log configured. The action is held in memory only, and a restart would lose it.'
          }
        >
          not saved to the audit log
        </span>
      )}

      {/* What the last action actually did, straight from the server's re-score. */}
      {current?.effects.map((e) => (
        <span key={e.role + e.facilityId} className="text-[10px] text-mist-400">
          {e.role === 'donor' ? 'donor' : 'receiver'}{' '}
          {e.projected && <span className="text-mist-600">would go </span>}
          <span className="tnum">{count(e.onHandBefore)}</span> →{' '}
          <span className="tnum text-mist-200">{count(e.onHandAfter)}</span>, P(out){' '}
          <span className="tnum">{(e.stockoutBefore * 100).toFixed(0)}%</span> →{' '}
          <span className="tnum text-mist-200">{(e.stockoutAfter * 100).toFixed(0)}%</span>
        </span>
      ))}

      <span className="flex-1" />

      {current && current.history.length > 1 && (
        <span
          className="text-[10px] text-mist-600"
          title={current.history
            .map(
              (h) =>
                h.action + ' · ' + h.actor + (h.role ? ' (as ' + h.role + ')' : '') + ' · ' +
                new Date(h.at).toLocaleString('en-IN') + (h.note ? ' · ' + h.note : ''),
            )
            .join('\n')}
        >
          {current.history.length} audit entries
        </span>
      )}

      {error && (
        <span className="text-[10px] text-sev-critical basis-full leading-relaxed">
          {error}
          {signIn && (
            <>
              {' '}
              <a href={signIn} className="underline">Sign in</a>
            </>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * The role each action is taken in.
 *
 * WHO acted is not sent: the server takes it from the signed-in session. The
 * ROLE is sent, and recorded as claimed (`actor_claimed`), because there is no
 * role directory to check it against -- an audit trail that says which role
 * performed a step is still the difference between a log and a list of
 * timestamps.
 */
const ROLE: Record<TicketAction, string> = {
  // The countersign is the OTHER jurisdiction agreeing, which is the whole
  // point of the action: an order a district officer could sign alone does not
  // need one.
  countersign: 'donor district officer',
  approve: 'district officer',
  dispatch: 'donor storekeeper',
  receive: 'receiving pharmacist',
  cancel: 'district officer',
};
