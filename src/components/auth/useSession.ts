'use client';

import { useEffect, useState } from 'react';

/**
 * Who this browser is signed in as, shared by every component on the page.
 *
 * One request per page load, not one per dispatch card: a district console
 * renders fifty cards, and each asking the server separately would be fifty
 * identical requests for one cookie.
 */

export interface ClientSession {
  loaded: boolean;
  configured: boolean;
  signedIn: boolean;
  name?: string;
  email?: string;
  auth?: 'google' | 'operator';
  /** Exactly how an action will be written on the audit trail. */
  actor?: string;
}

const EMPTY: ClientSession = { loaded: false, configured: true, signedIn: false };

let pending: Promise<ClientSession> | null = null;

function load(): Promise<ClientSession> {
  if (!pending) {
    pending = fetch('/api/auth/session', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { configured: false, signedIn: false }))
      .then((d) => ({ ...d, loaded: true }) as ClientSession)
      .catch(() => ({ ...EMPTY, loaded: true }));
  }
  return pending;
}

export function useSession(): ClientSession {
  const [session, setSession] = useState<ClientSession>(EMPTY);
  useEffect(() => {
    let live = true;
    void load().then((s) => live && setSession(s));
    return () => {
      live = false;
    };
  }, []);
  return session;
}

/** The sign-in link for the page this is called on. */
export function signInHref(): string {
  if (typeof window === 'undefined') return '/login';
  return '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
  pending = null;
  window.location.reload();
}
