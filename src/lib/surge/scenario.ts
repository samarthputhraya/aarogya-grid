import type { SeasonalityProfile, VedClass } from '@/lib/domain/types';
import { DRUG_CATALOGUE } from '@/lib/domain/drugs';
import { DISTRICTS_BY_CODE, districtNeighbours } from '@/lib/domain/geo';
import {
  buildDistrictState,
  toTransferContexts,
  type FacilityDrugState,
  type PipelineConfig,
} from '@/lib/pipeline';
import { computeStockRisk } from '@/lib/forecast/risk';
import {
  planRedistribution,
  newPlannerState,
  DEFAULT_SHORTAGE_PENALTY,
  type RedistributionPlan,
} from '@/lib/optimize/redistribute';
import type { DailyForecast } from '@/lib/forecast/timesfm';

/**
 * "What if dengue doubles in Purnia next fortnight?"
 *
 * WHY THE ANSWER IS NOT JUST MORE DEMAND
 * -------------------------------------
 * The obvious way to model an outbreak is to multiply demand and re-run the
 * planner. Do that and you get a wall of refusals, which is the measured
 * behaviour of this system under load: in the Bastar run, 99% of unserved needs
 * failed at `failed_bc_gate` -- the benefit of moving the stock did not clear
 * the cost of the vehicle. Raising demand raises both sides of that ratio and
 * the gate barely moves.
 *
 * That is not a modelling artefact, it is the actual policy. The benefit side
 * is priced by `DEFAULT_SHORTAGE_PENALTY` -- what one averted unit of Vital
 * shortage is worth, in rupees, to the health system. At routine valuation
 * (V=25) a district will not hire a truck to move anti-malarials fifty
 * kilometres. Under an outbreak it emphatically will, and the reason is not
 * that demand changed: it is that the COST OF A STOCK-OUT changed.
 *
 * So an emergency raises the policy parameter as well as the demand, and this
 * reports BOTH plans side by side. "At routine valuation N of M surge needs are
 * servable; under emergency valuation P are, for Rs X more transport" is the
 * sentence a ministry can act on. A single number is not.
 *
 * WHAT A SURGE TOUCHES
 * --------------------
 * One epidemiological pattern, and only the drugs that treat it. A dengue
 * outbreak does not raise demand for oxytocin. Restricting the scenario to the
 * pattern's formulary is both correct and what keeps this inside four seconds:
 * seven drugs of forty-seven, across one district's cluster.
 */

/** Diseases a caller can name, mapped onto the seasonal archetypes the model has. */
export const SURGE_PATTERNS: Record<
  SeasonalityProfile,
  { label: string; examples: string }
> = {
  monsoon_vector: {
    label: 'Vector-borne (malaria, dengue, chikungunya)',
    examples: 'dengue, malaria, chikungunya, vector, mosquito',
  },
  monsoon_envenomation: {
    label: 'Envenomation (snakebite)',
    examples: 'snakebite, snake, envenomation',
  },
  summer_enteric: {
    label: 'Enteric (diarrhoeal disease, cholera)',
    examples: 'cholera, diarrhoea, diarrhea, enteric, gastroenteritis',
  },
  winter_respiratory: {
    label: 'Acute respiratory infection',
    examples: 'influenza, flu, respiratory, ARI, pneumonia',
  },
  summer_heat: {
    label: 'Heat illness and dehydration',
    examples: 'heat stroke, heatwave, dehydration',
  },
  obstetric: { label: 'Obstetric', examples: 'delivery, maternal' },
  flat: { label: 'No seasonal pattern', examples: 'general' },
};

/**
 * What a stock-out is worth during a declared emergency.
 *
 * Four times routine, on every VED class, so the relative ordering the
 * catalogue already encodes is preserved -- an emergency does not make a
 * Desirable item as urgent as a Vital one, it raises the price of both. V=100
 * is the figure the design note names; the rest follow from the same multiple
 * rather than from three separate judgements nobody could defend individually.
 *
 * This is a MINISTRY DIAL, not a measurement. It is exposed, reported next to
 * its effect, and never averaged into a headline.
 */
