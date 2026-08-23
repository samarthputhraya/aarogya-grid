'use client';

import { useMemo, useState } from 'react';
import { geoMercator, geoPath } from 'd3-geo';
import type { FeatureCollection, Geometry } from 'geojson';
import indiaStatesRaw from '@/data/india-states.json';
import { riskColor, count, inr, compactCount } from '@/lib/format';

/**
 * National choropleth.
 *
 * Two layers, because they answer different questions:
 *   - State polygons, shaded by population-weighted risk. Answers "where is the
 *     problem, roughly?" at a glance from across a room.
 *   - District bubbles, sized by facilities tracked and coloured by the same
 *     ramp. Answers "which specific district?" and is the click target.
 *
 * States we hold no data for stay deliberately blank rather than being shaded
 * a default colour -- "no data" and "no problem" must never look alike on a map
 * a decision gets made from.
 */

const indiaStates = indiaStatesRaw as unknown as FeatureCollection<
  Geometry,
  { code: string | null; name: string }
>;

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
  stateRisk,
  metric = 'risk',
  onSelectDistrict,
  selectedDistrict,
}: {
  districts: MapDistrict[];
  stateRisk: Record<string, number>;
  metric?: MapMetric;
  onSelectDistrict?: (code: string) => void;
  selectedDistrict?: string | null;
}) {
  const [hover, setHover] = useState<MapDistrict | null>(null);

  const { pathFor, project } = useMemo(() => {
    const projection = geoMercator().fitSize([WIDTH, HEIGHT], indiaStates);
    const path = geoPath(projection);
    return {
      pathFor: (f: (typeof indiaStates)['features'][number]) => path(f) ?? '',
      project: (lon: number, lat: number) => projection([lon, lat]) ?? [0, 0],
    };
  }, []);

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

        {/* State polygons */}
        <g>
          {indiaStates.features.map((f, i) => {
            const code = f.properties.code;
            const risk = code ? stateRisk[code] : undefined;
            const hasData = risk !== undefined;
            return (
              <path
                key={f.properties.name + i}
                d={pathFor(f)}
                fill={hasData ? riskColor(risk) : 'var(--color-ink-850)'}
                fillOpacity={hasData ? 0.16 : 0.5}
                stroke="var(--color-ink-600)"
                strokeWidth={0.6}
              />
            );
          })}
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
