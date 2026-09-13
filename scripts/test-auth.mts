/**
 * Sign-in: the session token, the identity it carries, and who may write.
 *
 * Run with:  npx tsx scripts/test-auth.mts   (part of `npm test`)
 *
 * Offline. Google's half -- the ID token's signature and audience -- is
 * `google-auth-library`'s `verifyIdToken`, and is not re-tested here. What is
 * tested is everything this project decided: what a session may contain, that
 * a forged or stale one is refused, that nothing redirects off-site, that the
 * writes refuse without a session, and that an officer cannot countersign and
 * approve the same order.
 */
import { signSession, verifySession, maskEmail, actorIdFor, actorLabel, safeNext, allowed, type SessionClaims } from '../src/lib/auth/token';
import { requireWriter, sameOrigin, readCookie } from '../src/lib/auth/session';
import { assertTransition, applyTransition, TicketTransitionError, type DispatchTicket } from '../src/lib/dispatch/ticket';
// A plain JS module, shared with the .mjs rehearsal scripts.
import { mintOperatorToken, operatorCookie } from './lib/operator-session.mjs';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks++;
  if (ok) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  -- ' + detail : ''));
  }
}

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const now = Math.floor(Date.now() / 1000);
const claims = (over: Partial<SessionClaims> = {}): SessionClaims => ({
  v: 1,
  id: actorIdFor('google', '1098765432109876543', SECRET),
  name: 'Asha Kumari',
  email: maskEmail('asha.kumari@example.org'),
  auth: 'google',
  iat: now,
  exp: now + 3600,
  ...over,
});

console.log('\nthe session token');
{
  const token = signSession(claims(), SECRET);
  check('a signed session verifies', verifySession(token, SECRET)?.name === 'Asha Kumari');
  const [v, body, sig] = token.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ ...claims(), auth: 'operator', name: 'Someone Else' })).toString('base64url');
  check('a payload edited after signing is refused', verifySession(v + '.' + forgedBody + '.' + sig, SECRET) === null);
  check('a signature from another secret is refused', verifySession(token, SECRET + 'x') === null);
  check('a truncated token is refused', verifySession(v + '.' + body, SECRET) === null);
  check('an expired session is refused', verifySession(signSession(claims({ exp: now - 1 }), SECRET), SECRET) === null);
  check('an unknown sign-in method is refused',
    verifySession(signSession({ ...claims(), auth: 'password' } as unknown as SessionClaims, SECRET), SECRET) === null);
  check('another format version is refused', verifySession('v2.' + body + '.' + sig, SECRET) === null);
  check('an absurdly long cookie is not even parsed', verifySession('v1.' + 'a'.repeat(5000) + '.b', SECRET) === null);
}

console.log('\nwhat the audit trail publishes about a person');
{
  check('an address is masked to two characters and the domain', maskEmail('asha.kumari@example.org') === 'as•••@example.org');
  check('a one-letter local part does not leak more', maskEmail('a@b.in') === 'a•••@b.in');
  const a = actorIdFor('google', '1098765432109876543', SECRET);
  check('the pseudonymous id is stable for a person', a === actorIdFor('google', '1098765432109876543', SECRET));
  check('and different for another', a !== actorIdFor('google', '1098765432109876544', SECRET));
  check('and cannot be computed without the secret', a !== actorIdFor('google', '1098765432109876543', 'another-secret-entirely-000000000'));
  check('it does not contain the Google account id', !a.includes('1098765432109876543'));
  check('a person is labelled by name and masked address', actorLabel(claims()) === 'Asha Kumari · as•••@example.org');
  check('an operator session is labelled as one', actorLabel({ name: 'rehearsal', email: 'operator', auth: 'operator' }) === 'operator · rehearsal');
}

console.log('\nwhere sign-in may send someone');
{
  check('a path on this site is kept', safeNext('/district/DST-10-PURNIA?tab=orders') === '/district/DST-10-PURNIA?tab=orders');
  check('a protocol-relative URL is not followed', safeNext('//evil.example/login') === '/console');
  check('an absolute URL is not followed', safeNext('https://evil.example/') === '/console');
  check('a backslash trick is not followed', safeNext('/\\evil.example') === '/console');
  check('a header-splitting newline is not followed', safeNext('/console\r\nSet-Cookie: x=1') === '/console');
  check('nothing at all goes to the console', safeNext(null) === '/console');
}

console.log('\nwho may sign in');
{
  check('with no list, any verified account', allowed('anyone@gmail.com', ''));
  check('a listed domain is admitted', allowed('dho@kerala.gov.in', '@kerala.gov.in, someone@gmail.com'));
  check('a listed address is admitted', allowed('Someone@gmail.com', '@kerala.gov.in, someone@gmail.com'));
  check('anyone else is not', !allowed('someone.else@gmail.com', '@kerala.gov.in, someone@gmail.com'));
  check('a domain suffix trick is not', !allowed('x@notkerala.gov.in.evil.com', '@kerala.gov.in'));
}

