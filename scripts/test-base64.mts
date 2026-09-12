/**
 * The regression test for the silent voice bug.
 *
 * `CaptureConsole` used to encode a recording with
 * `btoa(String.fromCharCode(...new Uint8Array(buf)))`. That spread pushes one
 * argument per byte onto the call stack and throws `RangeError` somewhere past
 * ~100 KB -- which, at the bitrate a browser records Opus at, is about NINE
 * SECONDS of speech. It threw inside `MediaRecorder.onstop`, which nothing
 * awaits, so it produced no request and no error message: the flagship Hindi
 * demo simply did nothing for anyone who spoke a full sentence.
 *
 * This test does two things:
 *   1. proves `toBase64` survives buffers well past that ceiling, and
 *   2. proves the OLD expression actually fails on the same input, so the test
 *      cannot quietly stop testing anything.
 *
 * Run: npx tsx scripts/test-base64.mts
 */
import { toBase64, MAX_MEDIA_BYTES, MAX_UPLOAD_BYTES } from '../src/lib/base64';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

/** Deterministic pseudo-random bytes -- a real recording is not compressible. */
function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 0x2545f491;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

console.log('base64 encoding');

// Correctness against Node's own encoder, across the chunk boundary (8192) and
// every remainder-mod-3 case, because base64 pads in threes and a chunked
// implementation that split on a non-multiple of 3 would corrupt every seam.
for (const n of [0, 1, 2, 3, 8191, 8192, 8193, 16384, 16385, 100_000]) {
  const b = bytes(n);
  const expected = Buffer.from(b).toString('base64');
  check(`${n} bytes match Buffer.toString('base64')`, toBase64(b) === expected);
}

// The sizes that actually broke. 250 KB is ~20 s of Opus; 2 MB is a register
// photograph.
for (const [label, n] of [
  ['~9 s of Opus (120 KB)', 120 * 1024],
  ['~20 s of Opus (250 KB)', 250 * 1024],
  ['a register photograph (2 MB)', 2 * 1024 * 1024],
] as const) {
  let ok = false;
  let detail = '';
  try {
    const b = bytes(n);
    ok = toBase64(b) === Buffer.from(b).toString('base64');
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e);
  }
  check(`${label} encodes without throwing`, ok, detail);
}

// The proof that the bug was real. If this ever stops throwing, the test above
// has stopped being a regression test and should be reconsidered rather than
// trusted.
{
  let threw = false;
  try {
    const b = bytes(250 * 1024);
    btoa(String.fromCharCode(...(b as unknown as number[])));
  } catch {
    threw = true;
  }
  check('the old spread-based expression still throws on 250 KB', threw);
}

console.log('upload ceilings');
check(
  'MAX_MEDIA_BYTES leaves room for base64 inflation',
  Math.ceil(MAX_MEDIA_BYTES / 3) * 4 < MAX_UPLOAD_BYTES,
  `${(MAX_MEDIA_BYTES / 1024 / 1024).toFixed(2)} MB binary -> ${(
    (Math.ceil(MAX_MEDIA_BYTES / 3) * 4) /
    1024 /
    1024
  ).toFixed(2)} MB of text, ceiling ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB`,
);

console.log(failures === 0 ? '\nbase64: all checks passed' : `\nbase64: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
