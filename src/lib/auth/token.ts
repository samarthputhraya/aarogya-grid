import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The session token, and the identity it carries. Pure: no request, no cookie,
 * no network -- so every rule in here is testable in plain Node, and the
 * operator script that mints a rehearsal session is checked against this exact
 * code rather than a copy of it.
 *
 * WHAT IS IN A SESSION, AND WHAT IS DELIBERATELY NOT
 * --------------------------------------------------
 * The consoles publish the audit trail: `/api/overlay` and `/api/dispatch` are
 * public, and a ticket's history names who acted. So the identity that travels
 * with an action must be safe to publish. A session therefore holds:
 *
 *   id     a keyed hash of the Google account id. Stable for a person, useless
 *          to anyone without the server's secret -- which is what lets the
 *          four-eyes rule compare two people without either being named.
 *   name   the display name Google returned, trimmed.
 *   email  MASKED (`sa•••@gmail.com`). Enough for a colleague to recognise, not
 *          enough to harvest.
 *   auth   `google` for a person who signed in, `operator` for a session the
 *          operator minted for a rehearsal script -- recorded as such, so a
 *          scripted action can never pass for a person's.
 *
 * No raw email and no Google account id is stored anywhere by this app.
 *
 * FORMAT
 * ------
 * `v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(secret, "v1." + claims))>`.
 * Not a JWT, on purpose: there is one issuer, one verifier and one algorithm, and
 * a format with an `alg` header is a format with an `alg` header to get wrong.
 */

export type SessionAuth = 'google' | 'operator';

export interface SessionClaims {
  v: 1;
  /** Pseudonymous, stable per person: see `actorIdFor`. */
  id: string;
  name: string;
  /** Masked. See `maskEmail`. */
  email: string;
  auth: SessionAuth;
  /** Seconds since the epoch. */
  iat: number;
  exp: number;
}

/** How long a signed-in session lasts. A working day, not a month. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function signSession(claims: SessionClaims, secret: string): string {
  const body = 'v1.' + b64url(JSON.stringify(claims));
  return body + '.' + b64url(mac(secret, body));
}

/** The claims, or null for anything forged, truncated, expired or from another secret. */
export function verifySession(token: string | null | undefined, secret: string, nowMs = Date.now()): SessionClaims | null {
  if (!token || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const body = parts[0] + '.' + parts[1];
  const expected = mac(secret, body);
  let given: Buffer;
  try {
    given = fromB64url(parts[2]);
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: SessionClaims;
  try {
    claims = JSON.parse(fromB64url(parts[1]).toString('utf8')) as SessionClaims;
  } catch {
    return null;
  }
  if (claims.v !== 1 || typeof claims.id !== 'string' || typeof claims.exp !== 'number') return null;
  if (claims.auth !== 'google' && claims.auth !== 'operator') return null;
  if (claims.exp * 1000 <= nowMs) return null;
  return claims;
}

/**
 * `samartha@gmail.com` -> `sa•••@gmail.com`.
 *
 * Two characters of the local part and the whole domain: a district office can
 * tell its own people apart, and a scraper of the public audit trail learns a
 * domain.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  const local = email.slice(0, at);
  return local.slice(0, Math.min(2, local.length)) + '•••' + email.slice(at);
}

/**
 * A stable, pseudonymous id for a person.
 *
 * Keyed with the session secret, so it cannot be computed from a known Google
 * account id by anyone who does not hold the secret, and it changes if the
 * secret is rotated -- which is the correct direction for a pseudonym to fail.
 */
export function actorIdFor(auth: SessionAuth, subject: string, secret: string): string {
  if (auth === 'operator') return 'op:' + subject.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
  return 'g:' + b64url(mac(secret, 'actor:' + subject)).slice(0, 16);
}

/** How an actor is written on an audit row: who, and how they proved it. */
export function actorLabel(claims: Pick<SessionClaims, 'name' | 'email' | 'auth'>): string {
  return claims.auth === 'operator' ? 'operator · ' + claims.name : claims.name + ' · ' + claims.email;
}

/**
 * Where to send someone after they sign in.
 *
 * Only a path on this site: an open redirect on a sign-in endpoint is how a
 * phishing page borrows a real domain's login button.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || next.length > 512) return '/console';
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/console';
  if (/[\r\n]/.test(next)) return '/console';
  return next;
}

/**
 * Who may sign in, beyond "has a verified Google account".
 *
 * `AAROGYA_AUTH_ALLOW` is a comma list of addresses and `@domains`. Empty means
 * any verified account -- which is what a public demo judges need. A state
 * deployment sets its own domain.
 */
export function allowed(email: string, rule = process.env.AAROGYA_AUTH_ALLOW ?? ''): boolean {
  const entries = rule.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (entries.length === 0) return true;
  const e = email.toLowerCase();
  return entries.some((x) => (x.startsWith('@') ? e.endsWith(x) : e === x));
}
