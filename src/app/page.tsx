import NationalConsole from '@/components/NationalConsole';
import snapshot from '@/data/national-snapshot.json';
import type { NationalSnapshot } from '@/lib/snapshot-types';

/**
 * National control tower.
 *
 * Reads the precomputed snapshot rather than running the pipeline per request.
 * Building it takes ~2 minutes for the whole country; doing that on a page load
 * would be absurd. Against real data this same file would read last night's
 * batch output.
 */
export default function Page() {
  return <NationalConsole snapshot={snapshot as unknown as NationalSnapshot} />;
}
