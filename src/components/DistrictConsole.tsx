'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import TransferMap from './TransferMap';
import ResourcePanel from './ResourcePanel';
import ForecastPanel from './ForecastPanel';
import GridAssistant from './GridAssistant';
import { EmptyState, FOCUS_RING, Kpi, Th } from './ui/primitives';
import type {
  DispatchOrder,
  DistrictDetail,
  PositionRow,
  UnservedNeed,
  UnservedReason,
} from '@/lib/district-detail';
import {
  count,
  days,
  inrFull,
  pct,
  compactCount,
  FACILITY_LABEL,
  SEVERITY_CLASS,
  VED_LABEL,
  type Severity,
} from '@/lib/format';

/**
 * District console.
 *
 * The route this renders was, until now, a 404 reached from the most prominent
 * button on the national page. That is the whole reason it exists, and it
 * dictates the running order below: the panel a visitor lands on has to be the
 * thing the national view could not show them.
 *
 * INFORMATION ARCHITECTURE -- WHY THIS ORDER
 * ------------------------------------------
 * Panels are ranked by the question each one answers, hardest question first:
 *
 *   1. plan economics   "what does acting cost, and what does it buy?"
 *   2. DISPATCH ORDERS  "what exactly do I tell my storekeeper to do?"
 *   3. positions        "which shelves are the problem?"
 *   4. censored demand  "where did those demand figures come from, and why
 *                        should I believe them?"
 *   5. unserved needs   "what did you NOT fix, and why?"
 *   6. beds & workforce "how many of these numbers can I believe, and what
 *                        capacity do I have to act with?"
 *   7. facility roster  "how much of my district is even in this?"
 *
 * Censored demand sits at 4, immediately under the position table, because it
 * is that table's own footnote made visible. Every AMC, every reorder point and
 * every days-of-cover figure in those rows is derived from a demand fit that
 * deliberately DELETES the days a shelf stood empty -- a ledger records what was
 * dispensed, so a stock-out writes itself into the record as an absence of
 * demand and drags the next forecast down. Directly above, the reader has just
 * been given a screen of numbers; this is where they get to see the one
 * correction those numbers rest on, on a real 365-day series, before being told
 * what could not be fixed. It sits above the unserved panel and not below it
 * because a reader who doubts the demand figures has no reason to care which
 * needs went unmet.
 *
 * Beds and workforce sit at 6 rather than at the top because they are not a
 * competing headline -- they are the caveat and the capacity behind everything
 * above them. A reader who has just been shown a stock-out and a dispatch order
 * is exactly the reader who should then be told that the facility in question
 * has no pharmacist to have counted the shelf, and no free bed to admit the
 * patient the medicine was for.
 *
 * The dispatch orders sit ABOVE the alert table on purpose, which inverts the
 * usual dashboard reflex of showing the problem first and the action somewhere
 * below the fold. Every stock dashboard in existence can render a red table.
 * Almost none of them names an executable action against a specific batch on a
 * specific shelf, and that is the only output here worth the width.
 *
 * SELECTION MODEL
 * ---------------
 * Two independent selections, deliberately not merged into one:
 *   - `selectedOrderId` binds the order cards to the map arcs, both directions.
 *   - `facilityFilter` binds the roster to the position table and the map.
 * They are separate because they answer different questions and a user
 * frequently wants both at once -- "show me this facility's shelves WHILE I
 * read the order heading there" is the normal case, not an edge case.
 */

const TIERS: { key: string; label: string }[] = [
  { key: 'DW', label: 'Warehouse' },
  { key: 'DH', label: 'DH' },
  { key: 'CHC', label: 'CHC' },
  { key: 'PHC', label: 'PHC' },
  { key: 'SC', label: 'Sub-centre' },
];

/**
 * Why each need went unserved, in the words a district officer would use.
 *
 * These are not cosmetic relabels of the enum: each maps to a DIFFERENT ask.
 * "No surplus anywhere" is a procurement problem, "already committed" is an
 * allocation problem, the two range reasons are a transport-network problem,
 * and the benefit/cost gate is a budget problem. A single "unserved: 100"
 * cannot tell those apart, which is exactly why the histogram is on screen.
 */
const REASON_LABEL: Record<UnservedReason, string> = {
  no_surplus: 'No surplus held anywhere in the district',
  donor_stock_committed: 'Surplus existed, but a higher-harm need took it first',
  out_of_range: 'Every holder beyond the 150 km road cap',
  cold_chain_range: 'Every holder beyond the 60 km cold-box cap',
  no_usable_batch: 'No batch survives the trip with usable shelf life',
  failed_bc_gate: 'Failed the benefit/cost gate — the medicine is worth less than the trip',
};

const REASON_SHORT: Record<UnservedReason, string> = {
  no_surplus: 'no surplus',
  donor_stock_committed: 'committed',
  out_of_range: 'out of range',
  cold_chain_range: 'cold-chain range',
  no_usable_batch: 'no usable batch',
  failed_bc_gate: 'benefit/cost',
};

/** Average monthly consumption -- the unit every CMO office actually speaks in. */
function amc(row: PositionRow): number {
  return row.forecastDailyDemand * 30.4;
}