console.log('\nthe writes refuse without a session');
{
  const req = (headers: Record<string, string>) => new Request('https://aarogya.example/api/commit', { method: 'POST', headers });
  process.env.AAROGYA_SESSION_SECRET = SECRET;
  delete process.env.K_SERVICE;

  const none = requireWriter(req({ host: 'aarogya.example' }), '/capture');
  check('no cookie is a 401', 'refused' in none && none.refused.status === 401);
  const body = 'refused' in none ? ((await none.refused.json()) as { error: string; signIn: string }) : null;
  check('which says sign-in is required', body?.error === 'sign_in_required');
  check('and links back to the page, not the API', body?.signIn === '/login?next=%2Fcapture');

  const cookie = 'ag_session=' + encodeURIComponent(signSession(claims(), SECRET));
  const signedIn = requireWriter(req({ host: 'aarogya.example', cookie, origin: 'https://aarogya.example' }));
  check('a valid session is a writer', !('refused' in signedIn) && signedIn.actor === 'Asha Kumari · as•••@example.org');

  const crossSite = requireWriter(req({ host: 'aarogya.example', cookie, origin: 'https://evil.example' }));
  check('the same cookie from another origin is a 403', 'refused' in crossSite && crossSite.refused.status === 403);
  check('behind Cloud Run the forwarded host is what is compared',
    sameOrigin(req({ host: 'internal:8080', 'x-forwarded-host': 'aarogya.example', origin: 'https://aarogya.example' })));
  check('a script with no Origin header is judged by its cookie alone', sameOrigin(req({ host: 'aarogya.example' })));

  const stale = requireWriter(req({ host: 'aarogya.example', cookie: 'ag_session=' + encodeURIComponent(signSession(claims({ exp: now - 5 }), SECRET)) }));
  check('an expired cookie is a 401, not a writer', 'refused' in stale && stale.refused.status === 401);

  delete process.env.AAROGYA_SESSION_SECRET;
  process.env.K_SERVICE = 'aarogya-grid';
  const unconfigured = requireWriter(req({ host: 'aarogya.example', cookie }));
  check('on Cloud Run with no secret, writes fail closed (503)', 'refused' in unconfigured && unconfigured.refused.status === 503);
  delete process.env.K_SERVICE;

  check('cookies are read by name, not by prefix', readCookie(req({ cookie: 'ag_session_old=x; ag_session=y' }), 'ag_session') === 'y');
}

console.log('\nan operator session minted by the rehearsal scripts');
{
  const token = mintOperatorToken(SECRET, 'rehearsal donor officer', 600) as string;
  const verified = verifySession(token, SECRET);
  check('verifies with the server\'s own verifier', verified !== null);
  check('and is marked as an operator session', verified?.auth === 'operator' && verified.id === 'op:rehearsal-donor-officer');
  check('the cookie helper carries the same token', (operatorCookie(SECRET, 'x', 60) as string).startsWith('ag_session=v1.'));
}

console.log('\nfour eyes: one person cannot countersign and approve');
{
  const ticket: DispatchTicket = {
    ticketId: 'DST-10-PURNIA:ORD-1', districtCode: 'DST-10-PURNIA', orderId: 'ORD-1', state: 'proposed',
    from: { facilityId: 'A', facilityName: 'SC Bhagalpur-10', facilityType: 'SC', districtCode: 'DST-10-BHAGALP', districtName: 'Bhagalpur' },
    to: { facilityId: 'B', facilityName: 'CHC Purnia-01', facilityType: 'CHC', districtCode: 'DST-10-PURNIA', districtName: 'Purnia' },
    drugId: 'ORS-SACHET', drugName: 'ORS', unit: 'sachet', plannedUnits: 10, dispatchedUnits: null, receivedUnits: null,
    varianceUnits: null, crossDistrict: true, admissibility: 'requires_district_countersign', escalateTo: 'district',
    admissibilityNote: '', history: [{ at: 't', action: 'propose', from: 'proposed', to: 'proposed', actor: 'planner' }],
    effects: [], createdAt: 't', updatedAt: 't', seq: 1,
  };
  const countersigned = applyTransition(ticket, 'countersign', {
    at: 't', actor: 'Asha Kumari · as•••@example.org', actorId: 'g:asha', actorAuth: 'google', role: 'donor district officer', units: 0, effects: [], seq: 2,
  });
  let refusal: TicketTransitionError | null = null;
  try {
    assertTransition(countersigned, 'approve', 'g:asha');
  } catch (e) {
    refusal = e instanceof TicketTransitionError ? e : null;
  }
  check('the countersigner approving their own order is refused', refusal?.code === 'four_eyes');
  check('and told who must approve instead', /receiving district must approve/.test(refusal?.message ?? ''));
  let other: unknown = null;
  try {
    assertTransition(countersigned, 'approve', 'g:ravi');
  } catch (e) {
    other = e;
  }
  check('a second officer may approve', other === null);
  const legacy = applyTransition(ticket, 'countersign', { at: 't', actor: 'donor district officer', units: 0, effects: [], seq: 2 });
  let old: unknown = null;
  try {
    assertTransition(legacy, 'approve', 'g:asha');
  } catch (e) {
    old = e;
  }
  check('a countersign from before sign-in is not held to a rule nobody could meet', old === null);
  check('the transition records who, and the role separately',
    countersigned.history[1].actorId === 'g:asha' && countersigned.history[1].role === 'donor district officer');
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + '  ' + (checks - failures) + '/' + checks + ' checks');
process.exit(failures === 0 ? 0 : 1);
