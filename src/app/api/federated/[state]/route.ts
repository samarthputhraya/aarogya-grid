import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATES } from '@/lib/domain/geo';

/**
 * One state's node, byte for byte.
 *
 * THE POINT IS THE BYTES
 * ----------------------
 * `/api/federated` publishes the SHA-256 of every node file. This route returns
 * the file those digests describe, unmodified: read from disk and written to the
 * socket, never parsed and re-serialised. A reviewer can therefore do the
 * strongest check available to them from outside the repository --
 *
 *     curl -s <base>/api/federated/10 | sha256sum
 *
 * -- and compare it with the digest in the index and with the committed file in
 * `src/data/federated/10.json`. Three independent copies of the same bytes. If
 * this route rebuilt the JSON from a parsed object, all three would differ for
 * reasons that have nothing to do with honesty, and the check would be useless.
 *
 * `dynamicParams = false`: the state codes are a compile-time constant,
 * every one of them is prerendered, and an unknown code is a typo or a probe.
 * The right answer to both is a 404 out of static output rather than a Node
 * process waking up to discover there is no such state.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams() {
  return STATES.map((s) => ({ state: s.code }));
}

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/federated/[state]'>,
): Promise<Response> {
  // Next 16: `params` is a Promise. The synchronous shim Next 15 shipped is gone.
  const { state } = await ctx.params;

  // Checked against the catalogue rather than trusting the filesystem. With
  // `dynamicParams = false` this is unreachable in production; it stops a
  // stray file in `src/data/federated/` from becoming a route.
  if (!STATES.some((s) => s.code === state)) {
    return new Response(JSON.stringify({ error: 'unknown state code', known: STATES.map((s) => s.code) }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const body = await readFile(join(process.cwd(), 'src/data/federated', `${state}.json`), 'utf8');
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
