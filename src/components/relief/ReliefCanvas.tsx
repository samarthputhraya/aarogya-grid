'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import DeckGL from '@deck.gl/react';
import {
  AmbientLight,
  DirectionalLight,
  LightingEffect,
  LinearInterpolator,
  log,
} from '@deck.gl/core';
import type { MapViewState, PickingInfo } from '@deck.gl/core';
import { ArcLayer, ColumnLayer, SolidPolygonLayer } from '@deck.gl/layers';
import snapshot from '@/data/national-snapshot.json';
import type { NationalSnapshot } from '@/lib/snapshot-types';
import ReliefA11yLayer from './ReliefA11yLayer';
import { INDIA_POLYGONS } from '@/lib/relief/outline';
import {
  BEATS,
  buildField,
  fillFor,
  heightFor,
  type Beat,
  type CorridorRow,
  type DistrictRow,
} from '@/lib/relief/field';
import { INK_700, INK_500, MIST_100, recede, withAlpha } from '@/lib/relief/palette';

/**
 * The relief renderer. THE ONLY FILE IN THIS REPO THAT IMPORTS `@deck.gl/*`.
 *
 * That is a deliberate boundary, not an accident of tidiness. This module is loaded
 * through `next/dynamic({ ssr: false })` only after `probeRelief()` passes, so the
 * ~200 KB of deck.gl and luma.gl never enters the bundle of a visitor who is going to
 * be shown the SVG instead. Anything that imports from here inherits that weight, so
 * the accessibility layer and the chapter machine deliberately do not.
 *
 * `ssr: false` is also load-bearing for the container: luma.gl touches `window` at
 * module scope, and `output: 'standalone'` traces whatever the server imports into
 * `.next/standalone`. An SSR'd deck.gl would put five megabytes of graphics code into
 * a Cloud Run image whose cold start is, per `next.config.ts`, "visible in a demo".
 */

// deck and luma both log a version banner and assorted warnings at probe.gl level 1.
// Lighthouse's best-practices audit fails on browser console noise, so this is worth
// exactly one line to protect a 100.
log.level = 0;

/**
 * Metres. India is ~3,000 km across, so a full-height column is ~11% of the frame.
 *
 * Tuned by looking rather than by arithmetic: at 210,000 the skyline was present but
 * not legible -- the tallest district read as a raised dot rather than as a spike,
 * and the whole point of moving to height is that a bad district should be visible
 * without reading a legend.
 */
const COLUMN_MAX_ELEVATION = 340_000;
/** Metres. Thin enough that a tall column does not occlude the one behind it. */
const COLUMN_RADIUS = 16_500;
/**
 * Metres. Deliberately shallow.
 *
 * A thick slab turns the country into the subject of the picture. It only needs
 * enough depth to catch a highlight along its top edge and read as a surface the
 * data is standing ON.
 */
const PLINTH_ELEVATION = 16_000;

/**
 * The field is built HERE rather than passed in, and that is a payload decision.
 *
 * `/` is a server component that reads the snapshot at build time and ships none of
 * it -- the rendered HTML contains no district codes at all. Handing a prepared field
 * down as a prop to a client component would serialise all 128 districts and 244
 * corridors into the Flight payload of every visitor, including the ones who are
 * about to be shown the SVG because their machine failed the probe.
 *
 * Importing it inside this module puts it in the dynamically-imported chunk instead,
 * so it travels with deck.gl or not at all.
 */
const FIELD = buildField(snapshot as unknown as NationalSnapshot);

export interface ReliefCanvasProps {
  beat: Beat;
  /** 0..1 within the beat. Drives the corridor draw-in across beat 3. */
  t: number;
  interactive: boolean;
  selected: string | null;
  onSelect: (code: string) => void;
  onHover?: (code: string | null) => void;
  /** Camera moves are suppressed entirely when the reader asked for less motion. */
  staticCamera: boolean;
  /** Reports screen positions upward so the a11y layer can sit over the right pixels. */
  onViewStateChange?: (v: MapViewState) => void;
  /** A keyboard reader has entered the map and wants the sequence to stand down. */
  onSeize?: () => void;
  /**
   * Fired once the first frame has actually been composited.
   *
   * deck's own `onLoad` fires when the resources are ready, which is BEFORE anything
   * has been drawn -- crossfading on it shows a transparent canvas over the SVG for a
   * frame or two and reads as a flicker. So this waits one further rAF, at which
   * point there is genuinely a picture to fade to.
   */
  onReady?: () => void;
  className?: string;
}

