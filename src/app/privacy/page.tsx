import Link from 'next/link';

export const metadata = { title: 'Privacy · Aarogya Grid' };

/**
 * The privacy notice, written to describe what the code does -- each paragraph
 * names the file that does it, so it can be checked rather than trusted.
 */
export default function Page() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-12 text-[13px] leading-relaxed text-mist-300 space-y-6">
      <div>
        <Link href="/" className="text-[11px] text-mist-500 hover:text-mist-300">
          ← Aarogya Grid
        </Link>
        <h1 className="mt-3 text-xl font-semibold text-mist-100">Privacy</h1>
        <p className="mt-1 text-[11px] text-mist-500">Aarogya Grid is a hackathon prototype. Last updated 14 September 2026.</p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-mist-100">Reading the site</h2>
        <p>
          No account, no analytics and no advertising. Nothing identifying is stored by the application when you
          read the console, a district page or the federated nodes. Like any web service on Google Cloud Run, the
          platform keeps request logs (address, time, path, browser) for operating the service.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-mist-100">Signing in with Google</h2>
        <p>
          Signing in is needed only to change something: to read a stock report with the model, commit a number,
          or approve, dispatch or receive an order. Google confirms who you are; the application then keeps only:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>your name as Google provides it;</li>
          <li>a masked form of your address, such as <span className="text-mist-100">sa•••@gmail.com</span>;</li>
          <li>a keyed code derived from your Google account id, which tells two people apart without naming either.</li>
        </ul>
        <p>
          Your full email address and your Google account id are not stored. These three items sit in a signed,
          HttpOnly cookie for eight hours (<code>src/lib/auth/token.ts</code>), and are written next to every action you
          take, in the audit log, which is public on the consoles by design: an order that moved medicine between
          two facilities has to say who moved it.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-mist-100">Reports, audio and photographs</h2>
        <p>
          A typed report, a voice recording or a photograph of a register is sent to Gemini on Vertex AI, in the
          Mumbai region (asia-south1), to produce a draft (<code>src/app/api/capture/route.ts</code>). The application does
          not store the recording or the photograph. A number you confirm and commit is stored, with the actor
          described above, in BigQuery in the same region.
        </p>
        <p>
          The facility stock on this site is simulated. Do not record or photograph anything containing patient
          information.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-mist-100">Where it is kept, and for how long</h2>
        <p>
          Everything the application stores is in Google Cloud in asia-south1: the audit log in BigQuery, dispatch
          tickets in Cloud Storage. It is kept until the operator clears the prototype&rsquo;s log, which is done before
          and after demonstrations.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-mist-100">Questions and removal</h2>
        <p>
          Open an issue on the{' '}
          <a href="https://github.com/samarthputhraya/aarogya-grid/issues" className="underline decoration-dotted hover:text-mist-100">
            project repository
          </a>{' '}
          to ask what is held about an action you took or to have it removed.
        </p>
      </section>

      <p className="text-[11px] text-mist-500">
        <Link href="/terms" className="underline decoration-dotted hover:text-mist-300">Terms</Link>
      </p>
    </main>
  );
}
