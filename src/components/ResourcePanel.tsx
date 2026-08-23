import { Kpi, Th } from './ui/primitives';
import type {
  DistrictResources,
  OccupancyProbe,
  ReportingClass,
  ResourceFacilityRow,
} from '@/lib/district-detail';
import type { DistrictResourceSnapshot } from '@/lib/snapshot-types';
import { compactCount, count, pct, FACILITY_LABEL, SEVERITY_CLASS, type Severity } from '@/lib/format';

/**
 * The beds-and-workforce panel.
 *
 * WHY IT SITS INSIDE THE SUPPLY CONSOLE AND NOT ON A TAB OF ITS OWN
 * -----------------------------------------------------------------
 * The obvious move is a "Beds" tab and a "Staff" tab next to "Stock". That
 * would be three dashboards sharing a header, and it would throw away the only
 * thing that makes tracking all three worthwhile: they are the same fact seen
 * three ways.
 *
 * A facility with no pharmacist in position is a facility whose stock figures
 * -- the ones in the table directly above this panel -- were written down by
 * somebody doing it on top of a clinical shift. A ward at 96% occupancy is a
 * ward burning fluids and antibiotics faster than the forecast that ordered
 * them. Put those on separate tabs and the reader has to hold two screens in
 * their head to notice; put them on one page and the connection is unavoidable.
 *
 * So the running order here is deliberately: capacity, then people, then the
 * consequence for the numbers upstairs.
 */

const REPORTING_CLASS: Record<ReportingClass, { label: string; cls: string }> = {
  verified: { label: 'Verified', cls: 'text-sev-low bg-sev-low/10 border-sev-low/25' },
  attested: {
    label: 'Attested',
    cls: 'text-sev-moderate bg-sev-moderate/10 border-sev-moderate/25',
  },
  unverified: { label: 'Unverified', cls: 'text-sev-high bg-sev-high/10 border-sev-high/30' },
  unattended: {
    label: 'Unattended',
    cls: 'text-sev-critical bg-sev-critical/10 border-sev-critical/30',
  },
};

