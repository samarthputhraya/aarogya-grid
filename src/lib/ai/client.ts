import { GoogleGenAI } from '@google/genai';
import type { ZodType } from 'zod';

/**
 * Gemini client and structured-output helper.
 *
 * DESIGN NOTES
 * ------------
 * 1. GRACEFUL DEGRADATION. The grid -- forecasting, risk, redistribution -- is
 *    pure computation and does not need a model at all. Only the last-mile
 *    capture layer does. So a missing API key disables voice and register
 *    capture and leaves everything else working, rather than taking the app
 *    down. A demo that dies because an env var is unset is a demo that dies on
 *    stage.
 *
 * 2. STRUCTURED OUTPUT IS ENFORCED TWICE. We ask Gemini for JSON against a
 *    response schema AND validate the result with Zod before it goes anywhere
 *    near the ledger. The schema constrains the model; Zod is what we actually
 *    trust. On a validation failure we retry once with the error fed back, then
 *    give up and surface it -- we never pass through a partially-parsed object.
 *
 * 3. NO ITEM CODES FROM THE MODEL. Every prompt in this codebase asks Gemini for
 *    natural-language drug names, never catalogue IDs. Mapping to IDs is done
 *    deterministically in `resolve.ts`. See the note there for why.
 */

export const DEFAULT_MODEL_FALLBACK = 'gemini-2.5-flash';
export const DEFAULT_FAST_MODEL_FALLBACK = 'gemini-2.5-flash-lite';

let cached: GoogleGenAI | null = null;

export function apiKey(): string | undefined {
  const raw = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!raw) return undefined;

  // Take the first non-empty line rather than the whole variable.
  //
  // Pasting a secret into a hosting provider's environment UI very easily picks
  // up a trailing newline, or the same value repeated. The SDK puts the key
  // straight into a request header, so anything with an embedded newline throws
  // `Headers.append: "..." is an invalid header value` -- an error that quotes
  // the credential back. Being strict here turns a paste slip into a working
  // deploy instead of a leaked key.
  const first = raw
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  if (!first) return undefined;
  if (first !== raw.trim()) {
    console.warn(
      '[ai] GEMINI_API_KEY contained multiple lines; using the first. ' +
        'Check the value in your hosting provider settings.',
    );
  }
  return first;
}

/** Whether the AI capture layer is available. The UI branches on this. */
export function isConfigured(): boolean {
  return apiKey() !== undefined;
}

export function modelId(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL_FALLBACK;
}

export function fastModelId(): string {
  return process.env.GEMINI_MODEL_FAST?.trim() || DEFAULT_FAST_MODEL_FALLBACK;
}

export function getClient(): GoogleGenAI {
  const key = apiKey();
  if (!key) {
    throw new Error(
      'GEMINI_API_KEY is not set. Add it to .env.local -- see .env.example. ' +
        'The grid works without it; only voice and register capture are disabled.',
    );
  }
  if (!cached) cached = new GoogleGenAI({ apiKey: key });
  return cached;
}

export interface StructuredOptions {
  model?: string;
  systemInstruction?: string;
  temperature?: number;
  /** JSON Schema passed to Gemini to constrain generation. */
  responseSchema?: unknown;
  /** Retries on schema-validation failure. */
  maxRetries?: number;
}

export class AiValidationError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'AiValidationError';
  }
}

/** Strip markdown fences some models wrap JSON in, before parsing. */
function stripFences(text: string): string {
  const t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced ? fenced[1] : t).trim();
}

/**
 * Generate a value matching `schema`.
 *
 * `contents` is passed through to the SDK unchanged, so callers can send text,
 * inline audio, or inline images without this helper needing to know which.
 */
export async function generateStructured<T>(
  contents: unknown,
  schema: ZodType<T>,
  opts: StructuredOptions = {},
): Promise<T> {
  const ai = getClient();
  const model = opts.model ?? modelId();
  const maxRetries = opts.maxRetries ?? 1;

  let lastRaw = '';
  let lastError = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const instruction =
      attempt === 0
        ? opts.systemInstruction
        : [
            opts.systemInstruction ?? '',
            '',
            'Your previous response did not match the required schema.',
            'Error: ' + lastError,
            'Return ONLY valid JSON matching the schema. No prose, no markdown fences.',
          ]
            .join('\n')
            .trim();

    const response = await ai.models.generateContent({
      model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contents: contents as any,
      config: {
        temperature: opts.temperature ?? 0,
        responseMimeType: 'application/json',
        ...(opts.responseSchema ? { responseSchema: opts.responseSchema as never } : {}),
        ...(instruction ? { systemInstruction: instruction } : {}),
      },
    });

    const text = response.text ?? '';
    lastRaw = text;

    try {
      const parsed = JSON.parse(stripFences(text));
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
      lastError = result.error.issues
        .map((i) => i.path.join('.') + ': ' + i.message)
        .slice(0, 6)
        .join('; ');
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  throw new AiValidationError(
    'Model output failed schema validation after ' + (maxRetries + 1) + ' attempts: ' + lastError,
    lastRaw,
  );
}

/** Plain text generation, for the briefing endpoint where no schema applies. */
export async function generateText(
  contents: unknown,
  opts: Omit<StructuredOptions, 'responseSchema'> = {},
): Promise<string> {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: opts.model ?? modelId(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contents: contents as any,
    config: {
      temperature: opts.temperature ?? 0.2,
      ...(opts.systemInstruction ? { systemInstruction: opts.systemInstruction } : {}),
    },
  });
  return response.text ?? '';
}
