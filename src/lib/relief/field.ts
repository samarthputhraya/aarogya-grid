import type { NationalSnapshot } from '@/lib/snapshot-types';
import { riskRgba, BRAND, BRAND_DIM, type RGBA } from '@/lib/relief/palette';

/**
 * The snapshot, reshaped into what the relief layers consume.
 *
 * Everything here is a pure transform of the shipped payload -- no figure is typed,
 * for the same reason `lib/landing-figures.ts` exists. It runs once per snapshot,
 * not per frame; the layers read the precomputed rows and pick a channel.
 *
 * HEIGHT IS PROPORTIONAL, NOT STRETCHED
 * -------------------------------------
 * The tempting normalisation for a skyline is `(v - min) / (max - min)`, because it
 * always fills the full visual range. It is also a lie: it draws the least-critical
 * district at zero height, which reads as "nothing wrong here" when the real value is
 * 17 critical positions. So heights are `v / max` throughout -- the shortest column
 * is 18% of the tallest rather than 0%, and a column of zero height means the
 * quantity is actually zero.
 *
 * That matters most on the corridor channel, where 22 of 128 districts genuinely do
 * send nothing across their own boundary. Those stay flat while everything around
 * them rises, and it is a true statement about the plan rather than a floor artefact.
 */

export interface DistrictRow {
  code: string;
  name: string;
  stateName: string;
  /** `[lon, lat]`, the order deck.gl expects. */
  position: [number, number];
  fill: RGBA;
  riskScore: number;
  criticalPositions: number;
  crossDistrictTrips: number;
  population: number;
  /** 0..1 height channels, precomputed so the render path does no arithmetic. */
  hCritical: number;
  hCorridor: number;
}

export interface CorridorRow {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  source: [number, number];
  target: [number, number];
  crossState: boolean;
  orders: number;
  trips: number;
  units: number;
  /** 0..1, drives arc apex height. */
  weight: number;
  colour: RGBA;
}

export interface ReliefField {
  districts: DistrictRow[];
  corridors: CorridorRow[];
  /** Ranked worst-first. The a11y list and the keyboard order both use this. */
  byRisk: DistrictRow[];
}

export function buildField(snapshot: NationalSnapshot): ReliefField {
  const maxCritical = Math.max(...snapshot.districts.map((d) => d.criticalPositions), 1);
  const maxCross = Math.max(...snapshot.districts.map((d) => d.crossDistrictTrips), 1);

  const districts: DistrictRow[] = snapshot.districts.map((d) => ({
    code: d.districtCode,
    name: d.districtName,
    stateName: d.stateName,
    position: [d.lon, d.lat],
    fill: riskRgba(d.meanRiskScore),
    riskScore: d.meanRiskScore,
    criticalPositions: d.criticalPositions,
    crossDistrictTrips: d.crossDistrictTrips,
    population: d.population,
    hCritical: d.criticalPositions / maxCritical,
    hCorridor: d.crossDistrictTrips / maxCross,
  }));

  const maxOrders = Math.max(...snapshot.crossDistrictLinks.map((l) => l.orders), 1);

  // Sorted so cross-state corridors are appended last and therefore drawn on top.
  // Sorting on a copy: the snapshot array belongs to the caller.
  const corridors: CorridorRow[] = [...snapshot.crossDistrictLinks]
    .sort((a, b) => Number(a.crossState) - Number(b.crossState))
    .map((l) => {
      const weight = l.orders / maxOrders;
      return {
        from: l.fromDistrictCode,
        to: l.toDistrictCode,
        fromName: l.fromDistrictName,
        toName: l.toDistrictName,
        source: [l.fromLon, l.fromLat] as [number, number],
        target: [l.toLon, l.toLat] as [number, number],
        crossState: l.crossState,
        orders: l.orders,
        trips: l.trips,
        units: l.units,
        weight,
        // Brand for the crossings the brief actually asks about, dim brand for the
        // rest. This is the one place a second hue is permitted, and it is still
        // inside the existing brand pair rather than a new colour.
        colour: l.crossState
          ? ([...BRAND.slice(0, 3), 120 + Math.round(110 * weight)] as RGBA)
          : ([...BRAND_DIM.slice(0, 3), 55 + Math.round(90 * weight)] as RGBA),
      };
    });

  const byRisk = [...districts].sort((a, b) => b.riskScore - a.riskScore);

  return { districts, corridors, byRisk };
}

/**
 * The five beats of the landing sequence.
 *
 * `released` is not a beat -- it is what the field becomes once the sequence ends,
 * and `/console` starts there without ever entering the sequence at all.
 */
export type Beat = 0 | 1 | 2 | 3 | 4;

export interface BeatConfig {
  /** Which precomputed height channel the columns use. */
  height: 'none' | 'critical' | 'corridor';
  /** Fraction of corridors drawn, 0..1 -- animated across beat 3. */
  corridorReveal: number;
  /** Columns desaturate toward ink when the corridors become the subject. */
  columnAlpha: number;
}

export const BEATS: Record<Beat, BeatConfig> = {
  // 0 · the country at rest. No columns: the reader has not been told what is wrong yet.
  0: { height: 'none', corridorReveal: 0, columnAlpha: 190 },
  // 1 · the failure. Columns extrude to criticality and the ramp lights up.
  1: { height: 'critical', corridorReveal: 0, columnAlpha: 235 },
  // 2 · hold on the failure while the copy makes the surplus argument.
  2: { height: 'critical', corridorReveal: 0, columnAlpha: 235 },
  // 3 · the plan. Corridors draw in; columns recede so the arcs are the subject.
  3: { height: 'critical', corridorReveal: 1, columnAlpha: 150 },
  // 4 · the cost, and release. Height re-encodes to what each district actually
  //     sends across its own boundary -- the 22 self-sufficient ones fall flat.
  4: { height: 'corridor', corridorReveal: 1, columnAlpha: 200 },
};

export function heightFor(row: DistrictRow, beat: BeatConfig): number {
  switch (beat.height) {
    case 'critical':
      return row.hCritical;
    case 'corridor':
      return row.hCorridor;
    default:
      return 0;
  }
}
