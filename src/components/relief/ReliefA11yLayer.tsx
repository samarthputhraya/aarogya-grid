'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DistrictRow } from '@/lib/relief/field';
import { count } from '@/lib/format';

/**
 * The keyboard and screen-reader path to a canvas.
 *
 * A `<canvas>` has no accessibility tree. Nothing inside it can be focused, labelled
 * or announced, so a WebGL map is, on its own, completely unusable without a mouse.
 * `role="img"` plus a long description would only *describe* it; the map has to be
 * *operable*, because selecting a district is what the control is for.
 *
 * So the accessible product is this: a real DOM listbox that happens to drive a
 * camera. The canvas is `aria-hidden`; this is what assistive technology sees, and it
 * is also what a sighted keyboard user drives.
 *
 * ONE TAB STOP FOR 128 DISTRICTS. A listbox with a roving `aria-activedescendant`
 * puts exactly one stop in the tab order. The alternative -- `tabIndex={0}` per
 * district, which is what TransferMap does for its ~15 dispatch arcs -- is correct at
 * fifteen and hostile at a hundred and twenty-eight: a reader trying to get past the
 * map to the copy below it would press Tab 128 times.
 *
 * NOTE ON THE LIVE REGION: it is a SIBLING of the listbox, never a child. axe flags
 * `aria-required-children` the moment a listbox contains anything that is not an
 * option, and that single mistake is the difference between 100 and 92.
 *
 * This component must not import `@deck.gl/*`. It is rendered from inside the
 * dynamically-imported canvas module and receives its rows as props, so it costs
 * nothing to a visitor who was never promoted.
 */

export interface ReliefA11yLayerProps {
  rows: DistrictRow[];
  /** Worst-first. Up/Down walk this, so the map agrees with the console's ranking. */
  byRisk: DistrictRow[];
  focused: string | null;
  onFocus: (code: string | null) => void;
  selected: string | null;
  onSelect: (code: string) => void;
  /**
   * Fired the moment a keyboard reader enters the map.
   *
   * Tabbing in IS a request for control. Without this the sequence keeps driving the
   * camera while the reader tries to steer it, which is worse than either behaviour
   * on its own.
   */
  onSeize?: () => void;
}