export default function ResourcePanel({
  resources,
  summary,
}: {
  resources: DistrictResources;
  summary: DistrictResourceSnapshot;
}) {
  const unstaffedBeds = Math.max(0, summary.functionalBeds - summary.staffedBeds);
  const nonFunctionalBeds = Math.max(0, summary.sanctionedBeds - summary.functionalBeds);

  return (
    /*
     * Hidden in print, like every other analytical panel on this route. What
     * prints from the district console is the dispatch note a storekeeper acts
     * on; a bed occupancy table is context for the decision, not part of the
     * instruction, and printing it costs paper without changing what anyone
     * does with the trolley.
     */
    <section className="space-y-3" data-print="hide">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi
          label="Bed occupancy"
          value={pct(summary.bedOccupancyRate, 0)}
          sub={`${count(summary.occupiedBeds)} of ${count(summary.functionalBeds)} functional beds`}
          tone={summary.pressure === 'critical' || summary.pressure === 'high' ? 'critical' : undefined}
        />
        {/*
         * Three bed numbers, not one, because they fall away in sequence and
         * every step is somebody's budget line. Sanctioned is what the
         * establishment order says. Functional is what has a mattress and a
         * working oxygen point. Staffed is what the nurses on duty today can
         * actually cover -- and it is usually the smallest of the three, which
         * is why "we need more beds" is so often the wrong ask.
         */}
        <Kpi
          label="Beds lost to the gap"
          value={count(nonFunctionalBeds + unstaffedBeds)}
          sub={`${count(nonFunctionalBeds)} non-functional · ${count(unstaffedBeds)} unstaffed`}
          tone={nonFunctionalBeds + unstaffedBeds > 0 ? 'high' : undefined}
        />
        <Kpi
          label="Demand that found no bed"
          value={count(summary.unmetBedDays)}
          sub="patient-days over 180 · absent from every occupancy return"
          tone={summary.unmetBedDays > 0 ? 'critical' : undefined}
        />
        <Kpi
          label="Staff present today"
          value={`${count(summary.staffPresent)} of ${count(summary.staffSanctioned)}`}
          sub={`${pct(summary.effectiveAvailability, 0)} of the sanctioned establishment`}
          tone={summary.effectiveAvailability < 0.6 ? 'critical' : undefined}
        />
        <Kpi
          label="Vacancy · absence"
          value={`${pct(summary.vacancyRate, 0)} · ${pct(summary.absenteeismRate, 0)}`}
          sub="posts unfilled · filled posts not attending"
          tone={summary.vacancyRate > 0.3 ? 'high' : undefined}
        />
        <Kpi
          label="Specialist posts filled"
          value={
            summary.specialistSanctioned > 0
              ? `${count(summary.specialistInPosition)} of ${count(summary.specialistSanctioned)}`
              : '—'
          }
          sub="surgeon · physician · O&G · paediatrician"
          tone={summary.specialistVacancyRate > 0.5 ? 'critical' : undefined}
        />
      </div>

      {/*
       * The sentence this whole layer exists to be able to write. It is not a
       * staffing statistic -- it is a statement about the reliability of the
       * stock table on the same page, expressed in the only unit that makes a
       * data-quality problem land with a district officer: people covered.
       */}
      <div className="panel p-3 text-[11px] leading-relaxed text-mist-400">
        <span className="text-mist-200 font-semibold">What this means for the stock figures. </span>
        <span className="tnum text-mist-100">{count(summary.facilitiesWithoutPharmacist)}</span>{' '}
        stock-holding {summary.facilitiesWithoutPharmacist === 1 ? 'facility has' : 'facilities have'}{' '}
        no pharmacist in position, and{' '}
        <span className="tnum text-mist-100">{count(summary.subCentresWithoutAnm)}</span> sub-centres
        have no ANM. The stock register is kept by whoever is free, from memory, at month end. That
        makes{' '}
        <span className="tnum text-mist-100">{count(summary.unverifiedReportingFacilities)}</span>{' '}
        {summary.unverifiedReportingFacilities === 1 ? 'facility' : 'facilities'} covering{' '}
        <span className="tnum text-mist-100">
          {compactCount(summary.populationUnderUnverifiedReporting)}
        </span>{' '}
        people <span className="text-sev-high">unverified</span> — every quantity attributed to them
        in the table above is an estimate wearing the typeface of a measurement. Mean report trust
        across the district is{' '}
        <span className="tnum text-mist-100">{pct(summary.meanReportTrust, 0)}</span>, population-weighted.
      </div>

      {resources.occupancy && <OccupancyChart probe={resources.occupancy} />}

      <div className="panel">
        <div className="panel-head">
          <span>Beds and workforce by facility</span>
          {/*
           * The column key lives here, permanently visible, rather than in a
           * `title=` on each header. Three-part cells need explaining, and a
           * legend nobody hovers over is a legend nobody reads.
           */}
          <span className="text-mist-500 normal-case tracking-normal">
            beds: occupied / functional / sanctioned · staff: present / in position / sanctioned
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-mist-400 border-b border-ink-700">
                <Th className="text-left pl-3">Facility</Th>
                <Th className="text-left">Tier</Th>
                <Th className="text-right">Beds</Th>
                <Th className="text-right">Occupancy</Th>
                <Th className="text-right">Staffed beds</Th>
                <Th className="text-right">Staff</Th>
                <Th className="text-right">Vacancy</Th>
                <Th className="text-right">Absent</Th>
                <Th className="text-left pr-3">Stock report</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {resources.facilities.map((f) => (
                <FacilityResourceRow key={f.id} row={f} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function FacilityResourceRow({ row }: { row: ResourceFacilityRow }) {
  const report = REPORTING_CLASS[row.reportingClass];
  return (
    <tr className="row-hover transition-colors align-top">
      <td className="pl-3 py-1.5">
        <span className="text-mist-100">{row.name}</span>
        {/*
         * The gaps are rendered as sentences under the facility name rather
         * than hidden behind a tooltip or a count. "specialist 4/0" is a cell;
         * "this facility cannot function as a referral unit" is a decision.
         */}
        {row.criticalGaps.length > 0 && (
          <span className="block text-[10px] text-sev-high leading-snug mt-0.5 max-w-[46ch]">
            {row.criticalGaps.join(' ')}
          </span>
        )}
      </td>
      <td className="py-1.5 px-2 text-mist-400 text-[10px]" title={FACILITY_LABEL[row.type] ?? row.type}>
        {row.type}
      </td>
      <td className="py-1.5 px-2 text-right tnum text-mist-300">
        {row.sanctionedBeds === 0 ? (
          <span className="text-mist-500" title="No sanctioned inpatient beds at this tier">
            —
          </span>
        ) : (
          <>
            <span className="text-mist-100">{count(row.occupiedBeds)}</span>
            <span className="text-mist-500">
              {' / '}
              {count(row.functionalBeds)} / {count(row.sanctionedBeds)}
            </span>
          </>
        )}
      </td>
      <td className="py-1.5 px-2 text-right">
        {row.sanctionedBeds === 0 ? (
          <span className="text-mist-500">—</span>
        ) : (
          <span
            className={
              'tnum text-[11px] px-1.5 py-0.5 rounded border ' +
              SEVERITY_CLASS[row.pressure as Severity]
            }
            title={`Mean ${pct(row.meanOccupancyRate, 0)} · peak ${pct(row.peakOccupancyRate, 0)} · ${row.daysAtCapacity} days at capacity · ${count(row.unmetBedDays)} patient-days turned away`}
          >
            {pct(row.occupancyRate, 0)}
          </span>
        )}
      </td>
      <td className="py-1.5 px-2 text-right tnum">
        {row.sanctionedBeds === 0 ? (
          <span className="text-mist-500">—</span>
        ) : (
          <span className={row.staffedBeds < row.functionalBeds ? 'text-sev-high' : 'text-mist-300'}>
            {count(row.staffedBeds)}
          </span>
        )}
      </td>
      <td className="py-1.5 px-2 text-right tnum">
        <span className="text-mist-100">{count(row.staffPresent)}</span>
        <span className="text-mist-500">
          {' / '}
          {count(row.staffInPosition)} / {count(row.staffSanctioned)}
        </span>
      </td>
      <td className="py-1.5 px-2 text-right tnum">
        <span className={row.vacancyRate >= 0.3 ? 'text-sev-high' : 'text-mist-300'}>
          {pct(row.vacancyRate, 0)}
        </span>
      </td>
      <td className="py-1.5 px-2 text-right tnum">
        <span className={row.absenteeismRate >= 0.3 ? 'text-sev-high' : 'text-mist-300'}>
          {pct(row.absenteeismRate, 0)}
        </span>
      </td>
      <td className="py-1.5 px-2 pr-3">
        <span
          className={'text-[10px] px-1.5 py-0.5 rounded border ' + report.cls}
          title={row.reportingNote}
        >
          {report.label}
        </span>
        <span className="block text-[10px] text-mist-500 tnum mt-0.5">
          trust {pct(row.reportingScore, 0)}
          {row.consumptionPressure !== 1 && (
            <span title="Multiplier on modelled drug consumption implied by this facility's ward occupancy">
              {' '}
              · drug use ×{row.consumptionPressure.toFixed(2)}
            </span>
          )}
        </span>
      </td>
    </tr>
  );
}

/**
 * Occupied beds against admission demand, over the last 180 days.
 *
 * This chart has exactly one job: show the two lines separating. Below capacity
 * they are the same line, because every patient who arrived got a bed and the
 * occupancy return is a true record. Above capacity the recorded line goes flat
 * along the top -- it cannot do anything else -- while demand keeps climbing,
 * and everything between them is people who were sent somewhere else and appear
 * in no dataset anywhere.
 *
 * Drawn as inline SVG rather than through a charting library because it is two
 * polylines and a rule; pulling a chart runtime into the bundle to draw three
 * paths is how a page ends up shipping 300 KB to show 360 numbers.
 */
function OccupancyChart({ probe }: { probe: OccupancyProbe }) {
  const W = 900;
  const H = 150;
  const PAD_L = 34;
  const PAD_B = 16;
  const PAD_T = 8;

  const n = probe.occupied.length;
  const yMax = Math.max(probe.functionalBeds, ...probe.demand) * 1.08 || 1;
  const x = (i: number) => PAD_L + (i / Math.max(1, n - 1)) * (W - PAD_L - 6);
  const y = (v: number) => PAD_T + (1 - v / yMax) * (H - PAD_T - PAD_B);

  const path = (series: number[]) => series.map((v, i) => `${x(i)},${y(v).toFixed(1)}`).join(' ');

  const turnedAway = probe.demand.reduce(
    (a, v) => a + Math.max(0, v - probe.functionalBeds),
    0,
  );
  const daysOver = probe.demand.filter((v) => v > probe.functionalBeds).length;

  return (
    <div className="panel">
      <div className="panel-head">
        <span>Occupancy vs admission demand · {probe.facilityName}</span>
        <span className="text-mist-500 normal-case tracking-normal">
          180 days to {probe.asOf} · {probe.functionalBeds} functional of {probe.sanctionedBeds}{' '}
          sanctioned beds
        </span>
      </div>
      <div className="p-3">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[150px]" role="img">
          {/* capacity rule -- the ceiling the recorded series can never cross */}
          <line
            x1={PAD_L}
            x2={W - 6}
            y1={y(probe.functionalBeds)}
            y2={y(probe.functionalBeds)}
            stroke="var(--color-sev-critical)"
            strokeDasharray="4 3"
            strokeWidth="1"
            opacity="0.75"
          />
          <text
            x={PAD_L - 4}
            y={y(probe.functionalBeds) + 3}
            textAnchor="end"
            className="tnum"
            fontSize="9"
            fill="var(--color-sev-critical)"
          >
            {probe.functionalBeds}
          </text>
          <text x={PAD_L - 4} y={H - PAD_B} textAnchor="end" fontSize="9" fill="#7c8794">
            0
          </text>

          {/* demand: what presented. Never observable in a real occupancy return. */}
          <polyline
            points={path(probe.demand)}
            fill="none"
            stroke="var(--color-sev-high)"
            strokeWidth="1.1"
            opacity="0.85"
          />
          {/* occupied: what the return records. Flattens against the rule above. */}
          <polyline
            points={path(probe.occupied)}
            fill="none"
            stroke="var(--color-brand)"
            strokeWidth="1.4"
          />
        </svg>

        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[10px] text-mist-400 mt-1">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-px bg-brand" /> Beds occupied — what the HMIS return
            contains
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-px bg-sev-high" /> Admissions presenting — never
            recorded anywhere
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 border-t border-dashed border-sev-critical" />{' '}
            Functional bed capacity
          </span>
        </div>

        <p className="text-[11px] text-mist-400 leading-relaxed mt-2 max-w-[92ch]">
          {turnedAway > 0 ? (
            <>
              Demand exceeded capacity on{' '}
              <span className="tnum text-mist-100">{daysOver}</span> of {n} days, and{' '}
              <span className="tnum text-sev-high">{count(turnedAway)}</span> patient-days of
              admission demand found no bed. None of that appears in an occupancy return, which can
              only ever record patients who were admitted — so this facility reads as{' '}
              <span className="text-mist-300">fully utilised</span> in every report that reaches the
              state, when what it actually is, is short. It is the same blindness the stock ledger
              has: a shelf that runs out records zero consumption, not unmet demand.
            </>
          ) : (
            <>
              Demand stayed inside capacity across all {n} days, so the two lines coincide and the
              occupancy return is a true record of admissions. This is what the absence of censoring
              looks like, and it is worth being able to tell apart from a ward that is full.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
