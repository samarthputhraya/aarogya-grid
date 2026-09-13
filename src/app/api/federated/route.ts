import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The federation index: the national prior, the disclosure, and every node's digest.
 *
 * WHY THIS IS A URL
 * -----------------
 * "States keep their data and share only models" is a sentence. This is the
 * thing the sentence describes. A reviewer can open it, read the pooled prior
 * and the estimator that produced it, see the SHA-256 of each of the thirty-six
 * state and union-territory files, fetch any one of them at `/api/federated/<STATE>`, and hash it
 * themselves. Nothing about the claim has to be taken on trust, which is the
 * only form in which a claim like this is worth making.
 *
 * It also carries its own limitation. `disclosure.syntheticBetweenStateVariance`
 * says plainly that one simulator generates all thirty-six, so the
 * between-state variance the estimator recovers is largely an artefact and the
 * pooling weights are a demonstration. A reviewer who found that out for
 * themselves would be right to discount everything else on the page.
 *
 * SERVED AS BYTES, NOT AS AN OBJECT
 * ---------------------------------
 * The file is read and returned verbatim rather than imported, re-serialised
 * and shipped. Re-serialising would reorder nothing and change everything a
 * digest depends on -- key order survives, but indentation, number formatting
 * and the trailing newline do not -- and then the SHA-256 in the payload would
 * describe a file the API never serves. Reading the bytes keeps the digest
 * meaningful.
 *
 * `force-static` because the payload is a build artefact: the response is
 * computed once at build time and served from static output, so this route
 * costs nothing at request time and cannot be made to wait on a cold container.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  const body = await readFile(join(process.cwd(), 'src/data/federated/_national.json'), 'utf8');
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // A build artefact that changes only when the snapshot is rebuilt.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