/**
 * Framed on the claimed territory rather than on the districts.
 *
 * Fitting to the data would crop the country to the 16 states we hold data for,
 * which reads as a map of India with pieces missing -- the same reasoning the SVG
 * map records at IndiaMap.tsx:280-286. The uncovered remainder is honest information.
 */
const HOME_VIEW: MapViewState = {
  // West of the country's true centre ON PURPOSE. The canvas is full-bleed and the
  // argument is set in a column down the left, so centring the landmass would put
  // every headline directly on top of the districts it is describing. Targeting a
  // point out over the Arabian Sea slides India into the right two-thirds and leaves
  // the left third as quiet ground for type.
  longitude: 76.2,
  // Pitching the camera foreshortens the far half of the frame, so the geometric
  // centre of the country is NOT the centre of the picture -- at 46 degrees the
  // south runs off the bottom edge while empty sky accumulates above the Himalaya.
  // Sitting the target north of centre puts the landmass back in the frame.
  latitude: 22.2,
  // THE SUBJECT FILLS THE FRAME, AND RUNS OFF IT.
  //
  // At 3.78 the country sat as a small dark silhouette in the middle of a very
  // large dark rectangle, with margins on every side. That framing is what made a
  // WebGL relief read as "the same flat map as before": a subject with air all
  // around it is a picture of a thing, and a subject that bleeds past the edges is
  // the thing itself. The reference this borrows from runs its object clean off
  // both sides of the viewport for exactly this reason.
  //
  // Cropping the far north and the far south is an acceptable price. The territory
  // claim that `scripts/verify-outline.mts` protects is about what the OUTLINE
  // contains, not about what the camera happens to have in shot, and the reader can
  // orbit to the rest the moment the sequence releases.
  zoom: 5.02,
  pitch: 46,
  bearing: 0,
};

const REST_VIEW: MapViewState = { ...HOME_VIEW, zoom: 4.86, pitch: 22 };
const CLOSE_VIEW: MapViewState = { ...HOME_VIEW, zoom: 5.22, pitch: 56, bearing: -8 };

function viewForBeat(beat: Beat): MapViewState {
  switch (beat) {
    case 0:
      return REST_VIEW;
    case 1:
    case 2:
      return CLOSE_VIEW;
    case 3:
      return { ...HOME_VIEW, zoom: 4.96, pitch: 52, bearing: 6 };
    default:
      return HOME_VIEW;
  }
}

/**
 * The camera flies; it does not track the wheel, and it does not overshoot.
 *
 * Two decisions, and both of them are about smoothness rather than taste.
 *
 * FIRST: the interpolation runs inside deck's own animation loop, driven by
 * `transitionDuration`, NOT by a per-frame integrator in React. A hand-rolled
 * critically-damped spring is the textbook answer here and it is the wrong one in
 * this codebase, because advancing it means writing state every frame — which is
 * the exact pattern `ReliefAct` was just rebuilt to remove. Deck already owns a
 * frame loop; handing the flight to it costs one prop and zero React renders.
 *
 * SECOND: the easing cannot overshoot. `LinearInterpolator` moves each viewport
 * field independently along a monotonic curve, so the camera physically cannot
 * spring past its target and settle back. A viewport that bounces is the most
 * common tell of a generated page, and on an instrument it is worse than ugly — it
 * shows the reader a bearing and an altitude the plan never held.
 *
 * 900ms is long enough to read as a considered move and short enough that a reader
 * scrolling briskly is not left watching the camera catch up.
 */
