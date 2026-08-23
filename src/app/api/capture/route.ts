import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  extractVoiceReport,
  extractRegister,
  draftFromVoiceReport,
  draftFromRegister,
} from '@/lib/ai/stock-report';
import { getFacilityById, expectationsFor } from '@/lib/facility-lookup';
import { isConfigured, backend, AiValidationError, modelId, fastModelId } from '@/lib/ai/client';

/**
 * Last-mile capture endpoint.
 *
 * Accepts a typed transcript, an audio recording, or a photograph of a paper
 * stock register, and returns a VALIDATED DRAFT -- never a committed write.
 * Committing is a separate, explicit action, because everything in the draft
 * may have come from a model and some of it will be wrong.
 *
 * Route handlers are not cached by default in Next 16, which is what we want:
 * every submission is unique.
 */

export const runtime = 'nodejs';
// Register photographs are the largest payload; audio clips are well under this.
export const maxDuration = 60;

const Body = z.object({
  facilityId: z.string().min(3),
  asOf: z.string().optional(),
  kind: z.enum(['text', 'audio', 'register']),
  text: z.string().optional(),
  mediaBase64: z.string().optional(),
  mimeType: z.string().optional(),
});

export async function POST(request: Request) {
  if (!isConfigured()) {
    return NextResponse.json(
      {
        error: 'not_configured',
        message:
          'GEMINI_API_KEY is not set. Add it to .env.local and restart. ' +
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

  const facility = getFacilityById(body.facilityId);
  if (!facility) {
    return NextResponse.json(
      { error: 'unknown_facility', message: 'No facility with ID ' + body.facilityId },
      { status: 404 },
    );
  }

  const asOf = body.asOf ? new Date(body.asOf + 'T00:00:00Z') : new Date(Date.UTC(2026, 8, 30));
  const started = Date.now();

  try {
    const expectations = expectationsFor(facility, asOf);

    if (body.kind === 'register') {
      if (!body.mediaBase64 || !body.mimeType) {
        return NextResponse.json(
          { error: 'bad_request', message: 'register capture needs mediaBase64 and mimeType' },
          { status: 400 },
        );
      }
      const extraction = await extractRegister({
        mimeType: body.mimeType,
        data: body.mediaBase64,
      });
      return NextResponse.json({
        draft: draftFromRegister(extraction, facility, expectations),
        extraction,
        facility,
        model: modelId(),
        elapsedMs: Date.now() - started,
      });
    }

    const input =
      body.kind === 'audio'
        ? { audio: { mimeType: body.mimeType ?? 'audio/webm', data: body.mediaBase64 ?? '' } }
        : { text: body.text ?? '' };

    if (body.kind === 'audio' && !body.mediaBase64) {
      return NextResponse.json(
        { error: 'bad_request', message: 'audio capture needs mediaBase64' },
        { status: 400 },
      );
    }
    if (body.kind === 'text' && !body.text?.trim()) {
      return NextResponse.json(
        { error: 'bad_request', message: 'text capture needs a non-empty transcript' },
        { status: 400 },
      );
    }

    const report = await extractVoiceReport(input);
    return NextResponse.json({
      draft: draftFromVoiceReport(report, facility, expectations),
      extraction: report,
      facility,
      model: fastModelId(),
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    // NEVER echo an upstream error message to the client.
    //
    // This is not hypothetical caution. The SDK builds the request headers from
    // the API key, so a malformed key produces a `Headers.append: "<the key>" is
    // an invalid header value` error -- and echoing `e.message` published the
    // credential in a 502 body on a public URL. Any upstream error may quote the
    // request it failed to make, and the request carries the key.
    //
    // Errors are logged server-side, where the operator can already read the
    // environment, and the client gets a stable code it can branch on.
    console.error('[capture] upstream failure', e);

    if (e instanceof AiValidationError) {
      // e.raw is model output, not our request, so it cannot carry the key --
      // but it is unvalidated text from a generative model, so it is not echoed
      // to the client either. It is logged above.
      return NextResponse.json(
        {
          error: 'model_output_invalid',
          message:
            'The model returned a response that failed schema validation. ' +
            'This has been logged. Try rephrasing the report.',
        },
        { status: 502 },
      );
    }

    return NextResponse.json(
      {
        error: 'upstream_failed',
        message:
          'The capture service could not reach the model. This has been logged. ' +
          'The rest of the grid is unaffected.',
      },
      { status: 502 },
    );
  }
}

/**
 * Backend availability, resolved at REQUEST time.
 *
 * The same trap as /api/ask, in a second place. `/capture` called
 * `isConfigured()` in its page component and passed the result down, and
 * although that page is not in `generateStaticParams` it is still prerendered
 * at build time -- inside a container with none of the deployment's
 * environment. The deployed console therefore announced "GEMINI_API_KEY NOT
 * SET" while the service behind it was authenticating to Vertex perfectly well.
 *
 * Configuration belongs to request time. The client asks here on mount.
 */
export async function GET() {
  return NextResponse.json(
    { configured: isConfigured(), backend: backend() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
