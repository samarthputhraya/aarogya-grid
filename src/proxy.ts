import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { GLOBAL_KEY, MAX_BODY_BYTES, limiters, type RateLimitResult } from '@/lib/rate-limit';

/**
 * Spend ceiling on the public AI endpoints.
 *
 * `proxy.ts`, not `middleware.ts`: the middleware file convention is DEPRECATED
 * in Next 16 and renamed to proxy (`node_modules/next/dist/docs/01-app/
 * 03-api-reference/03-file-conventions/proxy.md`, "Version history": v16.0.0).
 * The function must be the default export or named `proxy`; only one per file.
 * Proxy defaults to the Node.js runtime in 16, and setting `runtime` here
 * throws -- which is what lets the limiter keep counters in process memory.
 *
 * WHAT THIS DEFENDS
 * -----------------
 * `/api/ask` and `/api/capture` are public and unauthenticated, and every POST
 * to either spends real money against a billed Vertex project. Three separate
 * holes, all closed here:
 *
 *   1. No ceiling on requests. One loop could drain the trial credit that keeps
 *      the live submission link alive.
 *   2. No ceiling on body size. Both handlers call `await request.json()`,
 *      which buffers the entire body into heap BEFORE Zod runs, so `mediaBase64`
 *      being an unbounded string was a heap-exhaustion vector that no amount of
 *      schema tightening inside the handler could reach. The only place to stop
 *      it is here, on `Content-Length`, before the body is read.
 *   3. A forgeable client key. `x-forwarded-for` is client-supplied, so the
 *      per-client counter is evadable. The global counter is not.
 *
 * WHAT THIS DOES NOT DEFEND
 * -------------------------
 * It is not authentication and does not pretend to be. It bounds spend and
 * memory. A determined attacker with many source addresses reaches the global
 * ceiling instead of the per-client one, which is the point of having both.
 *
 * The docs warn against relying on shared modules or globals in proxy, because
 * on some platforms proxy is deployed to a CDN edge separate from the app. This
 * deployment is a single Node server (`output: 'standalone'` on Cloud Run), so
 * proxy runs in the same process as the routes and the counters are real. If
 * that ever stopped being true the failure mode is fail-open -- traffic is
 * permitted, nothing breaks -- and the `.max()` bounds inside each route
 * handler still stand as the second line.
 */

export const config = {
  // Only the API surface is metered. Pages, static assets and the 128
  // prerendered district routes are free: they cost a disk read, not a
  // generation, and metering them would burn a visitor's budget on page views.
  matcher: '/api/:path*',
};

/** Endpoints that cost money. Everything else under /api is waved through. */
const METERED_PATHS = ['/api/ask', '/api/capture'];

/**
 * Methods that cost money.
 *
 * GET on both routes is the backend-availability probe the consoles call on
 * mount -- it reads two booleans and touches no model. Metering it would spend
 * a visitor's budget on page loads and, worse, would make the console announce
 * "no backend configured" once the budget ran out.
 */
const METERED_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Best-effort client identity.
 *
 * The FIRST `x-forwarded-for` entry is the client as reported by the chain, and
 * it is forgeable -- a client may send its own XFF and the infrastructure
 * appends rather than replaces. It is used anyway because the alternative (the
 * last entry) is the load balancer, which would put every visitor in one bucket
 * and rate-limit the demo to a single user. Forgery is answered by the global
 * counter, not by this key.
 */
function pickClientKey(request: NextRequest): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    // Cap the key length: an unbounded header value becomes an unbounded Map key.
    if (first) return first.slice(0, 64);
  }
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim().slice(0, 64);
  // Local dev, or an ingress that strips both. One shared bucket is the safe
  // reading of "we cannot tell these callers apart".
  return 'unknown';
}

function applyHeaders(headers: Headers, r: RateLimitResult): void {
  headers.set('RateLimit-Limit', String(r.limit));
  headers.set('RateLimit-Remaining', String(r.remaining));
  headers.set('RateLimit-Reset', String(r.retryAfterSeconds));
}

/**
 * The client renders `error` codes it recognises and falls back to `message`.
 * Both new codes follow the shape the route handlers already return, so the
 * consoles need no special case to display them.
 */
function tooMany(scope: 'client' | 'global', r: RateLimitResult): NextResponse {
  const message =
    scope === 'global'
      ? 'The public demo is at its shared request ceiling for the moment. ' +
        'This is a spend cap on the hosted Gemini backend, not an outage -- ' +
        'the consoles, forecasts and dispatch plans are unaffected. Try again shortly.'
      : 'Too many requests from this address. The AI endpoints are rate limited ' +
        'because each call spends metered Gemini capacity. The rest of the grid ' +
        'is unaffected. Try again shortly.';

  const response = NextResponse.json(
    { error: 'rate_limited', scope, message, retryAfterSeconds: r.retryAfterSeconds },
    { status: 429 },
  );
  applyHeaders(response.headers, r);
  response.headers.set('Retry-After', String(r.retryAfterSeconds));
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function tooLarge(declared: number | null): NextResponse {
  return NextResponse.json(
    {
      error: 'payload_too_large',
      message:
        'That upload is larger than this endpoint accepts. Register photographs ' +
        'should be downscaled before capture; audio clips are far below the limit.',
      maxBytes: MAX_BODY_BYTES,
      declaredBytes: declared,
    },
    { status: 413, headers: { 'Cache-Control': 'no-store' } },
  );
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const metered =
    METERED_METHODS.has(request.method) && METERED_PATHS.some((p) => pathname === p);

  if (!metered) return NextResponse.next();

  // ---- 1. Size, before the body is ever read -------------------------------
  //
  // A missing or unparseable Content-Length is treated as acceptable rather
  // than rejected: chunked uploads legitimately omit it, and rejecting them
  // would break a capture path that works today. The route's own `.max()`
  // bounds catch an oversized body that gets past this, one step later.
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number.parseInt(declared, 10);
    if (Number.isFinite(bytes) && bytes > MAX_BODY_BYTES) return tooLarge(bytes);
  }

  // ---- 2. The global ceiling ----------------------------------------------
  //
  // Checked FIRST and counted first, so that a flood spread across forged
  // addresses still lands here. Note the ordering consequence: a request
  // rejected globally has also consumed a unit of the global budget, which is
  // correct -- the global counter is measuring offered load, not served load.
  const { perClient, global } = limiters();
  const now = Date.now();

  const globalResult = global.check(GLOBAL_KEY, now);
  if (!globalResult.allowed) return tooMany('global', globalResult);

  // ---- 3. The per-client ceiling ------------------------------------------
  const clientResult = perClient.check(pickClientKey(request), now);
  if (!clientResult.allowed) return tooMany('client', clientResult);

  // ---- 4. Allowed. Report the remaining per-client budget. -----------------
  const response = NextResponse.next();
  applyHeaders(response.headers, clientResult);
  return response;
}
