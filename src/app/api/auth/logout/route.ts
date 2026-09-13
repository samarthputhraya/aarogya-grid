import { clearCookie, isSecure, sameOrigin, SESSION_COOKIE } from '@/lib/auth/session';

/** Sign out: the session cookie is cleared. POST only, and only from this site. */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'cross_origin' }, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': clearCookie(SESSION_COOKIE, isSecure(request)), 'Cache-Control': 'no-store' },
  });
}