export default function DistrictConsole({
  detail,
  configured,
}: {
  detail: DistrictDetail;
  /**
   * Whether a Gemini backend is reachable. Resolved on the server and passed
   * down rather than probed here: `isConfigured()` reads process.env, which a
   * client component cannot see, and guessing from a failed fetch would mean
   * showing the officer a broken panel before telling them why.
   */
  configured: boolean;
}) {
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const [facilityFilter, setFacilityFilter] = useState<string | null>(null);

  const cardRefs = useRef(new Map<string, HTMLDivElement | null>());

  /**
   * Selection driven from the map has to drag the matching card into view --
   * fifteen cards is taller than a viewport, and an arc that highlights a card
   * nobody can see is a cross-link that does not link.
   */
  const selectFromMap = useCallback((id: string | null) => {
    setSelectedOrderId(id);
    if (id) cardRefs.current.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  const d = detail.district;
  const e = detail.economics;

  const tierCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of detail.positions) m[p.facilityType] = (m[p.facilityType] ?? 0) + 1;
    return m;
  }, [detail.positions]);

  const visiblePositions = useMemo(
    () =>
      detail.positions.filter(
        (p) =>
          (tier === null || p.facilityType === tier) &&
          (facilityFilter === null || p.facilityId === facilityFilter),
      ),
    [detail.positions, tier, facilityFilter],
  );

  const unservedTotal = e.unservedReceivers;
  const reasons = useMemo(
    () =>
      (Object.entries(e.reasonHistogram) as [UnservedReason, number][])
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]),
    [e.reasonHistogram],
  );

  const filteredFacility = facilityFilter
    ? detail.facilities.find((f) => f.id === facilityFilter)
    : null;

  /**
   * The denominator behind the coverage tile.
   *
   * Guarded because `transfers + unservedReceivers` is a sum of two counts that
   * can both be zero -- a district where the optimiser found nothing to move and
   * nothing it had to decline is a legitimate outcome, and `0 of 0 · NaN%` is
   * not a way to report it.
   */
  const needsTotal = e.transfers + e.unservedReceivers;

  return (
    <div className="min-h-screen">
      {/* ================= header ================= */}
      <header
        className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/95 backdrop-blur"
        data-print="hide"
      >
        <div className="mx-auto max-w-[1600px] px-4 py-3 flex items-center gap-4 flex-wrap">
          <Link
            href="/"
            className={
              'text-mist-400 hover:text-mist-100 text-xs whitespace-nowrap rounded px-1 -mx-1 ' +
              FOCUS_RING
            }
          >
            ← National
          </Link>

          <div className="h-6 w-px bg-ink-700" />

          <div>
            <h1 className="text-sm font-semibold tracking-tight leading-none">
              {d.districtName}, {d.stateName}
            </h1>
            <p className="text-[10px] text-mist-400 leading-none mt-1">
              <span className="tnum">{d.districtCode}</span> · {count(d.facilities)} facilities ·{' '}
              {count(d.trackedPositions)} stock positions ·{' '}
              {count(d.resources.functionalBeds)} functional beds ·{' '}
              {count(d.resources.staffSanctioned)} sanctioned posts ·{' '}
              {compactCount(d.population)} modelled catchment
            </p>
          </div>

          <div className="flex-1" />

          <div className="text-[11px] text-mist-400 hidden md:block">
            <span className="text-mist-200 tnum">{detail.asOf}</span> · position as of
          </div>

          <Link
            href="/capture"
            className={
              'text-[11px] px-3 py-1.5 rounded border border-brand/40 text-brand ' +
              'hover:bg-brand/10 transition-colors ' +
              FOCUS_RING
            }
          >
            Field capture →
          </Link>
        </div>

        {/*
         * The simulated-data warning is a permanently visible strip, not a
         * `title=` tooltip. Nobody has ever seen your tooltip, and a caveat
         * that only appears on hover is a caveat you are hoping goes unread.
         *
         * It reads FACILITY, not STOCK, since the beds-and-workforce panel
         * landed. A strip that names only the stock ledger would, by omission,
         * imply the bed occupancy and attendance figures below it came from
         * somewhere firmer -- and a caveat that quietly launders the newest
         * numbers on the page is worse than no caveat, because the reader has
         * been told the page is honest about its provenance and will believe
         * anything the strip does not disclaim.
         */}
        <div className="border-t border-sev-moderate/20 bg-sev-moderate/[0.07]">
          <div className="mx-auto max-w-[1600px] px-4 py-1.5 text-[10px] text-sev-moderate flex items-center gap-2 flex-wrap">
            <span className="font-semibold tracking-wider">SIMULATED FACILITY DATA</span>
            <span className="text-sev-moderate/70">
              Districts, coordinates, IPHS tier structure, bed norms, the staffing establishment and
              the drug catalogue are real. Facility stock, batches, consumption ledgers, bed
              occupancy, post vacancy and daily attendance are all generated — parameterised from
              IPHS norms and published epidemiological seasonality, not fitted to observed data.
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-4 space-y-4">
        {/* ================= 0 · ask the grid =================
            Above plan economics deliberately. Everything below this point is a
            table a trained analyst can read; this is the panel a District Health
            Officer who has never seen the system can use in their own language.
            It is also the only place in the app where the model does more than
            transcribe -- it plans which tools to call and answers from what they
            return -- so it belongs where a first-time visitor lands. */}
        <GridAssistant
          districtCode={d.districtCode}
          districtName={d.districtName}
          configured={configured}
          positions={detail.positions.length}
          orders={detail.orders.length}
          unserved={unservedTotal}
        />

        {/* ================= 1 · plan economics ================= */}
        <section>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <Kpi
              label="Shortfall averted"
              value={count(e.shortfallAvertedUnits)}
              sub="expected units of unmet demand"
              tone="good"
            />
            <Kpi
              label="Transport cost"
              value={inrFull(e.transportCostInr)}
              sub={`${count(e.transfers)} vehicle movements`}
              tone="high"
            />
            {/* `₹0 · 0 units` is arithmetically true and reads as a broken tile.
                Nothing was rescued because nothing was near enough to expiry to
                be worth the diesel, which is a different statement and the one
                worth printing. */}
            <Kpi
              label="Stock rescued from expiry"
              value={e.wasteAvertedUnits > 0 ? inrFull(e.wasteAvertedInr) : 'None'}
              sub={
                e.wasteAvertedUnits > 0
                  ? `${count(e.wasteAvertedUnits)} units re-sited before expiry`
                  : 'no batch was close enough to expiry to be worth moving for that alone'
              }
            />
            <Kpi
              label="Needs served"
              value={needsTotal > 0 ? `${count(e.transfers)} of ${count(needsTotal)}` : 'None'}
              sub={
                needsTotal > 0
                  ? `${pct(e.coverageShare, 0)} coverage · ${count(e.unservedReceivers)} left unserved`
                  : 'no facility in this district was projected to run short'
              }
              tone={needsTotal > 0 && e.coverageShare < 0.25 ? 'critical' : undefined}
            />
            <Kpi
              label="Dispatch orders"
              value={count(e.transfers)}
              sub={`solved in ${detail.buildSeconds.toFixed(2)}s for this district`}
            />
          </div>

          {/*
           * Volunteering the weakness of the headline number is worth more than
           * the number. `netBenefitInr` is overwhelmingly a policy multiplier,
           * and someone will find that by dividing two figures already on the
           * page. Better they read it here first.
           */}
          <p className="text-[11px] text-mist-500 mt-2 leading-relaxed">
            Net benefit for this plan works out at{' '}
            <span className="tnum text-mist-300">{inrFull(e.netBenefitInr)}</span>, but that is{' '}
            <span className="text-mist-300">policy-weighted, not cash</span>: averted Vital shortage
            is valued at 25× the price of the medicine (
            <span className="tnum">DEFAULT_SHORTAGE_PENALTY</span>, redistribute.ts) — a ministry
            dial, not a measurement. On pure stock value these movements are cash-negative by the
            transport line above. The defensible figure is the units column, not the rupees.
          </p>
        </section>

        {/* ================= 2 · dispatch orders + map ================= */}
        <section className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] gap-4 items-start">
          <div className="panel">
            <div className="panel-head">
              <span>
                Dispatch orders · {d.districtName} · executable today
              </span>
              <div className="flex items-center gap-3">
                <span className="text-mist-500 normal-case tracking-normal">
                  ranked by risk removed
                </span>
                <button
                  onClick={() => window.print()}
                  data-print="hide"
                  disabled={detail.orders.length === 0}
                  title={
                    detail.orders.length === 0
                      ? 'There is no dispatch note to print for this district'
                      : 'Print the dispatch notes as stock transfer slips'
                  }
                  className={
                    'text-[10px] px-2 py-1 rounded border border-ink-600 text-mist-400 ' +
                    'hover:text-mist-200 hover:border-ink-500 transition-colors normal-case ' +
                    'tracking-normal disabled:opacity-40 disabled:cursor-not-allowed ' +
                    FOCUS_RING
                  }
                >
                  Print notes
                </button>
              </div>
            </div>

            {detail.orders.length === 0 ? (
              <EmptyState
                message="No transfer could be justified in this district."
                detail={
                  <>
                    Every shortfall here was either unmatched by surplus anywhere in the district or
                    failed the benefit/cost gate. The reason split is in{' '}
                    <span className="text-mist-300">Why {count(unservedTotal)} needs got nothing</span>{' '}
                    below — this is a procurement or transport-budget problem, not a visibility one.
                  </>
                }
              />
            ) : (
              <div className="p-3 space-y-3 max-h-[720px] overflow-y-auto">
                {detail.orders.map((o, i) => (
                  <OrderCard
                    key={o.id}
                    order={o}
                    index={i + 1}
                    selected={o.id === selectedOrderId}
                    onHover={() => setSelectedOrderId(o.id)}
                    onLeave={() => setSelectedOrderId(null)}
                    cardRef={(el) => {
                      cardRefs.current.set(o.id, el);
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="panel" data-print="hide">
            <div className="panel-head">
              <span>Movement pattern</span>
              <span className="text-mist-500 normal-case tracking-normal">
                {count(detail.facilities.length)} facilities ·{' '}
                {detail.orders.length === 0
                  ? 'no arcs'
                  : `${count(detail.orders.length)} arc${detail.orders.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <div className="p-2">
              <TransferMap
                facilities={detail.facilities}
                orders={detail.orders}
                selectedOrderId={selectedOrderId}
                onSelectOrder={selectFromMap}
                selectedFacilityId={facilityFilter}
              />
            </div>
            <p className="px-3 pb-3 text-[10px] text-mist-500 leading-relaxed">
              No basemap by design: a district-level facility scatter needs no national boundary,
              so this view carries none of the boundary-accuracy caveats the national choropleth
              does.{' '}
              {detail.orders.length === 0
                ? 'Node size is the number of stock positions held; colour is mean risk.'
                : 'Hover an arc to pull up its order.'}
            </p>
          </div>
        </section>

        {/* ================= 3 · stock positions ================= */}
        <section className="panel" data-print="hide">
          <div className="panel-head">
            <span>
              Stock positions at risk
              {filteredFacility ? ` · ${filteredFacility.name}` : ''}
            </span>
            <span className="text-mist-500 normal-case tracking-normal">
              {count(visiblePositions.length)} of {count(detail.positions.length)} critical + high
            </span>
          </div>

          {/* Tier chips. This is the district-scale answer to "your alert board
              is 100% district hospitals": here every tier has real rows, because
              the per-district payload carries no top-N cap. */}
          <div className="px-3 py-2 border-b border-ink-800 flex items-center gap-1.5 flex-wrap">
            <Chip active={tier === null} onClick={() => setTier(null)} label="All" n={detail.positions.length} />
            {TIERS.filter((t) => (tierCounts[t.key] ?? 0) > 0).map((t) => (
              <Chip
                key={t.key}
                active={tier === t.key}
                onClick={() => setTier(tier === t.key ? null : t.key)}
                label={t.label}
                n={tierCounts[t.key] ?? 0}
              />
            ))}
            {filteredFacility && (
              <button
                onClick={() => setFacilityFilter(null)}
                className={
                  'ml-auto text-[10px] px-2 py-1 rounded border border-brand/40 text-brand ' +
                  'hover:bg-brand/10 transition-colors ' +
                  FOCUS_RING
                }
              >
                clear {filteredFacility.name} ×
              </button>
            )}
          </div>

          {/* The table is not rendered at all when the filter empties it. A
              header row over nothing is the single most common way a console
              looks broken, and it costs a reader several seconds to work out
              that it is a filter and not a fault. */}
          {visiblePositions.length === 0 ? (
            <EmptyState
              message={
                filteredFacility
                  ? `${filteredFacility.name} has no critical or high-severity position${tier ? ` at ${tier} tier` : ''}.`
                  : 'No critical or high-severity positions match this filter.'
              }
              detail={
                detail.positions.length > 0 ? (
                  <>
                    <span className="tnum">{count(detail.positions.length)}</span> positions are
                    tracked in this district. Clear the tier chips or the facility selection to see
                    them.
                  </>
                ) : (
                  'Nothing in this district is forecast to breach its reorder point inside the resupply window.'
                )
              }
              tone={detail.positions.length === 0 ? 'good' : 'neutral'}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-mist-400 border-b border-ink-700">
                  <Th className="text-left pl-3">Facility</Th>
                  <Th className="text-left">Tier</Th>
                  <Th className="text-left">Drug</Th>
                  <Th>VED</Th>
                  <Th className="text-right">On hand</Th>
                  <Th className="text-right">RoP</Th>
                  <Th className="text-right">AMC</Th>
                  <Th className="text-right">MOS</Th>
                  <Th className="text-right">Cover</Th>
                  <Th className="text-right">Lead</Th>
                  <Th className="text-right">P(out)</Th>
                  <Th className="text-right">Shortfall</Th>
                  <Th className="text-right pr-3">Risk</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {visiblePositions.map((p, i) => {
                  const monthly = amc(p);
                  return (
                    <tr key={p.facilityId + p.drugId + i} className="row-hover transition-colors">
                      <td className="pl-3 py-1.5 text-mist-100">{p.facilityName}</td>
                      <td className="px-2 text-mist-400 text-[10px]">{p.facilityType}</td>
                      <td className="px-2 text-mist-200">
                        {p.drugName}
                        <span className="text-mist-500"> {p.drugStrength}</span>
                        <span className="block text-[10px] text-mist-500">
                          {p.demandPattern} · {p.forecastMethod}
                          {p.censoredDays > 0 ? ` · ${p.censoredDays}d censored` : ''}
                        </span>
                      </td>
                      <td className="px-2 text-center">
                        <VedChip ved={p.ved} />
                      </td>
                      <td className="px-2 text-right tnum">
                        {p.onHand === 0 ? (
                          <span className="text-sev-critical font-semibold">0</span>
                        ) : (
                          <span className="text-mist-200">{count(p.onHand)}</span>
                        )}
                        <span className="text-mist-500 text-[10px]"> {p.unit}</span>
                      </td>
                      <td className="px-2 text-right tnum text-mist-400">{count(p.reorderPoint)}</td>
                      <td className="px-2 text-right tnum text-mist-400">
                        {monthly >= 1 ? count(monthly) : monthly.toFixed(1)}
                      </td>
                      <td className="px-2 text-right tnum text-mist-300">
                        {monthly > 0 ? (p.onHand / monthly).toFixed(1) : '—'}
                      </td>
                      <td className="px-2 text-right tnum text-mist-300">{days(p.daysOfCover)}</td>
                      <td className="px-2 text-right tnum text-mist-400">{p.leadTimeDays}d</td>
                      <td className="px-2 text-right tnum text-mist-200">
                        {(p.stockoutProbability * 100).toFixed(0)}%
                      </td>
                      <td className="px-2 text-right tnum text-mist-300">
                        {count(p.expectedShortfallUnits)}
                      </td>
                      <td className="text-right pr-3 py-1.5">
                        <span
                          className={
                            'tnum text-[11px] px-1.5 py-0.5 rounded border ' +
                            SEVERITY_CLASS[p.severity as Severity]
                          }
                        >
                          {p.riskScore}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </div>
          )}
          <p className="px-3 py-2 border-t border-ink-800 text-[10px] text-mist-500 leading-relaxed">
            AMC = forecast daily demand × 30.4, where the forecast is the fitted daily demand of the
            panel below bent by the seasonal multipliers over this row&rsquo;s lead time. MOS = on
            hand ÷ AMC. Cover uses the forecaster&rsquo;s
            mean demand while P(out) comes from the Monte Carlo draw, so the two can disagree on the
            same row — they are derived from different demand estimates and we know which line does
            it.
          </p>
        </section>

        {/* ================= 4 · where those demand figures come from =================
            Renders nothing when the payload carries no usable probe, which is
            the correct failure: the panel is an argument about a real series,
            and an empty frame headed "censored demand" argues the opposite. */}
        <ForecastPanel probe={detail.probe} asOf={detail.asOf} />

        {/* ================= 5 · what we could not fix ================= */}
        <section className="grid grid-cols-1 lg:grid-cols-[1fr_1.35fr] gap-4 items-start">
          <div className="panel" data-print="hide">
            <div className="panel-head">
              <span>
                {unservedTotal === 0
                  ? 'Nothing was left unserved'
                  : `Why ${count(unservedTotal)} need${unservedTotal === 1 ? '' : 's'} got nothing`}
              </span>
            </div>
            <div className="p-3 space-y-2">
              {reasons.map(([reason, n]) => (
                <div key={reason}>
                  <div className="flex items-baseline justify-between gap-3 text-[11px]">
                    <span className="text-mist-200">{REASON_LABEL[reason]}</span>
                    <span className="tnum text-mist-100 whitespace-nowrap">
                      {count(n)}{' '}
                      <span className="text-mist-500">
                        {unservedTotal > 0 ? pct(n / unservedTotal, 0) : '—'}
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 mt-1 rounded-sm bg-ink-800 overflow-hidden">
                    <div
                      className="h-full bg-sev-high/70"
                      style={{ width: unservedTotal > 0 ? `${(n / unservedTotal) * 100}%` : '0%' }}
                    />
                  </div>
                </div>
              ))}
              {reasons.length === 0 && (
                <p className="text-xs text-sev-low leading-relaxed">
                  Every expected shortfall in this district had a feasible dispatch. That is
                  unusual, and it means the constraint here is not the road network or the
                  transport budget — it is whatever put the stock in the wrong facility.
                </p>
              )}

              <p className="text-[11px] text-mist-400 leading-relaxed pt-2 border-t border-ink-800 mt-3">
                A system that always wins is a system nobody believes. This is the denominator
                behind the coverage tile, split by the constraint that actually bound — and the
                split matters, because each row is a different ask. Stock that does not exist needs
                procurement; stock that exists but fails the benefit/cost gate needs a transport
                budget, not more visibility.
              </p>
            </div>
          </div>

          <div className="panel" data-print="hide">
            <div className="panel-head">
              <span>Worst unserved needs</span>
              {/* "top 40" alone hides the truncation. The reader needs to know
                  whether they are looking at the whole list or the head of a
                  much longer one, because the two support different claims. */}
              <span className="text-mist-500 normal-case tracking-normal">
                {detail.unserved.length < unservedTotal
                  ? `worst ${count(detail.unserved.length)} of ${count(unservedTotal)} by expected shortfall`
                  : `all ${count(detail.unserved.length)}, by expected shortfall`}
              </span>
            </div>
            {detail.unserved.length === 0 ? (
              <EmptyState
                message="Nothing went unserved in this district."
                detail="Every projected shortfall was matched to a donor holding usable stock within range and inside the benefit/cost gate."
                tone="good"
              />
            ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-mist-400 border-b border-ink-700">
                    <Th className="text-left pl-3">Facility</Th>
                    <Th className="text-left">Drug</Th>
                    <Th>VED</Th>
                    <Th className="text-right">On hand</Th>
                    <Th className="text-right">Needed</Th>
                    <Th className="text-right">Shortfall</Th>
                    <Th className="text-right">Donor</Th>
                    <Th className="text-right">Best B/C</Th>
                    <Th className="text-left pr-3">Blocked by</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800">
                  {detail.unserved.map((u: UnservedNeed, i) => (
                    <tr key={u.facilityId + u.drugId + i} className="row-hover transition-colors">
                      <td className="pl-3 py-1.5">
                        <span className="text-mist-100">{u.facilityName}</span>
                        <span className="text-mist-500 text-[10px]"> {u.facilityType}</span>
                      </td>
                      <td className="px-2 text-mist-200">{u.drugName}</td>
                      <td className="px-2 text-center">
                        <VedChip ved={u.ved} />
                      </td>
                      <td className="px-2 text-right tnum">
                        {u.onHand === 0 ? (
                          <span className="text-sev-critical font-semibold">0</span>
                        ) : (
                          <span className="text-mist-300">{count(u.onHand)}</span>
                        )}
                      </td>
                      <td className="px-2 text-right tnum text-mist-300">{count(u.neededUnits)}</td>
                      <td className="px-2 text-right tnum text-mist-100">
                        {count(u.expectedShortfallUnits)}
                        <span className="text-mist-500 text-[10px]"> {u.unit}</span>
                      </td>
                      <td className="px-2 text-right tnum text-mist-400">
                        {u.nearestDonorKm === null ? '—' : `${u.nearestDonorKm.toFixed(0)} km`}
                      </td>
                      <td className="px-2 text-right tnum text-mist-400">
                        {u.bestBenefitCostRatio === null ? '—' : u.bestBenefitCostRatio.toFixed(2)}
                      </td>
                      <td className="pr-3 py-1.5">
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded border border-ink-600 text-mist-400"
                          title={REASON_LABEL[u.reason]}
                        >
                          {REASON_SHORT[u.reason]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </div>
        </section>

        {/* ================= 6 · beds and workforce ================= */}
        <ResourcePanel resources={detail.resources} summary={d.resources} />

        {/* ================= 7 · facility roster ================= */}
        <section className="panel" data-print="hide">
          <div className="panel-head">
            <span>Facilities in scope</span>
            <span className="text-mist-500 normal-case tracking-normal">
              {count(detail.facilities.length)} modelled · click a row to filter the table and map
            </span>
          </div>
          {detail.facilities.length === 0 ? (
            <EmptyState
              message="No facilities are modelled for this district."
              detail="Every panel above is empty for the same reason. Rebuild the district payload with scripts/build-snapshot.mts."
            />
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-mist-400 border-b border-ink-700">
                  <Th className="text-left pl-3">Facility</Th>
                  <Th className="text-left">Tier</Th>
                  <Th className="text-right">Catchment</Th>
                  <Th className="text-right">Lead time</Th>
                  <Th className="text-right">To parent</Th>
                  <Th className="text-right">Positions</Th>
                  <Th className="text-right">Critical</Th>
                  <Th className="text-right">At zero</Th>
                  <Th className="text-right pr-3">Mean risk</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {detail.facilities.map((f) => (
                  /*
                   * A clickable row that only a mouse can reach is half a
                   * control. `aria-pressed` because this is a toggle, not
                   * navigation -- clicking the selected facility clears the
                   * filter, and a reader on a keyboard has no other way to
                   * discover that.
                   */
                  <tr
                    key={f.id}
                    tabIndex={0}
                    role="button"
                    aria-pressed={facilityFilter === f.id}
                    onClick={() => setFacilityFilter(facilityFilter === f.id ? null : f.id)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        setFacilityFilter(facilityFilter === f.id ? null : f.id);
                      }
                    }}
                    className={
                      'row-hover cursor-pointer transition-colors ' +
                      FOCUS_RING +
                      ' focus-visible:ring-inset ' +
                      (facilityFilter === f.id ? 'bg-brand/5' : '')
                    }
                  >
                    <td className="pl-3 py-1.5 text-mist-100">{f.name}</td>
                    <td className="px-2 text-mist-400 text-[10px]" title={FACILITY_LABEL[f.type] ?? f.type}>
                      {f.type}
                    </td>
                    <td className="px-2 text-right tnum text-mist-300">{compactCount(f.population)}</td>
                    <td className="px-2 text-right tnum text-mist-400">{f.leadTimeDays}d</td>
                    <td className="px-2 text-right tnum text-mist-400">
                      {f.parentId ? `${f.distanceToParentKm.toFixed(0)} km` : '—'}
                    </td>
                    <td className="px-2 text-right tnum text-mist-300">{count(f.positions)}</td>
                    {/* A zero in a severity column is dimmed in both columns,
                        not one. The pair sit next to each other and had
                        different treatments, which made a facility with no
                        critical positions but no zero-stock ones either look
                        like two different kinds of fine. */}
                    <td className="px-2 text-right tnum text-sev-critical">
                      {f.criticalPositions === 0 ? (
                        <span className="text-mist-500">0</span>
                      ) : (
                        count(f.criticalPositions)
                      )}
                    </td>
                    <td className="px-2 text-right tnum">
                      {f.zeroStockPositions === 0 ? (
                        <span className="text-mist-500">0</span>
                      ) : (
                        <span className="text-mist-300">{count(f.zeroStockPositions)}</span>
                      )}
                    </td>
                    <td className="text-right pr-3 tnum text-mist-100">
                      {f.meanRiskScore.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </section>

        {/* ================= provenance ================= */}
        <footer className="panel p-4 text-[11px] text-mist-400 leading-relaxed" data-print="hide">
          <p className="text-mist-200 font-semibold mb-2 text-xs">
            What is real here, and what is not
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <p className="text-sev-low mb-1">Real</p>
              <ul className="space-y-0.5 list-disc list-inside">
                <li>Districts, state LGD/Census codes, and coordinates</li>
                <li>IPHS facility tiers, catchment norms and bed strength</li>
                <li>IPHS staffing establishment by tier and cadre</li>
                <li>Drug catalogue, VED classification, cold-chain flags</li>
                <li>Every model, forecast and optimisation in the system</li>
              </ul>
            </div>
            <div>
              <p className="text-sev-moderate mb-1">Simulated</p>
              <ul className="space-y-0.5 list-disc list-inside">
                <li>Individual facilities, their names and catchments</li>
                <li>Stock positions, batches and consumption ledgers</li>
                <li>Bed occupancy, ward mix and days spent at capacity</li>
                <li>Post vacancy, daily attendance and stock-report trust</li>
                <li>District supply reliability and allocation behaviour</li>
              </ul>
            </div>
          </div>
          <p className="mt-3 pt-3 border-t border-ink-800">
            Where this data would come from in production, by tier: DW / DH / CHC → DVDMS extract ·
            PHC → DVDMS where deployed, else field capture · SC → field capture only, because the
            sub-centre record is a paper register today. That last line is the whole reason{' '}
            <Link href="/capture" className="text-brand hover:underline">
              /capture
            </Link>{' '}
            exists: roughly the tier carrying the most risk is the tier with the least digital
            trace.
          </p>
          {/*
           * The beds-and-workforce layer gets its own production-source line
           * rather than being folded into the DVDMS sentence above, because it
           * would arrive over entirely different rails -- HMIS for bed returns,
           * a state HRMIS for the establishment, biometric or ANMOL-style
           * attendance for who actually turned up. Naming those separately is
           * the difference between a claim we could substantiate on day one of
           * an integration and a claim that sounds like it is already true.
           */}
          <p className="mt-2">
            Beds and workforce would arrive the same way and from different systems: bed strength
            and occupancy returns from HMIS, the sanctioned and in-position establishment from the
            state HRMIS, and present-today attendance from the facility biometric or ANM app. Until
            those are connected, every bed and every post on this page is{' '}
            <span className="text-sev-moderate">simulated by the same seeded model</span> that
            produces the stock ledger — the vacancy and absence rates are drawn from published
            Rural Health Statistics bands, not measured at these facilities.
          </p>
          <p className="mt-2 text-mist-500">
            Real PHC inventory data is not public. Connecting a live DVDMS / e-Aushadhi extract
            replaces the simulator and changes nothing downstream. This district&rsquo;s{' '}
            <span className="tnum text-mist-300">{count(d.trackedPositions)}</span> positions and{' '}
            <span className="tnum text-mist-300">{count(e.transfers)}</span> dispatch orders were
            computed in <span className="tnum text-mist-300">{detail.buildSeconds.toFixed(2)}s</span>{' '}
            as part of a national batch built{' '}
            <span className="tnum text-mist-300">{detail.builtAt.slice(0, 10)}</span>.
          </p>
        </footer>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * One dispatch order, as a card rather than a table row.
 *
 * A row would force the rationale into a truncated cell, and the rationale is
 * the single most differentiated output in the repo: it is generated at the
 * moment of the decision from the samples that decision was made against, and
 * it names a facility, a batch, an expiry, a distance, a cost and a residual
 * risk in one sentence a non-technical reader can check. It gets the width.
 *
 * The layout is deliberately shaped like a stock transfer note -- from, to,
 * what, how many, off which batch, how far, what it costs -- because that is
 * the artefact this replaces, and because a storekeeper can act on a piece of
 * paper without any of this software.
 */
function OrderCard({
  order,
  index,
  selected,
  onHover,
  onLeave,
  cardRef,
}: {
  order: DispatchOrder;
  index: number;
  selected: boolean;
  onHover: () => void;
  onLeave: () => void;
  cardRef: (el: HTMLDivElement | null) => void;
}) {
  const after = order.receiverOnHandBefore + order.quantity;
  // The optimiser reports the FALL in stock-out probability, so the residual is
  // a subtraction, not a second sample. Clamped because a rounded difference of
  // two rounded probabilities can land a hair below zero.
  const probAfter = Math.max(0, order.receiverStockoutProbBefore - order.riskReduction);

  return (
    /*
     * Focus is wired to the same handler as hover, so tabbing through the
     * order list highlights the matching arc on the map exactly as pointing at
     * it does. Without this the map/card cross-link -- the thing the two panels
     * exist to demonstrate -- was reachable only with a mouse.
     */
    <div
      ref={cardRef}
      tabIndex={0}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onFocus={onHover}
      onBlur={onLeave}
      aria-label={`Dispatch order ${index}: ${count(order.quantity)} ${order.unit} of ${order.drugName} from ${order.from.name} to ${order.to.name}`}
      className={
        'rounded border transition-colors ' +
        FOCUS_RING +
        ' ' +
        (selected ? 'border-brand/40 bg-brand/[0.04]' : 'border-ink-700 bg-ink-850')
      }
    >
      {/* line 1 — what, and how much risk it removes */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 flex-wrap">
        <span className="tnum text-[10px] text-mist-500 w-5">{index}</span>
        <span className="text-xs font-semibold text-mist-100">
          {order.drugName} <span className="font-normal text-mist-300">{order.drugStrength}</span>
        </span>
        <VedChip ved={order.ved} />
        {order.coldChain && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-brand/30 text-brand bg-brand/10">
            COLD CHAIN
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[10px] text-mist-400">
          risk{' '}
          <span className="tnum text-sev-low">
            ↓ {(order.riskReduction * 100).toFixed(0)} pp
          </span>
        </span>
      </div>

      {/* line 2 — the movement itself */}
      <div className="px-3 pb-2 flex items-center gap-2 text-[11px] flex-wrap">
        <span className="text-mist-100">{order.from.name}</span>
        <span className="text-mist-500 text-[10px]">{order.from.type}</span>
        <span className="flex-1 min-w-[40px] border-t border-dashed border-ink-600 relative top-px" />
        <span className="tnum text-mist-400 text-[10px]">{order.distanceKm.toFixed(0)} km</span>
        <span className="flex-1 min-w-[40px] border-t border-dashed border-ink-600 relative top-px" />
        <span className="text-brand">▶</span>
        <span className="text-mist-100">{order.to.name}</span>
        <span className="text-mist-500 text-[10px]">{order.to.type}</span>
      </div>

      {/* line 3 — the pick list. This is the part that makes the card
          executable rather than advisory: a named batch, its expiry, and how
          many units come off it. */}
      <div className="mx-3 mb-2 rounded border border-ink-700 bg-ink-900/60">
        <div className="flex items-baseline justify-between px-2.5 py-1.5 border-b border-ink-800">
          <span className="tnum text-sm font-semibold text-mist-100">
            {count(order.quantity)}{' '}
            <span className="text-[11px] font-normal text-mist-400">{order.unit}</span>
          </span>
          <span className="tnum text-[11px] text-mist-300">
            {inrFull(order.estimatedCostInr)}
            <span className="text-mist-500 text-[10px]"> transport</span>
          </span>
        </div>
        <ul className="divide-y divide-ink-800">
          {order.lines.map((l) => (
            <li
              key={l.batchNo}
              className="flex items-baseline justify-between gap-3 px-2.5 py-1 text-[11px]"
            >
              <span className="tnum text-mist-200">{l.batchNo}</span>
              <span className="tnum text-mist-300">
                {count(l.quantity)} <span className="text-mist-500">{order.unit}</span>
              </span>
              <span className="tnum text-mist-400 text-[10px]">
                exp {l.expiryDate}{' '}
                <span className={l.daysToExpiry < 180 ? 'text-sev-high' : 'text-mist-500'}>
                  ({count(l.daysToExpiry)} d)
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* line 4 — the sentence. Verbatim from the optimiser; never re-templated
          in the UI, because a regenerated sentence would quietly disagree with
          the rounded figures printed above it. */}
      <p className="px-3 pb-2 text-[11px] text-mist-300 leading-relaxed border-l-2 border-ink-600 ml-3 pl-2.5">
        {order.rationale}
      </p>

      {/* line 5 — before / after, so the claim is checkable at a glance */}
      <div className="px-3 pb-2.5 flex items-center gap-4 text-[10px] text-mist-400 flex-wrap">
        <span>
          on hand{' '}
          <span className="tnum text-mist-200">{count(order.receiverOnHandBefore)}</span> →{' '}
          <span className="tnum text-sev-low">{count(after)}</span>
        </span>
        <span>
          P(out){' '}
          <span className="tnum text-sev-critical">
            {(order.receiverStockoutProbBefore * 100).toFixed(0)}%
          </span>{' '}
          → <span className="tnum text-sev-low">{(probAfter * 100).toFixed(0)}%</span>
        </span>
        {order.wasteAvertedUnits > 0 && (
          <span>
            rescued from expiry{' '}
            <span className="tnum text-mist-200">
              {count(order.wasteAvertedUnits)} {order.unit}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function VedChip({ ved }: { ved: string }) {
  return (
    <span
      className={
        'text-[10px] px-1.5 py-0.5 rounded border ' +
        (ved === 'V'
          ? 'border-sev-critical/40 text-sev-critical bg-sev-critical/10'
          : ved === 'E'
            ? 'border-sev-high/30 text-sev-high bg-sev-high/10'
            : 'border-ink-600 text-mist-400')
      }
      title={VED_LABEL[ved]}
    >
      {ved}
    </span>
  );
}

function Chip({
  label,
  n,
  active,
  onClick,
}: {
  label: string;
  n: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={
        'px-2 py-1 rounded text-[10px] border transition-colors ' +
        FOCUS_RING +
        ' ' +
        (active
          ? 'border-brand/50 bg-brand/10 text-brand'
          : 'border-ink-600 text-mist-400 hover:text-mist-200 hover:border-ink-500')
      }
    >
      {label} <span className={'tnum ' + (active ? 'text-brand/70' : 'text-mist-500')}>{count(n)}</span>
    </button>
  );
}
