/**
 * The pacing of the act, in one auditable table.
 *
 * Everything about how the five-beat sequence is timed lives here rather than
 * scattered through the component, so retuning the whole act means editing five
 * numbers and reading one comment — not hunting for magic constants inside a rAF.
 *
 * Pure and framework-free: no React import, so `scripts/` can assert against it.
 */

/**
 * How much of the act's scroll each beat gets.
 *
 * NOT equal fifths, deliberately. Beat 3 — the cross-district lift — is the claim
 * this entire page exists to make: 900 trips crossing a district boundary, 244
 * corridors, 79 of them crossing a state line. It gets the most scroll per unit of
 * camera travel because it is the thing a reader is most likely to disbelieve, and
 * the answer to disbelief is time on screen.
 *
 * Beat 0 is short because it is a held breath, not an argument.
 *
 * Must sum to 1. `normalise()` enforces it rather than trusting the arithmetic in
 * this comment to survive the next edit.
 */
export const BEAT_SPANS = [0.14, 0.2, 0.2, 0.28, 0.18] as const;

/**
 * The fraction of each beat's span spent HOLDING its composed state, before the
 * transition to the next one begins.
 *
 * This is the difference between an act and a scrub. A scrubbed sequence leaves the
 * reader permanently between two states: the camera tracks the wheel, so nothing is
 * ever composed, and a fast flick blows through all five without any of them ever
 * being a picture. That reads as drift, and drift is what "vibe coded" means when
 * someone is describing motion.
 *
 * At 0.7 each beat is a plateau for roughly two thirds of its travel and moves
 * decisively across the last third, so the copy for beat 3 is on screen while the
 * camera is actually AT beat 3.
 */
export const DWELL = 0.7;

/**
 * A dead zone at the top of the act where progress stays pinned at 0.
 *
 * The reader arrives here carrying the momentum of the scroll that delivered them.
 * Without a quarantine that inertia tail is spent immediately on beat 0, so the
 * first caption is consumed before it can be read and the act appears to lurch as
 * it opens. Sites that lock scroll solve this by swallowing input for ~800ms; that
 * is a keyboard trap and an accessibility failure, and this project already ships a
 * keyboard route into the map that a lock would break.
 *
 * A dead zone is the lock-free equivalent: native scrolling is never intercepted,
 * the scrollbar keeps its real meaning, and the reader can always leave — the act
 * simply does not start until they have actually committed to it.
 */
export const ENTRY_QUARANTINE = 0.06;

export interface ActPosition {
  /** 0..4 */
  beat: number;
  /** 0..1 within the beat, already shaped by the dwell. */
  t: number;
  /** 0..1 across the whole act, after the quarantine. */
  p: number;
}

function normalise(spans: readonly number[]): number[] {
  const total = spans.reduce((a, b) => a + b, 0);
  return spans.map((s) => s / total);
}

const SPANS = normalise(BEAT_SPANS);

/** Cumulative start offset of each beat, plus a trailing 1. */
const EDGES = SPANS.reduce<number[]>(
  (acc, s) => [...acc, acc[acc.length - 1] + s],
  [0],
);

/**
 * Raw scroll progress through the act element → a composed beat and a shaped `t`.
 *
 * The shaping is the whole point. Inside a beat, `t` sits at 0 for the first
 * `DWELL` of the span and then runs 0→1 over the remainder, so the value handed to
 * the camera is a plateau-and-step rather than a ramp.
 */
export function actPosition(raw: number): ActPosition {
  const clamped = Math.min(1, Math.max(0, raw));

  // Spend the quarantine first, then rescale what is left back onto 0..1 so the
  // five beats still divide the full remaining travel.
  const p =
    clamped <= ENTRY_QUARANTINE
      ? 0
      : (clamped - ENTRY_QUARANTINE) / (1 - ENTRY_QUARANTINE);

  const last = SPANS.length - 1;
  let beat = last;
  for (let i = 0; i < SPANS.length; i += 1) {
    if (p < EDGES[i + 1]) {
      beat = i;
      break;
    }
  }

  const within = SPANS[beat] > 0 ? (p - EDGES[beat]) / SPANS[beat] : 1;
  // Hold, then move.
  const t = within <= DWELL ? 0 : Math.min(1, (within - DWELL) / (1 - DWELL));

  return { beat, t, p };
}

/** Scroll offset, as a fraction of the act, that composes beat `i`. */
export function anchorFor(beat: number): number {
  const i = Math.min(SPANS.length - 1, Math.max(0, beat));
  // Land in the middle of the plateau, not on its leading edge, so a keyboard jump
  // arrives at the composed picture rather than at the moment it starts moving.
  const mid = EDGES[i] + SPANS[i] * DWELL * 0.5;
  return ENTRY_QUARANTINE + mid * (1 - ENTRY_QUARANTINE);
}

export const BEAT_COUNT = SPANS.length;

/**
 * The gauge axis.
 *
 * The readout is NOT a scroll percentage. It descends a real quantity — the
 * granularity at which the plan is being read — from every dispatch order in the
 * country down to a single corridor. Because the drop from 6,851 to 1 is enormous
 * and the last two stops are close together, the tab crowds at the bottom of its
 * travel, and that crowding states the information architecture without a legend:
 * most of the scroll is spent reaching the national picture, and then it resolves
 * hard onto one route.
 *
 * Every figure here is read from the shipped snapshot by `lib/landing-figures.ts`
 * and passed in — none is typed into this file. See the note in that module about
 * never publishing a number that was not derived from a shipped payload.
 */
export interface GaugeStop {
  /** Shown on the tab. */
  value: string;
  /** Announced to a screen reader. */
  label: string;
}
