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

/**
 * Where Vertex requests land when the deployment does not say.
 *
 * asia-south1 (Mumbai) rather than the SDK's us-central1 default, because the
 * first question a state health department's IT cell asks about any system that
 * touches facility-level data is which jurisdiction it is processed in. An
 * inference call that leaves India is a procurement conversation, not a
 * technical one.
 */
export const DEFAULT_VERTEX_LOCATION = 'asia-south1';

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

function firstLine(raw: string | undefined): string | undefined {
  const first = raw
    ?.split(/[\r\n]+/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first && first.length > 0 ? first : undefined;
}

/** GCP project for the Vertex backend, or undefined on the API-key path. */
export function vertexProject(): string | undefined {
  return firstLine(process.env.GOOGLE_CLOUD_PROJECT);
}

/** Region Vertex requests are pinned to. Never silently us-central1. */
export function vertexLocation(): string {
  return firstLine(process.env.GOOGLE_CLOUD_LOCATION) ?? DEFAULT_VERTEX_LOCATION;
}

/**
 * Whether to talk to Gemini through Vertex AI instead of the AI Studio key.
 *
 * WHY THIS IS NOT SIMPLY `GOOGLE_CLOUD_PROJECT !== undefined`
 * -----------------------------------------------------------
 * The two backends do not authenticate the same way. The API-key path carries
 * its credential in a header; the Vertex path uses Application Default
 * Credentials, which on a developer laptop means a `gcloud auth` login that
 * usually has not happened, and in CI means a service account that usually is
 * not mounted. A project id in `.env.local` is therefore not evidence that
 * Vertex will work -- it is frequently just a value someone pasted in while
 * setting up BigQuery.
 *
 * Flipping the backend on the mere presence of that id would take a working
 * demo and break it at the first inference call with an ADC error, which is
 * precisely the failure mode design note 1 above exists to prevent. So:
 *
 *   GOOGLE_GENAI_USE_VERTEXAI=true   -> Vertex, always. The deployment says so.
 *   GOOGLE_GENAI_USE_VERTEXAI=false  -> API key, always. Overrides everything.
 *   unset                            -> Vertex only when there is a project AND
 *                                       no API key to fall back to.
 *
 * Cloud Run with a service account and no key therefore gets asia-south1 data
 * residency with zero configuration, and a laptop with both set keeps working.
 * The variable name is the one the SDK itself reads, so nothing new is invented.
 *
 * Named `vertexEnabled` rather than the more natural `useVertex` because the
 * React hooks lint rule claims every `use*` identifier as a hook and rejects it
 * being called from a plain function, which this is.
 */
export function vertexEnabled(): boolean {
  if (!vertexProject()) return false;

  const flag = firstLine(process.env.GOOGLE_GENAI_USE_VERTEXAI)?.toLowerCase();
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;

  return apiKey() === undefined;
}

/** Which backend a request will actually use. Shown in the UI, not inferred there. */
export function backend(): 'vertex' | 'api-key' | 'unconfigured' {
  if (vertexEnabled()) return 'vertex';
  return apiKey() !== undefined ? 'api-key' : 'unconfigured';
}

/** Whether the AI capture layer is available. The UI branches on this. */
export function isConfigured(): boolean {
  return backend() !== 'unconfigured';
}

export function modelId(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL_FALLBACK;
}

export function fastModelId(): string {
  return process.env.GEMINI_MODEL_FAST?.trim() || DEFAULT_FAST_MODEL_FALLBACK;
}

export function getClient(): GoogleGenAI {
  if (cached) return cached;

  if (vertexEnabled()) {
    // `vertexai`, `project` and `location` are the option names on
    // GoogleGenAIOptions (genai.d.ts). No key is passed: the SDK resolves
    // Application Default Credentials, which is the whole point -- the
    // credential becomes a Cloud IAM identity that can be rotated, audited and
    // scoped to one region, instead of a string in an environment variable.
    cached = new GoogleGenAI({
      vertexai: true,
      project: vertexProject(),
      location: vertexLocation(),
    });
    return cached;
  }

  const key = apiKey();
  if (!key) {
    throw new Error(
      'No Gemini backend is configured. Set GEMINI_API_KEY in .env.local, or set ' +
        'GOOGLE_CLOUD_PROJECT with Application Default Credentials for Vertex AI -- ' +
        'see .env.example. The grid works without either; only the AI layer is disabled.',
    );
  }
  cached = new GoogleGenAI({ apiKey: key });
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
