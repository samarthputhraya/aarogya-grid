import { readSession, sessionSecret, GOOGLE_CLIENT_ID } from '@/lib/auth/session';
import { actorLabel } from '@/lib/auth/token';

/**
 * Who the browser is signed in as, for the consoles to render.
 *
 * Returns the same masked identity the audit trail will record, so what a
 * person sees next to the Approve button is exactly what their action will be
 * attributed to. The cookie itself is HttpOnly and never reaches script.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const session = readSession(request);
  const secret = sessionSecret();
  return Response.json(
    {
      configured: secret !== null,
      clientId: GOOGLE_CLIENT_ID,
      signedIn: session !== null,
      ...(session
        ? { name: session.name, email: session.email, auth: session.auth, actor: actorLabel(session), expiresAt: new Date(session.exp * 1000).toISOString() }
        : {}),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
