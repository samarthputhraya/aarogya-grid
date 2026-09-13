import { readCookie, sessionSecret, isSecure, sessionCookie, clearCookie, NEXT_COOKIE } from '@/lib/auth/session';
import { verifyGoogleCredential, GoogleCredentialError } from '@/lib/auth/google';
import { signSession, maskEmail, actorIdFor, safeNext, SESSION_TTL_SECONDS } from '@/lib/auth/token';

/**
 * Where Google Identity Services sends a signed-in person.
 *
 * In redirect mode the sign-in button does not call this from JavaScript:
 * Google POSTs a form here with the ID token as `credential`, after the person
 * has chosen an account on accounts.google.com. That makes it a cross-site
 * POST, so two things are checked before the token is even looked at:
 *
 *   - the `g_csrf_token` double submit: Google sets it as a cookie on this site
 *     and repeats it in the body, and a forged form cannot do both;
 *   - the credential itself, against Google's keys and this client's audience
 *     (`src/lib/auth/google.ts`).
 *
 * Then a session is issued and the person is sent back to the page they were
 * on. Failures go to `/login` with a reason, never to a stack trace.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function back(to: string, cookies: string[]): Response {
  const headers = new Headers({ Location: to, 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers });
}

export async function POST(request: Request): Promise<Response> {
  const secure = isSecure(request);
  const secret = sessionSecret();
  if (!secret) return back('/login?error=not_configured', []);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back('/login?error=bad_request', []);
  }
  const credential = form.get('credential');
  const bodyToken = form.get('g_csrf_token');
  const cookieToken = readCookie(request, 'g_csrf_token');
  if (typeof credential !== 'string' || !credential) return back('/login?error=bad_request', []);
  if (typeof bodyToken !== 'string' || !cookieToken || bodyToken !== cookieToken) {
    return back('/login?error=csrf', []);
  }

  try {
    const who = await verifyGoogleCredential(credential);
    const now = Math.floor(Date.now() / 1000);
    const token = signSession(
      {
        v: 1,
        id: actorIdFor('google', who.sub, secret.secret),
        name: who.name,
        email: maskEmail(who.email),
        auth: 'google',
        iat: now,
        exp: now + SESSION_TTL_SECONDS,
      },
      secret.secret,
    );
    const next = safeNext(readCookie(request, NEXT_COOKIE));
    return back(next, [sessionCookie(token, secure, SESSION_TTL_SECONDS), clearCookie(NEXT_COOKIE, secure)]);
  } catch (e) {
    const code = e instanceof GoogleCredentialError ? e.code : 'invalid_token';
    if (!(e instanceof GoogleCredentialError)) console.error('[auth] sign-in failed', e);
    return back('/login?error=' + code, []);
  }
}
