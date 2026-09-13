import 'server-only';
import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_CLIENT_ID } from './session';
import { allowed } from './token';

/**
 * Verifying a Google Identity Services credential.
 *
 * The browser never tells this server who someone is. Google POSTs an ID token
 * to `/api/auth/google`; this checks its signature against Google's published
 * keys, that it was issued FOR THIS CLIENT (the audience), that it has not
 * expired, and that the address was verified. Only then is anything about the
 * person believed.
 */

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

export class GoogleCredentialError extends Error {
  constructor(readonly code: 'invalid_token' | 'unverified_email' | 'not_allowed', message: string) {
    super(message);
    this.name = 'GoogleCredentialError';
  }
}

export async function verifyGoogleCredential(idToken: string): Promise<GoogleIdentity> {
  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (e) {
    throw new GoogleCredentialError('invalid_token', 'Google did not vouch for that sign-in: ' + (e as Error).message);
  }
  if (!payload?.sub || !payload.email) throw new GoogleCredentialError('invalid_token', 'The credential names nobody.');
  if (!payload.email_verified) {
    throw new GoogleCredentialError('unverified_email', 'That Google account has not verified its address.');
  }
  if (!allowed(payload.email)) {
    throw new GoogleCredentialError('not_allowed', 'That account is not on this deployment\'s sign-in list.');
  }
  return {
    sub: payload.sub,
    email: payload.email,
    name: (payload.name ?? payload.given_name ?? payload.email.split('@')[0]).slice(0, 60),
  };
}
