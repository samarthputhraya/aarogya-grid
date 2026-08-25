'use client';

import { useId, useMemo, useState } from 'react';
import { geoDistance, geoGraticule, geoMercator, geoPath } from 'd3-geo';
import type { Feature, MultiPolygon } from 'geojson';
import outlineRaw from '@/data/india-outline.json';
import { riskColor, count, inr, compactCount } from '@/lib/format';

/**
 * The national outline, and the one boundary claim this map makes.
 *
 * Sourced from datameet/maps `Country/india-composite.geojson` -- a COMPOSITE,
 * meaning the full territory India claims -- and simplified by
 * `scripts/simplify-outline.mts` from 10.3 MB to 34 KB.
 *
 * This matters beyond cartography. In India the depiction of national
 * boundaries is governed rather than a matter of preference, and the ordinary
 * international files (Natural Earth, GADM) terminate Jammu and Kashmir at the
 * Line of Control. Verified on the source before adopting it: the outline
 * reaches 37.10 N, which is Gilgit-Baltistan and Aksai Chin, and 97.40 E, which
 * is the whole of Arunachal Pradesh.
 *
 * Only the national outline ships. No internal state boundaries are drawn --
 * they would introduce a second class of boundary claim for no analytical gain,
 * since districts are plotted from their own coordinates and labelled by state.
 */
const OUTLINE = outlineRaw as unknown as Feature<MultiPolygon>;

/**
 * National district plot.
 *
 * WHY THERE ARE NO STATE BOUNDARIES HERE
 * --------------------------------------
 * This used to render a state polygon layer shaded by population-weighted risk.
 * That layer has been removed deliberately, and it should not be added back
 * without a properly sourced boundary file.
 *
 * The polygons we had were pre-2011 vintage: no Telangana (formed 2014, so its
 * districts plotted on top of Andhra Pradesh), and states still labelled
 * "Orissa" and "Uttaranchal". Depicting India's internal and external
 * boundaries is not a decorative decision -- an incorrect depiction is a
 * serious problem in any government-facing context, and a wrong boundary is
 * worse than no boundary.
 *
 * It also bought us very little. State mean risk spans 11.2 to 19.6 across the
 * whole country, rendered at 0.16 fill opacity, so the layer was visually an
 * undifferentiated wash. Every question it was supposed to answer is answered
 * better by the district bubbles, which carry real coordinates.
 *
 * The projection is therefore fitted to the districts themselves rather than to
 * a polygon extent.
 *
 * WHAT STANDS IN FOR THE MISSING GROUND
 * -------------------------------------
 * Without polygons the sheet needs some other way to read as a map rather than
 * as a scatter plot, and the only honest material available is the coordinate
 * system itself plus the data on the points. So:
 *
 *   - a 1-degree graticule with 5-degree emphasis, drawn from d3-geo's
 *     geoGraticule. A graticule is a statement about latitude and longitude and
 *     asserts nothing whatsoever about any border;
 *   - the Tropic of Cancer, which is a real geodetic line that genuinely
 *     crosses this country and gives the eye one horizontal anchor;
 *   - a neatline with degree ticks in the gutters, so the plot has a sheet
 *     edge instead of bleeding into the panel;
 *   - a marginalia strip below the neatline carrying the two keys the map
 *     previously lacked and a scale bar computed from the live projection.
 *
 * Deliberately NOT added: a convex hull or density field over the points. Both
 * would have produced a filled shape close enough to the outline of India to be
 * read as one, and it would have been the wrong outline -- it would swallow
 * parts of neighbouring countries and lop off the north-east. That is the exact
 * failure mode the paragraphs above exist to prevent.
 */

export interface MapDistrict {
  code: string;
  name: string;
  stateName: string;
  lat: number;
  lon: number;
  meanRiskScore: number;
  criticalPositions: number;
  facilities: number;
  projectedWasteInr: number;
  zeroStockShare: number;
  population: number;
}

export type MapMetric = 'risk' | 'critical' | 'waste' | 'zero';

const METRIC_LABEL: Record<MapMetric, string> = {
  risk: 'Mean risk score',
  critical: 'Critical positions',
  waste: 'Stock heading to expiry',
  zero: 'Positions at zero stock',
};

/**
 * The class breaks and colours of `riskColor` in src/lib/format.ts, restated so
 * the legend can put numbers against the swatches. These MUST track that
 * function; the fills below still come from `riskColor` itself so the map can
 * never disagree with itself, and this table is used only for labelling and for
 * bucketing the class histogram.
 */
const RAMP_BREAKS = [6, 11, 16, 22, 30];
const RAMP_COLORS = ['#34d399', '#a3d977', '#ffd23f', '#ff9838', '#ff7a45', '#ff4d5e'];
/** Non-risk metrics are rescaled into this band before being handed to the ramp. */
const RAMP_TOP = 38;

/** The Tropic of Cancer, 23 deg 26 min N. */
const TROPIC_LAT = 23.4368;