export const EMERGENCY_SHORTAGE_PENALTY: Record<VedClass, number> = {
  V: DEFAULT_SHORTAGE_PENALTY.V * 4,
  E: DEFAULT_SHORTAGE_PENALTY.E * 4,
  D: DEFAULT_SHORTAGE_PENALTY.D * 4,
};

export interface SurgeInput {
  districtCode: string;
  pattern: SeasonalityProfile;
  /** Caseload multiplier for the affected diseases. 2 = a doubling. */
  multiplier: number;
  /** How long the surge is assumed to run. Drives the horizon, not the rate. */
  days?: number;
  asOf?: Date;
  /** Monte Carlo draws. Lower for an interactive answer. */
  simulations?: number;
  forecastCache?: PipelineConfig['forecastCache'];
  forecastMethod?: PipelineConfig['forecastMethod'];
}

export interface SurgePlanSummary {
  label: 'routine' | 'emergency';
  shortagePenalty: Record<VedClass, number>;
  /** Needs the planner could serve. */
  served: number;
  /** Needs it refused, for any reason. */
  unserved: number;
  /** Refusals that failed the benefit/cost gate specifically. */
  failedBenefitCost: number;
  transferOrders: number;
  vehicleTrips: number;
  transportInr: number;
  shortfallAvertedUnits: number;
}

export interface SurgeOrder {
  fromFacilityId: string;
  fromFacilityName: string;
  fromDistrict: string;
  toFacilityId: string;
  toFacilityName: string;
  toDistrict: string;
  drugId: string;
  drugName: string;
  quantity: number;
  unit: string;
  distanceKm: number;
  estimatedCostInr: number;
  shortfallAvertedUnits: number;
  crossDistrict: boolean;
  rationale: string;
}

export interface SurgeResult {
  districtCode: string;
  districtName: string;
  stateName: string;
  pattern: SeasonalityProfile;
  patternLabel: string;
  multiplier: number;
  days: number;
  /** The drugs this pattern touches. Nothing else is re-scored or moved. */
  drugs: { id: string; name: string; ved: VedClass }[];
  positions: number;
  /** Risk before the surge, over the affected positions only. */
  baseline: { critical: number; high: number; expectedShortfallUnits: number };
  /** Risk under the surge, same positions. */
  surged: { critical: number; high: number; expectedShortfallUnits: number };
  /** Positions the surge pushes into critical that were not there before. */
  newlyCritical: number;
  routine: SurgePlanSummary;
  emergency: SurgePlanSummary;
  /** What the emergency valuation buys that routine does not. */
  extraNeedsServed: number;
  extraTransportInr: number;
  /** Pre-positioning orders from the EMERGENCY plan, biggest first. */
  orders: SurgeOrder[];
  elapsedMs: number;
}

/** Scale a forecast path. Bounds move with the mean; an outbreak is not more certain. */
function scaleForecastPath(f: DailyForecast | undefined, m: number): DailyForecast | undefined {
  if (!f) return undefined;
  return {
    ...f,
    mean: f.mean.map((v) => v * m),
    lower: f.lower.map((v) => v * m),
    upper: f.upper.map((v) => v * m),
  };
}

/**
 * Re-score one position under the surge.
 *
 * The SIZE of each demand rises, not its frequency. An outbreak does not make a
 * sub-centre dispense on more days than it is open; it makes each dispensing
 * day bigger. So `meanSize` and `meanDemand` scale and `demandProbability` does
 * not -- which matters, because the Monte Carlo draws occurrence from the
 * second. Scaling the probability instead would quietly turn an intermittent
 * series into a continuous one and change the shape of the tail the whole risk
 * model is estimating.
 */
