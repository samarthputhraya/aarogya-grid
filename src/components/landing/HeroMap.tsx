import { geoMercator, geoPath } from 'd3-geo';
import type { Feature, MultiPolygon } from 'geojson';
import outlineRaw from '@/data/india-outline.json';
import type { NationalSnapshot } from '@/lib/snapshot-types';

/**
 * The hero map.
 *
 * BOUNDARIES
 * ----------
 * This uses `@/data/india-outline.json` and nothing else, for the reason set
 * out at length in IndiaMap.tsx: that file is the datameet composite, verified
 * to reach 37.10 N and 97.40 E, and the ordinary international outlines
 * (Natural Earth, GADM) terminate Jammu and Kashmir at the Line of Control.
 * Depicting India's boundaries is governed rather than a matter of taste, and a
 * decorative map on a landing page is still a depiction. Do not swap this for a
 * prettier silhouette from a CDN.
 *
 * NO CLIENT JAVASCRIPT
 * --------------------
 * Every animation here is a CSS class with a per-element delay computed on the
 * server, so this renders as a server component and ships zero JS. That matters
 * more than it looks: this is the first paint of the first page an assessor
 * loads, and the alternative -- shipping d3 to the browser to animate a
 * decorative backdrop -- would put a projection library in the critical path of
 * a hero image.
 *
 * WHAT IS DRAWN
 * -------------
 * All of the plan's inter-district corridors, not a flattering subset. Width
 * and opacity scale with the orders each carries, so the shape of the plan is
 * legible without any corridor being hidden; the ones that cross a state line
 * are drawn in brand and sit on top, because that is the claim the brief
 * actually asks about.
 */
const OUTLINE = outlineRaw as unknown as Feature<MultiPolygon>;

const W = 620;
const H = 700;

/**
 * Mercator distorts northward, so a chord drawn straight between two projected
 * points reads as a taut wire across a curved sheet. Bowing each arc
 * perpendicular to its chord, by an amount proportional to its length, restores
 * the appearance of a route rather than a rubber band -- and it separates the
 * many short corridors that would otherwise overprint each other into a legible
 * fan.
 */
function arc(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular unit vector, consistently to one side so the whole plan bows
  // the same way and the arcs nest instead of crossing at random.
  const bow = Math.min(len * 0.22, 56);
  const cx = (x1 + x2) / 2 + (-dy / len) * bow;
  const cy = (y1 + y2) / 2 + (dx / len) * bow;
  return `M${x1.toFixed(1)},${y1.toFixed(1)}Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

export default function HeroMap({
  snapshot,
  className,
}: {
  snapshot: NationalSnapshot;
  className?: string;
}) {
  // Fitted to the landmass rather than to the districts: this is a silhouette
  // first and a plot second, and a projection fitted to district centroids
  // crops the coastline in a way that looks like a rendering bug.
  const projection = geoMercator().fitExtent(
    [
      [26, 18],
      [W - 26, H - 18],
    ],
    OUTLINE,
  );

  const land = geoPath(projection)(OUTLINE) ?? '';

  const project = (lon: number, lat: number): [number, number] => {
    const p = projection([lon, lat]);
    return p ? [p[0], p[1]] : [0, 0];
  };

  const maxOrders = Math.max(...snapshot.crossDistrictLinks.map((l) => l.orders), 1);

  // Cross-state last so they paint on top of the intra-state traffic. Sorting
  // by the flag rather than filtering keeps every corridor on the sheet.
  const links = [...snapshot.crossDistrictLinks].sort(
    (a, b) => Number(a.crossState) - Number(b.crossState),
  );

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={className}
      role="img"
      aria-label={`Map of India showing ${snapshot.crossDistrictLinks.length} inter-district medicine redistribution corridors across ${snapshot.totals.districts} districts.`}
    >
      <defs>
        {/* A soft vertical fade so the plot dissolves into the page rather than
            ending on a hard edge where the SVG box stops. */}
        <linearGradient id="hero-land" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-ink-600)" stopOpacity="0.78" />
          <stop offset="100%" stopColor="var(--color-ink-700)" stopOpacity="0.3" />
        </linearGradient>
        <radialGradient id="hero-fade" cx="50%" cy="42%" r="62%">
          <stop offset="0%" stopColor="#fff" stopOpacity="1" />
          <stop offset="72%" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id="hero-mask">
          <rect width={W} height={H} fill="url(#hero-fade)" />
        </mask>
      </defs>

      <g mask="url(#hero-mask)">
        {/* Landmass. Filled faintly and stroked at a hairline: enough to read as
            a country, not enough to compete with the corridors on top of it. */}
        <path
          d={land}
          fill="url(#hero-land)"
          stroke="var(--color-ink-500)"
          strokeWidth={1}
          strokeLinejoin="round"
        />

        {/* Corridors. */}
        <g fill="none" strokeLinecap="round">
          {links.map((l, i) => {
            const [x1, y1] = project(l.fromLon, l.fromLat);
            const [x2, y2] = project(l.toLon, l.toLat);
            const weight = l.orders / maxOrders;

            return (
              <path
                key={`${l.fromDistrictCode}-${l.toDistrictCode}`}
                d={arc(x1, y1, x2, y2)}
                pathLength={1}
                className="arc-draw"
                stroke={l.crossState ? 'var(--color-brand)' : 'var(--color-mist-500)'}
                strokeWidth={0.5 + 1.9 * Math.sqrt(weight)}
                strokeOpacity={l.crossState ? 0.42 + 0.38 * weight : 0.16 + 0.26 * weight}
                style={{
                  // Staggered by index rather than by geography: a geographic
                  // sweep looks like the plan was computed north-to-south,
                  // which is a claim about the algorithm that is not true.
                  animationDelay: `${(i % 40) * 26}ms`,
                }}
              />
            );
          })}
        </g>

        {/* District nodes, after the routes have landed. */}
        <g>
          {snapshot.districts.map((d, i) => {
            const [x, y] = project(d.lon, d.lat);
            return (
              <circle
                key={d.districtCode}
                cx={x.toFixed(1)}
                cy={y.toFixed(1)}
                r={1.7}
                className="node-in"
                fill="var(--color-mist-300)"
                fillOpacity={0.5}
                style={{ animationDelay: `${900 + (i % 32) * 22}ms` }}
              />
            );
          })}
        </g>
      </g>
    </svg>
  );
}
