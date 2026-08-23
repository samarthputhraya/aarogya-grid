import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  extractVoiceReport,
  extractRegister,
  draftFromVoiceReport,
  draftFromRegister,
} from '@/lib/ai/stock-report';
import { getFacilityById, expectationsFor } from '@/lib/facility-lookup';
import { isConfigured, AiValidationError, modelId, fastModelId } from '@/lib/ai/client';

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
    if (e instanceof AiValidationError) {
      return NextResponse.json(
        { error: 'model_output_invalid', message: e.message, raw: e.raw.slice(0, 2000) },
        { status: 502 },
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: 'upstream_failed', message }, { status: 502 });
  }
}
