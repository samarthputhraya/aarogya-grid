import NationalConsole from '@/components/NationalConsole';
import snapshot from '@/data/national-snapshot.json';
import type { NationalSnapshot } from '@/lib/snapshot-types';

/**
 * National control tower.
 *
 * Moved here from `/` when the landing page took the root. The console is the
 * product and the landing page is the argument for it; an assessor who arrives
 * cold needs the argument first, and an operator who uses this daily bookmarks
 * `/console` and never sees the landing page again. Every back-link in the app
 * (district view, capture, the district 404) points here rather than at `/`,
 * because "← National view" from a district means this page, not the pitch.
 *
 * Reads the precomputed snapshot rather than running the pipeline per request.
 * Building it takes ~2 minutes for the whole country; doing that on a page load
 * would be absurd. Against real data this same file would read last night's
 * batch output.
 */
export default function Page() {
  return <NationalConsole snapshot={snapshot as unknown as NationalSnapshot} />;
}
