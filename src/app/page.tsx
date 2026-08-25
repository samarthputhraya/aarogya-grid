import type { CSSProperties } from 'react';
import Link from 'next/link';
import snapshot from '@/data/national-snapshot.json';
import type { NationalSnapshot } from '@/lib/snapshot-types';
import { derive } from '@/lib/landing-figures';
import HeroMap from '@/components/landing/HeroMap';
import ReliefAct from '@/components/relief/ReliefAct';
import { compactCount, count, inr, population, pct } from '@/lib/format';

/**
 * The front door.
 *
 * WHY THIS PAGE EXISTS AT ALL
 * ---------------------------
 * For most of this project `/` was the national console: 80,896 stock positions
 * and a wall of tables, with no sentence anywhere saying what the thing was.
 * That is the right home page for the person who uses it daily and precisely
 * the wrong one for the person who has ten minutes and forty submissions to get
 * through. They are different readers with different needs, so they get
 * different pages, and the console moved to `/console`.
 *
 * The rule this page is written under is the same one the console is written
 * under: no number is typed here. Everything comes through `derive()` from the
 * shipped snapshot, so re-running the pipeline updates the hero. The one thing
 * a landing page is really tempted to do -- round the good number up and leave
 * the bad number off -- is structurally unavailable.
 *
 * And the bad number stays. `netCashInr` is negative: this plan spends more
 * moving stock than it recovers in averted expiry. Leading with that rather
 * than burying it is a deliberate call. Anyone competent enough to be worth
 * convincing will find it in ten seconds on the console, and finding it there
 * after not finding it here would cost more than it ever bought.
 *
 * WHERE THE CLIENT JAVASCRIPT IS, AND WHERE IT IS NOT
 * ---------------------------------------------------
 * This file is a server component and every section below the act is
 * server-rendered with CSS-only animation -- see landing.css for why the scroll
 * reveal is a view() timeline rather than the IntersectionObserver it started as.
 *
 * The act is the exception and the only one: `ReliefAct` is a client component
 * because a scroll-composed camera cannot be expressed in CSS, and deck.gl sits
 * behind a dynamic import inside it that never reaches a visitor whose machine
 * fails `probeRelief()`. (This block used to claim there was no 'use client'
 * anywhere in the tree. That stopped being true when the act landed.)
 *
 * EVERY LINE ON THIS PAGE IS A GAP
 * --------------------------------
 * There are no cards, no borders and no radii below the act. Sections are
 * `.rule-grid` with `gap: 1px` over a rule-coloured ground, and the cells paint
 * the ground back -- so the lattice is what survives. It cannot double at a
 * join, it repaints nothing, and it inverts with two token writes. Cells that
 * carry no data get `.cell-empty`, which says "deliberately blank" where bare
 * ground would say "unfinished".
 */
export const metadata = {
  title: 'Aarogya Grid — the medicine was already in the country',
  description:
    'Aarogya Grid forecasts medicine stock-outs across India’s primary health network, then finds the surplus already sitting in the next district and moves it before the shelf goes empty.',
};

const snap = snapshot as unknown as NationalSnapshot;

/**
 * Stagger helper.
 *
 * Siblings laid out in one row share a scroll position, so they would otherwise
 * reveal in perfect unison. Shifting where each one's range opens is what
 * separates them in time. Kept under ~14%: past that the last card in a row is
 * still arriving after the reader has finished reading the first.
 */
const at = (percent: number) => ({ '--reveal-at': `${percent}%` }) as CSSProperties;

