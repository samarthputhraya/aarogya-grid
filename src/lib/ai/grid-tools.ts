import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { FunctionDeclaration } from '@google/genai';
import type { DistrictDetail, DispatchOrder, PositionRow, FacilityRow } from '@/lib/district-detail';
import type { NationalSnapshot, DistrictSnapshot } from '@/lib/snapshot-types';
import type { UnservedNeed, UnservedReason } from '@/lib/optimize/redistribute';
import { DISTRICTS_BY_CODE } from '@/lib/domain/geo';
import { getDrug } from '@/lib/domain/drugs';
import { FACILITY_LABEL, VED_LABEL } from '@/lib/format';
import { resolveDrug, AUTO_ACCEPT } from './resolve';
import { resolveDistrict, resolveFacility, PLACE_AUTO_ACCEPT } from './resolve-place';
import { geminiSchema } from './schemas';

/**
 * The tool surface the Gemini grid agent operates through.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The forecasting, the Monte Carlo risk model and the redistribution optimiser
 * are deterministic TypeScript, and they stay that way. What they produce is a
 * 100 KB JSON file per district containing 140 stock positions, 36 dispatch
 * orders and 40 needs the optimiser declined -- which is to say, the most
 * valuable output in the system is a table no District Health Officer will ever
 * read. These tools are how a model reads it for them.
 *
 * THE ONE RULE
 * ------------
 * Gemini never invents, estimates or manipulates a quantity. Every number that
 * reaches the officer was computed by the pipeline, serialised to disk, and
 * COPIED here -- no sums, no averages, no unit conversions, no "roughly". The
 * only transformations these functions perform are filtering, sorting, capping
 * and renaming, all of which are order-preserving on values that already exist.
 * Where a genuinely derived figure is useful (the weekly means in
 * `explain_forecast`, the percentage form of every probability) it is computed
 * in this file, in TypeScript, deterministically -- never by asking the model to
 * do arithmetic in prose. That is the general remedy whenever the model is
 * caught calculating: the figure it wanted was the right one to say, so compute
 * it here and let it quote. See `percent()`.
 *
 * NO IDENTIFIER EVER REACHES THE MODEL
 * -------------------------------------
 * Every argument these tools take is a natural-language name, and every result
 * they return has had district codes, facility ids and drug ids stripped out.
 * This is the direct extension of `resolve.ts`'s thesis, and it is not
 * theoretical: in live testing the agent, asked a question with no answer in
 * this system, called a tool with `districtCode: "Lucknow"` -- a fabricated
 * identifier, confidently formatted. A model that has never been shown a code
 * cannot echo one back, and a model that must name a place in words can be
 * checked against a registry. Resolution happens in `resolve.ts` and
 * `resolve-place.ts`, deterministically, on the way in.
 *
 * EVERY RESULT IS STAMPED
 * -----------------------
 * Each payload carries `asOf` and `builtAt`. An answer about a stock position
 * is worthless without knowing the position is from last night's batch, and the
 * only way the model can say so is if the tool tells it every time.
 */

/** Hard caps. A tool that can return 140 rows will eventually be asked to. */
const MAX_POSITION_ROWS = 15;
const MAX_ORDER_ROWS = 10;
const MAX_UNSERVED_ROWS = 10;
const MAX_TOP_DISTRICTS = 10;

