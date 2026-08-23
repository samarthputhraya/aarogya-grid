/**
 * Skeleton for the district console.
 *
 * The page itself is prerendered, so this is only ever seen for the moment the
 * client router is fetching the RSC payload on a soft navigation from the
 * national map. It mirrors the real layout -- KPI band, order cards beside the
 * map, then a table -- rather than showing a spinner, because a shape that
 * matches what arrives reads as "loading" while a spinner reads as "waiting".
 */
export default function Loading() {
  return (
    <div className="min-h-screen animate-pulse">
      <div className="border-b border-ink-700 bg-ink-950">
        <div className="mx-auto max-w-[1600px] px-4 py-3 flex items-center gap-4">
          <div className="h-3 w-16 rounded bg-ink-700" />
          <div className="h-6 w-px bg-ink-700" />
          <div className="space-y-1.5">
            <div className="h-3 w-48 rounded bg-ink-700" />
            <div className="h-2 w-72 rounded bg-ink-800" />
          </div>
        </div>
        <div className="h-6 bg-sev-moderate/[0.07] border-t border-sev-moderate/20" />
      </div>

      <main className="mx-auto max-w-[1600px] px-4 py-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="panel px-3 py-2.5 space-y-2">
              <div className="h-2 w-20 rounded bg-ink-700" />
              <div className="h-5 w-24 rounded bg-ink-700" />
              <div className="h-2 w-28 rounded bg-ink-800" />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] gap-4 items-start">
          <div className="panel p-3 space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="rounded border border-ink-700 bg-ink-850 p-3 space-y-2">
                <div className="h-3 w-56 rounded bg-ink-700" />
                <div className="h-2 w-72 rounded bg-ink-800" />
                <div className="h-10 rounded bg-ink-900" />
                <div className="h-2 w-full rounded bg-ink-800" />
                <div className="h-2 w-4/5 rounded bg-ink-800" />
              </div>
            ))}
          </div>
          <div className="panel p-2">
            <div className="aspect-[520/460] rounded bg-ink-850" />
          </div>
        </div>

        <div className="panel p-3 space-y-2">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="h-4 rounded bg-ink-850" />
          ))}
        </div>
      </main>
    </div>
  );
}
