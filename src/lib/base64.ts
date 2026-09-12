/**
 * Base64 for binary the browser hands us, encoded in chunks.
 *
 * THE BUG THIS EXISTS TO KILL
 * ---------------------------
 * The voice capture path used to do:
 *
 *     btoa(String.fromCharCode(...new Uint8Array(buf)))
 *
 * The spread pushes one argument per BYTE onto the call stack, so somewhere past
 * ~100-125 KB it throws `RangeError: Maximum call stack size exceeded`. Worse,
 * it threw inside a `MediaRecorder.onstop` handler, which nothing awaits, so the
 * throw went nowhere: no request, no error, no spinner, a dead button.
 *
 * At the bitrate Chrome records Opus/WebM at, that ceiling arrives at roughly
 * NINE SECONDS of audio. The Hindi sample printed on the capture page itself
 * takes about twelve seconds to read aloud. So the demo's flagship interaction
 * failed silently for anyone who actually used it, and passed every test that
 * spoke one word.
 *
 * The register-photo path already looped correctly. This is that loop, in one
 * place, used by both callers and covered by `scripts/test-base64.mts`.
 */

/** Bytes per `String.fromCharCode` call. Far below the argument-count limit. */
const CHUNK = 8192;

export function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The ceiling `src/proxy.ts` enforces on a request body, mirrored here so the
 * browser can say "that recording is too long" instead of the server saying
 * "413" after the upload has already been paid for.
 */
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

/**
 * Base64 inflates by 4/3 and the JSON envelope costs a little more, so the
 * usable payload is smaller than the ceiling. 4 MB of binary encodes to ~5.33 MB
 * of text, which leaves room for the rest of the request.
 */
export const MAX_MEDIA_BYTES = Math.floor((MAX_UPLOAD_BYTES * 3) / 4) - 64 * 1024;
