import { randomBytes } from 'node:crypto';
import { verifySession, actorLabel, type SessionClaims } from './token';

/**
 * Who is making this request, for the endpoints that change something.
 *
 * WHAT IS PROTECTED
 * -----------------
 * The three writes: `POST /api/capture` (a model call on a billed project that
 * starts a stock report), `POST /api/commit` (a number on the national board)
 * and `POST /api/dispatch` (an order moving stock between two facilities).
 * Reading stays public -- the board, the plans, the federated nodes, the
 * assistant -- because a judge must be able to see everything without an
 * account, and an officer's action is only worth recording if it is
 * attributable to the officer.
 *
 * Kept free of Next's own request types, so the rules are testable in Node and
 * a route cannot bypass them by constructing its own response.
 */

/** The Google OAuth web client this deployment signs in with. Public by design. */
export const GOOGLE_CLIENT_ID =
  process.env.AAROGYA_GOOGLE_CLIENT_ID?.trim() ||
  '215071922486-bljepoq7kgqbuc30rtcv6noe6ou80qrt.apps.googleusercontent.com';

export const SESSION_COOKIE = 'ag_session';
/** Where to go after signing in, carried across Google's cross-site POST. */
export const NEXT_COOKIE = 'ag_next';

const DEV = Symbol.for('aarogya.auth.dev-secret');
type DevHost = typeof globalThis & { [DEV]?: string };

/**
 * The key sessions are signed with.
 *
 * On Cloud Run it MUST come from the environment (Secret Manager, mounted as
 * `AAROGYA_SESSION_SECRET`): every instance has to verify a cookie any other
 * instance issued. If it is missing there, sign-in and every write are refused
 * rather than signed with something guessable -- failing closed is the only
 * acceptable direction for this one.
 *
 * On a laptop, a random per-process key: sessions do not survive a restart,
 * which is fine for development and makes a forgotten default impossible.
 */
export function sessionSecret(): { secret: string; source: 'env' | 'dev' } | null {
  const fromEnv = process.env.AAROGYA_SESSION_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 32) return { secret: fromEnv, source: 'env' };
  if (process.env.K_SERVICE) return null;
  const host = globalThis as DevHost;
  if (!host[DEV]) host[DEV] = randomBytes(32).toString('base64');
  return { secret: host[DEV], source: 'dev' };
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function readSession(request: Request): SessionClaims | null {
  const secret = sessionSecret();
  if (!secret) return null;
  return verifySession(readCookie(request, SESSION_COOKIE), secret.secret);
}

/** Whether the request came over HTTPS, as the client saw it. Cloud Run terminates TLS. */
export function isSecure(request: Request): boolean {
  const proto = request.headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  return new URL(request.url).protocol === 'https:';
}

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return (
    SESSION_COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSeconds + (secure ? '; Secure' : '')
  );
}

export function clearCookie(name: string, secure: boolean): string {
  return name + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secure ? '; Secure' : '');
}

/**
 * Whether a state-changing request came from this site.
 *
 * The session cookie is SameSite=Lax, which already keeps it off a cross-site
 * POST; this is the second lock. A browser always sends `Origin` on a POST, so
 * a mismatch is refused. A request with no `Origin` at all is not a browser --
 * it is a script, and a script needs the cookie to do anything, which it can
 * only have been given.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export interface Writer {
  session: SessionClaims;
  /** How the action is written on the audit row. */
  actor: string;
}

function refuse(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error, message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * The signed-in writer, or the response that refuses them.
 *
 * `returnTo` is where the sign-in link should come back to -- the page the
 * button was pressed on, not the API route.
 */
export function requireWriter(request: Request, returnTo = '/console'): Writer | { refused: Response } {
  if (!sameOrigin(request)) {
    return { refused: refuse(403, 'cross_origin', 'This action must be made from the Aarogya Grid site itself.') };
  }
  const secret = sessionSecret();
  if (!secret) {
    return {
      refused: refuse(
        503,
        'sign_in_not_configured',
        'Sign-in is not configured on this deployment, so nothing can be changed. Reading is unaffected.',
      ),
    };
  }
  const session = verifySession(readCookie(request, SESSION_COOKIE), secret.secret);
  if (!session) {
    return {
      refused: refuse(
        401,
        'sign_in_required',
        'Sign in with Google to make changes. Everything on the board stays readable without an account; ' +
          'an action is only recorded against a person.',
        { signIn: '/login?next=' + encodeURIComponent(returnTo) },
      ),
    };
  }
  return { session, actor: actorLabel(session) };
}
