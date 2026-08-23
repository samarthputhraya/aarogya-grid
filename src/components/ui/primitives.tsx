import type { ReactNode } from 'react';

/**
 * The three shared console atoms.
 *
 * These were module-local to `NationalConsole` until the district console
 * needed the same tiles. Copying them would have been faster by about a
 * minute and wrong for the life of the project: the national and district
 * screens are pitched as one product, and the first time somebody nudged the
 * KPI value from 20px to 18px on one screen the two would have started
 * disagreeing about what a console looks like. One definition, two importers,
 * no drift.
 *
 * Deliberately NOT a client component. Nothing here holds state or takes an
 * event handler, so it can be rendered from either side of the RSC boundary --
 * the consoles are `'use client'`, but a future server-rendered panel can use
 * the same tiles without dragging a client bundle along.
 */

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

/** A headline figure in a panel-sized tile: label, value, one line of context. */
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
  return (
    <div className="panel px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-mist-400 mb-1">{label}</div>
      <div
        className={
          'tnum text-xl font-semibold leading-tight ' +
          (tone ? KPI_TONE_CLASS[tone] : 'text-mist-100')
        }
      >
        {value}
      </div>
      {sub && <div className="text-[10px] text-mist-500 mt-0.5">{sub}</div>}
    </div>
  );
}

/** A secondary figure inside a panel body -- half the size of a `Kpi`. */
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
    <div title={hint}>
      <div className="text-[10px] text-mist-400 uppercase tracking-wide">{label}</div>
      <div className={'tnum text-sm ' + (tone === 'critical' ? 'text-sev-critical' : 'text-mist-100')}>
        {value}
      </div>
    </div>
  );
}
