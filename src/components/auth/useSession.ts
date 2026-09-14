'use client';

import { useEffect, useState } from 'react';

/**
 * Who this browser is signed in as, shared by every component on the page.
 *
 * One request per page load, not one per dispatch card: a district console
 * renders fifty cards, and each asking the server separately would be fifty
 * identical requests for one cookie.
 *
 * Asked again when the tab comes back into focus. The cookie can change while
 * the page stays open -- signed out in another tab, a session that expired, a
 * different officer signed in on a shared counter machine -- and a badge still
 * naming the previous person is wrong in exactly the place it must not be: next
 * to the button whose action will be written against someone.
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

const subscribers = new Set<(s: ClientSession) => void>();

function recheck(): void {
  pending = null;
  void load().then((s) => subscribers.forEach((notify) => notify(s)));
}

function onVisible(): void {
  if (document.visibilityState === 'visible') recheck();
}

export function useSession(): ClientSession {
  const [session, setSession] = useState<ClientSession>(EMPTY);
  useEffect(() => {
    let live = true;
    const apply = (s: ClientSession) => {
      if (live) setSession(s);
    };
    if (subscribers.size === 0) {
      window.addEventListener('focus', recheck);
      document.addEventListener('visibilitychange', onVisible);
    }
    subscribers.add(apply);
    void load().then(apply);
    return () => {
      live = false;
      subscribers.delete(apply);
      if (subscribers.size === 0) {
        window.removeEventListener('focus', recheck);
        document.removeEventListener('visibilitychange', onVisible);
      }
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
