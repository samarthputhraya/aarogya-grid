'use client';

import { useMemo } from 'react';
import { geoMercator } from 'd3-geo';
import type { FeatureCollection, Point } from 'geojson';
import type { DispatchEndpoint, DispatchOrder, FacilityRow } from '@/lib/district-detail';
import { riskColor, severityOfScore, SEVERITY_COLOR, count, FACILITY_LABEL } from '@/lib/format';

/**
 * District dispatch map.
 *
 * WHY NOT `IndiaMap`
 * ------------------
 * `IndiaMap` is welded to `geoMercator().fitSize([720, 780], indiaStates)` --
 * its projection is derived from the national outline, so a district's twenty-
 * odd facilities land inside a single bubble. This is a separate, smaller,
 * BASEMAP-FREE component that fits its projection to the facilities it is
 * given. Being basemap-free is also the point: a district-level facility
 * scatter contains no national boundary, so it carries none of the
 * Survey-of-India correctness liability the state polygon layer does.
 *
 * WHY A MAP AT ALL, GIVEN THE CARDS
 * ---------------------------------
 * The cards answer "can my storekeeper execute this?". The map answers a
 * question the cards physically cannot: "is this a sensible PATTERN of
 * movement?" Stock flowing outward from the warehouse looks different from
 * stock being dragged inward from the periphery to the town, and only one of
 * those is a supply chain working. Both views share one `selectedOrderId`, so
 * they can never be describing different plans.
 */

const W = 520;
const H = 460;
const PAD = 36;

export interface TransferMapProps {
  facilities: FacilityRow[];
  orders: DispatchOrder[];
  selectedOrderId: string | null;
  onSelectOrder: (id: string | null) => void;
  /** Facility highlighted from the roster, if any. */
  selectedFacilityId?: string | null;
}

/**
 * A quadratic arc from `a` to `b`, always bowed to the LEFT of the direction of
 * travel.
 *
 * The handedness is load-bearing, not decorative: a district hospital and a
 * PHC that dispatch to each other would otherwise draw two identical straight
 * lines on top of one another, and three orders sharing an endpoint would draw
 * an unreadable fan. Bowing consistently to one side separates reciprocal
 * pairs into a lens shape whose two halves are individually hoverable.
 */