export default function ReliefA11yLayer({
  rows,
  byRisk,
  focused,
  onFocus,
  selected,
  onSelect,
  onSeize,
}: ReliefA11yLayerProps) {
  const [announcement, setAnnouncement] = useState('');
  const typeahead = useRef({ buffer: '', at: 0 });

  // Two orders, because a map needs two axes. Up/Down is semantic -- worst first,
  // matching the console's "Highest-risk districts" panel so the two never disagree.
  // Left/Right is spatial. A plain list can only offer the first, and a reader asking
  // "what is next to this" is asking the second.
  const byLongitude = useMemo(
    () => [...rows].sort((a, b) => a.position[0] - b.position[0]),
    [rows],
  );

  const describe = useCallback(
    (row: DistrictRow, index: number, total: number) =>
      `${row.name}, ${row.stateName}. ` +
      `Mean risk ${row.riskScore.toFixed(1)}. ` +
      `${count(row.criticalPositions)} critical positions. ` +
      `${row.crossDistrictTrips === 0 ? 'Sends nothing across its own boundary' : `On ${count(row.crossDistrictTrips)} cross-district trips`}. ` +
      `${index + 1} of ${total}.`,
    [],
  );

  const move = useCallback(
    (list: DistrictRow[], delta: number) => {
      const current = focused ? list.findIndex((d) => d.code === focused) : -1;
      // From nowhere, a forward key lands on the first item and a backward key on the
      // last -- so both directions enter the list rather than one of them doing
      // nothing, which is the usual bug.
      const next =
        current === -1
          ? delta > 0
            ? 0
            : list.length - 1
          : Math.min(list.length - 1, Math.max(0, current + delta));
      onFocus(list[next].code);
    },
    [focused, onFocus],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLUListElement>) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          move(byRisk, 1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          move(byRisk, -1);
          return;
        case 'ArrowRight':
          e.preventDefault();
          move(byLongitude, 1);
          return;
        case 'ArrowLeft':
          e.preventDefault();
          move(byLongitude, -1);
          return;
        case 'Home':
          e.preventDefault();
          onFocus(byRisk[0]?.code ?? null);
          return;
        case 'End':
          e.preventDefault();
          onFocus(byRisk[byRisk.length - 1]?.code ?? null);
          return;
        case 'Enter':
        case ' ':
          // Space is prevented for the reason TransferMap records: on a control
          // inside a scrollable page it otherwise pages the document down underneath
          // the reader, who was trying to pick a district.
          e.preventDefault();
          if (focused) {
            onSelect(focused);
            const row = rows.find((d) => d.code === focused);
            if (row) {
              setAnnouncement(
                selected === focused
                  ? `Cleared ${row.name}.`
                  : `Selected ${row.name}, ${row.stateName}.`,
              );
            }
          }
          return;
        case 'Escape':
          if (selected) {
            e.preventDefault();
            onSelect(selected); // the handler toggles
            setAnnouncement('Selection cleared.');
          }
          return;
        default:
          break;
      }

      // Typeahead. At 128 items this stops being a nicety -- arrowing from Agra to
      // Vijayapura is 80-odd keypresses.
      if (e.key.length === 1 && /\S/.test(e.key)) {
        const now = e.timeStamp;
        const t = typeahead.current;
        t.buffer = now - t.at > 800 ? e.key : t.buffer + e.key;
        t.at = now;
        const q = t.buffer.toLowerCase();
        const hit = byRisk.find((d) => d.name.toLowerCase().startsWith(q));
        if (hit) {
          e.preventDefault();
          onFocus(hit.code);
        }
      }
    },
    [byRisk, byLongitude, focused, selected, move, onFocus, onSelect, rows],
  );

  const focusedRow = focused ? rows.find((d) => d.code === focused) : null;

  // Clear the live region a beat after it speaks, timed from when the message was
  // SET rather than from when focus last moved.
  //
  // The first version keyed this off `focusedRow`, which meant a pending clear from
  // the previous arrow keypress wiped the "Selected Vijayapura" message ~250ms after
  // it appeared -- the commit was silent for exactly the reader who cannot see the
  // column light up. Caught by asserting on the live region's text after pressing
  // Enter, not by reading the code.
  //
  // Movement itself is deliberately NOT announced here: `aria-activedescendant`
  // already moves the virtual cursor onto the option and screen readers read it, so
  // adding a live message would make every arrow keypress speak twice.
  useEffect(() => {
    if (!announcement) return;
    const id = window.setTimeout(() => setAnnouncement(''), 1400);
    return () => window.clearTimeout(id);
  }, [announcement]);

  const focusedIndex = focusedRow ? byRisk.indexOf(focusedRow) : -1;

  return (
    <>
      {/* The control. Visually hidden: the visible feedback is the column lighting up
          on the map, which is better placed than any overlay could be. */}
      <ul
        className="sr-only"
        role="listbox"
        tabIndex={0}
        aria-label={`${rows.length} districts, ordered worst risk first. Arrow up and down to move by rank, left and right to move west and east, Enter to select.`}
        aria-activedescendant={focused ? `relief-opt-${focused}` : undefined}
        onKeyDown={onKeyDown}
        onFocus={() => {
          onSeize?.();
          if (!focused && byRisk[0]) onFocus(byRisk[0].code);
        }}
      >
        {byRisk.map((row, i) => (
          <li
            key={row.code}
            id={`relief-opt-${row.code}`}
            role="option"
            aria-selected={row.code === selected}
          >
            {describe(row, i, byRisk.length)}
          </li>
        ))}
      </ul>

      {/* Sibling, never a child of the listbox. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>

      {/* A visible readout, so a sighted keyboard user can see what they are on
          without hunting for the highlighted column. Pointer-events off: this is a
          caption, and the map underneath stays grabbable through it. */}
      {focusedRow ? (
        <div
          className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-lg border border-ink-700 bg-ink-950/85 px-3 py-2 backdrop-blur-sm"
          aria-hidden="true"
        >
          <p className="text-[12px] font-medium text-mist-100">
            {focusedRow.name}
            <span className="ml-2 text-[11px] font-normal text-mist-500">
              {focusedRow.stateName}
            </span>
          </p>
          <p className="mt-1 text-[11px] text-mist-400">
            <span className="tnum text-mist-200">{focusedRow.riskScore.toFixed(1)}</span>{' '}
            mean risk ·{' '}
            <span className="tnum text-mist-200">
              {count(focusedRow.criticalPositions)}
            </span>{' '}
            critical ·{' '}
            <span className="tnum text-mist-200">
              {count(focusedRow.crossDistrictTrips)}
            </span>{' '}
            cross-district trips
          </p>
          <p className="mt-1 text-[10px] text-mist-500">
            {focusedIndex + 1} of {byRisk.length} by risk
          </p>
        </div>
      ) : null}
    </>
  );
}