const FLIGHT = new LinearInterpolator(['longitude', 'latitude', 'zoom', 'pitch', 'bearing']);
const FLIGHT_MS = 900;
const FLIGHT_EASE = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Lighting applies to the plinth ONLY.
 *
 * This is a correctness constraint rather than an aesthetic one. `globals.css`
 * records a measured contrast ratio for every colour in the ramp, and those ratios
 * assume a flat fill. Under a directional light an extruded surface has its colour
 * multiplied per face, so a column turned away from the light can sit near 0.4x its
 * swatch -- which drops the mid-ramp yellows below the 4.5:1 floor and, worse, pulls
 * adjacent ramp classes close enough to be indistinguishable. That is the
 * "encoding gone, and gone silently" failure the palette comments warn about.
 *
 * So every data-bearing surface passes `material: false` and renders its exact
 * `riskColor()` fill. Only the plinth, which carries no data, is lit.
 */
const LIGHTING = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.0 }),
  // Low and cool. At 1.35 the slab lifted to a mid-blue and became the brightest
  // thing on the page, which put the country in front of the data standing on it.
  sun: new DirectionalLight({
    color: [150, 190, 235],
    intensity: 0.5,
    direction: [-0.5, -0.85, -1.4],
  }),
});

export default function ReliefCanvas({
  beat,
  t,
  interactive,
  selected,
  onSelect,
  onHover,
  staticCamera,
  onViewStateChange,
  onReady,
  onSeize,
  className,
}: ReliefCanvasProps) {
  // The camera is DERIVED, not stored-and-synced.
  //
  // The obvious shape -- hold the view in state, push the beat's view into it from an
  // effect -- means every beat change is a render, then an effect, then a second
  // render. React 19's lint rule rejects it for exactly that reason, and it is also
  // the shape that produces a visible one-frame snap at each transition.
  //
  // Instead: `userView` is null until the reader actually grabs the map, and the
  // effective view falls back to whatever the current beat asks for. Once they seize
  // control it stays seized -- the sequence never yanks the camera back out of their
  // hands, which is the single rudest thing a scroll-driven scene can do.
  const [userView, setUserView] = useState<MapViewState | null>(null);
  const [hovered, setHovered] = useState<DistrictRow | null>(null);
  // Keyboard focus, which is a separate thing from selection: a reader arrows THROUGH
  // districts and commits to one. Conflating the two would mean every arrow keypress
  // fired the parent's onSelect and, on /console, redrew the alert table 128 times.
  const [focused, setFocused] = useState<string | null>(null);

  const cfg = BEATS[beat];

  // The one district the reader is attending to, by any route: a committed
  // selection, a keyboard cursor, or a pointer. Collapsing the three into one value
  // here is what lets a single accessor express the whole hover law -- and it means
  // a keyboard reader and a mouse reader see the identical picture, which they did
  // not when focus and hover each had their own branch.
  const marked = selected ?? focused ?? hovered?.code ?? null;

  const viewState: MapViewState =
    userView ?? (staticCamera ? HOME_VIEW : viewForBeat(beat));

  // A beat-driven view flies; a view the reader is dragging must not, or every
  // pointer move would restart a 900ms transition and the map would feel like it
  // was made of treacle. `staticCamera` is the reduced-motion path and never moves
  // at all.
  const flying = userView === null && !staticCamera;
  const deckViewState = flying
    ? {
        ...viewState,
        transitionDuration: FLIGHT_MS,
        transitionInterpolator: FLIGHT,
        transitionEasing: FLIGHT_EASE,
      }
    : viewState;

  // Reporting the camera outward IS external synchronisation, so it belongs in an
  // effect. It carries no setState of its own.
  useEffect(() => {
    onViewStateChange?.(viewState);
  }, [viewState, onViewStateChange]);

  const handleFocus = useCallback(
    (code: string | null) => {
      setFocused(code);
      if (!code) return;
      const row = FIELD.districts.find((d) => d.code === code);
      if (!row) return;
      // Pan only: zoom, pitch and bearing are left exactly as the reader had them.
      // Re-zooming on every arrow keypress makes the map lurch and is disorienting
      // for precisely the reader who most needs it to be predictable.
      setUserView((prev) => {
        const base = prev ?? (staticCamera ? HOME_VIEW : viewForBeat(beat));
        return { ...base, longitude: row.position[0], latitude: row.position[1] };
      });
    },
    [beat, staticCamera],
  );

  const handleViewState = useCallback((params: { viewState: unknown }) => {
    // deck types this generically across every view class; this deck only ever
    // mounts a MapView, so the narrowing is safe and keeps the prop signature clean.
    setUserView(params.viewState as MapViewState);
  }, []);

  const handleHover = useCallback(
    (info: PickingInfo<DistrictRow>) => {
      const row = info.object ?? null;
      setHovered(row);
      onHover?.(row?.code ?? null);
    },
    [onHover],
  );

  const layers = useMemo(() => {
    // How many corridors are visible right now. Beat 3 draws them in; the order is
    // the planner's own, never a geographic sweep -- a north-to-south wipe would be
    // a claim about how the plan was computed, and it would be untrue.
    const reveal = beat === 3 ? cfg.corridorReveal * t : cfg.corridorReveal;
    const shown = Math.round(FIELD.corridors.length * Math.min(1, Math.max(0, reveal)));
    const corridors: CorridorRow[] = shown > 0 ? FIELD.corridors.slice(0, shown) : [];

    return [
      // The country. Lit, extruded, carries no data.
      new SolidPolygonLayer({
        id: 'relief-plinth',
        data: INDIA_POLYGONS,
        extruded: true,
        filled: true,
        wireframe: false,
        getElevation: PLINTH_ELEVATION,
        // THE COUNTRY HAS TO BE VISIBLE.
        //
        // This was `INK_850` (#101a28), which sits at 1.09:1 against the page
        // ground — a ratio the ramp records for an inset card on a panel, where
        // there is a border doing the separating. There is no border here. The
        // landmass read as a barely-perceptible dark shape on a dark rectangle,
        // which is most of why a WebGL relief was indistinguishable from the flat
        // SVG it replaced: if you cannot see the country, you cannot see that the
        // country is now a lit surface with things standing on it.
        //
        // `INK_700` is the strongest fill in the ramp that still sits clearly
        // BELOW every severity colour, so the plinth reads as ground the data
        // stands on rather than as another value competing with it.
        getFillColor: INK_700,
        material: {
          ambient: 0.30,
          diffuse: 0.45,
          shininess: 12,
          specularColor: [30, 40, 54],
        },
        pickable: false,
      }),

      // A hairline along the coast so the slab has a defined edge rather than
      // dissolving into the page ground at low pitch.
      new SolidPolygonLayer({
        id: 'relief-coast',
        data: INDIA_POLYGONS,
        extruded: false,
        filled: false,
        stroked: true,
        getLineColor: INK_500,
        getLineWidth: 1400,
        lineWidthMinPixels: 0.8,
        pickable: false,
        // Sit on top of the plinth rather than inside it.
        getElevation: PLINTH_ELEVATION,
      }),

      // Districts. UNLIT -- see the LIGHTING comment.
      new ColumnLayer({
        id: 'relief-columns',
        data: FIELD.districts,
        diskResolution: 6,
        radius: COLUMN_RADIUS,
        extruded: true,
        pickable: interactive,
        material: false,
        elevationScale: COLUMN_MAX_ELEVATION,
        getPosition: (d: DistrictRow) => [d.position[0], d.position[1], PLINTH_ELEVATION],
        getElevation: (d: DistrictRow) => heightFor(d, cfg),
        // ONE HOVER LAW, AND IT IS SUBTRACTIVE. See `recede()` in palette.ts, and
        // the matching `.is-faded` rule in landing.css that governs the DOM rows —
        // the map and the page obey the same law, so they cannot disagree about
        // what "this one" looks like.
        getFillColor: (d: DistrictRow) => {
          if (d.code === marked) return MIST_100;
          const base = withAlpha(fillFor(d, cfg), cfg.columnAlpha);
          return marked ? recede(base) : base;
        },
        updateTriggers: {
          getElevation: [cfg.height],
          getFillColor: [cfg.columnAlpha, cfg.colour, marked],
        },
        transitions: staticCamera
          ? undefined
          : { getElevation: { duration: 900 }, getFillColor: { duration: 350 } },
        onHover: handleHover,
        onClick: (info: PickingInfo<DistrictRow>) => {
          if (info.object) onSelect(info.object.code);
        },
      }),

      // Corridors, above the surface. This is the whole reason for the third
      // dimension: in the flat map the arcs and the district markers fight for one
      // plane, and 244 of them crossing each other is what made it unreadable.
      new ArcLayer({
        id: 'relief-corridors',
        data: corridors,
        greatCircle: false,
        getSourcePosition: (d: CorridorRow) => [d.source[0], d.source[1], PLINTH_ELEVATION],
        getTargetPosition: (d: CorridorRow) => [d.target[0], d.target[1], PLINTH_ELEVATION],
        getSourceColor: (d: CorridorRow) => d.colour,
        getTargetColor: (d: CorridorRow) => d.colour,
        getWidth: (d: CorridorRow) => 0.9 + 2.6 * Math.sqrt(d.weight),
        getHeight: (d: CorridorRow) => 0.3 + 0.7 * d.weight,
        widthUnits: 'pixels',
        widthMinPixels: 0.7,
        pickable: false,
      }),
    ];
  }, [cfg, beat, t, marked, interactive, staticCamera, handleHover, onSelect]);

  return (
    <div className={className}>
      <DeckGL
        layers={layers}
        effects={[LIGHTING]}
        viewState={deckViewState}
        onViewStateChange={interactive ? handleViewState : undefined}
        // THE FILL-RATE BUDGET.
        //
        // An extruded-column relief is fill-rate bound, not vertex bound: 128
        // columns and 244 translucent arcs each cover a lot of pixels, and arcs
        // blend, so every one of those pixels is touched more than once. The cost
        // therefore scales with the SQUARE of the device pixel ratio, and on the
        // 1.5x displays that Windows laptops ship scaled to by default that is
        // 2.25x the work for a difference in edge quality nobody looking at a
        // national map is going to notice.
        //
        // Capping at 1.25 keeps the retina-ish crispness and refuses the tail.
        // Antialiasing is dropped entirely above 1.5, where the extra samples buy
        // least and cost most.
        useDevicePixels={
          typeof window !== 'undefined' ? Math.min(1.25, window.devicePixelRatio) : 1
        }
        // Antialiasing is a context-creation attribute, so it has to be set on the
        // device rather than per-frame. Above 1.5 DPR the extra samples are the
        // least visible and the most expensive thing on the frame.
        deviceProps={
          typeof window !== 'undefined' && window.devicePixelRatio >= 1.5
            ? { webgl: { antialias: false } }
            : undefined
        }
        onLoad={() => {
          if (onReady) requestAnimationFrame(() => requestAnimationFrame(onReady));
        }}
        controller={
          interactive
            ? { dragPan: true, dragRotate: true, scrollZoom: false, doubleClickZoom: false, touchRotate: false }
            : false
        }
        // No clear colour: the canvas paints the country, not a sky, and the page
        // ground shows through everywhere the plinth does not cover.
        getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'default')}
        style={{ position: 'absolute', inset: '0' }}
      />

      {/* The keyboard and screen-reader path. The canvas above has no accessibility
          tree at all, so this is not an enhancement -- without it the map is
          mouse-only. It also closes a gap the SVG map has always had: all 128
          district bubbles there are unreachable by keyboard too.

          Mounted ALWAYS, not only once the map is interactive. Gating it on
          `interactive` meant that during the scroll sequence -- which is most of the
          time a reader spends on this page -- there was no keyboard route into the
          map whatsoever, and the only way in was to find and press Skip first.
          Tabbing in now seizes control instead, which is what the reader meant. */}
      <ReliefA11yLayer
        rows={FIELD.districts}
        byRisk={FIELD.byRisk}
        focused={focused}
        onFocus={handleFocus}
        selected={selected}
        onSelect={onSelect}
        onSeize={onSeize}
      />
    </div>
  );
}