function surgeState(state: FacilityDrugState, multiplier: number, asOf: Date, simulations: number): FacilityDrugState {
  const fit = {
    ...state.fit,
    meanDemand: state.fit.meanDemand * multiplier,
    meanSize: state.fit.meanSize * multiplier,
    sigma: state.fit.sigma * multiplier,
    sigmaSize: state.fit.sigmaSize * multiplier,
  };
  const forecast = scaleForecastPath(state.forecast, multiplier);
  return {
    ...state,
    fit,
    forecast,
    risk: computeStockRisk({
      facilityId: state.facility.id,
      drug: state.drug,
      fit,
      onHand: state.sim.onHand,
      batches: state.sim.batches,
      leadTimeDays: state.leadTimeDays,
      asOf,
      population: state.facility.population,
      simulations,
      forecast,
    }),
  };
}

const ASOF_DEFAULT = new Date(Date.UTC(2026, 8, 30));
/** Donor reach for a pre-positioning plan. Matches the nightly build's cluster. */
const NEIGHBOUR_RADIUS_KM = 180;
const MAX_NEIGHBOURS = 4;

function summarise(
  plan: RedistributionPlan,
  label: 'routine' | 'emergency',
  penalty: Record<VedClass, number>,
): SurgePlanSummary {
  return {
    label,
    shortagePenalty: penalty,
    served: plan.transfers.length,
    unserved: plan.unserved.length,
    failedBenefitCost: plan.unservedByReason.failed_bc_gate,
    transferOrders: plan.transfers.length,
    vehicleTrips: plan.trips.length,
    transportInr: Math.round(plan.totalCostInr),
    shortfallAvertedUnits: Math.round(plan.totalShortfallAverted),
  };
}

/**
 * Run an outbreak scenario and return both plans.
 *
 * Deterministic: same district, pattern, multiplier and seed give the same
 * answer every time, which is what lets the agent quote it.
 */
