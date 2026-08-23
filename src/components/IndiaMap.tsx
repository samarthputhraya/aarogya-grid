'use client';

import { useMemo, useState } from 'react';
import { geoMercator } from 'd3-geo';
import { riskColor, count, inr, compactCount } from '@/lib/format';

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
 */

/** Districts are plotted from their real coordinates; nothing here is inferred. */
interface PointCollection {
  type: 'MultiPoint';
  coordinates: [number, number][];
}

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

const WIDTH = 720;
const HEIGHT = 780;

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
  switch (metric) {
    case 'risk':
      return d.meanRiskScore.toFixed(1);
    case 'critical':
      return count(d.criticalPositions);
    case 'waste':
      return inr(d.projectedWasteInr);
    case 'zero':
      return (d.zeroStockShare * 100).toFixed(1) + '%';
  }
}

export default function IndiaMap({
  districts,
  metric = 'risk',
  onSelectDistrict,
  selectedDistrict,
}: {
  districts: MapDistrict[];
  metric?: MapMetric;
  onSelectDistrict?: (code: string) => void;
  selectedDistrict?: string | null;
}) {
  const [hover, setHover] = useState<MapDistrict | null>(null);

  // Fit to the districts themselves. The inset leaves room for the largest
  // bubble radius plus its label, so edge districts are never clipped.
  const project = useMemo(() => {
    const points: PointCollection = {
      type: 'MultiPoint',
      coordinates: districts.map((d) => [d.lon, d.lat]),
    };
    const inset = 46;
    const projection = geoMercator().fitExtent(
      [
        [inset, inset],
        [WIDTH - inset, HEIGHT - inset],
      ],
      points,
    );
    return (lon: number, lat: number) => projection([lon, lat]) ?? [0, 0];
  }, [districts]);

  // One label per state, at the centroid of the districts we actually plot.
  // This is a readability aid derived from the data, not a boundary claim.
  const stateLabels = useMemo(() => {
    const acc = new Map<string, { x: number; y: number; n: number }>();
    for (const d of districts) {
      const [x, y] = project(d.lon, d.lat);
      const e = acc.get(d.stateName) ?? { x: 0, y: 0, n: 0 };
      acc.set(d.stateName, { x: e.x + x, y: e.y + y, n: e.n + 1 });
    }
    return [...acc.entries()].map(([name, v]) => ({
      name,
      x: v.x / v.n,
      y: v.y / v.n,
    }));
  }, [districts, project]);

  // Scale bubble radius by facility count, on a sqrt scale so area (not radius)
  // encodes magnitude -- radius-encoding exaggerates large values badly.
  const maxFacilities = useMemo(
    () => Math.max(1, ...districts.map((d) => d.facilities)),
    [districts],
  );

  // For non-risk metrics the colour ramp needs rescaling into the 0..40 band
  // the risk ramp expects, or every bubble comes out the same colour.
  const maxMetric = useMemo(
    () => Math.max(1, ...districts.map((d) => metricValue(d, metric))),
    [districts, metric],
  );

  const colorFor = (d: MapDistrict) => {
    if (metric === 'risk') return riskColor(d.meanRiskScore);
    return riskColor((metricValue(d, metric) / maxMetric) * 38);
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-auto"
        role="img"
        aria-label="Map of India showing district-level medicine stock risk"
      >
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* State labels, placed at the centroid of each state's own districts.
            Derived from the plotted points, so nothing here asserts a boundary. */}
        <g aria-hidden="true">
          {stateLabels.map((s) => (
            <text
              key={s.name}
              x={s.x}
              y={s.y}
              textAnchor="middle"
              className="fill-mist-500"
              style={{
                fontSize: 10,
                letterSpacing: '0.09em',
                textTransform: 'uppercase',
                pointerEvents: 'none',
              }}
            >
              {s.name}
            </text>
          ))}
        </g>

        {/* District bubbles */}
        <g>
          {districts.map((d) => {
            const [x, y] = project(d.lon, d.lat);
            const r = 3.2 + 6.5 * Math.sqrt(d.facilities / maxFacilities);
            const color = colorFor(d);
            const isSelected = selectedDistrict === d.code;
            const isHot = d.meanRiskScore >= 22;

            return (
              <g key={d.code}>
                {isHot && (
                  <circle
                    cx={x}
                    cy={y}
                    r={r}
                    fill="none"
                    stroke={color}
                    strokeWidth={1}
                    className="pulse-ring"
                    style={{ transformBox: 'fill-box' }}
                  />
                )}
                <circle
                  cx={x}
                  cy={y}
                  r={r}
                  fill={color}
                  fillOpacity={isSelected ? 1 : 0.78}
                  stroke={isSelected ? '#fff' : 'var(--color-ink-950)'}
                  strokeWidth={isSelected ? 1.6 : 0.7}
                  className="cursor-pointer transition-all"
                  filter={isSelected ? 'url(#glow)' : undefined}
                  onMouseEnter={() => setHover(d)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onSelectDistrict?.(d.code)}
                />
              </g>
            );
          })}
        </g>
      </svg>

      {/* Legend */}
      <div className="absolute bottom-2 left-2 panel px-3 py-2 text-[10px] pointer-events-none">
        <div className="text-mist-400 uppercase tracking-wider mb-1.5 font-semibold">
          {METRIC_LABEL[metric]}
        </div>
        <div className="flex items-center gap-1">
          {['#34d399', '#a3d977', '#ffd23f', '#ff9838', '#ff7a45', '#ff4d5e'].map((c) => (
            <span key={c} className="w-6 h-2 rounded-[1px]" style={{ background: c }} />
          ))}
        </div>
        <div className="flex justify-between text-mist-400 mt-1">
          <span>lower</span>
          <span>higher</span>
        </div>
        <div className="mt-2 pt-2 border-t border-ink-700 text-mist-400">
          bubble size = facilities tracked
        </div>
      </div>

      {/* Hover card */}
      {hover && (
        <div className="absolute top-2 right-2 panel px-3 py-2 text-xs pointer-events-none min-w-[190px]">
          <div className="font-semibold text-mist-100">{hover.name}</div>
          <div className="text-mist-400 text-[11px] mb-2">{hover.stateName}</div>
          <dl className="space-y-1">
            <Row label={METRIC_LABEL[metric]} value={metricDisplay(hover, metric)} />
            <Row label="Facilities" value={count(hover.facilities)} />
            <Row label="Critical" value={count(hover.criticalPositions)} />
            <Row label="Population" value={compactCount(hover.population)} />
          </dl>
          <div className="text-[10px] text-mist-400 mt-2 pt-2 border-t border-ink-700">
            click to open district
          </div>
        </div>
      )}
    </div>
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
