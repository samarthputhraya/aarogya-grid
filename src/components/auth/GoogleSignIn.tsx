'use client';

import { useEffect, useRef, useState } from 'react';
import Script from 'next/script';

/**
 * The Google Identity Services button, in redirect mode.
 *
 * Redirect rather than popup: a popup is blocked by default on the phones an
 * ANM would use, and the redirect flow hands the credential to the server
 * directly, so the ID token is never held by this page's JavaScript.
 *
 * Where to come back to is kept in a short-lived cookie, because Google's POST
 * to the sign-in endpoint carries nothing of ours. It is `SameSite=None` on
 * purpose: that POST is cross-site, and a Lax cookie would not travel with it.
 */

interface GoogleId {
  accounts: {
    id: {
      initialize(config: Record<string, unknown>): void;
      renderButton(el: HTMLElement, options: Record<string, unknown>): void;
    };
  };
}

export default function GoogleSignIn({ clientId, next }: { clientId: string; next: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const secure = window.location.protocol === 'https:';
    document.cookie =
      'ag_next=' + encodeURIComponent(next) + '; Path=/; Max-Age=600; SameSite=' + (secure ? 'None; Secure' : 'Lax');
  }, [next]);

  useEffect(() => {
    const google = (window as unknown as { google?: GoogleId }).google;
    if (!ready || !google || !el.current) return;
    google.accounts.id.initialize({
      client_id: clientId,
      ux_mode: 'redirect',
      login_uri: window.location.origin + '/api/auth/google',
      auto_select: false,
      itp_support: true,
    });
    google.accounts.id.renderButton(el.current, {
      type: 'standard',
      theme: 'filled_black',
      size: 'large',
      text: 'signin_with',
      shape: 'rectangular',
      logo_alignment: 'left',
      width: 280,
    });
  }, [ready, clientId]);

  return (
    <>
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onReady={() => setReady(true)}
        onError={() => setFailed(true)}
      />
      {/* color-scheme light: a cross-origin iframe on a dark-scheme page is painted over an
          opaque canvas, which showed as a white box around Google's rounded button. */}
      <div ref={el} className="min-h-[44px]" style={{ colorScheme: 'light' }} />
      {failed && (
        <p className="text-[11px] text-sev-high mt-2">
          Google&rsquo;s sign-in script did not load. A content blocker is the usual reason.
        </p>
      )}
    </>
  );
}