export class ToolError extends Error {
  constructor(
    message: string,
    /** Machine-readable so the agent loop can classify without parsing prose. */
    readonly code:
      | 'unknown_district'
      | 'ambiguous_district'
      | 'identifier_rejected'
      | 'unknown_facility'
      | 'ambiguous_facility'
      | 'unknown_drug'
      | 'no_data',
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * What a tool hands back.
 *
 * `data` goes to the model. `summary` and `rows` go to the audit trail and are
 * written by THIS code, never by the model -- in testing the agent cheerfully
 * reported using a tool called `default_api:list_critical_positions`, a name it
 * had invented a namespace prefix for. A trace quoted from the model is not a
 * trace, it is another generation.
 *
 * `grounded` is the set of names this tool actually put in front of the model.
 * The agent loop unions these across a run and uses them to check the citations
 * the model claims, so a facility it never saw cannot appear in the answer.
 */
export interface ToolOutcome {
  data: Record<string, unknown>;
  summary: string;
  rows: number;
  grounded: { facilities: string[]; drugs: string[] };
}

export interface GridToolContext {
  /**
   * The district console the officer is looking at. Used when a tool call omits
   * the district, which is the common case -- "what am I short of?" said while
   * looking at Lucknow means Lucknow, and making the model repeat it is a way
   * of inviting it to get it wrong.
   */
  districtCode: string | null;
}

export interface GridTool {
  name: string;
  description: string;
  args: z.ZodType;
  run: (args: never, ctx: GridToolContext) => Promise<ToolOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Data access                                                                 */
/* -------------------------------------------------------------------------- */

/*
 * Read the same files the consoles read, cached in module scope.
 *
 * `buildDistrictState` + `planRedistribution` would recompute all of this from
 * scratch in about 1.7 s per district, deterministically and byte-identically.
 * That is a fine trade for a page build and a terrible one inside a chat turn
 * that already spends two round trips waiting on a model, so the agent reads
 * the batch output exactly as `src/app/district/[code]/page.tsx` does.
 */
const districtCache = new Map<string, DistrictDetail>();
let nationalCache: Promise<NationalSnapshot> | null = null;

function dataPath(...parts: string[]): string {
  return join(process.cwd(), 'src', 'data', ...parts);
}

async function loadNational(): Promise<NationalSnapshot> {
  if (!nationalCache) {
    nationalCache = readFile(dataPath('national-snapshot.json'), 'utf8').then(
      (raw) => JSON.parse(raw) as NationalSnapshot,
    );
  }
  return nationalCache;
}

async function loadDistrict(code: string): Promise<DistrictDetail> {
  const cached = districtCache.get(code);
  if (cached) return cached;

  try {
    const raw = await readFile(dataPath('districts', code + '.json'), 'utf8');
    const detail = JSON.parse(raw) as DistrictDetail;
    districtCache.set(code, detail);
    return detail;
  } catch {
    // The code came out of the registry, so a miss means the snapshot build has
    // not run for this district -- an operational fact worth stating plainly
    // rather than a stack trace.
    throw new ToolError(
      'No computed snapshot exists for ' +
        (DISTRICTS_BY_CODE[code]?.name ?? code) +
        '. The nightly build may not have covered it.',
      'no_data',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Argument resolution                                                         */
/* -------------------------------------------------------------------------- */

interface ResolvedContext {
  detail: DistrictDetail;
  districtName: string;
  stateName: string;
}

/**
 * Turn a spoken district name (or the console's own district) into real data.
 *
 * Ambiguity is thrown back at the model as an error rather than guessed,
 * because the model's next move is then to ask the officer -- which is the
 * correct behaviour for "Bijapur", a name two states have used.
 */
async function districtContext(
  arg: string | undefined,
  ctx: GridToolContext,
): Promise<ResolvedContext> {
  const query = arg?.trim();

  if (!query) {
    if (!ctx.districtCode) {
      throw new ToolError(
        'No district was given and no district is open. Name the district in the `district` argument.',
        'unknown_district',
      );
    }
    const info = DISTRICTS_BY_CODE[ctx.districtCode];
    const detail = await loadDistrict(ctx.districtCode);
    return { detail, districtName: info?.name ?? detail.district.districtName, stateName: info?.stateName ?? detail.district.stateName };
  }

  const resolution = resolveDistrict(query);

  if (resolution.rejectedAsIdentifier) {
    throw new ToolError(
      'That looks like a district code, and codes are not accepted here. ' +
        'Pass the district NAME as a person would say it, e.g. "Lucknow".',
      'identifier_rejected',
    );
  }
  if (!resolution.best) {
    throw new ToolError(
      'No district in this grid matches "' + query + '". It covers 128 districts across 16 states.',
      'unknown_district',
    );
  }
  if (resolution.needsConfirmation) {
    const options = [resolution.best, ...resolution.alternatives]
      .map((r) => r.district.name + ' (' + r.district.stateName + ')')
      .join(', ');
    throw new ToolError(
      '"' + query + '" is ambiguous. Ask the officer which one is meant: ' + options + '.',
      'ambiguous_district',
    );
  }

  const info = resolution.best.district;
  return { detail: await loadDistrict(info.code), districtName: info.name, stateName: info.stateName };
}

/** Resolve a drug name to a catalogue id, or refuse. Never the model's job. */
function drugIdFor(name: string): { drugId: string; drugName: string; confidence: number } {
  const resolution = resolveDrug(name);
  if (!resolution.best) {
    throw new ToolError('No drug in the catalogue matches "' + name + '".', 'unknown_drug');
  }
  if (resolution.best.confidence < AUTO_ACCEPT) {
    const options = [resolution.best, ...resolution.alternatives].map((r) => r.drug.name).join(', ');
    throw new ToolError(
      '"' + name + '" does not clearly match one catalogue item. Candidates: ' + options + '.',
      'unknown_drug',
    );
  }
  return {
    drugId: resolution.best.drug.id,
    drugName: resolution.best.drug.name,
    confidence: resolution.best.confidence,
  };
}

/* -------------------------------------------------------------------------- */
/* Projections -- the id-stripping layer                                       */
/* -------------------------------------------------------------------------- */

/**
 * `-1` is the pipeline's sentinel for "no measurable demand, so cover is
 * infinite". Handing a model a negative number of days and a footnote is asking
 * for it to be quoted as "-1 days of cover"; `null` plus an explicit note is
 * not quotable as a quantity at all.
 */
function daysOfCover(value: number): number | null {
  return value >= 0 ? value : null;
}

/**
 * The percentage form of a probability or share, computed HERE.
 *
 * Caught in live testing on Bastar: handed `stockoutProbability: 0.998`, the
 * model wrote "a 99.8% stock-out probability". The figure was arithmetically
 * perfect and it was still a rule-1 violation -- the model multiplied by a
 * hundred, and a model that will do that will do it to a quantity next.
 *
 * Forbidding it harder is the wrong fix, because the model is not being
 * disobedient: an officer does not think in probabilities, so "99.8%" is the
 * genuinely correct thing to say and 0.998 is not. The right fix is the one
 * `explain_forecast`'s weekly means already use -- do the arithmetic in
 * TypeScript, deterministically, and hand the model the answer. Every payload
 * that carries a probability now carries its percentage alongside, so quoting
 * is always available and converting is never necessary.
 *
 * Returned as a STRING, with the sign attached. A number would be one more
 * thing to do arithmetic to; a string is only quotable.
 */
function percent(value: number): string {
  return Number((value * 100).toFixed(1)) + '%';
}

function positionView(p: PositionRow) {
  return {
    facility: p.facilityName,
    facilityTier: FACILITY_LABEL[p.facilityType] ?? p.facilityType,
    drug: p.drugName,
    strength: p.drugStrength,
    unit: p.unit,
    criticality: VED_LABEL[p.ved] ?? p.ved,
    onHand: p.onHand,
    daysOfCover: daysOfCover(p.daysOfCover),
    daysOfCoverNote: p.daysOfCover >= 0 ? '' : 'no measurable demand in the last year',
    reorderPoint: p.reorderPoint,
    forecastDailyDemand: p.forecastDailyDemand,
    leadTimeDays: p.leadTimeDays,
    stockoutProbability: p.stockoutProbability,
    stockoutProbabilityPercent: percent(p.stockoutProbability),
    expectedShortfallUnits: p.expectedShortfallUnits,
    projectedExpiryWasteUnits: p.projectedExpiryWaste,
    riskScore: p.riskScore,
    severity: p.severity,
    demandPattern: p.demandPattern,
    forecastMethod: p.forecastMethod,
    censoredDaysInHistory: p.censoredDays,
  };
}

function orderView(o: DispatchOrder) {
  return {
    from: o.from.name,
    fromTier: FACILITY_LABEL[o.from.type] ?? o.from.type,
    to: o.to.name,
    toTier: FACILITY_LABEL[o.to.type] ?? o.to.type,
    drug: o.drugName,
    strength: o.drugStrength,
    unit: o.unit,
    criticality: VED_LABEL[o.ved] ?? o.ved,
    coldChain: o.coldChain,
    quantity: o.quantity,
    // The batch pick list is the difference between "move some paracetamol" and
    // an instruction a storekeeper can execute without opening a second system.
    batches: o.lines.map((l) => ({
      batchNo: l.batchNo,
      quantity: l.quantity,
      expiryDate: l.expiryDate,
      daysToExpiry: l.daysToExpiry,
    })),
    distanceKm: o.distanceKm,
    estimatedCostInr: o.estimatedCostInr,
    wasteAvertedUnits: o.wasteAvertedUnits,
    riskReduction: o.riskReduction,
    riskReductionPercent: percent(o.riskReduction),
    receiverOnHandBefore: o.receiverOnHandBefore,
    receiverStockoutProbBefore: o.receiverStockoutProbBefore,
    receiverStockoutProbBeforePercent: percent(o.receiverStockoutProbBefore),
    // Verbatim, and it must stay verbatim. This sentence was written at the
    // moment of the decision, from the samples that decision was made against.
    // A model that re-derives it produces a sentence that quietly disagrees
    // with the plan it describes -- which is the one failure this whole design
    // exists to prevent.
    rationale: o.rationale,
  };
}

/**
 * Plain-English gloss for each reason the optimiser declined a need.
 *
 * Copied from the taxonomy comment in `redistribute.ts`, because the difference
 * between "the stock does not exist" and "the stock exists and the trip costs
 * more than the medicine" is the difference between an indent and a policy
 * change, and the officer must not have to infer which one `failed_bc_gate`
 * means.
 */
const REASON_GLOSS: Record<UnservedReason, string> = {
  no_surplus: 'Nobody else in the district holds this item above their own reorder point. The stock does not exist here.',
  donor_stock_committed: 'Stock existed when planning began, but facilities in worse shape were served first.',
  out_of_range: 'Surplus exists, but every holder is beyond the road-distance cap for a transfer.',
  cold_chain_range: 'Surplus exists, but no holder is within the much tighter cold-box distance cap.',
  no_usable_batch: 'A donor is close enough, but no batch would survive the trip with usable shelf life left.',
  failed_bc_gate: 'A transfer was possible and was rejected on economics: the medicine is worth less than the trip. This is a procurement decision, not a logistics one.',
};

function unservedView(u: UnservedNeed) {
  return {
    facility: u.facilityName,
    facilityTier: FACILITY_LABEL[u.facilityType] ?? u.facilityType,
    drug: u.drugName,
    unit: u.unit,
    criticality: VED_LABEL[u.ved] ?? u.ved,
    neededUnits: u.neededUnits,
    expectedShortfallUnits: u.expectedShortfallUnits,
    stockoutProbability: u.stockoutProbability,
    stockoutProbabilityPercent: percent(u.stockoutProbability),
    onHand: u.onHand,
    reason: u.reason,
    reasonMeaning: REASON_GLOSS[u.reason],
    nearestDonorKm: u.nearestDonorKm,
    bestBenefitCostRatio: u.bestBenefitCostRatio,
  };
}

function districtView(d: DistrictSnapshot) {
  return {
    district: d.districtName,
    state: d.stateName,
    population: d.population,
    facilities: d.facilities,
    trackedPositions: d.trackedPositions,
    criticalPositions: d.criticalPositions,
    highPositions: d.highPositions,
    meanRiskScore: d.meanRiskScore,
    zeroStockShare: d.zeroStockShare,
    zeroStockSharePercent: percent(d.zeroStockShare),
    expectedShortfallUnits: d.expectedShortfallUnits,
    projectedWasteInr: d.projectedWasteInr,
    reliability: d.reliability,
    pullFraction: d.pullFraction,
    transfers: d.transfers,
    transportCostInr: d.transportCostInr,
    wasteAvertedInr: d.wasteAvertedInr,
    shortfallAvertedUnits: d.shortfallAverted,
    netBenefitInr: d.netBenefitInr,
  };
}

function stamp(detail: DistrictDetail) {
  return { asOf: detail.asOf, builtAt: detail.builtAt };
}

/* -------------------------------------------------------------------------- */
/* The tools                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Argument schemas.
 *
 * One Zod object per tool serves both directions: `geminiSchema()` turns it
 * into the JSON Schema the declaration carries, and the same object validates
 * whatever comes back before it touches real data. Two schemas would eventually
 * disagree, and the half that drifts is always the validating half.
 *
 * Everything optional is `.optional()` rather than `.default()`, because
 * `geminiSchema` strips `default` from the JSON Schema it emits -- a default
 * declared here would be invisible to the model and applied silently on the way
 * back, which is a difference between what was asked for and what was done.
 */
const DistrictArg = z
  .string()
  .describe('District name as a person would say it, e.g. "Lucknow" or "Bastar". Never a code. Omit to use the district currently open.');

const ResolveDistrictArgs = z.object({
  query: z.string().describe('The place name the officer used, exactly as they said it.'),
});

const NationalOverviewArgs = z.object({
  rankBy: z
    .enum(['risk', 'critical', 'shortfall', 'waste', 'netBenefit'])
    .optional()
    .describe('How to rank districts. Defaults to risk.'),
  limit: z.number().int().min(1).max(MAX_TOP_DISTRICTS).optional(),
});

const DistrictStatusArgs = z.object({ district: DistrictArg.optional() });

const ListPositionsArgs = z.object({
  district: DistrictArg.optional(),
  severity: z.enum(['critical', 'high']).optional(),
  criticality: z
    .enum(['V', 'E', 'D'])
    .optional()
    .describe('VED class: V = Vital, E = Essential, D = Desirable.'),
  drug: z.string().optional().describe('Drug name in plain words, e.g. "ORS" or "anti snake venom". Never a code.'),
  facilityTier: z.enum(['SC', 'PHC', 'CHC', 'SDH', 'DH', 'DW']).optional(),
  limit: z.number().int().min(1).max(MAX_POSITION_ROWS).optional(),
});

const ListOrdersArgs = z.object({
  district: DistrictArg.optional(),
  drug: z.string().optional().describe('Drug name in plain words. Never a code.'),
  facility: z.string().optional().describe('Facility name in plain words, e.g. "SC Lucknow-04". Never an id.'),
  limit: z.number().int().min(1).max(MAX_ORDER_ROWS).optional(),
});

const UnmetNeedArgs = z.object({
  district: DistrictArg.optional(),
  drug: z.string().optional().describe('Drug name in plain words. Never a code.'),
  limit: z.number().int().min(1).max(MAX_UNSERVED_ROWS).optional(),
});

const FacilitySnapshotArgs = z.object({
  district: DistrictArg.optional(),
  facility: z.string().describe('Facility name in plain words, e.g. "SC Lucknow-04" or "the district hospital". Never an id.'),
});

const ExplainForecastArgs = z.object({ district: DistrictArg.optional() });

const DrugReferenceArgs = z.object({
  name: z.string().describe('Drug name, brand name or vernacular term, e.g. "lal goli", "Monocef".'),
});

function pluralRows(n: number, noun: string): string {
  return n + ' ' + noun + (n === 1 ? '' : 's');
}

export const GRID_TOOLS: GridTool[] = [
  {
    name: 'resolve_district',
    description:
      'Check which district a place name refers to before using it. Returns the matched district, ' +
      'its state and modelled population, plus near-matches when the name is ambiguous. ' +
      'Use this when the officer names a place you are not sure about.',
    args: ResolveDistrictArgs,
    run: async (rawArgs) => {
      const args = rawArgs as z.infer<typeof ResolveDistrictArgs>;
      const resolution = resolveDistrict(args.query);

      if (resolution.rejectedAsIdentifier) {
        throw new ToolError(
          'That is a district code, not a name. Pass the name as a person would say it.',
          'identifier_rejected',
        );
      }
      if (!resolution.best) {
        throw new ToolError(
          'No district in this grid matches "' + args.query + '".',
          'unknown_district',
        );
      }

      const best = resolution.best;
      return {
        data: {
          query: args.query,
          district: best.district.name,
          state: best.district.stateName,
          matchConfidence: best.confidence,
          needsConfirmation: resolution.needsConfirmation,
          alternatives: resolution.alternatives.map((a) => ({
            district: a.district.name,
            state: a.district.stateName,
            matchConfidence: a.confidence,
          })),
          note: resolution.needsConfirmation
            ? 'Below the auto-accept threshold of ' +
              PLACE_AUTO_ACCEPT +
              '. Ask the officer to confirm before quoting numbers for it.'
            : '',
        },
        summary:
          '"' + args.query + '" -> ' + best.district.name + ', ' + best.district.stateName +
          ' (' + best.confidence.toFixed(2) + ', ' + best.via + ')' +
          (resolution.needsConfirmation ? ' — needs confirmation' : ''),
        rows: 1,
        grounded: { facilities: [], drugs: [] },
      };
    },
  },

  {
    name: 'national_overview',
    description:
      'The whole country at once: national totals and the worst districts, ranked. ' +
      'Use for "where is the country worst tonight" and for putting one district in national context.',
    args: NationalOverviewArgs,
    run: async (rawArgs) => {
      const args = rawArgs as z.infer<typeof NationalOverviewArgs>;
      const snapshot = await loadNational();
      const limit = args.limit ?? 5;
      const rankBy = args.rankBy ?? 'risk';

      // Ordering only. No value is combined with any other value.
      const key: Record<string, (d: DistrictSnapshot) => number> = {
        risk: (d) => d.meanRiskScore,
        critical: (d) => d.criticalPositions,
        shortfall: (d) => d.expectedShortfallUnits,
        waste: (d) => d.projectedWasteInr,
        netBenefit: (d) => d.netBenefitInr,
      };
      const ranked = [...snapshot.districts].sort((a, b) => key[rankBy](b) - key[rankBy](a)).slice(0, limit);

      return {
        data: {
          asOf: snapshot.asOf,
          builtAt: snapshot.builtAt,
          rankedBy: rankBy,
          totals: snapshot.totals,
          topDistricts: ranked.map(districtView),
          states: snapshot.states.map((s) => ({
            state: s.stateName,
            districts: s.districts,
            facilities: s.facilities,
            criticalPositions: s.criticalPositions,
            meanRiskScore: s.meanRiskScore,
            zeroStockShare: s.zeroStockShare,
            projectedWasteInr: s.projectedWasteInr,
            netBenefitInr: s.netBenefitInr,
            population: s.population,
          })),
          note: 'netBenefitInr is policy-weighted: averted Vital shortage is valued at 25x unit price. Quote it as a policy figure, not as cash.',
        },
        summary:
          'national totals + top ' + limit + ' districts by ' + rankBy +
          ' (worst: ' + (ranked[0]?.districtName ?? 'none') + ')',
        rows: ranked.length,
        grounded: { facilities: [], drugs: [] },
      };
    },
  },

  {
    name: 'district_status',
    description:
      'Headline numbers for one district: risk, critical positions, expected shortfall, projected waste, ' +
      'and the redistribution plan economics including how much of the need the plan could NOT cover. ' +
      'Call this first for any district question — it grounds every follow-up.',
    args: DistrictStatusArgs,
    run: async (rawArgs, ctx) => {
      const args = rawArgs as z.infer<typeof DistrictStatusArgs>;
      const { detail } = await districtContext(args.district, ctx);
      const e = detail.economics;

      return {
        data: {
          ...stamp(detail),
          ...districtView(detail.district),
          plan: {
            transfers: e.transfers,
            transportCostInr: e.transportCostInr,
            wasteAvertedUnits: e.wasteAvertedUnits,
            wasteAvertedInr: e.wasteAvertedInr,
            shortfallAvertedUnits: e.shortfallAvertedUnits,
            netBenefitInr: e.netBenefitInr,
            unservedReceivers: e.unservedReceivers,
            coverageShare: e.coverageShare,
            coverageSharePercent: percent(e.coverageShare),
            coverageNote:
              'coverageShare = transfers / (transfers + unservedReceivers). ' +
              'The rest could not be filled by moving stock at all — see explain_unmet_need.',
            reasonHistogram: e.reasonHistogram,
          },
          counts: {
            dispatchOrders: detail.orders.length,
            criticalAndHighPositions: detail.positions.length,
            unmetNeedsListed: detail.unserved.length,
            facilities: detail.facilities.length,
          },
        },
        summary:
          detail.district.districtName + ': ' + detail.district.criticalPositions + ' critical of ' +
          detail.district.trackedPositions + ' positions, ' + detail.orders.length + ' dispatch orders, ' +
          e.unservedReceivers + ' needs unserved',
        rows: 1,
        grounded: { facilities: [], drugs: [] },
      };
    },
  },

  {
    name: 'list_positions',
    description:
      'Stock positions at risk in a district, worst first — what is about to run out, where, and how fast. ' +
      'Each row carries on-hand, days of cover, the reorder point, stock-out probability and expected ' +
      'shortfall units. Filter by severity, VED class, drug or facility tier.',
    args: ListPositionsArgs,
    run: async (rawArgs, ctx) => {
      const args = rawArgs as z.infer<typeof ListPositionsArgs>;
      const { detail } = await districtContext(args.district, ctx);
      const limit = args.limit ?? 8;

      const drug = args.drug ? drugIdFor(args.drug) : null;
      let rows: PositionRow[] = detail.positions;
      if (args.severity) rows = rows.filter((p) => p.severity === args.severity);
      if (args.criticality) rows = rows.filter((p) => p.ved === args.criticality);
      if (args.facilityTier) rows = rows.filter((p) => p.facilityType === args.facilityTier);
      if (drug) rows = rows.filter((p) => p.drugId === drug.drugId);

      const returned = rows.slice(0, limit);

      return {
        data: {
          ...stamp(detail),
          district: detail.district.districtName,
          filters: {
            severity: args.severity ?? 'critical and high',
            criticality: args.criticality ?? 'all',
            facilityTier: args.facilityTier ?? 'all',
            drug: drug?.drugName ?? 'all',
          },
          matched: rows.length,
          returned: returned.length,
          positions: returned.map(positionView),
          note:
            'Only critical and high positions are tracked in this list. ' +
            'censoredDaysInHistory counts days the shelf closed at zero — demand on those days was never recorded, so it is a floor, not a measurement.',
        },
        summary:
          pluralRows(rows.length, 'position') + ' matched, ' + returned.length + ' returned' +
          (drug ? ' for ' + drug.drugName : '') +
          (returned[0] ? ' — worst: ' + returned[0].drugName + ' at ' + returned[0].facilityName : ''),
        rows: returned.length,
        grounded: {
          facilities: returned.map((p) => p.facilityName),
          drugs: returned.map((p) => p.drugName),
        },
      };
    },
  },

  {
    name: 'list_dispatch_orders',
    description:
      'The transfers the optimiser recommends TODAY in a district: which facility ships what to whom, ' +
      'off which batch, how far, what it costs, and how much the receiver\'s stock-out risk falls. ' +
      'Each order carries a rationale sentence written by the optimiser — quote it, never rewrite the numbers in it. ' +
      'This is the tool that turns an answer into an action.',
    args: ListOrdersArgs,
    run: async (rawArgs, ctx) => {
      const args = rawArgs as z.infer<typeof ListOrdersArgs>;
      const { detail } = await districtContext(args.district, ctx);
      const limit = args.limit ?? 5;

      const drug = args.drug ? drugIdFor(args.drug) : null;
      let rows: DispatchOrder[] = detail.orders;
      if (drug) rows = rows.filter((o) => o.drugId === drug.drugId);

      let facilityName: string | null = null;
      if (args.facility) {
        const roster = detail.facilities.map((f) => ({ id: f.id, name: f.name, type: f.type }));
        const match = resolveFacility(args.facility, roster);
        if (!match.best) {
          throw new ToolError(
            'No facility in ' + detail.district.districtName + ' matches "' + args.facility + '".',
            'unknown_facility',
          );
        }
        facilityName = match.best.facility.name;
        const id = match.best.facility.id;
        rows = rows.filter((o) => o.from.id === id || o.to.id === id);
      }

      // Biggest risk reduction first: the order most worth doing before lunch.
      const returned = [...rows].sort((a, b) => b.riskReduction - a.riskReduction).slice(0, limit);

      return {
        data: {
          ...stamp(detail),
          district: detail.district.districtName,
          filters: { drug: drug?.drugName ?? 'all', facility: facilityName ?? 'all' },
          matched: rows.length,
          returned: returned.length,
          totalOrdersInDistrict: detail.orders.length,
          orders: returned.map(orderView),
          note: 'Sorted by risk reduction. Quantities and batch numbers are executable as printed.',
        },
        summary:
          pluralRows(rows.length, 'order') + ' matched, ' + returned.length + ' returned' +
          (returned[0]
            ? ' — top: ' + returned[0].quantity + ' ' + returned[0].unit + ' ' + returned[0].drugName +
              ', ' + returned[0].from.name + ' to ' + returned[0].to.name
            : ''),
        rows: returned.length,
        grounded: {
          facilities: returned.flatMap((o) => [o.from.name, o.to.name]),
          drugs: returned.map((o) => o.drugName),
        },
      };
    },
  },

  {
    name: 'explain_unmet_need',
    description:
      'The needs the optimiser could NOT fill, and exactly why each one failed — no surplus anywhere, ' +
      'donor stock already committed, out of range, cold chain, no usable batch, or rejected on economics. ' +
      'Use this for anything that needs escalation or procurement rather than a transfer.',
    args: UnmetNeedArgs,
    run: async (rawArgs, ctx) => {
      const args = rawArgs as z.infer<typeof UnmetNeedArgs>;
      const { detail } = await districtContext(args.district, ctx);
      const limit = args.limit ?? 6;

      const drug = args.drug ? drugIdFor(args.drug) : null;
      let rows: UnservedNeed[] = detail.unserved;
      if (drug) rows = rows.filter((u) => u.drugId === drug.drugId);
      const returned = rows.slice(0, limit);

      const histogram = detail.economics.reasonHistogram;
      const dominant = (Object.entries(histogram) as [UnservedReason, number][])
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])[0];

      return {
        data: {
          ...stamp(detail),
          district: detail.district.districtName,
          transfersPlanned: detail.economics.transfers,
          unservedReceivers: detail.economics.unservedReceivers,
          coverageShare: detail.economics.coverageShare,
          coverageSharePercent: percent(detail.economics.coverageShare),
          reasonHistogram: histogram,
          reasonMeanings: REASON_GLOSS,
          matched: rows.length,
          returned: returned.length,
          needs: returned.map(unservedView),
          note:
            'The histogram counts every unserved receiver in the district. ' +
            'The rows are the worst ' + detail.unserved.length + ' carried in the snapshot, not all of them.',
        },
        summary:
          detail.economics.unservedReceivers + ' unserved receivers, coverage ' +
          (detail.economics.coverageShare * 100).toFixed(1) + '%' +
          (dominant ? ' — mostly ' + dominant[0] + ' (' + dominant[1] + ')' : ''),
        rows: returned.length,
        grounded: {
          facilities: returned.map((u) => u.facilityName),
          drugs: returned.map((u) => u.drugName),
        },
      };
    },
  },

  {
    name: 'facility_snapshot',
    description:
      'Everything about one facility: its tier, catchment, lead time, distance to its parent stocking point, ' +
      'how many of its positions are critical or at zero, its worst items, and the transfers it is ' +
      'due to send or receive.',
    args: FacilitySnapshotArgs,
    run: async (rawArgs, ctx) => {
      const args = rawArgs as z.infer<typeof FacilitySnapshotArgs>;
      const { detail } = await districtContext(args.district, ctx);

      const roster = detail.facilities.map((f) => ({ id: f.id, name: f.name, type: f.type }));
      const match = resolveFacility(args.facility, roster);

      if (match.rejectedAsIdentifier) {
        throw new ToolError(
          'That looks like a facility id, and ids are not accepted here. Pass the facility NAME.',
          'identifier_rejected',
        );
      }
      if (!match.best) {
        throw new ToolError(
          'No facility in ' + detail.district.districtName + ' matches "' + args.facility + '". ' +
            'The district has ' + detail.facilities.length + ' facilities.',
          'unknown_facility',
        );
      }
      if (match.needsConfirmation && match.alternatives.length > 0) {
        throw new ToolError(
          '"' + args.facility + '" could be ' +
            [match.best, ...match.alternatives].map((m) => m.facility.name).join(', ') +
            '. Ask the officer which.',
          'ambiguous_facility',
        );
      }

      const id = match.best.facility.id;
      const row = detail.facilities.find((f) => f.id === id) as FacilityRow;
      const parent = row.parentId ? detail.facilities.find((f) => f.id === row.parentId) : undefined;
      const positions = detail.positions.filter((p) => p.facilityId === id).slice(0, 10);
      const outbound = detail.orders.filter((o) => o.from.id === id).slice(0, 5);
      const inbound = detail.orders.filter((o) => o.to.id === id).slice(0, 5);

      return {
        data: {
          ...stamp(detail),
          district: detail.district.districtName,
          facility: {
            name: row.name,
            tier: FACILITY_LABEL[row.type] ?? row.type,
            catchmentPopulation: row.population,
            parentStockPoint: parent?.name ?? 'not in this district roster',
            distanceToParentKm: row.distanceToParentKm,
            resupplyLeadTimeDays: row.leadTimeDays,
            trackedPositions: row.positions,
            criticalPositions: row.criticalPositions,
            zeroStockPositions: row.zeroStockPositions,
            meanRiskScore: row.meanRiskScore,
          },
          worstPositions: positions.map(positionView),
          sending: outbound.map(orderView),
          receiving: inbound.map(orderView),
          matchConfidence: match.best.confidence,
        },
        summary:
          row.name + ': ' + row.criticalPositions + ' critical of ' + row.positions + ' positions, ' +
          inbound.length + ' inbound / ' + outbound.length + ' outbound orders',
        rows: 1,
        grounded: {
          facilities: [
            row.name,
            ...positions.map((p) => p.facilityName),
            ...outbound.flatMap((o) => [o.from.name, o.to.name]),
            ...inbound.flatMap((o) => [o.from.name, o.to.name]),
          ],
          drugs: [
            ...positions.map((p) => p.drugName),
            ...outbound.map((o) => o.drugName),
            ...inbound.map((o) => o.drugName),
          ],
        },
      };
    },
  },

  {
    name: 'explain_forecast',
    description:
      'How the forecast for one worked example in the district was produced: the fitted daily demand, ' +
      'the method, the reorder point, how many days of history were censored by stock-outs, and the ' +
      'demand history summarised week by week. Use this when the officer asks how a number was arrived at, ' +
      'or why a forecast might be wrong.',
    args: ExplainForecastArgs,
    run: async (rawArgs, ctx) => {
      const args = rawArgs as z.infer<typeof ExplainForecastArgs>;
      const { detail } = await districtContext(args.district, ctx);
      const probe = detail.probe;

      if (!probe) {
        throw new ToolError(
          'No worked forecast example was recorded for ' + detail.district.districtName + '.',
          'no_data',
        );
      }

      const position = detail.positions.find(
        (p) => p.facilityId === probe.facilityId && p.drugId === probe.drugId,
      );

      /*
       * Downsampling happens HERE, in TypeScript, over the recorded series.
       *
       * The raw arrays are 365 elements each and a model handed them would
       * either quote a day at random or start doing arithmetic on them, which
       * is the one thing it must never do. Weekly means are a fixed,
       * deterministic reduction computed before the model sees anything.
       */
      const weeks: { week: number; meanDailyIssues: number; censoredDays: number }[] = [];
      for (let start = 0; start < probe.recorded.length; start += 7) {
        const slice = probe.recorded.slice(start, start + 7);
        const mask = probe.censored.slice(start, start + 7);
        if (slice.length === 0) continue;
        const total = slice.reduce((a, b) => a + b, 0);
        weeks.push({
          week: Math.floor(start / 7) + 1,
          meanDailyIssues: +(total / slice.length).toFixed(2),
          censoredDays: mask.filter(Boolean).length,
        });
      }
      const censoredDays = probe.censored.filter(Boolean).length;
      const next30 = probe.seasonalMultipliers.slice(0, 30);
      const meanSeasonal = next30.length
        ? +(next30.reduce((a, b) => a + b, 0) / next30.length).toFixed(3)
        : 1;

      return {
        data: {
          ...stamp(detail),
          district: detail.district.districtName,
          facility: probe.facilityName,
          drug: probe.drugName,
          unit: probe.unit,
          fittedDailyDemand: probe.fittedDailyDemand,
          reorderPoint: probe.reorderPoint,
          onHand: probe.onHand,
          leadTimeDays: probe.leadTimeDays,
          forecastMethod: position?.forecastMethod ?? 'not recorded',
          demandPattern: position?.demandPattern ?? 'not recorded',
          stockoutProbability: position?.stockoutProbability ?? null,
          stockoutProbabilityPercent:
            position?.stockoutProbability === undefined ? 'not recorded' : percent(position.stockoutProbability),
          historyDays: probe.recorded.length,
          censoredDays,
          censoringNote:
            'On censored days the shelf was empty, so demand that day was never recorded. ' +
            'The fit corrects for this; without the correction the forecast would under-predict, ' +
            'which is how a stock-out becomes self-perpetuating.',
          weeklyHistory: weeks,
          seasonalityNext30Days: { meanMultiplier: meanSeasonal, dailyMultipliers: next30 },
          reorderPointNote:
            'The reorder point comes from Monte Carlo simulation over the lead time, not from a mean times a factor.',
        },
        summary:
          'forecast probe: ' + probe.drugName + ' at ' + probe.facilityName + ' — ' +
          probe.fittedDailyDemand + '/day fitted, reorder point ' + probe.reorderPoint + ', ' +
          censoredDays + ' of ' + probe.recorded.length + ' days censored',
        rows: weeks.length,
        grounded: { facilities: [probe.facilityName], drugs: [probe.drugName] },
      };
    },
  },

  {
    name: 'drug_reference',
    description:
      'Catalogue facts about a medicine: strength, unit, VED criticality, whether it is on the National ' +
      'List of Essential Medicines, whether it needs cold chain, shelf life and indicative unit cost. ' +
      'Use this instead of stating a drug\'s classification from memory. Handles brand names and ' +
      'vernacular terms ("lal goli", "Monocef").',
    args: DrugReferenceArgs,
    run: async (rawArgs) => {
      const args = rawArgs as z.infer<typeof DrugReferenceArgs>;
      const resolution = resolveDrug(args.name);
      if (!resolution.best) {
        throw new ToolError('No catalogue item matches "' + args.name + '".', 'unknown_drug');
      }

      const drug = getDrug(resolution.best.drug.id);
      return {
        data: {
          query: args.name,
          drug: drug.name,
          strength: drug.strength,
          form: drug.form,
          unit: drug.unit,
          criticality: VED_LABEL[drug.ved] ?? drug.ved,
          onNlem: drug.nlem,
          coldChain: drug.coldChain,
          shelfLifeMonths: drug.shelfLifeMonths,
          indicativeUnitCostInr: drug.unitCostInr,
          therapeuticGroup: drug.therapeuticGroup,
          seasonality: drug.seasonality,
          matchConfidence: resolution.best.confidence,
          matchedVia: resolution.best.via,
          alternatives:
            resolution.best.confidence < AUTO_ACCEPT
              ? resolution.alternatives.map((a) => ({ drug: a.drug.name, matchConfidence: a.confidence }))
              : [],
          note:
            'indicativeUnitCostInr is an order-of-magnitude procurement cost used to price transport ' +
            'trade-offs. It is not a tender rate and must not be quoted as one.',
        },
        summary:
          '"' + args.name + '" -> ' + drug.name + ' ' + drug.strength + ' (' +
          (VED_LABEL[drug.ved] ?? drug.ved) + (drug.coldChain ? ', cold chain' : '') + ')',
        rows: 1,
        grounded: { facilities: [], drugs: [drug.name] },
      };
    },
  },
];

const TOOLS_BY_NAME = new Map(GRID_TOOLS.map((t) => [t.name, t]));

/** The declarations handed to Gemini. Derived from the same Zod objects that validate the args back. */
export function toolDeclarations(): FunctionDeclaration[] {
  return GRID_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: geminiSchema(tool.args),
  }));
}

export function toolNames(): string[] {
  return GRID_TOOLS.map((t) => t.name);
}

/**
 * Execute one tool call from the model.
 *
 * Two gates, in this order, before any real data is touched: the name must be
 * one we registered (the model has been observed inventing namespaced tool
 * names), and the arguments must survive the tool's own Zod schema. Neither is
 * something the SDK's automatic function calling would do for us, which is why
 * the loop in `grid-agent.ts` is hand-written.
 */
export async function runTool(
  name: string,
  rawArgs: unknown,
  ctx: GridToolContext,
): Promise<ToolOutcome> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    throw new ToolError(
      'There is no tool called "' + name + '". Available tools: ' + toolNames().join(', ') + '.',
      'no_data',
    );
  }

  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => (i.path.length ? i.path.join('.') + ': ' : '') + i.message)
      .slice(0, 4)
      .join('; ');
    throw new ToolError('Invalid arguments for ' + name + ' — ' + issues, 'no_data');
  }

  return tool.run(parsed.data as never, ctx);
}
