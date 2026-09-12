import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveDrug, AUTO_ACCEPT } from '@/lib/ai/resolve';
import { getFacilityById } from '@/lib/facility-lookup';
import { formularyFor } from '@/lib/domain/drugs';
import {
  recomputePosition,
  UnknownFacilityError,
  UnstockedDrugError,
} from '@/lib/overlay/recompute';
import { recordStockEvent, type StockEventSource } from '@/lib/overlay/store';
import {
  RUNTIME_FORECAST_CACHE,
  RUNTIME_FORECAST_METHOD,
} from '@/lib/overlay/runtime-forecast';

/**
 * Commit a confirmed stock report.
 *
 * This is the write the whole capture path exists to reach: a health worker
 * speaks or photographs a number, a human confirms it, and the risk board
 * changes. `/api/capture` returns a DRAFT and never writes; this route is the
 * separate, explicit action that does.
 *
 * DRUG NAMES, NOT DRUG IDS, AND THE VALIDATION IS RE-RUN HERE
 * -----------------------------------------------------------
 * The body carries what the human confirmed -- a name and a quantity -- and the
 * server resolves the name against the catalogue itself. It does NOT accept a
 * `drugId`, and it does NOT trust the draft's `status`.
 *
 * That is deliberate and it is the security boundary of the feature. The draft
 * was produced by a language model and shaped by a client; a route that accepted
 * `{drugId, status: 'auto_accept'}` would let anything that can POST write any
 * number against any position, with the model's own confidence as the only
 * gate -- and that gate would be client-supplied. Resolving here means the
 * catalogue, the facility's formulary and the confidence threshold are all
 * enforced by code the client cannot reach.
 *
 * WHAT A COMMIT IS AND IS NOT
 * ---------------------------
 * It updates the live overlay in front of the nightly snapshot and re-scores the
 * position synchronously, so the caller gets the new risk in the response rather
 * than having to poll for it. It is NOT durable: the overlay is in-process, and
 * the response says so via `durable`. A container restart loses it. That is a
 * bounded, stated limitation rather than a hidden one -- see `overlay/store.ts`.
 */

export const runtime = 'nodejs';

const Body = z.object({
  facilityId: z.string().min(3).max(64),
  entries: z
    .array(
      z.object({
        /** What the worker said, as confirmed. Resolved server-side. */
        drugName: z.string().min(2).max(120),
        /**
         * Closing stock on the shelf. Not a delta -- a stock-take reports a
         * position, and a delta would need a base this route cannot verify.
         */
        onHand: z.number().int().min(0).max(1_000_000),
        strengthHint: z.string().max(40).optional(),
      }),
    )
    .min(1)
    .max(40),
  source: z.enum(['voice', 'photo', 'typed', 'dispatch']).default('typed'),
});

interface Rejected {
  drugName: string;
  reason: string;
  /** What the resolver thought it might be, when it had a guess. */
  suggestion?: string;
  confidence?: number;
}

export async function POST(request: Request): Promise<Response> {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid request', detail: e instanceof z.ZodError ? e.issues : String(e) },
      { status: 400 },
    );
  }

  const facility = getFacilityById(parsed.facilityId);
  if (!facility) {
    return NextResponse.json({ error: 'Unknown facility: ' + parsed.facilityId }, { status: 404 });
  }

  const formulary = new Set(formularyFor(facility.type).map((d) => d.id));
  const committed = [];
  const rejected: Rejected[] = [];
  let slowestMs = 0;

  for (const entry of parsed.entries) {
    const resolution = resolveDrug(entry.drugName, { strengthHint: entry.strengthHint });
    const best = resolution.best;

    // The same threshold the draft path uses. Re-applied here because the draft
    // arrived over the wire and its status is not evidence.
    if (!best || best.confidence < AUTO_ACCEPT) {
      rejected.push({
        drugName: entry.drugName,
        reason: !best
          ? 'no catalogue match'
          : 'confidence ' + best.confidence.toFixed(2) + ' is below the ' +
            AUTO_ACCEPT + ' threshold -- confirm the drug before committing',
        suggestion: best?.drug.name,
        confidence: best ? +best.confidence.toFixed(3) : undefined,
      });
      continue;
    }

    // A facility cannot report stock of something it has no business holding.
    if (!formulary.has(best.drug.id)) {
      rejected.push({
        drugName: entry.drugName,
        reason: facility.type + ' does not stock ' + best.drug.name,
        suggestion: best.drug.name,
        confidence: +best.confidence.toFixed(3),
      });
      continue;
    }

    try {
      const result = recomputePosition(facility.id, best.drug.id, entry.onHand, {
        cache: RUNTIME_FORECAST_CACHE,
        method: RUNTIME_FORECAST_METHOD,
      });
      slowestMs = Math.max(slowestMs, result.elapsedMs);

      const event = recordStockEvent({
        facilityId: facility.id,
        facilityName: facility.name,
        districtCode: facility.districtCode,
        drugId: best.drug.id,
        drugName: best.drug.name,
        onHand: entry.onHand,
        source: parsed.source as StockEventSource,
        // Durability is WS2's BigQuery write, which is deliberately not on this
        // path yet. Reported honestly rather than implied.
        durable: false,
        recomputeMs: result.elapsedMs,
        risk: {
          onHand: result.risk.onHand,
          previousOnHand: result.previousOnHand,
          stockoutProbability: +result.risk.stockoutProbability.toFixed(4),
          previousStockoutProbability: +result.previousRisk.stockoutProbability.toFixed(4),
          riskScore: result.risk.riskScore,
          previousRiskScore: result.previousRisk.riskScore,
          severity: result.risk.severity,
          previousSeverity: result.previousRisk.severity,
          daysOfCover: Number.isFinite(result.risk.daysOfCover)
            ? +result.risk.daysOfCover.toFixed(1)
            : -1,
          reorderPoint: Math.round(result.risk.reorderPoint),
          expectedShortfallUnits: +result.risk.expectedShortfallUnits.toFixed(1),
          forecastSource: result.forecastSource,
        },
      });
      committed.push(event);
    } catch (e) {
      if (e instanceof UnknownFacilityError || e instanceof UnstockedDrugError) {
        rejected.push({ drugName: entry.drugName, reason: e.message });
        continue;
      }
      throw e;
    }
  }

  return NextResponse.json(
    {
      facilityId: facility.id,
      facilityName: facility.name,
      committed,
      rejected,
      /** Slowest single-position recompute. The WS2 budget is 100 ms. */
      recomputeMs: slowestMs,
      durable: false,
    },
    // 207 when some entries were refused: the request partly succeeded, and a
    // 200 would let a client tick every row green.
    { status: rejected.length > 0 && committed.length > 0 ? 207 : committed.length === 0 ? 422 : 200 },
  );
}
