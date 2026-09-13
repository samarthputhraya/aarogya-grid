import NationalConsole from '@/components/NationalConsole';
import { loadNationalSnapshot } from '@/lib/run-store';

/**
 * National control tower.
 *
 * Moved here from `/` when the landing page took the root. The console is the
 * product and the landing page is the argument for it; an assessor who arrives
 * cold needs the argument first, and an operator who uses this daily bookmarks
 * `/console` and never sees the landing page again.
 *
 * Reads the batch run the service is serving (`@/lib/run-store`) at request
 * time rather than importing a snapshot at build time, so a run the scheduled
 * job publishes reaches this page without a redeploy. The snapshot is parsed
 * once per run and held in memory; a request renders, it does not recompute.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  const snapshot = await loadNationalSnapshot();
  return <NationalConsole snapshot={snapshot} />;
}