// ---------------------------------------------------------------------------
// Sheet geometry. The neatline encloses the map body; everything below it is
// marginalia, and the projection is fitted so that no district can ever be
// drawn into that strip regardless of what the data does.
// ---------------------------------------------------------------------------
const WIDTH = 720;
const HEIGHT = 744;
const FRAME = { x0: 54, y0: 40, x1: 676, y1: 604 };
/** Keeps the largest bubble, and its stroke, clear of the neatline. */
const BUBBLE_PAD = 18;

const AXIS_LABEL_Y = FRAME.y1 + 15;
const RULE_Y = 634;
const KEY_TITLE_Y = 648;
const HIST_BASE_Y = 682;
const HIST_MAX_H = 20;
const BAR_Y = 684;
const BAR_H = 10;
const KEY_LABEL_Y = 708;
const NOTE_Y = 728;

const SWATCH_W = 30;
const RAMP_X = FRAME.x0;
const RAMP_W = SWATCH_W * RAMP_COLORS.length;
const SIZE_KEY_X = FRAME.x0 + 290;

function metricValue(d: MapDistrict, metric: MapMetric): number {
  switch (metric) {
    case 'risk':
      return d.meanRiskScore;
    case 'critical':
      return d.criticalPositions;
    case 'waste':
      return d.projectedWasteInr;
    case 'zero':
      return d.zeroStockShare * 100;
  }
}

function metricDisplay(d: MapDistrict, metric: MapMetric): string {
  return formatMetric(metricValue(d, metric), metric);
}

/** Formats a raw metric value -- used for both the hover card and the legend. */
function formatMetric(v: number, metric: MapMetric): string {
  switch (metric) {
    case 'risk':
      return Number.isInteger(v) ? String(v) : v.toFixed(1);
    case 'critical':
      return count(v);
    case 'waste':
      return inr(v);
    case 'zero':
      return v.toFixed(1) + '%';
  }
}

/** Which of the six ramp classes a ramp-scale value falls in. */
function rampIndex(scaled: number): number {
  for (let i = 0; i < RAMP_BREAKS.length; i++) {
    if (scaled < RAMP_BREAKS[i]) return i;
  }
  return RAMP_BREAKS.length;
}

/** Rough advance width for the uppercase tracked labels used on the sheet. */
function labelWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.7;
}

function degLabel(value: number, pos: string, neg: string): string {
  return `${Math.abs(Math.round(value))}°${value < 0 ? neg : pos}`;
}

/**
 * Round a projected coordinate to 1/100 of a user unit.
 *
 * EVERY number that reaches an SVG attribute from the projection goes through
 * this, and it is a correctness fix rather than tidiness. A Mercator projection
 * is `log(tan(...))`, and `Math.log` / `Math.tan` are permitted to differ in
 * their last one or two digits between implementations -- which Node and the
 * browser's V8 are. The server rendered a degree tick at `y1="99.19720870681431"`
 * and the client computed `99.1972087068142`; React called that a hydration
 * mismatch, warned in the console of the national console's own front page, and
 * threw away the server's attributes for that subtree.
 *
 * Two decimals is far below a pixel on a 720-unit viewBox, so nothing moves --
 * both sides simply round to the same string well above the digit where they
 * disagree.
 */