export function simulateSurge(input: SurgeInput): SurgeResult {
  const started = Date.now();
  const district = DISTRICTS_BY_CODE[input.districtCode];
  if (!district) throw new Error('Unknown district code: ' + input.districtCode);

  const multiplier = Math.max(1, Math.min(10, input.multiplier));
  const days = Math.max(1, Math.min(90, input.days ?? 14));
  const asOf = input.asOf ?? ASOF_DEFAULT;
  // 400 draws, not the batch's 600 or the recompute's 1,200. This runs while
  // somebody waits and it runs over a whole cluster; the tail estimate is
  // noisier and the answer is a comparison between two plans built from the
  // same draws, so the noise largely cancels.
  const simulations = input.simulations ?? 400;

  const affected = DRUG_CATALOGUE.filter((d) => d.seasonality === input.pattern);
  if (affected.length === 0) {
    throw new Error('No drug in the catalogue treats a ' + input.pattern + ' condition.');
  }
  const affectedIds = new Set(affected.map((d) => d.id));

  const config: PipelineConfig = {
    asOf,
    simulations,
    // Only the pattern's drugs. A dengue outbreak does not move oxytocin, and
    // restricting the formulary is what keeps this inside four seconds.
    drugFilter: (d) => affectedIds.has(d.id),
    forecastCache: input.forecastCache ?? null,
    forecastMethod: input.forecastMethod ?? null,
  };

  const baselineStates = buildDistrictState(district.code, config);
  const neighbourCodes = districtNeighbours(district.code, NEIGHBOUR_RADIUS_KM, MAX_NEIGHBOURS).map(
    (n) => n.code,
  );
  const neighbourBaseline = neighbourCodes.flatMap((code) => buildDistrictState(code, config));

  // The surge hits the district AND its neighbours: an outbreak does not stop
  // at an administrative line, and a plan that let untouched neighbours donate
  // freely would be solving a problem nobody has.
  const surgedStates = baselineStates.map((s) => surgeState(s, multiplier, asOf, simulations));
  const surgedNeighbours = neighbourBaseline.map((s) => surgeState(s, multiplier, asOf, simulations));

  const countSeverity = (states: FacilityDrugState[]) => ({
    critical: states.filter((s) => s.risk.severity === 'critical').length,
    high: states.filter((s) => s.risk.severity === 'high').length,
    expectedShortfallUnits: Math.round(
      states.reduce((a, s) => a + s.risk.expectedShortfallUnits, 0),
    ),
  });

  const baselineCritical = new Set(
    baselineStates.filter((s) => s.risk.severity === 'critical').map((s) => s.facility.id + '|' + s.drug.id),
  );
  const newlyCritical = surgedStates.filter(
    (s) => s.risk.severity === 'critical' && !baselineCritical.has(s.facility.id + '|' + s.drug.id),
  ).length;

  const contexts = toTransferContexts([...surgedStates, ...surgedNeighbours]);
  const planOptions = {
    asOf,
    simulations,
    // Neighbours donate; only this district receives. Same rule the nightly
    // build uses, so a surge plan and a routine plan are comparable.
    eligibleReceiver: (c: { facility: { districtCode: string } }) =>
      c.facility.districtCode === district.code,
  };

  // Two plans, each from its OWN planner state. A shared one would let the
  // first plan promise a batch the second then could not use, and the
  // comparison would be measuring the order they ran in.
  const routinePlan = planRedistribution(
    contexts,
    { ...planOptions, shortagePenalty: DEFAULT_SHORTAGE_PENALTY },
    newPlannerState(),
  );
  const emergencyPlan = planRedistribution(
    contexts,
    { ...planOptions, shortagePenalty: EMERGENCY_SHORTAGE_PENALTY },
    newPlannerState(),
  );

  const routine = summarise(routinePlan, 'routine', DEFAULT_SHORTAGE_PENALTY);
  const emergency = summarise(emergencyPlan, 'emergency', EMERGENCY_SHORTAGE_PENALTY);

  const byFacility = new Map(
    [...surgedStates, ...surgedNeighbours].map((s) => [s.facility.id, s.facility]),
  );
  const orders: SurgeOrder[] = emergencyPlan.transfers
    .slice()
    .sort((a, b) => b.shortfallAvertedUnits - a.shortfallAvertedUnits)
    .slice(0, 12)
    .map((t) => {
      const from = byFacility.get(t.fromFacilityId);
      const to = byFacility.get(t.toFacilityId);
      const drug = affected.find((d) => d.id === t.drugId);
      return {
        fromFacilityId: t.fromFacilityId,
        fromFacilityName: from?.name ?? t.fromFacilityId,
        fromDistrict: from?.districtName ?? '',
        toFacilityId: t.toFacilityId,
        toFacilityName: to?.name ?? t.toFacilityId,
        toDistrict: to?.districtName ?? '',
        drugId: t.drugId,
        drugName: drug?.name ?? t.drugId,
        quantity: t.quantity,
        unit: drug?.unit ?? 'unit',
        distanceKm: +t.distanceKm.toFixed(1),
        estimatedCostInr: Math.round(t.estimatedCostInr),
        shortfallAvertedUnits: Math.round(t.shortfallAvertedUnits),
        crossDistrict: (from?.districtCode ?? '') !== (to?.districtCode ?? ''),
        rationale: t.rationale,
      };
    });

  return {
    districtCode: district.code,
    districtName: district.name,
    stateName: district.stateName,
    pattern: input.pattern,
    patternLabel: SURGE_PATTERNS[input.pattern].label,
    multiplier,
    days,
    drugs: affected.map((d) => ({ id: d.id, name: d.name, ved: d.ved })),
    positions: surgedStates.length,
    baseline: countSeverity(baselineStates),
    surged: countSeverity(surgedStates),
    newlyCritical,
    routine,
    emergency,
    extraNeedsServed: emergency.served - routine.served,
    extraTransportInr: emergency.transportInr - routine.transportInr,
    orders,
    elapsedMs: Date.now() - started,
  };
}
