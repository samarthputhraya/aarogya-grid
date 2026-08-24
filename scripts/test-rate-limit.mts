/**
 * Harness for the public-endpoint spend ceiling.
 * Run with:  npx tsx scripts/test-rate-limit.mts
 *
 * Two halves. The first exercises `FixedWindowLimiter` directly, with an
 * injected clock, so the behaviour AT a window boundary is asserted rather than
 * slept through. The second drives the real `proxy` function with real
 * `NextRequest` objects, because the limiter being correct and the proxy
 * actually applying it to the right method on the right path are separate
 * claims and only the second one protects the bill.
 *
 * Deliberately covered, because each was a way to build this wrong:
 *   - GET must stay free. Both consoles probe `GET /api/ask` on mount, and
 *     metering that would spend a visitor's budget on page loads and then tell
 *     them the backend was unconfigured.
 *   - Memory must be bounded. A Map keyed on a forgeable header is a
 *     denial-of-service vector in its own right if it can grow without limit.
 *   - Rejection must carry `message`, because that is the field both consoles
 *     render on a non-OK response. A 429 the UI cannot display is an outage.
 */
import { NextRequest } from 'next/server';
import { FixedWindowLimiter, MAX_BODY_BYTES, limiters, GLOBAL_KEY } from '../src/lib/rate-limit';
import { proxy } from '../src/proxy';

const checks: [string, boolean][] = [];
function check(name: string, ok: boolean) {
  checks.push([name, ok]);
}

console.log('Aarogya Grid -- rate limit harness');

// ---------------------------------------------------------------------------
// PART 1 -- the limiter, with a clock we control
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

{
  const lim = new FixedWindowLimiter({ limit: 3, windowMs: 1000 });
  const a = lim.check('ip1', T0);
  const b = lim.check('ip1', T0 + 100);
  const c = lim.check('ip1', T0 + 200);
  const d = lim.check('ip1', T0 + 300);

  check('1st request allowed', a.allowed);
  check('3rd request allowed (limit is inclusive)', c.allowed);
  check('4th request denied', !d.allowed);
  check('remaining counts down 2,1,0', a.remaining === 2 && b.remaining === 1 && c.remaining === 0);
  check('remaining never goes negative', d.remaining === 0);
  check('limit is echoed', d.limit === 3);
  check('retryAfterSeconds is at least 1', d.retryAfterSeconds >= 1);
  check('resetAtMs is window start + windowMs', a.resetAtMs === T0 + 1000);

  // The boundary itself: at exactly startedAt + windowMs the window is over.
  const afterBoundary = lim.check('ip1', T0 + 1000);
  check('window reopens exactly at startedAt + windowMs', afterBoundary.allowed);
  check('reopened window restarts the count', afterBoundary.remaining === 2);

  // A request one millisecond BEFORE the boundary is still inside the old window.
  const lim2 = new FixedWindowLimiter({ limit: 1, windowMs: 1000 });
  lim2.check('ip1', T0);
  check('still limited 1ms before the boundary', !lim2.check('ip1', T0 + 999).allowed);
}

{
  const lim = new FixedWindowLimiter({ limit: 2, windowMs: 1000 });
  lim.check('ip1', T0);
  lim.check('ip1', T0);
  check('a different key has its own budget', lim.check('ip2', T0).allowed);
  check('the exhausted key is still exhausted', !lim.check('ip1', T0).allowed);
}

{
  const lim = new FixedWindowLimiter({ limit: 2, windowMs: 1000 });
  lim.check('ip1', T0);
  const p1 = lim.peek('ip1', T0);
  const p2 = lim.peek('ip1', T0);
  check('peek does not consume budget', p1.remaining === 1 && p2.remaining === 1);
  check('peek on an unknown key reports a full budget', lim.peek('nobody', T0).remaining === 2);
  check('peek on an expired window reports a full budget', lim.peek('ip1', T0 + 5000).remaining === 2);
}

{
  // Memory bound. 500 distinct keys inside one window against a cap of 50.
  const lim = new FixedWindowLimiter({ limit: 10, windowMs: 60_000, maxKeys: 50 });
  for (let i = 0; i < 500; i++) lim.check('ip' + i, T0);
  check('maxKeys caps tracked keys', lim.size <= 50);
  check('eviction still admits new keys (fails open)', lim.check('brand-new', T0).allowed);
}

{
  // Expiry sweep. Keys from an old window must not survive into a new one.
  const lim = new FixedWindowLimiter({ limit: 10, windowMs: 1000, maxKeys: 10_000 });
  for (let i = 0; i < 200; i++) lim.check('ip' + i, T0);
  check('all keys tracked inside the window', lim.size === 200);
  lim.check('later', T0 + 5000);
  check('expired windows are swept', lim.size === 1);
}

