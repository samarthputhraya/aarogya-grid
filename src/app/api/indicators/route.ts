import { NextResponse } from 'next/server';
import FEED from '@/data/early-warnings.json';

/**
 * The early-warning feed, as a consumer outside this project would read it.
 *
 * WHY THIS IS A URL AND NOT A SLIDE
 * ---------------------------------
 * "Interoperable" is the easiest word in a deck to write and the hardest to
 * check. A reviewer can open this, validate it against
 * `docs/indicator-schema.json`, and see for themselves that the required fields
 * carry no Indian vocabulary -- an area has a code, a name and a population; a
 * signal has a hazard class from a fixed list, an observed value, an expected
 * range and a confidence. Everything local is in an optional block they can
 * drop without losing the meaning.
 *
 * It also carries its own honesty: `method.validation` says what the detector
 * was measured at, and `disclosure.dataProvenance` says the caseload behind it
 * is simulated. A surveillance exchange that did not state its provenance would
 * invite a consumer to treat a simulation as a case count, and there would be
 * no way to discover the mistake downstream.
 *
 * Filters exist because a pooling system asks narrow questions:
 *   /api/indicators?hazard=vector_borne&minConfidence=moderate&since=2026-09-20
 */

export const runtime = 'nodejs';
// Dynamic because the filters below read the query string. The payload itself
// is a build-time artefact, so the work is a filter over an in-memory array;
// the hour of Cache-Control is what keeps a poller off the box.
export const dynamic = 'force-dynamic';

const CONFIDENCE = ['low', 'moderate', 'high'];

interface Signal {
  hazardClass: string;
  confidence: string;
  observedTo: string;
  area: { code: string };
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const hazard = params.get('hazard');
  const minConfidence = params.get('minConfidence');
  const since = params.get('since');
  const area = params.get('area');

  const feed = FEED as unknown as { signals: Signal[] };
  const floor = minConfidence ? CONFIDENCE.indexOf(minConfidence) : -1;

  const signals = feed.signals.filter(
    (s) =>
      (!hazard || s.hazardClass === hazard) &&
      (floor < 0 || CONFIDENCE.indexOf(s.confidence) >= floor) &&
      (!since || s.observedTo >= since) &&
      (!area || s.area.code === area),
  );

  return NextResponse.json(
    {
      ...feed,
      signals,
      // The schema is part of the answer, not a footnote in a README. A
      // consumer that has to go looking for the contract is a consumer that
      // will guess at it.
      schema: '/docs/indicator-schema.json',
    },
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // A feed rebuilt nightly; an hour of cache costs a consumer nothing and
        // saves re-serving 186 KB to a poller.
        'Cache-Control': 'public, max-age=3600',
      },
    },
  );
}
