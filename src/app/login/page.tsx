import Link from 'next/link';
import GoogleSignIn from '@/components/auth/GoogleSignIn';
import { GOOGLE_CLIENT_ID, sessionSecret } from '@/lib/auth/session';
import { safeNext } from '@/lib/auth/token';

/**
 * Sign in -- only needed to CHANGE something.
 *
 * Everything on the board is readable without an account. What needs a person
 * is an action: reading a stock report with the model, committing it, or moving
 * a dispatch order along. Those are recorded against whoever took them.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in · Aarogya Grid' };

const REASONS: Record<string, string> = {
  csrf: 'The sign-in could not be matched to this browser. Try again from this page.',
  invalid_token: 'Google did not confirm that sign-in. Try again.',
  unverified_email: 'That Google account has not verified its email address.',
  not_allowed: 'That account is not on this deployment’s sign-in list.',
  not_configured: 'Sign-in is not configured on this deployment. Reading is unaffected.',
  bad_request: 'The sign-in response was incomplete. Try again.',
};

export default async function Page({ searchParams }: PageProps<'/login'>) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === 'string' ? params.next : null);
  const error = typeof params.error === 'string' ? REASONS[params.error] ?? 'Sign-in failed.' : null;
  const configured = sessionSecret() !== null;

  return (
    <main className="min-h-screen grid place-items-center px-4 py-12">
      <div className="panel w-full max-w-md p-6 space-y-5">
        <div>
          <Link href="/" className="text-[11px] text-mist-500 hover:text-mist-300">
            ← Aarogya Grid
          </Link>
          <h1 className="mt-3 text-lg font-semibold text-mist-100">Sign in to act on the grid</h1>
          <p className="mt-2 text-[12px] leading-relaxed text-mist-400">
            You can read every screen without an account. Reading a stock report with Gemini, committing a
            number to the board, and approving, dispatching or receiving an order are recorded against the
            person who did them &mdash; so those need a Google sign-in.
          </p>
        </div>

        {error && (
          <p className="text-[12px] text-sev-high border border-sev-high/30 bg-sev-high/10 rounded px-3 py-2">{error}</p>
        )}

        {configured ? (
          <GoogleSignIn clientId={GOOGLE_CLIENT_ID} next={next} />
        ) : (
          <p className="text-[12px] text-mist-400">{REASONS.not_configured}</p>
        )}

        <div className="text-[11px] leading-relaxed text-mist-500 border-t border-ink-700 pt-4 space-y-2">
          <p>
            What is kept: your name as Google gives it, a masked address such as <span className="text-mist-300">sa•••@gmail.com</span>,
            and a keyed code that tells two people apart without naming either. Your full address and
            your Google account id are not stored.
          </p>
          <p>
            <Link href="/privacy" className="underline decoration-dotted hover:text-mist-300">Privacy</Link>
            {' · '}
            <Link href="/terms" className="underline decoration-dotted hover:text-mist-300">Terms</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
