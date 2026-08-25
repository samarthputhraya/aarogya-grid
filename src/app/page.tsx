import type { CSSProperties } from 'react';
import Link from 'next/link';
import snapshot from '@/data/national-snapshot.json';
import type { NationalSnapshot } from '@/lib/snapshot-types';
import { derive } from '@/lib/landing-figures';
import HeroMap from '@/components/landing/HeroMap';
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
 * ZERO CLIENT JAVASCRIPT
 * ----------------------
 * Every element on this page is server-rendered and every animation is CSS.
 * There is no 'use client' anywhere in its tree -- see landing.css for why the
 * scroll reveal is a view() timeline rather than the IntersectionObserver this
 * started as.
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
    <main className="relative overflow-x-hidden">
      {/* ================= NAV ================= */}
      <header className="sticky top-0 z-40 border-b border-ink-700/80 bg-ink-950/80 backdrop-blur-md">
        <nav className="mx-auto flex max-w-[1180px] items-center gap-4 px-5 py-3.5">
          <span className="grid size-7 place-items-center rounded border border-brand/40 bg-brand/10 font-display text-sm text-brand">
            A
          </span>
          <span className="text-[13px] font-semibold tracking-tight text-mist-100">
            Aarogya Grid
          </span>
          <span className="hidden text-[11px] text-mist-500 sm:inline">
            Medicines, beds and health workforce · national
          </span>
          <div className="ml-auto flex items-center gap-2">
            {/* min-h-11 rather than more padding: the tap target has to clear
                44px on a phone, but the nav bar should not grow to match it, so
                the box is given the height and the text stays optically where
                it was. Measured at 375px -- these were 32px before. */}
            <Link
              href="/capture"
              className="hidden min-h-11 items-center rounded px-3 text-[12px] text-mist-400 transition-colors hover:text-mist-100 sm:inline-flex"
            >
              Field capture
            </Link>
            <Link
              href="/console"
              className="inline-flex min-h-11 items-center rounded border border-brand/45 bg-brand/10 px-3.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand/20"
            >
              Open the console →
            </Link>
          </div>
        </nav>
      </header>

      {/* ================= HERO ================= */}
      <section className="relative isolate">
        <div className="atmosphere" aria-hidden="true" />
        <div className="graticule" aria-hidden="true" />

        {/* Decorative here -- the same corridors are readable and interrogable
            on the console -- so it sits beside the copy on large screens and
            below it on small, and never takes the reading column with it.
            Sized off its own width rather than the section height: keyed to
            height it grows with the copy and crops itself against the 46%
            column, which is exactly what the first build did. */}
        <div
          className="pointer-events-none absolute right-0 top-[45%] z-0 hidden w-[44%] max-w-[540px] -translate-y-1/2 opacity-70 lg:block"
          aria-hidden="true"
        >
          <HeroMap snapshot={snap} className="h-auto w-full" />
        </div>

        <div className="relative z-10 mx-auto max-w-[1180px] px-5 pb-24 pt-20 sm:pt-28 lg:pb-32 lg:pt-32">
          <div className="max-w-[46rem]">
            <div className="reveal mb-7 inline-flex items-center gap-2.5 rounded-full border border-ink-700 bg-ink-900/70 px-3.5 py-1.5">
              <span className="relative flex size-1.5">
                <span className="pulse-ring absolute inline-flex size-full rounded-full bg-brand" />
                <span className="relative inline-flex size-1.5 rounded-full bg-brand" />
              </span>
              <span className="text-[11px] text-mist-300">
                Snapshot <span className="tnum text-mist-100">{f.asOf}</span> ·{' '}
                <span className="tnum text-mist-100">{f.districts}</span> districts · built
                in <span className="tnum text-mist-100">{f.buildSeconds}s</span>
              </span>
            </div>

            <h1 className="display text-[2.75rem] text-mist-100 sm:text-[3.75rem] lg:text-[4.25rem]">
              The medicine was <span className="display-em">already</span> in the country.
            </h1>

            <p className="mt-7 max-w-[34rem] text-[1.0625rem] leading-relaxed text-mist-300">
              Aarogya Grid forecasts stock-outs across India’s primary health network, then
              finds the surplus sitting in a district nearby and moves it before the shelf
              goes empty. Not more procurement — better circulation of what has already
              been bought.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="/console"
                className="rounded-lg bg-brand px-5 py-3 text-[13px] font-semibold text-ink-950 transition-transform hover:-translate-y-0.5"
              >
                Open the live console →
              </Link>
              <a
                href="#ledger"
                className="rounded-lg border border-ink-600 px-5 py-3 text-[13px] font-medium text-mist-200 transition-colors hover:border-ink-500 hover:text-mist-100"
              >
                Read the honest ledger
              </a>
            </div>

            {/* Three figures under the fold line, sized so the eye reads them as
                one row of evidence rather than three separate claims. */}
            <dl className="mt-14 grid max-w-[34rem] grid-cols-3 gap-6 border-t border-ink-700 pt-7">
              {[
                { v: compactCount(f.shortfallAverted), l: 'units of shortfall averted' },
                { v: count(f.corridors), l: 'inter-district corridors' },
                { v: population(f.populationCovered), l: 'people in catchment' },
              ].map((s, i) => (
                <div key={s.l} className="reveal" style={at(i * 4)}>
                  <dt className="tnum text-[1.6rem] leading-none text-mist-100">{s.v}</dt>
                  <dd className="mt-2 text-[11px] leading-snug text-mist-500">{s.l}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        {/* On small screens the map moves below the copy at low opacity, so the
            page still has its centrepiece without the headline sitting on top of
            a plot of India. */}
        <div className="relative z-0 -mt-4 px-5 pb-12 opacity-40 lg:hidden" aria-hidden="true">
          <HeroMap snapshot={snap} className="mx-auto h-auto w-full max-w-[380px]" />
        </div>
      </section>

      {/* ================= THE NUMBER ================= */}
      <section className="relative border-y border-ink-700 bg-ink-900/40">
        <div className="mx-auto max-w-[1180px] px-5 py-20 lg:py-28">
          <div className="reveal text-center">
            <p className="eyebrow">What the plan actually does</p>
            <p className="figure-hero tnum mt-6 text-[4.5rem] font-bold leading-none sm:text-[6.5rem] lg:text-[8rem]">
              {count(f.shortfallAverted)}
            </p>
            <p className="mx-auto mt-6 max-w-[36rem] text-[1.0625rem] leading-relaxed text-mist-300">
              units of medicine that were forecast to run out, and now do not — filled from
              stock that already existed somewhere else in the network.
            </p>
          </div>

          <ul className="mx-auto mt-14 grid max-w-[62rem] gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            ].map((s, i) => (
              <li key={s.l} className="reveal card p-5" style={at(i * 3.5)}>
                <p className="tnum text-[1.75rem] leading-none text-mist-100">{s.v}</p>
                <p className="mt-2.5 text-[12px] font-medium text-brand">{s.l}</p>
                <p className="mt-1.5 text-[11px] leading-snug text-mist-500">{s.d}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ================= THE LEDGER ================= */}
      <section id="ledger" className="scroll-mt-16">
        <div className="mx-auto max-w-[1180px] px-5 py-20 lg:py-28">
          <div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-20">
            <div className="reveal">
              <p className="eyebrow">The part most decks leave out</p>
              <h2 className="display mt-5 text-[2rem] text-mist-100 sm:text-[2.5rem]">
                It does not pay for itself in cash.
              </h2>
              <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-mist-300">
                <p>
                  Redistribution spends more moving stock than it recovers in averted
                  expiry. That is not a rounding error to be presented away — it is the
                  actual shape of the intervention, and any figure that hid it would fall
                  apart the moment someone opened the console.
                </p>
                <p>
                  So the case is put the other way round. Rather than claiming a return, the
                  plan states the price at which the return exists: it breaks even when one
                  averted unit of unmet demand is worth{' '}
                  <span className="tnum font-medium text-mist-100">
                    ₹{f.breakEvenInrPerUnit.toFixed(2)}
                  </span>
                  . Whether a dose of a Vital medicine reaching a patient is worth that is a
                  policy judgement, not an engineering one.
                </p>
              </div>
            </div>

            <div className="reveal card p-6 sm:p-8" style={at(5)}>
              <p className="eyebrow mb-5">Plan economics · national</p>

              <div className="ledger-row">
                <span className="text-[13px] text-mist-300">Waste averted</span>
                <span className="tnum text-[15px] text-sev-low">
                  + {inr(f.wasteAvertedInr)}
                </span>
              </div>
              <div className="ledger-row">
                <span className="text-[13px] text-mist-500 line-through decoration-mist-500/60">
                  One dedicated vehicle per order
                </span>
                <span className="tnum text-[15px] text-mist-500 line-through decoration-mist-500/60">
                  − {inr(f.unconsolidatedCostInr)}
                </span>
              </div>
              <div className="ledger-row">
                <span className="text-[13px] text-mist-300">
                  Transport cost
                  <span className="ml-2 text-[11px] text-mist-500">
                    {count(f.trips)} trips, {count(f.transfers)} orders
                  </span>
                </span>
                <span className="tnum text-[15px] text-sev-critical">
                  − {inr(f.transportCostInr)}
                </span>
              </div>
              <div className="ledger-row border-t border-ink-600 pt-4">
                <span className="text-[13px] font-medium text-mist-100">
                  Net cash position
                </span>
                <span className="tnum text-[17px] font-medium text-sev-critical">
                  − {inr(Math.abs(f.netCashInr))}
                </span>
              </div>
              <div className="ledger-row">
                <span className="text-[13px] font-medium text-mist-100">
                  Shortfall averted
                </span>
                <span className="tnum text-[17px] font-medium text-sev-low">
                  {count(f.shortfallAverted)} units
                </span>
              </div>

              <p className="mt-6 border-t border-ink-700 pt-5 text-[12px] leading-relaxed text-mist-400">
                Pricing a route once instead of once per drug is what pays for crossing a
                boundary at all — consolidation takes transport from{' '}
                <span className="tnum whitespace-nowrap">{inr(f.unconsolidatedCostInr)}</span> to{' '}
                <span className="tnum whitespace-nowrap">{inr(f.transportCostInr)}</span>, a saving of{' '}
                <span className="tnum whitespace-nowrap text-mist-200">{inr(f.consolidationSavingInr)}</span>.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ================= HOW IT WORKS ================= */}
      <section className="border-y border-ink-700 bg-ink-900/40">
        <div className="mx-auto max-w-[1180px] px-5 py-20 lg:py-28">
          <div className="reveal max-w-[40rem]">
            <p className="eyebrow">How it works</p>
            <h2 className="display mt-5 text-[2rem] text-mist-100 sm:text-[2.5rem]">
              Four stages, one shared allocation state.
            </h2>
          </div>

          <ol className="mt-14 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
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
            ].map((s, i) => (
              <li key={s.n} className="reveal card card-link p-6" style={at(i * 3.5)}>
                <p className="tnum text-[11px] text-brand-dim">{s.n}</p>
                <h3 className="mt-3 text-[15px] font-semibold text-mist-100">{s.t}</h3>
                <p className="mt-2.5 text-[12.5px] leading-relaxed text-mist-400">{s.d}</p>
              </li>
            ))}
          </ol>

          <p className="reveal mx-auto mt-12 max-w-[46rem] text-center text-[12.5px] leading-relaxed text-mist-500">
            Because planning shares one allocation state, districts are not independent and
            the plan is order-dependent — deterministic, not symmetric. It parallelises
            where clusters are disjoint, which on this build is 9 rounds rather than{' '}
            {f.districts} tasks. Simulation and forecasting remain embarrassingly parallel.
          </p>
        </div>
      </section>

      {/* ================= REACH ================= */}
      <section>
        <div className="mx-auto max-w-[1180px] px-5 py-20 lg:py-28">
          <div className="reveal max-w-[40rem]">
            <p className="eyebrow">Depth and reach</p>
            <h2 className="display mt-5 text-[2rem] text-mist-100 sm:text-[2.5rem]">
              Built at national scale, not demoed on one district.
            </h2>
          </div>

          <dl className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
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
            ].map((s, i) => (
              <div key={s.l} className="reveal" style={at((i % 4) * 3.5)}>
                <dt className="tnum text-[2rem] leading-none text-mist-100">{s.v}</dt>
                <dd className="mt-2.5">
                  <span className="block text-[12px] font-medium text-brand">{s.l}</span>
                  <span className="mt-1 block text-[11px] leading-snug text-mist-500">
                    {s.s}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ================= PROVENANCE ================= */}
      <section className="border-y border-ink-700 bg-ink-900/40">
        <div className="mx-auto max-w-[1180px] px-5 py-20 lg:py-28">
          <div className="reveal max-w-[44rem]">
            <p className="eyebrow">Provenance</p>
            <h2 className="display mt-5 text-[2rem] text-mist-100 sm:text-[2.5rem]">
              What is real here, and what is not.
            </h2>
            <p className="mt-6 text-[15px] leading-relaxed text-mist-300">
              No public PHC inventory feed exists in India. The facility layer is generated
              by a seeded simulator, parameterised from IPHS norms and published
              epidemiological seasonality — fitted to those norms, not to observed
              consumption. Saying so plainly is cheaper than being caught not saying it.
            </p>
          </div>

          <div className="mt-12 grid gap-3 lg:grid-cols-2">
            <div className="reveal card p-6 sm:p-7">
              <p className="mb-4 flex items-center gap-2 text-[12px] font-semibold text-sev-low">
                <span className="size-1.5 rounded-full bg-sev-low" aria-hidden="true" />
                Real
              </p>
              <ul className="space-y-2.5 text-[12.5px] leading-relaxed text-mist-300">
                {[
                  'Districts, state LGD/Census codes, and coordinates',
                  'IPHS facility norms, catchment norms and bed strength',
                  'IPHS staffing establishment by tier and cadre',
                  'Drug catalogue, VED classification, cold-chain flags',
                  'Every model, forecast and optimisation in the system',
                ].map((x) => (
                  <li key={x} className="flex gap-2.5">
                    <span className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-mist-500" />
                    {x}
                  </li>
                ))}
              </ul>
            </div>

            <div className="reveal card p-6 sm:p-7" style={at(4)}>
              <p className="mb-4 flex items-center gap-2 text-[12px] font-semibold text-sev-moderate">
                <span className="size-1.5 rounded-full bg-sev-moderate" aria-hidden="true" />
                Simulated
              </p>
              <ul className="space-y-2.5 text-[12.5px] leading-relaxed text-mist-300">
                {[
                  'Individual facilities, their names and catchments',
                  'Stock positions, batches and consumption ledgers',
                  'Bed occupancy, staff vacancy and daily attendance',
                  'District supply reliability and allocation behaviour',
                ].map((x) => (
                  <li key={x} className="flex gap-2.5">
                    <span className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-mist-500" />
                    {x}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <p className="reveal mt-8 max-w-[52rem] text-[12px] leading-relaxed text-mist-500">
            One caveat the console repeats and this page will not bury: the workforce layer
            and the stock layer are correlated by construction. Remoteness is derived from
            the same synthetic district reliability parameter that drives supply, so the
            fact that badly-supplied districts are also badly-staffed here is an assumption
            in the model, not a finding from it —{' '}
            <span className="text-mist-400">
              {count(f.facilitiesWithoutPharmacist)} stock-holding facilities have no
              pharmacist in position
            </span>
            , against {pct(f.vacancyRate)} vacancy and {pct(f.absenteeismRate)} absence, and
            that is why the stock board carries an error bar.
          </p>
        </div>
      </section>

      {/* ================= CTA ================= */}
      <section className="relative isolate overflow-hidden">
        <div className="atmosphere" aria-hidden="true" />
        <div className="relative z-10 mx-auto max-w-[1180px] px-5 py-24 text-center lg:py-32">
          <div className="reveal">
            <h2 className="display mx-auto max-w-[32rem] text-[2.25rem] text-mist-100 sm:text-[3rem]">
              Open it and go looking for the seams.
            </h2>
            <p className="mx-auto mt-6 max-w-[34rem] text-[15px] leading-relaxed text-mist-300">
              Every figure on this page is read from the same shipped snapshot the console
              renders. Drill into any district, follow any corridor, and check the
              arithmetic.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <Link
                href="/console"
                className="rounded-lg bg-brand px-6 py-3.5 text-[13px] font-semibold text-ink-950 transition-transform hover:-translate-y-0.5"
              >
                Open the live console →
              </Link>
              <a
                href="https://github.com/samarthputhraya/aarogya-grid"
                className="rounded-lg border border-ink-600 px-6 py-3.5 text-[13px] font-medium text-mist-200 transition-colors hover:border-ink-500 hover:text-mist-100"
              >
                Read the source
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ================= FOOTER ================= */}
      <footer className="border-t border-ink-700">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-4 px-5 py-8 text-[11px] text-mist-500 sm:flex-row sm:items-center">
          <p>
            Aarogya Grid · snapshot <span className="tnum">{f.asOf}</span> · built{' '}
            <span className="tnum">{f.buildSeconds}s</span> · every figure regenerable from
            a seed
          </p>
          {/* Same 44px floor as the header. These were 17px tall -- below even
              the 24px WCAG 2.2 minimum, let alone the 44px one -- which on a
              phone is three links the reader has to aim at. */}
          <nav className="-my-2 flex gap-5 sm:ml-auto">
            <Link
              href="/console"
              className="inline-flex min-h-11 items-center transition-colors hover:text-mist-200"
            >
              Console
            </Link>
            <Link
              href="/capture"
              className="inline-flex min-h-11 items-center transition-colors hover:text-mist-200"
            >
              Field capture
            </Link>
            <a
              href="https://github.com/samarthputhraya/aarogya-grid"
              className="inline-flex min-h-11 items-center transition-colors hover:text-mist-200"
            >
              Source
            </a>
          </nav>
        </div>
      </footer>
    </main>
  );
}
