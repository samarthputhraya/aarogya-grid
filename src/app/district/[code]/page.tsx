import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { notFound } from 'next/navigation';
import DistrictConsole from '@/components/DistrictConsole';
import { DISTRICTS, DISTRICTS_BY_CODE } from '@/lib/domain/geo';
import type { DistrictDetail } from '@/lib/district-detail';

/**
 * District console route.
 *
 * PRERENDERED, NOT COMPUTED PER REQUEST
 * -------------------------------------
 * `buildDistrictState` + `planRedistribution` would run happily inside this
 * function -- `scripts/demo-district.mts` proves the whole chain works in one
 * call -- and it would be about eight lines. It is deliberately not done that
 * way. One district measures ~1.5 s of pipeline plus ~150 ms of solver, and on
 * a stage that 1.7 s is not 1.7 s: it is 1.7 s of Node CPU on top of a cold
 * route compile or a serverless boot, sitting in the single highest-stakes
 * click in the demo. The pipeline is deterministic (fixed seed, fixed as-of),
 * so a request-time recompute would spend that time producing byte-identical
 * numbers. `scripts/build-snapshot.mts` already does the compute for all 128
 * districts and now writes each one out; this page does nothing but read it.
 *
 * ONE FILE PER DISTRICT, READ WITH `readFile` -- NOT `import`
 * -----------------------------------------------------------
 * A static `import` of a combined details file would be inlined into every one
 * of the 128 prerendered routes, turning a ~12 MB payload into ~12 MB of HTML
 * per page. Reading the district's own file from disk at build time keeps each
 * page to its own payload. This is not hypothetical: `src/app/page.tsx` imports
 * the 228 KB national snapshot into a client component, which is exactly why
 * the national HTML is several hundred KB.
 *
 * `dynamicParams = false` because the district set is a compile-time constant.
 * An unknown code is a typo or a probe, and the correct answer to both is a
 * 404 served from static output, not a Node process starting up to discover
 * there is no such district.
 */

export const dynamicParams = false;
export const revalidate = false;

export function generateStaticParams() {
  return DISTRICTS.map((d) => ({ code: d.code }));
}

export async function generateMetadata(props: PageProps<'/district/[code]'>) {
  // Next 16: `params` is a Promise. The synchronous compatibility shim Next 15
  // shipped has been removed outright, so this `await` is required, not
  // stylistic.
  const { code } = await props.params;
  const district = DISTRICTS_BY_CODE[code];
  return {
    title: district
      ? `${district.name}, ${district.stateName} — Aarogya Grid`
      : 'District — Aarogya Grid',
    description: district
      ? `Stock risk, dispatch orders and unmet needs across the ${district.name} primary health network.`
      : undefined,
  };
}

export default async function Page(props: PageProps<'/district/[code]'>) {
  const { code } = await props.params;

  // Checked against the catalogue rather than trusting the filesystem: with
  // `dynamicParams = false` this is unreachable in production, but it stops a
  // stale or hand-written JSON file in `src/data/districts/` from resurrecting
  // a district the geography no longer knows about.
  if (!DISTRICTS_BY_CODE[code]) notFound();

  const raw = await readFile(join(process.cwd(), 'src/data/districts', `${code}.json`), 'utf8');
  const detail = JSON.parse(raw) as DistrictDetail;
    return <DistrictConsole detail={detail} />;
}
