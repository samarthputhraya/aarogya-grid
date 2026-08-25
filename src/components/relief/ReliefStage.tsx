'use client';

import { useCallback, useState, type ReactNode } from 'react';
import ReliefUpgrade from './ReliefUpgrade';
import type { Beat } from '@/lib/relief/field';

/**
 * The box both renderers live in.
 *
 * THE STAGE OWNS THE ASPECT RATIO, NOT THE CHILDREN. That is what makes the swap
 * free of layout shift: the SVG can be taken out of the visual flow without the
 * container collapsing, because the height was never coming from the SVG in the
 * first place. Cumulative layout shift here is structurally zero rather than
 * empirically zero.
 *
 * The SVG is hidden with `visibility`, never unmounted:
 *   - it is the print target, and a canvas prints as a blank or a bad raster while
 *     the SVG prints as vectors that globals.css already inverts correctly;
 *   - it is where the canvas falls back to if the GL context is lost mid-session;
 *   - removing 244 paths from the DOM is a layout and a paint on the main thread at
 *     exactly the moment the GPU is busy.
 *
 * It does gain `aria-hidden` once promoted, or its `role="img"` label would be
 * announced alongside the interactive layer describing the same thing.
 */
export interface ReliefStageProps {
  /** The server-rendered SVG map. Always painted; hidden once WebGL takes over. */
  children: ReactNode;
  /** `width / height` of the SVG, so the box reserves the right space up front. */
  ratio: string;
  beat?: Beat;
  t?: number;
  interactive?: boolean;
  /** The console earns the upgrade at a smaller viewport than the landing page. */
  minWidth?: number;
  selected?: string | null;
  onSelect?: (code: string) => void;
  onHover?: (code: string | null) => void;
  className?: string;
}

export default function ReliefStage({
  children,
  ratio,
  beat = 4,
  t = 1,
  interactive = true,
  minWidth = 1024,
  selected = null,
  onSelect,
  onHover,
  className,
}: ReliefStageProps) {
  const [promoted, setPromoted] = useState(false);

  // Uncontrolled fallback so the stage is usable on the landing page, where there is
  // no parent holding a selection. On /console the parent passes both and stays the
  // owner, exactly as it does for the SVG map today.
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  const activeSelection = onSelect ? selected : ownSelected;

  const handleSelect = useCallback(
    (code: string) => {
      if (onSelect) onSelect(code);
      else setOwnSelected((prev) => (prev === code ? null : code));
    },
    [onSelect],
  );

  return (
    <div
      className={`relative ${className ?? ''}`}
      style={{ aspectRatio: ratio }}
      data-relief-stage=""
      data-relief-promoted={promoted ? 'true' : 'false'}
    >
      <div
        className="absolute inset-0"
        aria-hidden={promoted || undefined}
        style={
          promoted
            ? { visibility: 'hidden', contentVisibility: 'hidden' }
            : undefined
        }
        data-relief-svg=""
      >
        {children}
      </div>

      <ReliefUpgrade
        beat={beat}
        t={t}
        interactive={interactive}
        minWidth={minWidth}
        selected={activeSelection}
        onSelect={handleSelect}
        onHover={onHover}
        onPromoted={setPromoted}
      />
    </div>
  );
}
