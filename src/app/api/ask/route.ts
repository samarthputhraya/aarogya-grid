import { NextResponse } from 'next/server';
import { z } from 'zod';
import { askGrid, briefDistrict } from '@/lib/ai/grid-agent';
import { DISTRICTS_BY_CODE } from '@/lib/domain/geo';
import { isConfigured, backend, AiValidationError } from '@/lib/ai/client';

/**
 * Grid assistant endpoint.
 *
 * Two entry points behind one route because they are the same machinery with a
 * different opening message: `ask` answers a District Health Officer's
 * question, `brief` writes their morning action briefing. Both return the tool
 * trace alongside the answer, and the trace is not optional -- an answer about
 * medicine stock with no evidence of where the numbers came from is exactly the
 * artefact this system exists to replace.
 *
 * Route handlers are not cached by default in Next 16, which is what we want:
 * every question is unique.
 */

export const runtime = 'nodejs';
// A briefing runs four tools across two or three model turns. Sixty seconds is
// generous for that and still well short of a hung request.
export const maxDuration = 60;

/**
 * Every string is bounded.
 *
 * `src/proxy.ts` rejects an oversized body on `Content-Length` before it is
 * read, which is the only place that can prevent the heap spike, since `await
 * request.json()` below buffers the whole body before Zod ever runs. These
 * bounds are the second line: they hold if the proxy is bypassed, and they keep
 * a merely-large-but-legal body from being forwarded to a metered model.
 */
const Body = z.object({
  mode: z.enum(['ask', 'brief']),
  /**
   * The district console the officer has open. Required for `brief`, optional
   * for `ask` because a national question ("where is the country worst
   * tonight?") legitimately has no district. Validated against the registry,
   * never trusted as a path segment -- the tools build a filename from it.
   */
  districtCode: z.string().max(32).optional(),
  // Long enough for any real question an officer types; short enough that it
  // cannot be used to push a large prompt through a billed model.
  question: z.string().max(2_000).optional(),
  language: z.enum(['en', 'hi', 'hinglish']).optional(),
});

export async function POST(request: Request) {
  if (!isConfigured()) {
    return NextResponse.json(
      {
        error: 'not_configured',
        message:
          'No Gemini backend is configured. Set GEMINI_API_KEY in .env.local, or ' +
          'GOOGLE_CLOUD_PROJECT with Application Default Credentials for Vertex AI. ' +
          'The rest of the grid works without it.',
      },
      { status: 503 },
    );
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'bad_request', message: e instanceof Error ? e.message : 'Invalid body' },
      { status: 400 },
    );
  }

  if (body.districtCode && !DISTRICTS_BY_CODE[body.districtCode]) {
    return NextResponse.json(
      { error: 'unknown_district', message: 'No district with code ' + body.districtCode },
      { status: 404 },
    );
  }

  if (body.mode === 'brief' && !body.districtCode) {
    return NextResponse.json(
      { error: 'bad_request', message: 'brief needs a districtCode' },
      { status: 400 },
    );
  }
  if (body.mode === 'ask' && !body.question?.trim()) {
    return NextResponse.json(
      { error: 'bad_request', message: 'ask needs a non-empty question' },
      { status: 400 },
    );
  }

  try {
    const result =
      body.mode === 'brief'
        ? await briefDistrict({
            districtCode: body.districtCode as string,
            language: body.language,
          })
        : await askGrid({
            districtCode: body.districtCode ?? null,
            question: body.question as string,
            language: body.language,
          });

    // `...result` last would overwrite `model` with the same value; spread
    // first so the agent's own record of which model answered is authoritative.
    return NextResponse.json({ ...result, mode: body.mode, backend: backend() });
  } catch (e) {
    // NEVER echo an upstream error message to the client.
    //
    // Same discipline as `/api/capture`, and for the same concrete reason: the
    // SDK builds request headers from the API key, so a malformed key produces
    // a `Headers.append: "<the key>" is an invalid header value` error, and
    // echoing `e.message` publishes the credential in a 502 body on a public
    // URL. That happened once. Any upstream error may quote the request it
    // failed to make, and the request carries the credential.
    //
    // Errors are logged server-side, where the operator can already read the
    // environment, and the client gets a stable code it can branch on.
    console.error('[ask] agent failure', e);

    if (e instanceof AiValidationError) {
      // e.raw is model output rather than our request, so it cannot carry the
      // key -- but it is unvalidated generative text, so it is not echoed
      // either. It is logged above.
      return NextResponse.json(
        {
          error: 'model_output_invalid',
          message:
            'The assistant returned an answer that failed validation. ' +
            'This has been logged. Try asking more specifically.',
        },
        { status: 502 },
      );
    }

    return NextResponse.json(
      {
        error: 'upstream_failed',
        message:
          'The assistant could not complete this question. This has been logged. ' +
          'The rest of the grid is unaffected.',
      },
      { status: 502 },
    );
  }
}

/**
 * Backend availability, resolved at REQUEST time.
 *
 * WHY THIS ENDPOINT EXISTS
 * ------------------------
 * The district pages are prerendered with `dynamicParams = false`, so anything
 * the server computes for them is computed during `next build` -- which, in a
 * container image, runs with none of the deployment's environment. Passing
 * `isConfigured()` down as a prop therefore baked "no backend configured" into
 * all 128 static pages while the running service was perfectly able to answer,
 * and the console told every visitor the opposite of the truth.
 *
 * Build-time and request-time are different moments and configuration belongs
 * to the second one. The client asks here on mount.
 */
export async function GET() {
  return NextResponse.json(
    { configured: isConfigured(), backend: backend() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