export default function Page() {
  const f = derive(snap);

  return (
    <main className="landing relative overflow-x-clip">
      {/* ================= NAV =================
          No `backdrop-filter`. A frosted bar sitting over a full-bleed WebGL canvas
          makes the compositor read back the canvas texture underneath it on every
          frame the map draws; it is the single most expensive piece of chrome a
          page like this can wear, and it buys an effect nobody has ever asked a
          logistics console for. Opaque ground, one hairline, done.

          The hairline is the field showing through, not a border. */}
      <header className="sticky top-0 z-40 bg-[var(--color-ink-700)] pb-px">
        <nav className="flex items-stretch gap-px bg-[var(--color-ink-700)]">
          <div className="flex flex-1 items-center gap-[0.9em] bg-ink-950 px-[2em] py-[1em]">
            <span
              className="chamfer grid size-[1.6em] place-items-center bg-brand text-[0.75em] font-bold text-ink-950"
              aria-hidden="true"
            >
              A
            </span>
            <span className="text-[0.8125em] font-semibold tracking-tight text-mist-100">
              Aarogya Grid
            </span>
            <span className="hidden font-mono text-[0.6875em] uppercase tracking-[0.1em] text-mist-500 sm:inline">
              Medicines · beds · workforce — national
            </span>
          </div>
          {/* min-h rather than more padding: the tap target has to clear 44px on a
              phone, but the nav bar should not grow to match it, so the box is
              given the height and the text stays optically where it was. */}
          <Link
            href="/capture"
            className="hidden min-h-11 items-center bg-ink-950 px-[1.5em] font-mono text-[0.6875em] uppercase tracking-[0.1em] text-mist-400 transition-colors hover:bg-ink-900 hover:text-mist-100 sm:inline-flex"
          >
            Field capture
          </Link>
          <Link
            href="/console"
            className="inline-flex min-h-11 items-center bg-brand px-[1.75em] font-mono text-[0.6875em] font-semibold uppercase tracking-[0.1em] text-ink-950 transition-colors hover:bg-mist-100"
          >
            Open the console
          </Link>
        </nav>
      </header>

      {/* ================= THE ACT =================
          The plan, full bleed, with the argument annotating it. This replaces the
          old hero -- a headline beside a decorative picture of the data -- because
          the picture WAS the most interesting thing on the page and it was being
          used as wallpaper. Beat copy is defined here rather than inside the act so
          every figure still comes through derive(). */}
      <ReliefAct
        consoleHref="/console"
        ledgerHref="#ledger"
        fallback={<HeroMap snapshot={snap} className="h-full w-full opacity-45" />}
        copy={[
          {
            subject: 'The network',
            magnitude: `${count(f.facilities)} facilities`,
            gauge: {
              value: `${count(f.facilities)} FAC`,
              label: `the network — ${count(f.facilities)} facilities`,
            },
            headline: (
              <>
                The medicine was{' '}
                <span className="display-hollow">already</span> in the country
              </>
            ),
            body: (
              <p>
                <span className="fig">{count(f.facilities)}</span> facilities across{' '}
                <span className="fig">{f.districts}</span> districts and{' '}
                <span className="fig">{f.states}</span> states, serving{' '}
                <span className="fig">{population(f.populationCovered)}</span> people.
                Every column you are about to see is one of them.
              </p>
            ),
          },
          {
            subject: 'The failure',
            magnitude: `${count(f.criticalPositions)} critical`,
            gauge: {
              value: `${count(f.criticalPositions)} CRIT`,
              label: `the failure — ${count(f.criticalPositions)} critical positions`,
            },
            headline: <>Some of it is about to run out</>,
            body: (
              <p>
                <span className="fig text-sev-critical">
                  {count(f.criticalPositions)}
                </span>{' '}
                stock positions come back critical, and{' '}
                <span className="fig text-sev-critical">
                  {count(f.zeroStockPositions)}
                </span>{' '}
                are already at zero on the shelf. The taller and redder the column,
                the closer that district is to a patient being turned away.
              </p>
            ),
          },
          {
            subject: 'The surplus',
            magnitude: `${f.netGivers} give · ${f.netTakers} take`,
            gauge: {
              value: `${f.netTakers} SHORT`,
              label: `the surplus — ${f.netGivers} districts with spare, ${f.netTakers} short`,
            },
            headline: <>The stock to fix it is sitting next door</>,
            body: (
              <>
                <p>
                  Recoloured: green ships more than it takes, red takes more than it
                  ships. <span className="fig text-sev-low">{f.netGivers}</span>{' '}
                  districts have spare;{' '}
                  <span className="fig text-sev-critical">{f.netTakers}</span> need it.
                </p>
                {f.deepestDeficit ? (
                  <p className="mt-[0.9em]">
                    The deepest deficit is{' '}
                    <span className="text-mist-100">{f.deepestDeficit.name}</span>,
                    short{' '}
                    <span className="fig text-sev-critical">
                      {count(f.deepestDeficit.net)}
                    </span>{' '}
                    orders. Its largest supplier is{' '}
                    <span className="text-mist-100">
                      {f.deepestDeficit.supplierName}
                    </span>{' '}
                    with{' '}
                    <span className="fig text-sev-low">
                      {count(f.deepestDeficit.supplierOrders)}
                    </span>
                    {f.deepestDeficit.sameState
                      ? ` — the next district over, inside ${f.deepestDeficit.stateName}.`
                      : ` — across the line in ${f.deepestDeficit.supplierState}.`}
                  </p>
                ) : null}
              </>
            ),
          },
          {
            subject: 'Cross-district lift',
            magnitude: `${count(f.crossDistrictTrips)} trips`,
            gauge: {
              value: `${count(f.corridors)} CORR`,
              label: `the plan — ${count(f.corridors)} corridors, ${count(f.crossDistrictTrips)} crossing a district line`,
            },
            headline: (
              <>
                <span className="fig">{count(f.corridors)}</span> corridors, drawn in
                the order they were solved
              </>
            ),
            body: (
              <p>
                <span className="fig">{count(f.transfers)}</span> dispatches on{' '}
                <span className="fig">{count(f.trips)}</span> vehicle trips.{' '}
                <span className="fig text-brand">{count(f.crossDistrictTrips)}</span>{' '}
                of them cross a district line and{' '}
                <span className="fig text-brand">{f.crossStateCorridors}</span>{' '}
                corridors cross a state line — the arcs in teal. Height is how many
                orders ride each route.
              </p>
            ),
          },
          {
            subject: 'The cost',
            magnitude: `₹${f.breakEvenInrPerUnit.toFixed(2)} per unit`,
            gauge: {
              value: `₹${f.breakEvenInrPerUnit.toFixed(2)}/U`,
              label: `the cost — break-even at ${f.breakEvenInrPerUnit.toFixed(2)} rupees per averted unit`,
            },
            headline: <>It does not pay for itself in cash</>,
            body: (
              <p>
                Net cash is{' '}
                <span className="fig text-sev-critical">
                  −{inr(Math.abs(f.netCashInr))}
                </span>
                . The plan breaks even only when one averted unit of unmet demand is
                worth{' '}
                <span className="fig">₹{f.breakEvenInrPerUnit.toFixed(2)}</span>.
                Columns now show what each district actually sends across its own
                boundary — the flat ones solved it alone.
              </p>
            ),
          },
        ]}
      />

      {/* ================= THE NUMBER =================
          Everything from here down sits on ONE ruled field. There are no cards.
          Every line you can see is a 1px gap in a grid, showing the layer beneath —
          so nothing can double at a join, nothing repaints a border box, and the
          figures, the map and the ledger all read as regions of one instrument
          rather than as a stack of components that happen to share a palette. */}
      <div className="rule-field">
        <section className="rule-grid" aria-labelledby="number-head">
          <div className="cell px-[3.5em] py-[5em]" style={{ ['--span' as string]: 12 }}>
            <div className="reveal mx-auto max-w-[52em] text-center">
              <p className="eyebrow justify-center">
                <span className="eyebrow-mark" aria-hidden="true" />
                <span>Outcome</span>
                <span aria-hidden="true">·</span>
                <span className="eyebrow-sub">What the plan actually does</span>
              </p>
              {/* The one headline figure on the page, and the only element allowed
                  at this size. Tabular figures throughout — see landing.css. */}
              <p id="number-head" className="display display-xl fig mt-[0.5em] text-brand">
                {count(f.shortfallAverted)}
              </p>
              <p className="mx-auto mt-[1.5em] max-w-[38em] text-[1em] leading-[1.6] text-mist-300">
                units of medicine that were forecast to run out, and now do not — filled
                from stock that already existed somewhere else in the network.
              </p>
            </div>
          </div>

          {/* The band. Four cells of the same field, not four cards on it. */}
          {[
            {
              v: count(f.transfers),
              l: 'dispatches',
              d: 'individual facility-to-facility orders in the plan',
            },
            {
              v: count(f.trips),
              l: 'vehicle trips',
              d: 'orders sharing a route share a vehicle',
            },
            {
              v: count(f.crossDistrictTrips),
              l: 'cross a district line',
              d: `carrying ${count(f.crossDistrictOrders)} orders`,
            },
            {
              v: count(f.rideAlongOrders),
              l: 'ride along',
              d: 'admitted only because a vehicle was already going',
            },
          ].map((x, i) => (
            <div
              key={x.l}
              className="cell cell-raised reveal px-[1.75em] py-[2em]"
              style={{ ['--span' as string]: 3, ['--span-sm' as string]: 6, ...at(i * 3.5) }}
            >
              <p className="fig display display-md leading-none">{x.v}</p>
              <p className="mt-[0.75em] font-mono text-[0.6875em] uppercase tracking-[0.1em] text-brand">
                {x.l}
              </p>
              <p className="mt-[0.5em] text-[0.75em] leading-snug text-mist-500">{x.d}</p>
            </div>
          ))}
        </section>

        {/* ================= THE LEDGER ================= */}
        <section id="ledger" className="rule-grid scroll-mt-16" aria-labelledby="ledger-head">
          <div className="cell reveal px-[3.5em] py-[5em]" style={{ ['--span' as string]: 6 }}>
            <p className="eyebrow">
              <span className="eyebrow-mark" aria-hidden="true" />
              <span>Ledger</span>
              <span aria-hidden="true">·</span>
              <span className="eyebrow-sub">The part most decks leave out</span>
              <span aria-hidden="true">·</span>
              <span className="eyebrow-mag fig">−{inr(Math.abs(f.netCashInr))}</span>
            </p>
            <h2 id="ledger-head" className="display display-md mt-[0.6em]">
              It does not pay for itself in cash
            </h2>
            <div className="mt-[1.5em] space-y-[1em] text-[0.9375em] leading-[1.65] text-mist-300">
              <p>
                Redistribution spends more moving stock than it recovers in averted
                expiry. That is not a rounding error to be presented away — it is the
                actual shape of the intervention, and any figure that hid it would fall
                apart the moment someone opened the console.
              </p>
              <p>
                So the case is put the other way round. Rather than claiming a return,
                the plan states the price at which the return exists: it breaks even when
                one averted unit of unmet demand is worth{' '}
                <span className="fig">₹{f.breakEvenInrPerUnit.toFixed(2)}</span>. Whether
                a dose of a Vital medicine reaching a patient is worth that is a policy
                judgement, not an engineering one.
              </p>
            </div>
          </div>

          <div
            className="cell cell-raised reveal px-[2.5em] py-[3em]"
            style={{ ['--span' as string]: 6, ...at(5) }}
          >
            <p className="eyebrow mb-[1.5em]">
              <span className="eyebrow-mark" aria-hidden="true" />
              <span>Plan economics</span>
              <span aria-hidden="true">·</span>
              <span className="eyebrow-sub">National</span>
            </p>

            <div className="ledger-row">
              <span className="ledger-label">Waste averted</span>
              <span className="ledger-value text-sev-low">+ {inr(f.wasteAvertedInr)}</span>
            </div>
            <div className="ledger-row">
              <span className="ledger-label text-mist-500 line-through decoration-mist-500/60">
                One dedicated vehicle per order
              </span>
              <span className="ledger-value text-mist-500 line-through decoration-mist-500/60">
                − {inr(f.unconsolidatedCostInr)}
              </span>
            </div>
            <div className="ledger-row">
              <span className="ledger-label">
                Transport cost
                <span className="ml-[0.6em] font-mono text-[0.75em] text-mist-500">
                  {count(f.trips)} trips, {count(f.transfers)} orders
                </span>
              </span>
              <span className="ledger-value text-sev-critical">
                − {inr(f.transportCostInr)}
              </span>
            </div>
            <div className="ledger-row">
              <span className="ledger-label font-medium text-mist-100">
                Net cash position
              </span>
              {/* Not softened, not hidden, not reframed. The negative line is the most
                  trustworthy number on this page. */}
              <span className="ledger-value text-[1.0625em]" data-sign="negative">
                − {inr(Math.abs(f.netCashInr))}
              </span>
            </div>
            <div className="ledger-row">
              <span className="ledger-label font-medium text-mist-100">
                Shortfall averted
              </span>
              <span className="ledger-value text-[1.0625em] text-sev-low">
                {count(f.shortfallAverted)} units
              </span>
            </div>

            <p className="mt-[1.75em] border-t border-[var(--color-ink-700)] pt-[1.25em] text-[0.75em] leading-[1.7] text-mist-400">
              Pricing a route once instead of once per drug is what pays for crossing a
              boundary at all — consolidation takes transport from{' '}
              <span className="fig whitespace-nowrap">{inr(f.unconsolidatedCostInr)}</span>{' '}
              to <span className="fig whitespace-nowrap">{inr(f.transportCostInr)}</span>, a
              saving of{' '}
              <span className="fig whitespace-nowrap text-mist-200">
                {inr(f.consolidationSavingInr)}
              </span>
              .
            </p>
          </div>
        </section>

        {/* ================= HOW IT WORKS ================= */}
        <section className="rule-grid" aria-labelledby="stages-head">
          <div className="cell px-[3.5em] py-[4em]" style={{ ['--span' as string]: 8 }}>
            <div className="reveal max-w-[42em]">
              <p className="eyebrow">
                <span className="eyebrow-mark" aria-hidden="true" />
                <span>Method</span>
                <span aria-hidden="true">·</span>
                <span className="eyebrow-sub">How it works</span>
                <span aria-hidden="true">·</span>
                <span className="eyebrow-mag fig">4 stages</span>
              </p>
              <h2 id="stages-head" className="display display-md mt-[0.6em]">
                Four stages, one shared allocation state
              </h2>
            </div>
          </div>
          {/* Deliberately empty, and saying so. A blank half-row of ground reads
              as unfinished; the cross-hatch reads as instrument substrate, and
              it puts the rule back on the lattice where the eye expects one. */}
          <div className="cell cell-empty" style={{ ['--span' as string]: 4 }} />

          {[
            {
              n: '01',
              t: 'Simulate',
              d: `A year of stock ledger for ${compactCount(f.trackedPositions)} facility × drug positions — receipts, consumption, batches and expiry — seeded so any figure can be regenerated exactly.`,
            },
            {
              n: '02',
              t: 'Forecast',
              d: `Demand and stock-out probability per position. ${count(f.criticalPositions)} come back critical; ${count(f.zeroStockPositions)} are already at zero on the shelf.`,
            },
            {
              n: '03',
              t: 'Plan',
              d: 'Match surplus to shortfall against a benefit/cost gate. A donor batch can be promised only once, so the whole run shares one allocation state rather than solving districts independently.',
            },
            {
              n: '04',
              t: 'Dispatch',
              d: `Consolidate orders onto shared vehicles and let them cross district lines — ${count(f.crossDistrictTrips)} of ${count(f.trips)} trips do, on ${count(f.corridors)} corridors.`,
            },
          ].map((x, i) => (
            <div
              key={x.n}
              className="cell cell-raised reveal px-[1.75em] py-[2.25em]"
              style={{ ['--span' as string]: 3, ['--span-sm' as string]: 6, ...at(i * 3.5) }}
            >
              <p className="fig text-[0.6875em] tracking-[0.1em] text-brand">{x.n}</p>
              <h3 className="mt-[0.9em] font-mono text-[0.8125em] font-semibold uppercase tracking-[0.08em] text-mist-100">
                {x.t}
              </h3>
              <p className="mt-[0.75em] text-[0.78125em] leading-[1.7] text-mist-400">{x.d}</p>
            </div>
          ))}

          <div className="cell px-[3.5em] py-[2.5em]" style={{ ['--span' as string]: 12 }}>
            <p className="reveal mx-auto max-w-[50em] text-center text-[0.78125em] leading-[1.7] text-mist-500">
              Because planning shares one allocation state, districts are not independent
              and the plan is order-dependent — deterministic, not symmetric. It
              parallelises where clusters are disjoint, which on this build is{' '}
              <span className="fig">9</span> rounds rather than{' '}
              <span className="fig">{f.districts}</span> tasks. Simulation and forecasting
              remain embarrassingly parallel.
            </p>
          </div>
        </section>

        {/* ================= REACH ================= */}
        <section className="rule-grid" aria-labelledby="reach-head">
          <div className="cell px-[3.5em] py-[4em]" style={{ ['--span' as string]: 8 }}>
            <div className="reveal max-w-[42em]">
              <p className="eyebrow">
                <span className="eyebrow-mark" aria-hidden="true" />
                <span>Reach</span>
                <span aria-hidden="true">·</span>
                <span className="eyebrow-sub">Depth across India</span>
                <span aria-hidden="true">·</span>
                <span className="eyebrow-mag fig">{count(f.districts)} districts</span>
              </p>
              <h2 id="reach-head" className="display display-md mt-[0.6em]">
                Built at national scale, not demoed on one district
              </h2>
            </div>
          </div>
          {/* Deliberately empty, and saying so. A blank half-row of ground reads
              as unfinished; the cross-hatch reads as instrument substrate, and
              it puts the rule back on the lattice where the eye expects one. */}
          <div className="cell cell-empty" style={{ ['--span' as string]: 4 }} />

          {[
            { v: count(f.districts), l: 'districts', s: `across ${f.states} states` },
            { v: count(f.facilities), l: 'facilities', s: 'DH, CHC, PHC and sub-centre' },
            {
              v: compactCount(f.trackedPositions),
              l: 'stock positions',
              s: 'facility × drug pairs tracked',
            },
            {
              v: population(f.populationCovered),
              l: 'people covered',
              s: 'modelled catchment population',
            },
            {
              v: count(f.corridors),
              l: 'corridors',
              s: `${f.crossStateCorridors} cross a state line`,
            },
            {
              v: count(f.districtsOnACorridor),
              l: 'districts on a corridor',
              s: `of ${f.districts} — the rest are self-sufficient`,
            },
            {
              v: `${f.buildSeconds}s`,
              l: 'to build the country',
              s: 'one machine, one batch run',
            },
            {
              v: inr(f.netBenefitInr),
              l: 'net benefit',
              s: `at ₹${f.breakEvenInrPerUnit.toFixed(2)} per averted unit`,
            },
          ].map((x, i) => (
            <div
              key={x.l}
              className="cell reveal px-[1.75em] py-[2.25em]"
              style={{ ['--span' as string]: 3, ['--span-sm' as string]: 6, ...at((i % 4) * 3.5) }}
            >
              <p className="fig display display-md leading-none">{x.v}</p>
              <p className="mt-[0.75em] font-mono text-[0.6875em] uppercase tracking-[0.1em] text-brand">
                {x.l}
              </p>
              <p className="mt-[0.5em] text-[0.75em] leading-snug text-mist-500">{x.s}</p>
            </div>
          ))}
        </section>

        {/* ================= PROVENANCE ================= */}
        <section className="rule-grid" aria-labelledby="prov-head">
          <div className="cell px-[3.5em] py-[4em]" style={{ ['--span' as string]: 8 }}>
            <div className="reveal max-w-[46em]">
              <p className="eyebrow">
                <span className="eyebrow-mark" aria-hidden="true" />
                <span>Provenance</span>
                <span aria-hidden="true">·</span>
                <span className="eyebrow-sub">What is real, what is not</span>
              </p>
              <h2 id="prov-head" className="display display-md mt-[0.6em]">
                What is real here, and what is not
              </h2>
              <p className="mt-[1.5em] text-[0.9375em] leading-[1.65] text-mist-300">
                No public PHC inventory feed exists in India. The facility layer is
                generated by a seeded simulator, parameterised from IPHS norms and
                published epidemiological seasonality — fitted to those norms, not to
                observed consumption. Saying so plainly is cheaper than being caught not
                saying it.
              </p>
            </div>
          </div>
          {/* Deliberately empty, and saying so. A blank half-row of ground reads
              as unfinished; the cross-hatch reads as instrument substrate, and
              it puts the rule back on the lattice where the eye expects one. */}
          <div className="cell cell-empty" style={{ ['--span' as string]: 4 }} />

          {[
            {
              k: 'Real',
              tone: 'text-sev-low',
              bg: 'bg-sev-low',
              items: [
                'Districts, state LGD/Census codes, and coordinates',
                'IPHS facility norms, catchment norms and bed strength',
                'IPHS staffing establishment by tier and cadre',
                'Drug catalogue, VED classification, cold-chain flags',
                'Every model, forecast and optimisation in the system',
              ],
            },
            {
              k: 'Simulated',
              tone: 'text-sev-moderate',
              bg: 'bg-sev-moderate',
              items: [
                'Individual facilities, their names and catchments',
                'Stock positions, batches and consumption ledgers',
                'Bed occupancy, staff vacancy and daily attendance',
                'District supply reliability and allocation behaviour',
              ],
            },
          ].map((g, i) => (
            <div
              key={g.k}
              className="cell cell-raised reveal px-[2.25em] py-[2.5em]"
              style={{ ['--span' as string]: 6, ...at(i * 4) }}
            >
              <p
                className={`mb-[1.25em] flex items-center gap-[0.6em] font-mono text-[0.75em] font-semibold uppercase tracking-[0.1em] ${g.tone}`}
              >
                {/* Square, not a dot. Nothing on this surface is round except the
                    terminator on an annotation leader. */}
                <span className={`size-[0.55em] ${g.bg}`} aria-hidden="true" />
                {g.k}
              </p>
              <ul className="space-y-[0.7em] text-[0.78125em] leading-[1.7] text-mist-300">
                {g.items.map((x) => (
                  <li key={x} className="flex gap-[0.75em]">
                    <span
                      className="mt-[0.6em] size-[0.3em] shrink-0 bg-mist-500"
                      aria-hidden="true"
                    />
                    {x}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="cell px-[3.5em] py-[2.5em]" style={{ ['--span' as string]: 12 }}>
            <p className="reveal max-w-[56em] text-[0.75em] leading-[1.75] text-mist-500">
              One caveat the console repeats and this page will not bury: the workforce
              layer and the stock layer are correlated by construction. Remoteness is
              derived from the same synthetic district reliability parameter that drives
              supply, so the fact that badly-supplied districts are also badly-staffed
              here is an assumption in the model, not a finding from it —{' '}
              <span className="text-mist-400">
                <span className="fig">{count(f.facilitiesWithoutPharmacist)}</span>{' '}
                stock-holding facilities have no pharmacist in position
              </span>
              , against <span className="fig">{pct(f.vacancyRate)}</span> vacancy and{' '}
              <span className="fig">{pct(f.absenteeismRate)}</span> absence, and that is
              why the stock board carries an error bar.
            </p>
          </div>
        </section>

        {/* ================= CTA =================
            The two blurred, infinitely-drifting radial fields that used to sit here
            are gone. A 90px full-viewport blur on a looping transform is the most
            expensive decoration a page can wear and the loudest generated-page tell
            available; the cross-hatch cells flanking this block do the same job of
            saying "deliberately empty" for zero bytes and zero compositing. */}
        <section className="rule-grid" aria-labelledby="cta-head">
          <div className="cell cell-empty" style={{ ['--span' as string]: 2 }} />
          <div
            className="cell reveal px-[3.5em] py-[6em] text-center"
            style={{ ['--span' as string]: 8 }}
          >
            <h2 id="cta-head" className="display display-lg mx-auto max-w-[16em]">
              Open it and go looking for the seams
            </h2>
            <p className="mx-auto mt-[1.5em] max-w-[36em] text-[0.9375em] leading-[1.65] text-mist-300">
              Every figure on this page is read from the same shipped snapshot the console
              renders. Drill into any district, follow any corridor, and check the
              arithmetic.
            </p>
            <div className="mt-[2.25em] flex flex-wrap justify-center gap-[0.5em]">
              <Link href="/console" className="btn btn-primary chamfer">
                Open the live console
              </Link>
              <a
                href="https://github.com/samarthputhraya/aarogya-grid"
                className="btn btn-ghost chamfer"
              >
                Read the source
              </a>
            </div>
          </div>
          <div className="cell cell-empty" style={{ ['--span' as string]: 2 }} />
        </section>
      </div>

      {/* ================= FOOTER ================= */}
      <footer className="bg-[var(--color-ink-700)] pt-px">
        <div className="flex flex-col gap-px bg-[var(--color-ink-700)] sm:flex-row">
          <p className="flex-1 bg-ink-950 px-[3.5em] py-[2em] font-mono text-[0.6875em] uppercase tracking-[0.08em] text-mist-500">
            Aarogya Grid · snapshot <span className="fig">{f.asOf}</span> · built{' '}
            <span className="fig">{f.buildSeconds}s</span> · every figure regenerable from
            a seed
          </p>
          {/* Same 44px floor as the header. These were 17px tall -- below even
              the 24px WCAG 2.2 minimum, let alone the 44px one -- which on a
              phone is three links the reader has to aim at. */}
          <nav className="flex gap-px bg-[var(--color-ink-700)]">
            {[
              { href: '/console', label: 'Console', ext: false },
              { href: '/capture', label: 'Field capture', ext: false },
              {
                href: 'https://github.com/samarthputhraya/aarogya-grid',
                label: 'Source',
                ext: true,
              },
            ].map((l) =>
              l.ext ? (
                <a
                  key={l.label}
                  href={l.href}
                  className="inline-flex min-h-11 items-center bg-ink-950 px-[1.5em] font-mono text-[0.6875em] uppercase tracking-[0.1em] text-mist-500 transition-colors hover:bg-ink-900 hover:text-mist-100"
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.label}
                  href={l.href}
                  className="inline-flex min-h-11 items-center bg-ink-950 px-[1.5em] font-mono text-[0.6875em] uppercase tracking-[0.1em] text-mist-500 transition-colors hover:bg-ink-900 hover:text-mist-100"
                >
                  {l.label}
                </Link>
              ),
            )}
          </nav>
        </div>
      </footer>
    </main>
  );
}
