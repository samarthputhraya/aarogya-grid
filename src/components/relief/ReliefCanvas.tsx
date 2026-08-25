'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { AmbientLight, DirectionalLight, LightingEffect, log } from '@deck.gl/core';
import type { MapViewState, PickingInfo } from '@deck.gl/core';
import { ArcLayer, ColumnLayer, SolidPolygonLayer } from '@deck.gl/layers';
import snapshot from '@/data/national-snapshot.json';
import type { NationalSnapshot } from '@/lib/snapshot-types';
import { INDIA_POLYGONS } from '@/lib/relief/outline';
import { BEATS, buildField, heightFor, type Beat, type CorridorRow, type DistrictRow } from '@/lib/relief/field';
import { INK_850, INK_600, MIST_100, withAlpha } from '@/lib/relief/palette';

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
  longitude: 82.2,
  // Pitching the camera foreshortens the far half of the frame, so the geometric
  // centre of the country is NOT the centre of the picture -- at 46 degrees the
  // south runs off the bottom edge while empty sky accumulates above the Himalaya.
  // Sitting the target north of centre puts the landmass back in the frame.
  latitude: 23.4,
  zoom: 3.78,
  pitch: 46,
  bearing: 0,
};

const REST_VIEW: MapViewState = { ...HOME_VIEW, zoom: 3.66, pitch: 20 };
const CLOSE_VIEW: MapViewState = { ...HOME_VIEW, zoom: 4.0, pitch: 55, bearing: -8 };

function viewForBeat(beat: Beat): MapViewState {
  switch (beat) {
    case 0:
      return REST_VIEW;
    case 1:
    case 2:
      return CLOSE_VIEW;
    case 3:
      return { ...HOME_VIEW, pitch: 52, bearing: 6 };
    default:
      return HOME_VIEW;
  }
}

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

  const cfg = BEATS[beat];
  const viewState: MapViewState =
    userView ?? (staticCamera ? HOME_VIEW : viewForBeat(beat));

  // Reporting the camera outward IS external synchronisation, so it belongs in an
  // effect. It carries no setState of its own.
  useEffect(() => {
    onViewStateChange?.(viewState);
  }, [viewState, onViewStateChange]);

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
        getFillColor: INK_850,
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
        getLineColor: INK_600,
        getLineWidth: 1400,
        lineWidthMinPixels: 0.6,
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
        getFillColor: (d: DistrictRow) =>
          d.code === selected
            ? MIST_100
            : withAlpha(d.fill, d.code === hovered?.code ? 255 : cfg.columnAlpha),
        updateTriggers: {
          getElevation: [cfg.height],
          getFillColor: [cfg.columnAlpha, selected, hovered?.code],
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
  }, [cfg, beat, t, selected, hovered, interactive, staticCamera, handleHover, onSelect]);

  return (
    <div className={className}>
      <DeckGL
        layers={layers}
        effects={[LIGHTING]}
        viewState={viewState}
        onViewStateChange={interactive ? handleViewState : undefined}
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
    </div>
  );
}