function snap(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

/**
 * One district-to-district movement, as much of `CrossDistrictLink` as a map
 * needs. Structurally assignable from that type, so the console passes the
 * snapshot rows straight through.
 */
export interface MapFlow {
  fromDistrictName: string;
  toDistrictName: string;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  trips: number;
  orders: number;
  units: number;
  crossState: boolean;
}

/**
 * Flow strokes.
 *
 * One hue for every arc, and the state crossing encoded as a DASH rather than
 * as a second colour. The palette in globals.css reserves saturated colour for
 * the severity ramp and says so; a violet introduced here for "crosses a state"
 * would be the only hue on the sheet that does not mean severity, sitting on
 * top of bubbles that do. A dash is the same channel `TransferMap` already uses
 * for cold chain, reads at 1 px, and survives the projector this palette was
 * tuned for.
 */
const FLOW_COLOR = 'var(--color-brand)';
const CROSS_STATE_DASH = '4 2.5';

/**
 * A shallow arc from `a` to `b`, bowed consistently to the left of travel.
 *
 * These flows are short -- a median of 99 km between district centres, against
 * a sheet where the whole country is 620 px wide -- so the bow is what stops a
 * pair that supplies in both directions from drawing two identical lines on top
 * of each other. It is deliberately shallower than the district map's 0.22:
 * at national zoom a deep bow on a 20 px chord reads as a loop.
 */
function flowArc(a: [number, number], b: [number, number]): string {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const bow = 0.14;
  const cx = (x1 + x2) / 2 - (dy / len) * len * bow;
  const cy = (y1 + y2) / 2 + (dx / len) * len * bow;
  return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

export default function IndiaMap({
  districts,
  metric = 'risk',
  onSelectDistrict,
  selectedDistrict,
  flows = [],
  showFlows = false,
}: {
  districts: MapDistrict[];
  metric?: MapMetric;
  onSelectDistrict?: (code: string) => void;
  selectedDistrict?: string | null;
  /** District-to-district movements to overlay. See `MapFlow`. */
  flows?: MapFlow[];
  showFlows?: boolean;
}) {
  const [hover, setHover] = useState<MapDistrict | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  // Fit to the national outline rather than to the districts.
  //
  // Fitting to the data would crop the country to the 16 states we hold data
  // for, which reads as a map of India with pieces missing. Fitting to the
  // outline shows the whole country and lets the covered districts light up
  // inside it -- the uncovered remainder is then honest information rather than
  // an absence the frame conceals.
  const projection = useMemo(
    () =>
      geoMercator().fitExtent(
        [
          [FRAME.x0 + BUBBLE_PAD, FRAME.y0 + BUBBLE_PAD],
          [FRAME.x1 - BUBBLE_PAD, FRAME.y1 - BUBBLE_PAD],
        ],
        OUTLINE,
      ),
    [],
  );

  /** The landmass path, recomputed only when the projection changes. */
  const landPath = useMemo(() => geoPath(projection)(OUTLINE) ?? '', [projection]);

  /**
   * Projected point, ROUNDED to 1/100 of a user unit.
   *
   * The rounding is not cosmetic. A Mercator projection is `log(tan(...))`, and
   * `Math.log`/`Math.tan` are permitted to differ in their last couple of digits
   * between implementations -- which is exactly what Node and the browser's V8
   * are. The server rendered a bubble at `cy="99.8546973456614"`, the client
   * computed `99.85469734566186`, and React reported a hydration mismatch on the
   * national map and discarded the server's attributes for that subtree.
   *
   * Two decimals is far below a pixel on a 720-unit viewBox that is displayed at
   * most a little over 700 px wide, so nothing moves; both sides now agree
   * because both round to the same string long before the digits where they
   * disagree. The arc and label geometry derives from this, so it is fixed at
   * the one place the divergence enters.
   */
  const project = useMemo(
    () =>
      (lon: number, lat: number): [number, number] => {
        const p = projection([lon, lat]);
        if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return [0, 0];
        return [snap(p[0]), snap(p[1])];
      },
    [projection],
  );

  // The graticule is generated for whatever the neatline actually encloses, so
  // it fills the sheet edge to edge rather than only the data's bounding box.
  const grid = useMemo(() => {
    const path = geoPath(projection);
    const [lonMin, latMax] = projection.invert?.([FRAME.x0, FRAME.y0]) ?? [68, 30];
    const [lonMax, latMin] = projection.invert?.([FRAME.x1, FRAME.y1]) ?? [98, 6];

    const extent: [[number, number], [number, number]] = [
      [Math.floor(lonMin), Math.floor(latMin)],
      [Math.ceil(lonMax), Math.ceil(latMax)],
    ];

    const minor = path(geoGraticule().extent(extent).step([1, 1])()) ?? '';
    const major = path(geoGraticule().extent(extent).step([5, 5])()) ?? '';

    const meridians: { lon: number; x: number }[] = [];
    for (let lon = Math.ceil(lonMin / 5) * 5; lon <= lonMax; lon += 5) {
      meridians.push({ lon, x: snap((projection([lon, (latMin + latMax) / 2]) ?? [0, 0])[0]) });
    }
    const parallels: { lat: number; y: number }[] = [];
    for (let lat = Math.ceil(latMin / 5) * 5; lat <= latMax; lat += 5) {
      parallels.push({ lat, y: snap((projection([(lonMin + lonMax) / 2, lat]) ?? [0, 0])[1]) });
    }

    const tropicY = snap((projection([(lonMin + lonMax) / 2, TROPIC_LAT]) ?? [0, 0])[1]);

    // Scale bar. Mercator scale is a function of latitude, so this is measured
    // at the centre of the sheet and labelled as such rather than pretending to
    // hold everywhere.
    const midY = (FRAME.y0 + FRAME.y1) / 2;
    const a = projection.invert?.([FRAME.x0 + 40, midY]) ?? [0, 0];
    const b = projection.invert?.([FRAME.x0 + 140, midY]) ?? [0, 0];
    const kmPerPx = (geoDistance(a, b) * 6371) / 100;
    const nice = [50, 100, 200, 250, 500, 1000, 2000];
    let barKm = nice[0];
    for (const candidate of nice) {
      if (candidate / kmPerPx <= 190) barKm = candidate;
    }
    // If even the smallest round distance will not fit the strip, no bar is
    // better than a bar that runs into the other keys.
    const raw = Number.isFinite(kmPerPx) && kmPerPx > 0 ? barKm / kmPerPx : 0;
    const barPx = snap(raw >= 20 && raw <= 190 ? raw : 0);

    return {
      minor,
      major,
      meridians,
      parallels,
      tropicY,
      inRange: TROPIC_LAT > latMin && TROPIC_LAT < latMax,
      barKm,
      barPx,
      barLat: (latMin + latMax) / 2,
    };
  }, [projection]);

  // Bubble area encodes exposure. `facilities` was the original size channel,
  // but in the shipped snapshot every district reports the same facility count,
  // which makes the channel -- and its legend line -- carry no information at
  // all. So the channel falls back to population served whenever facilities
  // turn out to be flat, and the key below names whichever one is live.
  const size = useMemo(() => {
    const facilities = districts.map((d) => d.facilities);
    const spread = Math.max(...facilities) - Math.min(...facilities);
    const useFacilities = districts.length > 0 && spread > 0;
    const field = useFacilities
      ? (d: MapDistrict) => d.facilities
      : (d: MapDistrict) => d.population;
    const values = districts.map(field);
    const max = Math.max(1, ...values);
    const min = Math.min(...values, max);
    return {
      field,
      max,
      min,
      label: useFacilities ? 'Facilities tracked' : 'Population served',
      format: useFacilities ? count : compactCount,
      radius: (d: MapDistrict) => 3.2 + 7 * Math.sqrt(field(d) / max),
    };
  }, [districts]);

  // For non-risk metrics the colour ramp needs rescaling into the 0..38 band
  // the risk ramp expects, or every bubble comes out the same colour.
  const maxMetric = useMemo(
    () => Math.max(1, ...districts.map((d) => metricValue(d, metric))),
    [districts, metric],
  );

  /** Value on the ramp's own scale -- the number that actually picks a colour. */
  const scaledValue = (d: MapDistrict) =>
    metric === 'risk'
      ? d.meanRiskScore
      : (metricValue(d, metric) / maxMetric) * RAMP_TOP;

  const colorFor = (d: MapDistrict) => riskColor(scaledValue(d));

  /** The ramp break expressed in the metric's own units, for the legend. */
  const breakValue = (threshold: number) =>
    metric === 'risk' ? threshold : (threshold / RAMP_TOP) * maxMetric;

  // How the country actually distributes across the six classes. A ramp with no
  // distribution under it tells you the encoding but not the situation.
  const classCounts = useMemo(() => {
    const acc = new Array(RAMP_COLORS.length).fill(0) as number[];
    for (const d of districts) acc[rampIndex(scaledValue(d))]++;
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [districts, metric, maxMetric]);
  const maxClassCount = Math.max(1, ...classCounts);

  // Motion is an alert, not a texture. globals.css already makes the case for
  // this on the dispatch arcs: one thing moving draws the eye, fifteen things
  // moving is a frame rate. Fifteen districts clear the old >= 22 threshold, so
  // the ring is reserved for the five worst on the metric currently displayed,
  // and only while they are genuinely in the top classes.
  const pulsing = useMemo(() => {
    const hot = districts
      .filter((d) => scaledValue(d) >= RAMP_BREAKS[3])
      .sort((a, b) => scaledValue(b) - scaledValue(a))
      .slice(0, 5);
    return new Set(hot.map((d) => d.code));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [districts, metric, maxMetric]);

  // One label per state, at the centroid of the districts we actually plot.
  // This is a readability aid derived from the data, not a boundary claim.
  //
  // Placement is greedy: states are tried heaviest-first, each gets up to five
  // candidate positions around its centroid, and a label that cannot find a
  // clear slot is dropped rather than allowed to overprint one already placed.
  // Dropping a label is a smaller cost than two illegible ones.
  const stateLabels = useMemo(() => {
    const acc = new Map<string, { x: number; y: number; n: number; weight: number }>();
    for (const d of districts) {
      const [x, y] = project(d.lon, d.lat);
      const e = acc.get(d.stateName) ?? { x: 0, y: 0, n: 0, weight: 0 };
      acc.set(d.stateName, {
        x: e.x + x,
        y: e.y + y,
        n: e.n + 1,
        weight: e.weight + d.population,
      });
    }

    const candidates: { dx: number; dy: number; anchor: 'middle' | 'start' | 'end' }[] = [
      { dx: 0, dy: -16, anchor: 'middle' },
      { dx: 0, dy: 22, anchor: 'middle' },
      { dx: -16, dy: 4, anchor: 'end' },
      { dx: 16, dy: 4, anchor: 'start' },
      { dx: 0, dy: 4, anchor: 'middle' },
    ];

    const fontSize = 9.5;
    const placed: {
      name: string;
      x: number;
      y: number;
      anchor: 'middle' | 'start' | 'end';
      box: [number, number, number, number];
    }[] = [];

    const ordered = [...acc.entries()].sort(
      (a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]),
    );

    for (const [name, v] of ordered) {
      const cx = v.x / v.n;
      const cy = v.y / v.n;
      const w = labelWidth(name.toUpperCase(), fontSize);

      for (const c of candidates) {
        const x = cx + c.dx;
        const y = cy + c.dy;
        const left = c.anchor === 'middle' ? x - w / 2 : c.anchor === 'end' ? x - w : x;
        const box: [number, number, number, number] = [left - 3, y - 9, left + w + 3, y + 3];
        if (box[0] < FRAME.x0 + 2 || box[2] > FRAME.x1 - 2) continue;
        if (box[1] < FRAME.y0 + 2 || box[3] > FRAME.y1 - 2) continue;
        const clash = placed.some(
          (p) =>
            box[0] < p.box[2] && box[2] > p.box[0] && box[1] < p.box[3] && box[3] > p.box[1],
        );
        if (clash) continue;
        placed.push({ name, x, y, anchor: c.anchor, box });
        break;
      }
    }
    return placed;
  }, [districts, project]);

  /**
   * The redistribution overlay: every district-to-district movement in the plan.
   *
   * ALL of them are drawn, not a top-N. That is affordable here because the
   * flows are regional -- 244 arcs whose median span is 99 km on a sheet where
   * the country is 620 px across -- so they cluster into short local strokes
   * rather than a cross-country hairball. A truncated overlay would also be the
   * wrong picture for the one claim this layer exists to support: that stock
   * crosses boundaries across the country, not on a handful of showcase routes.
   *
   * Painted ascending by orders so the heaviest corridor is on top, and sorted
   * on a copy because the prop belongs to the caller.
   */
  const flowArcs = useMemo(() => {
    if (!showFlows || flows.length === 0) return [];
    const maxOrders = Math.max(1, ...flows.map((f) => f.orders));
    return [...flows]
      .sort((a, b) => a.orders - b.orders)
      .map((f, i) => ({
        key: `${f.fromDistrictName}|${f.toDistrictName}|${i}`,
        flow: f,
        d: flowArc(project(f.fromLon, f.fromLat), project(f.toLon, f.toLat)),
        width: 0.5 + 2.4 * Math.sqrt(f.orders / maxOrders),
        dash: f.crossState ? CROSS_STATE_DASH : undefined,
      }));
  }, [flows, showFlows, project]);

  if (districts.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-xs text-mist-500">
        No districts in the current selection.
      </div>
    );
  }

  const active = hover ?? districts.find((d) => d.code === selectedDistrict) ?? null;
  const activeXY = active ? project(active.lon, active.lat) : null;
  const inactive = districts.filter((d) => d.code !== active?.code);

  // Park the hover card on whichever side of the sheet the cursor is not on, so
  // reading a district never hides its neighbours.
  const cardSide = activeXY && activeXY[0] > WIDTH / 2 ? 'left' : 'right';

  const scaleX1 = FRAME.x1;
  const scaleX0 = FRAME.x1 - grid.barPx;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-auto"
        role="img"
        aria-label={
          `District plot of India: ${districts.length} districts across ` +
          `${new Set(districts.map((d) => d.stateName)).size} states, coloured by ` +
          `${METRIC_LABEL[metric].toLowerCase()}. Administrative boundaries are not shown.` +
          // The arcs themselves are aria-hidden -- 244 individually announced
          // paths would be unusable -- so the layer is described once, here.
          (flowArcs.length > 0
            ? ` Overlaid: ${flowArcs.length} district-to-district medicine movements, ` +
              `${flowArcs.filter((a) => a.flow.crossState).length} of which also cross a state boundary.`
            : '')
        }
      >
        <defs>
          <filter id={`glow-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id={`body-${uid}`}>
            <rect
              x={FRAME.x0}
              y={FRAME.y0}
              width={FRAME.x1 - FRAME.x0}
              height={FRAME.y1 - FRAME.y0}
            />
          </clipPath>
        </defs>

        {/* The map body reads a shade below the panel it sits in, so the sheet
            has an edge even before the neatline is drawn. */}
        <rect
          x={FRAME.x0}
          y={FRAME.y0}
          width={FRAME.x1 - FRAME.x0}
          height={FRAME.y1 - FRAME.y0}
          fill="var(--color-ink-950)"
        />

        {/* The landmass. Drawn beneath the graticule so the grid reads as ruling
            over a map rather than as a fence around it, and beneath every
            bubble so the data always sits on top of the geography. */}
        <g clipPath={`url(#body-${uid})`} aria-hidden="true">
          <path
            d={landPath}
            fill="var(--color-ink-850)"
            stroke="var(--color-ink-600)"
            strokeWidth={0.8}
            strokeLinejoin="round"
          />
        </g>

        {/* Graticule: latitude and longitude only. It states no border. */}
        <g clipPath={`url(#body-${uid})`} aria-hidden="true">
          <path
            d={grid.minor}
            fill="none"
            stroke="var(--color-ink-800)"
            strokeWidth={0.5}
            opacity={0.85}
          />
          <path d={grid.major} fill="none" stroke="var(--color-ink-700)" strokeWidth={0.7} />
          {grid.inRange && (
            <>
              <line
                x1={FRAME.x0}
                x2={FRAME.x1}
                y1={grid.tropicY}
                y2={grid.tropicY}
                stroke="var(--color-ink-600)"
                strokeWidth={0.8}
                strokeDasharray="6 5"
              />
              <text
                x={FRAME.x1 - 8}
                y={grid.tropicY - 5}
                textAnchor="end"
                className="fill-mist-500"
                style={{ fontSize: 8, letterSpacing: '0.12em' }}
              >
                TROPIC OF CANCER
              </text>
            </>
          )}
        </g>

        {/* Crosshair for the hovered or selected district: the point's own
            coordinate, carried out to the gutters where it can be read off. */}
        {activeXY && (
          <g aria-hidden="true" style={{ pointerEvents: 'none' }}>
            <line
              x1={activeXY[0]}
              x2={activeXY[0]}
              y1={FRAME.y0}
              y2={FRAME.y1}
              stroke="var(--color-brand)"
              strokeWidth={0.7}
              strokeDasharray="2 5"
              opacity={0.45}
            />
            <line
              x1={FRAME.x0}
              x2={FRAME.x1}
              y1={activeXY[1]}
              y2={activeXY[1]}
              stroke="var(--color-brand)"
              strokeWidth={0.7}
              strokeDasharray="2 5"
              opacity={0.45}
            />
          </g>
        )}

        {/* Neatline and degree ticks. */}
        <g aria-hidden="true">
          <rect
            x={FRAME.x0}
            y={FRAME.y0}
            width={FRAME.x1 - FRAME.x0}
            height={FRAME.y1 - FRAME.y0}
            fill="none"
            stroke="var(--color-ink-600)"
            strokeWidth={1}
          />
          {grid.meridians.map((m) => (
            <g key={`m${m.lon}`}>
              <line
                x1={m.x}
                x2={m.x}
                y1={FRAME.y1}
                y2={FRAME.y1 + 4}
                stroke="var(--color-ink-600)"
                strokeWidth={0.8}
              />
              <text
                x={m.x}
                y={AXIS_LABEL_Y}
                textAnchor="middle"
                className="fill-mist-500 tnum"
                style={{ fontSize: 9 }}
              >
                {degLabel(m.lon, 'E', 'W')}
              </text>
            </g>
          ))}
          {grid.parallels.map((p) => (
            <g key={`p${p.lat}`}>
              <line
                x1={FRAME.x0 - 4}
                x2={FRAME.x0}
                y1={p.y}
                y2={p.y}
                stroke="var(--color-ink-600)"
                strokeWidth={0.8}
              />
              <text
                x={FRAME.x0 - 7}
                y={p.y + 3}
                textAnchor="end"
                className="fill-mist-500 tnum"
                style={{ fontSize: 9 }}
              >
                {degLabel(p.lat, 'N', 'S')}
              </text>
            </g>
          ))}
        </g>

        {/* Live coordinate read-out, printed over the tick labels it replaces. */}
        {active && activeXY && (
          <g aria-hidden="true" style={{ pointerEvents: 'none' }}>
            <Readout
              x={activeXY[0]}
              y={AXIS_LABEL_Y}
              anchor="middle"
              text={`${active.lon.toFixed(1)}°E`}
            />
            <Readout
              x={FRAME.x0 - 7}
              y={activeXY[1] + 3}
              anchor="end"
              text={`${active.lat.toFixed(1)}°N`}
            />
          </g>
        )}

        {/* State labels, placed at the centroid of each state's own districts.
            Derived from the plotted points, so nothing here asserts a boundary.
            The ink halo lets them survive being drawn over a bubble. */}
        <g aria-hidden="true">
          {stateLabels.map((s) => (
            <text
              key={s.name}
              x={s.x}
              y={s.y}
              textAnchor={s.anchor}
              className="fill-mist-400"
              style={{
                fontSize: 9.5,
                letterSpacing: '0.09em',
                textTransform: 'uppercase',
                pointerEvents: 'none',
                paintOrder: 'stroke',
                stroke: 'var(--color-ink-950)',
                strokeWidth: 3.5,
                strokeLinejoin: 'round',
              }}
            >
              {s.name}
            </text>
          ))}
        </g>

        {/* District bubbles. The active one is painted last so it is never
            buried under a neighbour it happens to overlap. */}
        <g>
          {inactive.map((d) => (
            <Bubble
              key={d.code}
              d={d}
              xy={project(d.lon, d.lat)}
              r={size.radius(d)}
              color={colorFor(d)}
              pulsing={pulsing.has(d.code)}
              selected={selectedDistrict === d.code}
              glowId={`glow-${uid}`}
              onHover={setHover}
              onSelect={onSelectDistrict}
            />
          ))}
          {active && activeXY && (
            <g>
              <circle
                cx={activeXY[0]}
                cy={activeXY[1]}
                r={size.radius(active) + 6}
                fill="none"
                stroke={colorFor(active)}
                strokeWidth={0.9}
                opacity={0.5}
                style={{ pointerEvents: 'none' }}
              />
              <Bubble
                d={active}
                xy={activeXY}
                r={size.radius(active)}
                color={colorFor(active)}
                pulsing={false}
                selected={selectedDistrict === active.code}
                glowId={`glow-${uid}`}
                onHover={setHover}
                onSelect={onSelectDistrict}
              />
            </g>
          )}
        </g>

        {/* Redistribution flows, OVER the bubbles and clipped to the body.
            Over, because these arcs are the point of the layer and beneath 128
            opaque bubbles centred on the very endpoints they join, they were
            invisible -- the feature rendered and could not be seen. They cannot
            steal a click from the district underneath because the group is
            pointer-events:none, so the interactive layer is still the bubbles.
            Clipped, because an arc must never stray into the marginalia strip.

            Each arc is drawn twice: a dark halo, then the stroke. The ground
            behind a flow is not one colour -- it is the ink of the sheet in the
            gaps and a saturated risk fill wherever it crosses a bubble -- and a
            single teal stroke that reads cleanly on the first disappears into
            the second. The halo gives every arc the same background. */}
        {flowArcs.length > 0 && (
          <g
            clipPath={`url(#body-${uid})`}
            fill="none"
            style={{ pointerEvents: 'none' }}
            aria-hidden="true"
          >
            {flowArcs.map((a) => (
              <path
                key={a.key + '-halo'}
                d={a.d}
                stroke="var(--color-ink-950)"
                strokeWidth={a.width + 1.6}
                strokeOpacity={0.5}
                strokeLinecap="round"
              />
            ))}
            {flowArcs.map((a) => (
              <path
                key={a.key}
                d={a.d}
                stroke={FLOW_COLOR}
                strokeWidth={a.width}
                strokeOpacity={0.9}
                strokeDasharray={a.dash}
                strokeLinecap="round"
              />
            ))}
          </g>
        )}

        {/* ------------------------------ marginalia ------------------------------ */}
        <g aria-hidden="true">
          <line
            x1={FRAME.x0}
            x2={FRAME.x1}
            y1={RULE_Y}
            y2={RULE_Y}
            stroke="var(--color-ink-700)"
            strokeWidth={1}
          />

          {/* Colour key: the class breaks in the metric's own units, with the
              national distribution standing on top of them. */}
          <KeyTitle x={RAMP_X} text={`${METRIC_LABEL[metric]} · districts`} />
          {RAMP_COLORS.map((c, i) => {
            const h = (classCounts[i] / maxClassCount) * HIST_MAX_H;
            const x = RAMP_X + i * SWATCH_W;
            return (
              <g key={c}>
                {classCounts[i] > 0 && (
                  <>
                    <rect
                      x={x + 3}
                      y={HIST_BASE_Y - h}
                      width={SWATCH_W - 6}
                      height={h}
                      fill={c}
                      opacity={0.45}
                    />
                    <text
                      x={x + SWATCH_W / 2}
                      y={HIST_BASE_Y - h - 3}
                      textAnchor="middle"
                      className="fill-mist-500 tnum"
                      style={{ fontSize: 8 }}
                    >
                      {classCounts[i]}
                    </text>
                  </>
                )}
                <rect x={x} y={BAR_Y} width={SWATCH_W} height={BAR_H} fill={c} />
              </g>
            );
          })}
          <line
            x1={RAMP_X}
            x2={RAMP_X + RAMP_W}
            y1={HIST_BASE_Y}
            y2={HIST_BASE_Y}
            stroke="var(--color-ink-700)"
            strokeWidth={0.7}
          />
          {RAMP_BREAKS.map((b, i) => {
            const x = RAMP_X + (i + 1) * SWATCH_W;
            // Every break gets a tick; every second one gets a number, which is
            // as many as fit at this width without the labels touching.
            return (
              <g key={b}>
                <line
                  x1={x}
                  x2={x}
                  y1={BAR_Y + BAR_H}
                  y2={BAR_Y + BAR_H + 4}
                  stroke="var(--color-ink-500)"
                  strokeWidth={0.8}
                />
                {i % 2 === 0 && (
                  <text
                    x={x}
                    y={KEY_LABEL_Y}
                    textAnchor="middle"
                    className="fill-mist-400 tnum"
                    style={{ fontSize: 9 }}
                  >
                    {formatMetric(breakValue(b), metric)}
                  </text>
                )}
              </g>
            );
          })}

          {/* Size key, drawn at the radii the map actually uses. */}
          <KeyTitle x={SIZE_KEY_X} text={size.label} />
          {(() => {
            const stops = [size.min, (size.min + size.max) / 2, size.max];
            let cursor = SIZE_KEY_X;
            return stops.map((v, i) => {
              const r = 3.2 + 7 * Math.sqrt(v / size.max);
              const cx = cursor + r;
              cursor = cx + r + 34;
              return (
                <g key={i}>
                  <circle
                    cx={cx}
                    cy={BAR_Y + BAR_H / 2}
                    r={r}
                    fill="var(--color-ink-600)"
                    stroke="var(--color-ink-500)"
                    strokeWidth={0.7}
                  />
                  <text
                    x={cx}
                    y={KEY_LABEL_Y}
                    textAnchor="middle"
                    className="fill-mist-400 tnum"
                    style={{ fontSize: 9 }}
                  >
                    {size.format(v)}
                  </text>
                </g>
              );
            });
          })()}

          {/* Scale bar, measured off the live projection rather than assumed. */}
          {grid.barPx > 0 && (
            <>
              <KeyTitle
                x={scaleX0}
                text={`Scale at ${grid.barLat.toFixed(0)}°N`}
              />
              {[0, 1, 2, 3].map((i) => (
                <rect
                  key={i}
                  x={scaleX0 + (i * grid.barPx) / 4}
                  y={BAR_Y}
                  width={grid.barPx / 4}
                  height={BAR_H}
                  fill={i % 2 === 0 ? 'var(--color-mist-400)' : 'var(--color-ink-800)'}
                  stroke="var(--color-ink-500)"
                  strokeWidth={0.7}
                />
              ))}
              <text
                x={scaleX0}
                y={KEY_LABEL_Y}
                textAnchor="middle"
                className="fill-mist-400 tnum"
                style={{ fontSize: 9 }}
              >
                0
              </text>
              <text
                x={scaleX1}
                y={KEY_LABEL_Y}
                textAnchor="end"
                className="fill-mist-400 tnum"
                style={{ fontSize: 9 }}
              >
                {grid.barKm} km
              </text>
            </>
          )}

          {/* Source and projection note. On a government sheet the absence of
              boundaries is a statement, and a statement gets said out loud.
              When the overlay is on, this line doubles as its key: the two
              stroke colours are named by colouring the words themselves, which
              costs no vertical room in a strip that has none left. */}
          <text
            x={FRAME.x0}
            y={NOTE_Y}
            className="fill-mist-500"
            style={{ fontSize: 9, letterSpacing: '0.02em' }}
          >
            {flowArcs.length > 0 ? (
              <>
                {`Mercator · ${districts.length} district HQs · `}
                <tspan fill={FLOW_COLOR}>
                  {`arcs = ${flowArcs.length} inter-district movements, dashed where they cross a state (${flowArcs.filter((a) => a.flow.crossState).length})`}
                </tspan>
                {' · width = orders · boundaries not depicted'}
              </>
            ) : (
              `Mercator projection · ${districts.length} district headquarters from recorded coordinates · administrative boundaries not depicted`
            )}
          </text>
        </g>
      </svg>

      {/* Hover card */}
      {hover && (
        <div
          className={
            'absolute top-2 panel px-3 py-2 text-xs pointer-events-none min-w-[196px] ' +
            (cardSide === 'left' ? 'left-2' : 'right-2')
          }
        >
          <div className="font-semibold text-mist-100">{hover.name}</div>
          <div className="text-mist-400 text-[11px] mb-2">{hover.stateName}</div>
          <dl className="space-y-1">
            <Row label={METRIC_LABEL[metric]} value={metricDisplay(hover, metric)} />
            <Row label={size.label} value={size.format(size.field(hover))} />
            <Row label="Critical" value={count(hover.criticalPositions)} />
            <Row label="Population" value={compactCount(hover.population)} />
          </dl>
          <div className="mt-2 pt-2 border-t border-ink-700 text-[10px]">
            <div className="tnum text-mist-500">
              {hover.lat.toFixed(2)}&deg;N &nbsp;{hover.lon.toFixed(2)}&deg;E
            </div>
            <div className="text-mist-400 mt-1">click to open district</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Bubble({
  d,
  xy,
  r,
  color,
  pulsing,
  selected,
  glowId,
  onHover,
  onSelect,
}: {
  d: MapDistrict;
  xy: number[];
  r: number;
  color: string;
  pulsing: boolean;
  selected?: boolean;
  glowId?: string;
  onHover: (d: MapDistrict | null) => void;
  onSelect?: (code: string) => void;
}) {
  return (
    <g>
      {pulsing && (
        <circle
          cx={xy[0]}
          cy={xy[1]}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={1}
          className="pulse-ring"
          style={{ transformBox: 'fill-box', pointerEvents: 'none' }}
        />
      )}
      <circle
        cx={xy[0]}
        cy={xy[1]}
        r={r}
        fill={color}
        fillOpacity={selected ? 1 : 0.78}
        stroke={selected ? '#fff' : 'var(--color-ink-950)'}
        strokeWidth={selected ? 1.6 : 0.7}
        className="cursor-pointer"
        filter={selected && glowId ? `url(#${glowId})` : undefined}
        onMouseEnter={() => onHover(d)}
        onMouseLeave={() => onHover(null)}
        onClick={() => onSelect?.(d.code)}
      />
    </g>
  );
}

/** Marginalia column heading -- same case and tracking as .panel-head. */
function KeyTitle({ x, text }: { x: number; text: string }) {
  return (
    <text
      x={x}
      y={KEY_TITLE_Y}
      className="fill-mist-500"
      style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase' }}
    >
      {text}
    </text>
  );
}

/** A coordinate value printed over the degree ticks it temporarily replaces. */
function Readout({
  x,
  y,
  anchor,
  text,
}: {
  x: number;
  y: number;
  anchor: 'middle' | 'end';
  text: string;
}) {
  const w = text.length * 5.4 + 8;
  return (
    <g>
      <rect
        x={anchor === 'middle' ? x - w / 2 : x - w + 4}
        y={y - 9}
        width={w}
        height={12}
        rx={2}
        fill="var(--color-ink-950)"
        stroke="var(--color-ink-700)"
        strokeWidth={0.7}
      />
      <text
        x={x}
        y={y}
        textAnchor={anchor}
        className="fill-brand tnum"
        style={{ fontSize: 9 }}
      >
        {text}
      </text>
    </g>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-mist-400">{label}</dt>
      <dd className="tnum text-mist-100">{value}</dd>
    </div>
  );
}
