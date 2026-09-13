'use client';

import { FOCUS_RING } from '../ui/primitives';
import { useSession, signInHref, signOut } from './useSession';

/**
 * Signed in as whom, or a way to sign in -- in the header of every page that
 * can change something.
 *
 * It shows the identity the audit trail will record (a name and a masked
 * address), not the account's full address, because that is what the action
 * will actually be attributed to.
 */
export default function SessionBadge({ compact = false }: { compact?: boolean }) {
  const session = useSession();
  if (!session.loaded) return <span className="text-[10px] text-mist-600">…</span>;
  if (!session.configured) {
    return (
      <span className="text-[10px] px-2 py-1 rounded border border-ink-600 text-mist-500" title="This deployment has no sign-in secret, so changes are refused.">
        read-only
      </span>
    );
  }
  if (!session.signedIn) {
    return (
      <a
        href={signInHref()}
        className={'text-[11px] px-2.5 py-1 rounded border border-brand/50 text-brand bg-brand/10 hover:bg-brand/20 ' + FOCUS_RING}
      >
        Sign in to act
      </a>
    );
  }
  return (
    <span className="flex items-center gap-2 text-[10px] text-mist-400">
      {!compact && <span className="text-mist-500">acting as</span>}
      <span className="text-mist-200" title={session.auth === 'operator' ? 'An operator-minted session for a rehearsal script' : 'Signed in with Google'}>
        {session.actor}
      </span>
      <button onClick={() => void signOut()} className={'underline decoration-dotted hover:text-mist-200 rounded ' + FOCUS_RING}>
        sign out
      </button>
    </span>
  );
}