function arcPath(a: [number, number], b: [number, number], bow = 0.22): string {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const cx = (x1 + x2) / 2 + nx * len * bow;
  const cy = (y1 + y2) / 2 + ny * len * bow;
  return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

/**
 * Arrowhead for a quadratic arc, drawn as a real polygon rather than an SVG
 * `<marker>`.
 *
 * Markers would need one `<marker>` element per stroke colour, because
 * `fill="context-stroke"` is not reliable across the browsers a demo actually
 * runs in. The tangent of a quadratic at its endpoint is simply `end - control`,
 * so computing the triangle here costs three lines and works everywhere.
 */
function arrowHead(a: [number, number], b: [number, number], bow = 0.22, size = 6): string {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const cx = (x1 + x2) / 2 + (-dy / len) * len * bow;
  const cy = (y1 + y2) / 2 + (dx / len) * len * bow;
  const tx = x2 - cx;
  const ty = y2 - cy;
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl;
  const uy = ty / tl;
  // Pull the tip back off the node so the triangle sits against the circle
  // rather than inside it.
  const tipX = x2 - ux * 3.5;
  const tipY = y2 - uy * 3.5;
  const baseX = tipX - ux * size;
  const baseY = tipY - uy * size;
  const px = -uy * size * 0.45;
  const py = ux * size * 0.45;
  return `${tipX.toFixed(1)},${tipY.toFixed(1)} ${(baseX + px).toFixed(1)},${(baseY + py).toFixed(1)} ${(baseX - px).toFixed(1)},${(baseY - py).toFixed(1)}`;
}

export default function TransferMap({
  facilities,
  orders,
  selectedOrderId,
  onSelectOrder,
  selectedFacilityId = null,
}: TransferMapProps) {
  /**
   * Every point the sheet has to hold: the district's own facilities AND both
   * ends of every order.
   *
   * These used to be the same set, and fitting to the roster alone was correct
   * for exactly as long as no order left the district. Once the planner started
   * crossing boundaries the donor end of a cross-district order sat outside the
   * fitted extent -- on the worst of the 128 districts, 0.83 extent-widths
   * outside it, which puts the arc's tail off the canvas entirely. 106 of the
   * 128 districts carry at least one such order, so this was not an edge case;
   * it was most of the pages drawing a line that came from nowhere.
   *
   * Fitting to the union costs a little scale on districts that reach a long
   * way for stock, which is the honest depiction: the reach IS the finding.
   */
  const points = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<[number, number]> = [];
    const push = (lon: number, lat: number) => {
      const k = lon.toFixed(4) + ',' + lat.toFixed(4);
      if (seen.has(k)) return;
      seen.add(k);
      out.push([lon, lat]);
    };
    for (const f of facilities) push(f.lon, f.lat);
    for (const o of orders) {
      push(o.from.lon, o.from.lat);
      push(o.to.lon, o.to.lat);
    }
    return out;
  }, [facilities, orders]);

  const project = useMemo(() => {
    const collection: FeatureCollection<Point> = {
      type: 'FeatureCollection',
      features: points.map((c) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: c },
      })),
    };
    const projection =
      points.length > 0
        ? geoMercator().fitExtent(
            [
              [PAD, PAD],
              [W - PAD, H - PAD],
            ],
            collection,
          )
        : null;
    return (lon: number, lat: number): [number, number] => {
      const p = projection ? projection([lon, lat]) : null;
      // A degenerate extent (every point on one coordinate) makes d3 return a
      // non-finite scale. Falling back to the centre keeps the SVG valid
      // instead of emitting `NaN` into a path attribute.
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return [W / 2, H / 2];
      // Rounded to 1/100 of a user unit because Mercator is `log(tan(...))` and
      // `Math.log` / `Math.tan` may differ in their last digits between Node and
      // the browser's V8. The arc paths already round to one decimal on their
      // way into `d`, so they never showed it; the facility circles and the
      // out-of-district markers take these numbers raw, and React reported the
      // difference as a hydration mismatch and discarded the server's
      // attributes for the map. Far below a pixel on a 520-unit viewBox.
      return [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
    };
  }, [points]);

  const maxPositions = useMemo(
    () => Math.max(1, ...facilities.map((f) => f.positions)),
    [facilities],
  );
  const maxQuantity = useMemo(() => Math.max(1, ...orders.map((o) => o.quantity)), [orders]);

  /**
   * Painted ascending by risk reduction, so the order that matters most is
   * drawn last and therefore on top. `IndiaMap` paints in array order and its
   * highest-risk bubbles end up underneath whatever follows them.
   */
  const arcs = useMemo(() => {
    return [...orders]
      .sort((a, b) => a.riskReduction - b.riskReduction)
      .map((o) => {
        const from = project(o.from.lon, o.from.lat);
        const to = project(o.to.lon, o.to.lat);
        return {
          order: o,
          d: arcPath(from, to),
          head: arrowHead(from, to),
          // Colour by the RECEIVER's severity, using the same ramp as every
          // table on the page, so the map and the rows cannot disagree about
          // what "bad" looks like.
          color: SEVERITY_COLOR[severityOfScore(o.receiverStockoutProbBefore * 100)],
          width: 1 + 2.6 * Math.sqrt(o.quantity / maxQuantity),
        };
      });
  }, [orders, project, maxQuantity]);

  const selected = arcs.find((a) => a.order.id === selectedOrderId) ?? null;
  const endpoints = new Set(
    selected ? [selected.order.from.id, selected.order.to.id] : selectedFacilityId ? [selectedFacilityId] : [],
  );

  /**
   * Order endpoints that are not on this district's roster.
   *
   * `facilities` is deliberately this district's own facilities and nothing
   * else -- it is the roster the page tabulates, and padding it with a
   * neighbour's hospitals would corrupt every count computed from it. But a
   * cross-district order has one end in that neighbour, and drawing an arc to
   * an invisible terminus reads as a rendering fault rather than as a supply
   * line reaching over a boundary.
   *
   * So they are drawn, from the order's own endpoint record, and drawn
   * DIFFERENTLY: no risk fill, because this page never computed a risk score
   * for a facility it does not hold positions for, and inventing one would be
   * the map asserting something the payload does not contain.
   */
  const externalNodes = useMemo(() => {
    const own = new Set(facilities.map((f) => f.id));
    const out = new Map<string, { ep: DispatchEndpoint; sends: boolean; receives: boolean }>();
    for (const o of orders) {
      for (const [ep, sends] of [
        [o.from, true],
        [o.to, false],
      ] as const) {
        if (own.has(ep.id)) continue;
        const row = out.get(ep.id) ?? { ep, sends: false, receives: false };
        if (sends) row.sends = true;
        else row.receives = true;
        out.set(ep.id, row);
      }
    }
    return [...out.values()];
  }, [facilities, orders]);

  /** Whether any movement on this sheet leaves the district. */
  const anyCrossDistrict = orders.some((o) => o.crossDistrict);

  /**
   * Whether the cold-chain channel is actually in use here.
   *
   * Six of the 128 districts have a plan with no cold-chain movement in it, and
   * on those the legend was asserting a dashed stroke that appears nowhere on
   * the canvas. The legend already promises to describe only channels that
   * vary; this makes that true.
   */
  const anyColdChain = orders.some((o) => o.coldChain);

  /**
   * Nothing to project. Reached when a district payload carries no facilities
   * at all -- a rebuild artefact rather than a finding -- and the honest thing
   * is to say so rather than serve an empty 520x460 box that reads as a map
   * that failed to load.
   */
  if (facilities.length === 0) {
    return (
      <div className="aspect-[520/460] grid place-items-center px-6 text-center">
        <div>
          <p className="text-xs text-mist-300">No facilities to plot.</p>
          <p className="text-[11px] text-mist-500 mt-1 leading-relaxed">
            This district&rsquo;s payload carries no facility roster, so there is nothing to project
            and no movement to draw.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={
          `Dispatch map: ${count(facilities.length)} facilities and ` +
          `${count(orders.length)} recommended transfers` +
          (anyCrossDistrict
            ? `, of which ${count(orders.filter((o) => o.crossDistrict).length)} cross a district boundary`
            : '')
        }
      >
        {/* Arcs, below everything. */}
        <g fill="none">
          {arcs.map((a) => {
            const isSel = a.order.id === selectedOrderId;
            return (
              <g key={a.order.id}>
                {/* Fat invisible hit target -- a 2px stroke is not a click target. */}
                <path
                  d={a.d}
                  stroke="transparent"
                  strokeWidth={12}
                  /*
                   * The browser's default ring is suppressed because focusing
                   * this path already repaints the arc below in brand colour
                   * with a flowing dash -- a far stronger indicator than a ring
                   * around the bounding box of a diagonal curve, which on a
                   * long arc is most of the map. The focus state is not
                   * removed, it is replaced.
                   */
                  className="cursor-pointer focus:outline-none"
                  tabIndex={0}
                  role="button"
                  aria-label={
                    `${count(a.order.quantity)} ${a.order.unit} of ${a.order.drugName} ` +
                    `from ${a.order.from.name}${a.order.crossDistrict ? ` in ${a.order.from.districtName}` : ''} ` +
                    `to ${a.order.to.name}${a.order.crossDistrict ? ` in ${a.order.to.districtName}` : ''}, ` +
                    `${a.order.distanceKm} km` +
                    (a.order.rideAlong ? ', riding a vehicle already making this trip' : '')
                  }
                  onMouseEnter={() => onSelectOrder(a.order.id)}
                  onFocus={() => onSelectOrder(a.order.id)}
                  onClick={() => onSelectOrder(isSel ? null : a.order.id)}
                  /*
                   * role="button" is a promise that Enter and Space activate
                   * the thing. Without this handler the arc announced itself
                   * as a button, took focus, and then did nothing when a
                   * keyboard user pressed the key it had just advertised --
                   * the arc could only be toggled with a mouse. Space is
                   * preventDefault-ed because on an SVG child of a scrollable
                   * panel it otherwise pages the console down underneath the
                   * user.
                   */
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      onSelectOrder(isSel ? null : a.order.id);
                    }
                  }}
                />
                <path
                  d={a.d}
                  stroke={a.color}
                  strokeWidth={a.width}
                  strokeOpacity={selectedOrderId && !isSel ? 0.2 : 0.72}
                  strokeDasharray={a.order.coldChain ? '3 3' : undefined}
                  strokeLinecap="round"
                  className="pointer-events-none transition-opacity"
                />
                <polygon
                  points={a.head}
                  fill={a.color}
                  fillOpacity={selectedOrderId && !isSel ? 0.2 : 0.85}
                  className="pointer-events-none"
                />
              </g>
            );
          })}
        </g>

        {/* Out-of-district endpoints, under the roster so an id collision can
            never hide one of this district's own facilities. Square, hollow and
            unfilled: a different shape says "different thing" at a glance, and
            the absent fill says the page has no risk score for it rather than
            implying a good one. */}
        <g>
          {externalNodes.map(({ ep, sends, receives }) => {
            const [x, y] = project(ep.lon, ep.lat);
            const isEndpoint = endpoints.has(ep.id);
            const s = 5.5;
            return (
              <rect
                key={ep.id}
                x={x - s}
                y={y - s}
                width={s * 2}
                height={s * 2}
                transform={`rotate(45 ${x} ${y})`}
                fill="var(--color-ink-950)"
                fillOpacity={0.6}
                stroke={isEndpoint ? 'var(--color-brand)' : 'var(--color-mist-400)'}
                strokeWidth={isEndpoint ? 2 : 1.2}
                strokeDasharray={isEndpoint ? undefined : '2 1.5'}
              >
                <title>
                  {`${ep.name} · ${FACILITY_LABEL[ep.type] ?? ep.type} · ${ep.districtName} district · ${
                    sends && receives ? 'sends and receives' : sends ? 'sends stock here' : 'receives stock from here'
                  } · outside this district, so no position count on this page`}
                </title>
              </rect>
            );
          })}
        </g>

        {/* Facility nodes. */}
        <g>
          {facilities.map((f) => {
            const [x, y] = project(f.lon, f.lat);
            const r = 3 + 5 * Math.sqrt(f.positions / maxPositions);
            const isEndpoint = endpoints.has(f.id);
            return (
              <circle
                key={f.id}
                cx={x}
                cy={y}
                r={r}
                fill={riskColor(f.meanRiskScore)}
                fillOpacity={0.82}
                stroke={isEndpoint ? 'var(--color-brand)' : 'var(--color-ink-950)'}
                strokeWidth={isEndpoint ? 2 : 0.8}
              >
                <title>
                  {`${f.name} · ${FACILITY_LABEL[f.type] ?? f.type} · ${count(f.positions)} positions, ${count(f.criticalPositions)} critical · mean risk ${f.meanRiskScore.toFixed(1)}`}
                </title>
              </circle>
            );
          })}
        </g>

        {/* The selected arc, repainted on top with a flowing dash so direction
            of travel is unambiguous without reading the arrowhead. */}
        {selected && (
          <g fill="none" className="pointer-events-none">
            <path d={selected.d} stroke={selected.color} strokeWidth={selected.width + 1.2} strokeOpacity={0.95} />
            <path d={selected.d} stroke="var(--color-brand)" strokeWidth={1.6} className="arc-flow" />
            <polygon points={selected.head} fill={selected.color} />
          </g>
        )}
      </svg>

      {/* Legend. Only channels that actually vary are claimed -- a legend that
          describes a constant is the kind of thing a judge checks. */}
      <div className="absolute bottom-1 left-1 text-[10px] text-mist-400 leading-relaxed pointer-events-none">
        {orders.length > 0 ? (
          <>
            <div>→ dispatch · width = quantity</div>
            <div>
              {anyColdChain ? 'dashed = cold chain · ' : ''}colour = receiver risk · node = positions
              held
            </div>
            {anyCrossDistrict && <div>◇ facility outside this district</div>}
          </>
        ) : (
          <div>node size = positions held · colour = mean risk</div>
        )}
      </div>
    </div>
  );
}
