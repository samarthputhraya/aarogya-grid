import type { ReactNode } from 'react';

/**
 * The shared console atoms.
 *
 * These were module-local to `NationalConsole` until the district console
 * needed the same tiles. Copying them would have been faster by about a
 * minute and wrong for the life of the project: the national and district
 * screens are pitched as one product, and the first time somebody nudged the
 * KPI value from 20px to 18px on one screen the two would have started
 * disagreeing about what a console looks like. One definition, several
 * importers, no drift.
 *
 * Deliberately NOT a client component. Nothing here holds state or takes an
 * event handler, so it can be rendered from either side of the RSC boundary --
 * the consoles are `'use client'`, but a future server-rendered panel can use
 * the same tiles without dragging a client bundle along.
 */

/**
 * One focus ring for the whole application.
 *
 * A console is operated with a keyboard by exactly the people who use it every
 * day, and until this existed nothing on either screen showed where the focus
 * was: the browser default ring is a white-ish box that reads as a rendering
 * artefact against `ink-950`. `focus-visible` rather than `focus` so a mouse
 * click on a row does not leave a ring sitting behind, which is the reason
 * most consoles end up deleting their focus styles altogether.
 */
export const FOCUS_RING =
  'focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60';

export type KpiTone = 'critical' | 'high' | 'good';

const KPI_TONE_CLASS: Record<KpiTone, string> = {
  critical: 'text-sev-critical',
  high: 'text-sev-high',
  good: 'text-brand',
};

/** Table header cell. Padding lives here so every console table aligns. */
export function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th className={'py-2 px-2 font-medium ' + className}>{children}</th>;
}

/**
 * A headline figure in a panel-sized tile: label, value, one line of context.
 *
 * The value STEPS DOWN in size as it gets longer. Six of these sit in one row
 * at 1280 px, which is ~195 px of tile, and `1,23,456 of 2,34,567` at 20 px of
 * tabular monospace is 240 px wide -- it either overflows the tile or wraps
 * into two lines of headline, and on a projector both read as a broken page.
 * Two breakpoints, chosen against the longest values the data actually
 * produces, keep every tile on one line without anyone having to remember the
 * rule at each call site.
 *
 * A value with no digit in it -- `None`, `—` -- drops the tabular monospace,
 * because a word set in a numeric face looks like a placeholder that was never
 * filled in.
 */
export function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  tone?: KpiTone;
}) {
  const size = value.length > 15 ? 'text-base' : value.length > 11 ? 'text-lg' : 'text-xl';
  const numeric = /\d/.test(value);

  return (
    <div className="panel px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-mist-400 mb-1">{label}</div>
      <div
        className={
          (numeric ? 'tnum ' : '') +
          size +
          ' font-semibold leading-tight ' +
          (tone ? KPI_TONE_CLASS[tone] : numeric ? 'text-mist-100' : 'text-mist-400')
        }
      >
        {value}
      </div>
      {sub && <div className="text-[10px] text-mist-500 mt-0.5 leading-snug">{sub}</div>}
    </div>
  );
}

/**
 * A secondary figure inside a panel body -- half the size of a `Kpi`.
 *
 * When a `hint` is supplied the label carries a dotted underline. A `title`
 * with nothing to signal it is a tooltip nobody discovers, and the hints on
 * this screen carry the arithmetic behind the figure.
 */
export function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: 'critical';
  hint?: string;
}) {
  return (
    <div title={hint} className={hint ? 'cursor-help' : undefined}>
      <div
        className={
          'text-[10px] text-mist-400 uppercase tracking-wide ' +
          (hint ? 'underline decoration-dotted decoration-ink-500 underline-offset-2' : '')
        }
      >
        {label}
      </div>
      <div className={'tnum text-sm ' + (tone === 'critical' ? 'text-sev-critical' : 'text-mist-100')}>
        {value}
      </div>
    </div>
  );
}

/**
 * What a panel says when it has nothing to show.
 *
 * A heading over blank space is indistinguishable from a panel that failed to
 * load, and on this product the difference matters more than usual: "no
 * transfer could be justified here" is a finding about the district, and a
 * reader who cannot tell it apart from a bug will assume the bug. So an empty
 * panel states the fact in the same voice as the rest of the page, and where
 * the fact has a consequence -- go and look at that other panel, this is why
 * it happened -- the `detail` line carries it.
 */
export function EmptyState({
  message,
  detail,
  tone = 'neutral',
}: {
  message: string;
  detail?: ReactNode;
  tone?: 'neutral' | 'good';
}) {
  return (
    <div className="px-4 py-6 text-center">
      <p className={'text-xs ' + (tone === 'good' ? 'text-sev-low' : 'text-mist-300')}>{message}</p>
      {detail && (
        <p className="text-[11px] text-mist-500 leading-relaxed mt-1 max-w-[64ch] mx-auto">
          {detail}
        </p>
      )}
    </div>
  );
}
