/**
 * One district's demand series for `export-demand.mts`, as a pure task so the
 * export can run it on every core. See that script for what the numbers mean.
 */
import { DISTRICTS_BY_CODE } from '../../src/lib/domain/geo';
import { formularyFor } from '../../src/lib/domain/drugs';
import { generateNetwork, DEMO_SCALE } from '../../src/lib/sim/facilities';
import { simulateInventory } from '../../src/lib/sim/inventory';

export const SEED = 20260930;
export const HISTORY_DAYS = 365;

export interface DemandTask {
  code: string;
  asOfIso: string;
  windowDays: number;
}

export interface ExportedSeries {
  sid: string;
  districtCode: string;
  drugId: string;
  /** Facilities in the district whose formulary carries this drug. */
  carriers: number;
  /** Days where at least one carrier was stocked out and the ratio fired. */
  adjustedDays: number;
  /** Days where EVERY carrier was stocked out. The value is a lower bound. */
  blindDays: number;
  values: number[];
}

export interface DemandTaskResult {
  series: ExportedSeries[];
  totalFacilityDays: number;
  censoredFacilityDays: number;
}

export default function demandForDistrict(task: DemandTask): DemandTaskResult {
  const district = DISTRICTS_BY_CODE[task.code];
  const asOf = new Date(task.asOfIso + 'T00:00:00Z');
  const WINDOW_DAYS = task.windowDays;
  const sliceFrom = HISTORY_DAYS - WINDOW_DAYS;
  const facilities = generateNetwork(DEMO_SCALE, [district], SEED);

  const openIssues = new Map<string, Float64Array>();
  const openCount = new Map<string, Int32Array>();
  const rawIssues = new Map<string, Float64Array>();
  const carriers = new Map<string, number>();
  let totalFacilityDays = 0;
  let censoredFacilityDays = 0;

  for (const facility of facilities) {
    for (const drug of formularyFor(facility.type)) {
      const sim = simulateInventory(facility, drug, { asOf, historyDays: HISTORY_DAYS, seed: SEED });

      let open = openIssues.get(drug.id);
      if (!open) {
        open = new Float64Array(WINDOW_DAYS);
        openIssues.set(drug.id, open);
        openCount.set(drug.id, new Int32Array(WINDOW_DAYS));
        rawIssues.set(drug.id, new Float64Array(WINDOW_DAYS));
        carriers.set(drug.id, 0);
      }
      const counts = openCount.get(drug.id)!;
      const raw = rawIssues.get(drug.id)!;
      carriers.set(drug.id, carriers.get(drug.id)! + 1);

      for (let d = 0; d < WINDOW_DAYS; d++) {
        const idx = sliceFrom + d;
        const issued = sim.recordedSeries[idx];
        raw[d] += issued;
        if (!sim.censoredMask[idx]) {
          open[d] += issued;
          counts[d] += 1;
        }
      }
      totalFacilityDays += WINDOW_DAYS;
      for (let d = sliceFrom; d < HISTORY_DAYS; d++) {
        if (sim.censoredMask[d]) censoredFacilityDays++;
      }
    }
  }

  const series: ExportedSeries[] = [];
  for (const [drugId, open] of openIssues) {
    const counts = openCount.get(drugId)!;
    const raw = rawIssues.get(drugId)!;
    const n = carriers.get(drugId)!;
    const values: number[] = new Array(WINDOW_DAYS);
    let adjustedDays = 0;
    let blindDays = 0;
    for (let d = 0; d < WINDOW_DAYS; d++) {
      if (counts[d] === 0) {
        // Every carrier dark. Nothing to scale from, so the raw total stands --
        // a lower bound, and counted as one so the artefact says how often.
        values[d] = Math.round(raw[d]);
        blindDays++;
      } else {
        if (counts[d] < n) adjustedDays++;
        values[d] = Math.round((open[d] * n) / counts[d]);
      }
    }
    series.push({ sid: district.code + '|' + drugId, districtCode: district.code, drugId, carriers: n, adjustedDays, blindDays, values });
  }
  return { series, totalFacilityDays, censoredFacilityDays };
}
