'use client';

/**
 * Next 16 hands an error boundary `{ error, retry }`.
 *
 * NOT `reset`. `reset` was the Next 15 prop name and the current file-convention
 * docs demote it to "only if you have a specific reason"; wiring a button to a
 * prop that is no longer passed produces a button that looks fine and does
 * nothing, which is worse than having no button.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="min-h-screen grid place-items-center p-8">
      <div className="panel max-w-md p-5">
        <div className="text-sm text-sev-critical mb-2">District console failed to load</div>
        <p className="text-xs text-mist-400 mb-4 leading-relaxed">
          {error.digest ? (
            <>
              Reference <span className="tnum text-mist-200">{error.digest}</span>.{' '}
            </>
          ) : null}
          The precomputed district file is missing or malformed. Every district page is read from{' '}
          <span className="tnum text-mist-300">src/data/districts/</span> at build time — rebuild it
          with <span className="tnum text-mist-200">npx tsx scripts/build-snapshot.mts</span>.
        </p>
        <button
          onClick={() => retry()}
          className="text-[11px] px-3 py-1.5 rounded border border-brand/40 text-brand hover:bg-brand/10 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