{
  let threw = 0;
  for (const bad of [{ limit: 0, windowMs: 1000 }, { limit: 5, windowMs: 0 }, { limit: NaN, windowMs: 1000 }]) {
    try {
      new FixedWindowLimiter(bad);
    } catch {
      threw++;
    }
  }
  check('an invalid rule throws rather than silently permitting everything', threw === 3);
}

// ---------------------------------------------------------------------------
// PART 2 -- the proxy, with real requests
// ---------------------------------------------------------------------------

function req(
  url: string,
  init: { method?: string; ip?: string; contentLength?: number } = {},
): NextRequest {
  const headers = new Headers();
  if (init.ip) headers.set('x-forwarded-for', init.ip);
  if (init.contentLength !== undefined) headers.set('content-length', String(init.contentLength));
  return new NextRequest(new URL(url, 'https://example.test'), {
    method: init.method ?? 'POST',
    headers,
  });
}

/** A proxy response that lets the request through carries no status of its own. */
function passedThrough(res: Response): boolean {
  return res.status === 200 && res.headers.get('x-middleware-next') === '1';
}

function fresh() {
  const { perClient, global } = limiters();
  perClient.reset();
  global.reset();
}

{
  fresh();
  const res = proxy(req('/api/ask', { method: 'GET', ip: '10.0.0.1' }));
  check('GET /api/ask is not metered', passedThrough(res));

  fresh();
  const many = Array.from({ length: 200 }, () =>
    proxy(req('/api/ask', { method: 'GET', ip: '10.0.0.1' })),
  );
  check('200 GET probes all pass (the console mounts freely)', many.every(passedThrough));
}

{
  fresh();
  const res = proxy(req('/api/health', { method: 'POST', ip: '10.0.0.1' }));
  check('an unmetered API path passes through', passedThrough(res));
}

{
  fresh();
  const res = proxy(req('/api/capture', { ip: '10.0.0.1', contentLength: MAX_BODY_BYTES + 1 }));
  check('an oversized body is rejected', res.status === 413);
}

{
  fresh();
  const res = proxy(req('/api/capture', { ip: '10.0.0.1', contentLength: 1024 }));
  check('a normal body is accepted', passedThrough(res));

  fresh();
  const noLength = proxy(req('/api/capture', { ip: '10.0.0.1' }));
  check('a missing Content-Length is not rejected (chunked uploads are legal)', passedThrough(noLength));
}

{
  // Exhaust one client and confirm the shape of the rejection.
  fresh();
  const limit = Number.parseInt(process.env.AAROGYA_RATE_LIMIT ?? '20', 10);
  let denied: Response | null = null;
  for (let i = 0; i < limit + 5; i++) {
    const res = proxy(req('/api/ask', { ip: '10.0.0.9' }));
    if (res.status === 429 && !denied) denied = res;
  }
  check('a client is eventually rate limited', denied !== null);
  check('rejection sets Retry-After', denied?.headers.get('Retry-After') !== null);
  check('rejection sets RateLimit-Limit', denied?.headers.get('RateLimit-Limit') === String(limit));
  check('rejection is not cacheable', denied?.headers.get('Cache-Control') === 'no-store');

  const body = denied ? ((await denied.json()) as Record<string, unknown>) : {};
  check('rejection body has the error code the clients branch on', body.error === 'rate_limited');
  check('rejection body has `message` -- the field both consoles render', typeof body.message === 'string');
  check('rejection names which ceiling was hit', body.scope === 'client' || body.scope === 'global');

  // A second, untouched client must still be served.
  const other = proxy(req('/api/ask', { ip: '10.0.0.10' }));
  check('one exhausted client does not lock out the others', passedThrough(other));
}

{
  // The global ceiling: many forged addresses, one shared bill.
  fresh();
  let sawGlobal = false;
  for (let i = 0; i < 400; i++) {
    const res = proxy(req('/api/ask', { ip: '10.1.' + ((i >> 8) & 255) + '.' + (i & 255) }));
    if (res.status === 429) {
      const b = (await res.json()) as { scope?: string };
      if (b.scope === 'global') sawGlobal = true;
    }
  }
  check('forging the client key still hits the global ceiling', sawGlobal);
  check('the global counter tracks exactly one key', limiters().global.size === 1);
  check('the global bucket key is stable', limiters().global.peek(GLOBAL_KEY).limit === 240);
}

{
  fresh();
  const allowed = proxy(req('/api/ask', { ip: '10.0.0.2' }));
  check('an allowed request reports the remaining budget', allowed.headers.get('RateLimit-Remaining') !== null);
}

// Leave the process with clean counters so a later harness in the same `npm
// test` run does not start against a spent global budget.
fresh();

// ---------------------------------------------------------------------------

console.log('\n--- checks ---');
let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  if (!ok) failed++;
}
console.log(
  failed === 0
    ? '\nAll ' + checks.length + ' checks passed.'
    : '\n' + failed + ' of ' + checks.length + ' check(s) FAILED.',
);
process.exit(failed === 0 ? 0 : 1);
