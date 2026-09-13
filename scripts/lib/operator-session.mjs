/**
 * An operator-minted session, for the rehearsal and recording scripts.
 *
 * The writes those scripts exercise need a signed-in actor now, and a script
 * cannot click through Google's account chooser. So the operator -- who holds
 * the signing secret -- mints a short session for a named rehearsal role. It is
 * marked `auth: "operator"`, and every row it writes says `operator · <label>`,
 * so a scripted action can never pass for a person's on the audit trail.
 *
 * The format is `src/lib/auth/token.ts`'s, written out again in plain JS so an
 * `.mjs` script can use it without a TypeScript loader; `scripts/test-auth.mts`
 * verifies a token minted here with the server's own verifier, so the two
 * cannot drift apart unnoticed.
 */
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** The Secret Manager secret the deployment mounts as AAROGYA_SESSION_SECRET. */
export const SESSION_SECRET_NAME = 'aarogya-session-secret';

export function mintOperatorToken(secret, label = 'rehearsal', ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1,
    id: 'op:' + label.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
    name: label,
    email: 'operator',
    auth: 'operator',
    iat: now,
    exp: now + ttlSeconds,
  };
  const body = 'v1.' + b64url(JSON.stringify(claims));
  return body + '.' + b64url(createHmac('sha256', secret).update(body).digest());
}

/** A `Cookie` header value carrying an operator session. */
export function operatorCookie(secret, label = 'rehearsal', ttlSeconds = 3600) {
  return 'ag_session=' + encodeURIComponent(mintOperatorToken(secret, label, ttlSeconds));
}

/**
 * The signing secret for a target.
 *
 * `AAROGYA_SESSION_SECRET` wins. Otherwise, for a deployment, it is read from
 * Secret Manager with the operator's own gcloud credentials -- which is the
 * point: only someone who can read the secret can mint a session. A local
 * server started without the variable signs with a random per-process key that
 * no script can know, so a local rehearsal must set the variable for both.
 */
export function sessionSecretFor(base) {
  const fromEnv = process.env.AAROGYA_SESSION_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (/localhost|127\.0\.0\.1/.test(base)) return null;
  // `GCLOUD` for an install that is not on PATH. One quoted command string, so a
  // path with spaces (the Windows default) survives the shell `gcloud.cmd` needs.
  const gcloud = process.env.GCLOUD ?? 'gcloud';
  try {
    return execSync('"' + gcloud + '" secrets versions access latest --secret=' + SESSION_SECRET_NAME, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}
