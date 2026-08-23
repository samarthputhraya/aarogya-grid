import CaptureConsole from '@/components/CaptureConsole';
import { facilitiesInDistrict } from '@/lib/facility-lookup';

/**
 * Field capture page.
 *
 * Offers a spread of facility tiers across different districts, because the
 * formulary a facility carries changes what the resolver will accept -- a
 * sub-centre genuinely cannot report Ceftriaxone, and demonstrating that
 * refusal matters more than demonstrating a happy path.
 */
export default function Page() {
  const districts = ['DST-22-BASTAR', 'DST-28-VISAKHAP', 'DST-19-MURSHIDA', 'DST-27-GADCHIRO'];
  const facilities = districts
    .flatMap((d) => facilitiesInDistrict(d))
    .filter((f) => f.type === 'PHC' || f.type === 'SC' || f.type === 'CHC')
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
    .slice(0, 40);

  return <CaptureConsole facilities={facilities} />;
}
