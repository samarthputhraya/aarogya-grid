import { notFound } from 'next/navigation';
import DistrictConsole from '@/components/DistrictConsole';
import { DISTRICTS_BY_CODE } from '@/lib/domain/geo';
import { loadDistrictDetail } from '@/lib/run-store';

/**
 * District console route.
 *
 * READ, NOT COMPUTED, PER REQUEST
 * -------------------------------
 * `buildDistrictState` + `planRedistribution` would run happily inside this
 * function and it is deliberately not done that way: one district is seconds of
 * pipeline and solver, in the single highest-stakes click of the demo, spent
 * producing byte-identical numbers. The batch computes every district and this
 * page reads the payload the served run carries.
 *
 * RENDERED ON REQUEST, NOT PRERENDERED
 * ------------------------------------
 * With 128 districts every page was prerendered at build time. At 769 that is
 * roughly a gigabyte of HTML and React payload baked into the image, and a
 * scheduled batch run could never reach a page without a rebuild. So the page
 * renders on request from the run store's in-memory copy of the payload.
 *
 * An unknown code is still a 404 before any file is touched: the registry, not
 * the filesystem, decides what a district is.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(props: PageProps<'/district/[code]'>) {
  // Next 16: `params` is a Promise; the synchronous shim is gone.
  const { code } = await props.params;
  const district = DISTRICTS_BY_CODE[code];
  return {
    title: district ? `${district.name}, ${district.stateName} — Aarogya Grid` : 'District — Aarogya Grid',
    description: district
      ? `Stock risk, dispatch orders and unmet needs across the ${district.name} primary health network.`
      : undefined,
  };
}

export default async function Page(props: PageProps<'/district/[code]'>) {
  const { code } = await props.params;
  if (!DISTRICTS_BY_CODE[code]) notFound();
  const detail = await loadDistrictDetail(code);
  return <DistrictConsole detail={detail} />;
}
