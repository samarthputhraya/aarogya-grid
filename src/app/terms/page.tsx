import Link from 'next/link';

export const metadata = { title: 'Terms · Aarogya Grid' };

export default function Page() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-12 text-[13px] leading-relaxed text-mist-300 space-y-6">
      <div>
        <Link href="/" className="text-[11px] text-mist-500 hover:text-mist-300">
          ← Aarogya Grid
        </Link>
        <h1 className="mt-3 text-xl font-semibold text-mist-100">Terms</h1>
        <p className="mt-1 text-[11px] text-mist-500">Last updated 14 September 2026.</p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-mist-100">What this is</h2>
        <p>
          Aarogya Grid is a prototype built for the Build with AI: Code for Communities hackathon. Districts,
          populations, the medicines catalogue and the facility norms are real; facility-level stock, consumption,
          batches and staffing are simulated. It is a demonstration, not a service.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-mist-100">Not for real decisions</h2>
        <p>
          Nothing on this site is clinical, procurement or public-health advice. Forecasts, warnings and dispatch
          orders describe a simulated network and must not be used to move real medicine or to make decisions about
          patients.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-mist-100">Using it</h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>Do not submit patient information, or any recording or photograph containing it.</li>
          <li>
            Actions you take while signed in are recorded against the identity described in the{' '}
            <Link href="/privacy" className="underline decoration-dotted hover:text-mist-100">privacy notice</Link> and shown
            on the public audit trail.
          </li>
          <li>The model-backed endpoints are rate limited; do not try to get around the limits.</li>
          <li>The operator may clear the log, reset the board or take the service down at any time.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-mist-100">Code and warranty</h2>
        <p>
          The source is published under the Apache License 2.0. The service is provided as is, without warranty of
          any kind, to the extent the law allows.
        </p>
      </section>
    </main>
  );
}
