# Aarogya Grid

**National medicine supply intelligence for India's primary health network.**

Forecasts medicine stock-outs across India's Sub-Centre / PHC / CHC network, and finds the stock already
sitting nearby — often close enough to expiry that it will be written off unused — that could prevent them.

Built for **Build with AI: Code for Communities — Second Edition**, problem statement 03,
*Smart Health & Supply Chain Resilience*.

---

## The problem

A Primary Health Centre runs out of anti-snake venom in monsoon. The vials exist. They are ninety minutes
away, in a facility that will write them off unused in six weeks.

Nobody knows either fact, because the two facilities report into a paper register that reaches the district
office weeks later, if at all. India's public health supply chain does not primarily fail on procurement
volume. It fails on **visibility** and on **lateral movement** — the ability to see a shortage forming and
move stock sideways before it becomes a stock-out.

Aarogya Grid attacks both halves.

## What it does

**1. Sees the network.** A national control tower over 128 districts across 16 states — 2,824 facilities,
81,104 tracked facility × drug positions, 32,242 functional beds and 33,959 sanctioned posts, across districts
whose **real 2011 Census population** totals 372 million.

**2. Forecasts what will fail — on Google's TimesFM, where it measurably wins.** Demand is forecast
by **BigQuery `AI.FORECAST` (TimesFM 2.0)** in `asia-south1`. All **6,016** district × drug series are
forecast **21 days** ahead from a **90-day** context; the model declined none of them.

It does not serve every position, and that is a measurement rather than a compromise. A **28-day
held-out backtest** scored TimesFM against the incumbent Croston per facility × drug, on demand
neither model had seen, using **MASE and RMSSE** (never MAPE — it divides by the actual, and
intermittent demand is full of zeros). TimesFM takes a demand class only where it beat Croston by
more than **5%** MASE. It won **intermittent** demand by 6.5% and holds **30,535** of the **81,104**
shipped positions; Croston keeps the rest. The full table, including where TimesFM loses, is in
[`docs/forecast-backtest.md`](docs/forecast-backtest.md).

Where TimesFM does serve, the two models split the work by strength. Demand at a *single* primary
health facility is *intermittent* — long runs of zeros punctuated by bursts — which is the regime a
foundation model trained on continuous series is worst at, and the regime **Croston's method** was
designed for. A *district* aggregate is smooth and seasonal, which is TimesFM's. So **TimesFM
forecasts the district mean path; a per-facility share disaggregates it; and Croston keeps the
occurrence process** — how often a facility sees any demand at all. That zero-inflation is what makes
the stock-out tail the right shape, and TimesFM does not model it. Stock-out probability and expected
shortfall still come from a **Monte Carlo simulation** over the procurement lead time, not a point
estimate, because "you will run out on the 14th" is a promise the data cannot support.

The forecasts are **committed to this repo** (`src/data/forecast-cache.json`), so cloning and building
reproduces the real TimesFM numbers with no Google Cloud account, and `AAROGYA_NO_BQ=1` builds a valid
snapshot from censored Croston alone with no network at all. Both paths are checked in `npm test`.
Runtime and batching are measured in [`docs/forecast-runtime.md`](docs/forecast-runtime.md).

**3. Corrects for censored history.** A stock ledger records what was *dispensed*, not what was *needed*.
Once a facility hits zero, demand keeps arriving and stops being recorded. Fitting naively on that ledger
systematically under-forecasts exactly the facilities that are already failing — the worst-served districts.
The pipeline fits on the ledger with stocked-out periods excluded.

**4. Finds the stock that is already there.** The optimiser pairs facilities heading for a stock-out with
facilities heading for expiry, scoring each candidate transfer on averted shortfall weighted by **VED**
(Vital / Essential / Desirable) class, waste averted, and transport cost. Every recommendation names the
**specific batch and its expiry date** — a recommendation a storekeeper cannot act on is not a recommendation.

**Stock crosses district lines, and a route is priced once.** These are one change, not two. An earlier
build planned each district in isolation and charged every order its own dedicated vehicle — 2,798 orders
over 2,083 distinct routes, and not one of them crossed a boundary. A cross-district trip is longer, so it
fails the same benefit/cost gate harder and could never have been afforded on its own; it becomes viable
only once orders sharing a route share the vehicle. Together they turn 2,798 orders into **7,097** on
**2,449 vehicle trips**, of which **743 trips reach into another district**, carrying **2,097 orders** over
**218 district-to-district corridors** touching **112 of the 128 districts** — **74** of those corridors
also crossing a state line. Transport comes to **₹33.3 L** against **₹82.8 L** if each order were billed its
own vehicle, and **3,873** orders are filled for the price of handling because a vehicle was already going.
The result: **43% more shortfall averted** — 495,166 → 7,07,621 units — for a net cash cost of **₹28.2 L**.

One consequence is worth stating because it is the kind of thing that hides: a cold-chain order joining an
ambient run refrigerates the *whole* vehicle. The gate that admits ride-alongs was charging such an order
₹60 of handling while it actually cost ₹60 plus the upgrade — 238 trips and ₹1.82 L of vehicle, about 4.8%
of the transport budget, admitted against a test they had not passed. The rupees were always counted in the
totals; they were not counted in the *decision*. The upgrade is now priced into the gate and billed to the
order that causes it: of 325 cold-chain ride-alongs, **56 still clear the gate** at their true cost and pay
**₹40,065** of upgrade between them, and the rest are declined. Net of the donor stock that frees up, the
plan carries 184 fewer orders, costs ₹1.53 L less to run, and scores *higher* — which is what removing
orders whose cost exceeded their benefit is supposed to do.

**4b. Closes the loop in real time.** A health worker speaks or photographs a stock report, a human
confirms it, and **the risk board changes within a second — in every open tab, without a reload**.
`POST /api/commit` resolves the drug **by name, server-side** (never a client-supplied `drugId`, and
never the draft's own status — the draft came from a language model), re-scores that position
synchronously, and pushes the delta over **Server-Sent Events**.

Measured end to end by `npm run rehearse:live`, in a real browser, **against the live Cloud Run
deployment**: **server-side re-score 11 ms** (budget 100 ms) and **178 ms to reach two open tabs**
(budget 2 s). The first commit a cold container sees costs 34 ms rather than 11 — module
initialisation, reported by the rehearsal rather than averaged away.

The part that is easy to get wrong is the reload. `/console` and all 128 `/district/[code]` routes are
**prerendered at build time**, so a committed report can never be in the HTML the server returns.
Subscribing to SSE alone produces a demo that works beautifully until somebody presses F5 and every
change vanishes. So both consoles **fetch `/api/overlay` on mount AND subscribe to the stream** — the
fetch supplies the past, the stream supplies the future — and the rehearsal reloads the page and
asserts the change is still there.

**And it survives the container being replaced.** Every committed event is appended to a partitioned
BigQuery table (`aarogya_grid.stock_events`) and published to a Pub/Sub topic (`aarogya-events`); a
restarted container reads the log back before it serves its first request. `npm run rehearse:restart`
starts a production server, commits, **kills the process**, starts another, and opens a real browser
against the replacement — which renders the corrected number off a page that was prerendered before the
report existed. The append is acknowledged in well under a second and the restore query in a couple of
seconds; the exact figures, for both a killed local process and a replaced Cloud Run revision, are in
[docs/restart-gate.md](docs/restart-gate.md), written by the gate itself. The sequence resumes from the
log rather than from zero, so an SSE client that reconnects with `Last-Event-ID` is still asking for
the same thing it was before.

The durable write is deliberately **not** on the commit's critical path. The recompute takes ~15 ms and
the append a few hundred; awaiting it would make a health worker on a district hospital's wifi wait
twenty times longer for the same answer, and would let a busy warehouse in another region fail a report
that is already correct. So each event reports its own state — `pending` on the way out, then
`durable` or `failed` over the stream a moment later — and the chip on screen says which. A failed
append never fails a commit.

Honest limits, still stated rather than implied: the in-memory overlay is not shared between instances,
so the service runs `--max-instances=1` — a commit landing on one container would otherwise be invisible
to a stream held open on another. The scale-out step is a **subscriber** on the topic the commit path
already publishes to, and that subscriber is not built: with one instance it would be dead code behind a
flag nobody flips before 30 September. `npm run verify:pubsub` proves the publish side by pulling the
messages back off a real subscription.

**4b. And the loop closes: approve → dispatch → receive.** The planner produces dispatch orders and the
console prints them. That is where a recommendation engine stops, and it is why so many systems of this
shape are called dashboards: nothing that happens afterwards ever comes back. Every order card now
carries a ticket —

    proposed ──approve──▶ approved ──dispatch──▶ dispatched ──receive──▶ received
       │                     │
       └──────cancel─────────┴──▶ cancelled

— and **the log of its transitions is the audit trail**. There is no companion table of current ticket
states, because an append-only log plus a mutable projection is two records of one event, and the day
they disagree neither is evidence. A ticket's state is the fold of its rows in `dispatch_tickets`, so a
restarted container rebuilds it by replaying, and a ticket that was mid-flight when the process died
needs no special case.

**Approval moves no stock.** Stock leaves the donor when it is *dispatched* and arrives when it is
*received*; in between it is on a vehicle and on nobody's shelf. Writing both at approval is the obvious
simplification and it would show the same units in two places for the length of the journey — which is
exactly the error the paper process makes and exactly what a real-time view is for. So approval re-scores
both ends as **projections**, labelled as such on the card, and the two real movements write into the
same overlay a voice report writes into.

**The short receipt is first-class.** The receipt field takes what actually arrived, the difference is
kept as `varianceUnits`, and the receiver's risk recovers by what turned up rather than by what was
sent. Measured in `npm run rehearse:dispatch`, on a cross-district ARV order: approval projected the
receiver from **P(out) 100% → 2%** at 14 vials; 14 were dispatched, **11 arrived**, and the receiver
landed at **17%**. Both numbers are on the card. An interface that made the honest answer harder to
enter than the convenient one would produce a dataset in which nothing ever goes missing.

Illegal transitions are **409 with the legal actions attached**, never a quiet 200 — a second approve is
almost always a double submit or a stale tab, and answering 200 teaches the client that its retry worked.
Quantities are arithmetic rather than policy: a donor cannot send what it does not hold, and more cannot
arrive than was sent (the fix for that is the dispatch note, not the receipt). The order itself — donor,
drug, planned quantity — is read from the district payload **server-side**; the client supplies an id, an
action, and at most a smaller number of units. There is no authentication in this build, so the actor is
recorded as `actor_claimed`, which is what it is.

`GET /api/dispatch/export?districtCode=…` returns the plan as a **batch-wise stock-issue CSV** — indent
number, both facilities, item, batch, expiry, and three separate quantity columns for indented, issued
and received. One row per batch, because that is how a storekeeper picks and how expiry is tracked; a
short issue comes off the batches in pick order, so the shortfall lands where it physically landed.
That file is the difference between a dashboard and something a district could pilot next month: this is
a decision layer over DVDMS and e-Aushadhi, not a replacement for them.

**5. Tracks the other two resources the network runs on.** Medicines are one of three things a facility can
run out of. **Bed availability** is modelled per IPHS norms with ward-level seasonality; **personnel
attendance** is modelled as *sanctioned* vs *in-position* vs *present-today*, because in rural India the
vacancy gap and the absence gap are different problems and the distance between those three numbers is the
finding.

They are not three dashboards on one page. They are one system, and the hinge is this: **228 stock-holding
facilities have no pharmacist in position to keep the register, and 394 facilities covering 8.5 million
people carry stock figures nobody is in post to verify.** That does not rewrite any measured quantity — it
widens the forecast error bar around it.

**6. Closes the last mile with Gemini.** The upstream data problem is that an ANM at a sub-centre reports
stock on paper, in Hindi, using words like *"bukhar ki goli"* and brand names like Crocin and Dolo. Nothing
in a catalogue matches that. Gemini handles transcription, translation and extraction from **speech or a
photographed paper register**.

**7. Lets a District Health Officer interrogate all of it, in their own language.** `askGrid` and
`briefDistrict` give Gemini a **function-calling tool surface over the computed state**. The officer asks
*"Bastar mein kaun se centre par dawa khatam hone wali hai?"*; the model plans which tools to call, calls
them, and answers only from what they return. The **tool-call trace is shown in the UI**, because a
grounded answer nobody can check is indistinguishable from a confident guess.

## How Google AI is used — and how it is bounded

Gemini does the part only a language model can do, and is deliberately trusted with nothing else:

| Safeguard | Why |
|---|---|
| **The model never emits catalogue IDs.** It returns natural-language drug names only; mapping names → IDs is deterministic (`src/lib/ai/resolve.ts`). | A hallucinated item code can never enter the ledger. |
| **Structured output is enforced twice** — a Gemini response schema constrains generation, and Zod validates the result before it goes anywhere. | The schema steers the model; Zod is what we actually trust. |
| **Nothing is committed.** Every capture produces a *draft* for human confirmation. | Implausible quantities, unit mismatches, and drugs outside the facility's formulary are flagged, not silently accepted. |
| **The formulary bounds the tier.** A Sub-Centre cannot report Ceftriaxone. | The system refuses rather than trusting the transcript. |

The resolver handles Hindi colloquialisms (*saap kaatne ka injection* → Anti-Snake Venom, *lal goli* → IFA),
brand names, and misspellings — while correctly distinguishing **cetirizine** from **ceftriaxone**, which are
one edit apart and clinically unrelated. See `scripts/test-resolve.mts` (27 assertions).

### The agent loop is hand-written, deliberately

The SDK offers automatic function calling. We don't use it. The loop is written by hand so that we can
reject any tool name not in the registry, Zod-validate every argument before it reaches real data, cap the
number of turns, and **record the trace ourselves rather than asking the model what it did**. Automatic
calling provides none of that and hides all of it.

That last point is not paranoia. Asked about a district it had not been given, the model invented the
district code `"Lucknow"`; asked to self-report its tool usage, it invented a namespace prefix that does not
exist. So the model is never given an identifier to emit — tool arguments are natural-language names,
resolved deterministically inside the tool, exactly as `resolve.ts` does for drugs.

Ten tools are exposed, all pure functions over already-computed data: `resolve_district`,
`national_overview`, `district_status`, `facility_snapshot`, `list_positions`,
`list_dispatch_orders`, `cross_district_flows`, `explain_forecast`, `explain_unmet_need` and
`drug_reference`.

Adversarial testing (`scripts/test-agent.mts`) found and fixed two real defects: the model was **computing**
percentages from raw probabilities (`0.998` → "99.8%") — faithful arithmetic, but a violation of the rule
that it may never manipulate a quantity, now fixed by giving every ratio a precomputed percent companion to
quote; and Hindi was not being honoured under the weight of English tool payloads. The suite audits every
numeric token in the model's prose against the tool payloads it actually saw, and **proves the audit can
fail** by tampering a known-good answer.

Models are configuration, not constants: `GEMINI_MODEL` for the agent, `GEMINI_MODEL_FAST` for capture
and for the agent's retry when the primary is rate-limited or unavailable. The deployed service runs
**`gemini-3.5-flash`** with **`gemini-2.5-flash`** behind it — the only two Gemini models Vertex serves in
`asia-south1`, which is verified by probing rather than assumed. Set both in `.env.local`; the code
default for both is `gemini-2.5-flash`, because no `-lite` variant is served in `asia-south1`.

### Backends

Two, selected automatically. The **Gemini API** path uses `GEMINI_API_KEY`. The **Vertex AI** path is used
when `GOOGLE_CLOUD_PROJECT` is set and there is no key to fall back on (or `GOOGLE_GENAI_USE_VERTEXAI=true`
forces it), and pins inference to **`asia-south1`** rather than the SDK's `us-central1` default — because
the first question a state health department's IT cell asks about a system touching facility-level data is
which jurisdiction it is processed in. On Cloud Run with a service account, the credential stops being a
string in an environment variable and becomes an IAM identity that can be rotated, audited and scoped.

The selection is deliberately *not* "Vertex if a project id exists" — a project id in an env file is not
evidence that Application Default Credentials are configured, and flipping on its presence would break
every call at the first inference attempt.

## Data provenance — what is real and what is not

This is stated plainly because a judge will ask, and because the honest answer is a strength.

**Real:** the districts, their coordinates and state assignments; **district populations, from the 2011
Census**; the facility tier structure and bed norms (IPHS 2022); the sanctioned staffing establishment by
tier (IPHS 2022); the catalogue of 46 drugs from India's **National List of Essential Medicines** plus one
tracked consumable, with VED classification, pack units, cold-chain flags and indicative unit costs.

**Anchored to real data, but modelled:** how many facilities each district has, and how reliable its supply
is. Facility counts are scaled by Census population, so Pune carries 48 modelled facilities and Adilabad 12,
rather than every district carrying an identical 22. Supply reliability is anchored to each state's **NFHS-5
institutional delivery rate** — a published measure of whether a state's health system reaches people. It is
a **proxy**: it is not a measurement of whether consignments arrive complete and on time, and nobody
publishes that, which is the problem this product exists to address.

**Simulated:** the stock ledger, bed occupancy and staff attendance. All are generated by a seeded,
deterministic simulator parameterised from IPHS norms and published epidemiological seasonality. None of it
is **fitted to observed data**. Vacancy and absence rates are shaped by the published literature but are
modelling assumptions, not measurements of any real district.

### Two things a careful reader will check, so they are stated here

**District populations are the 2011 Census apportioned to CURRENT boundaries.** Where a district has been
split since 2011, our figure is therefore *smaller* than the "Census 2011" number a search returns: our
Bastar is 578,326, while undivided 2011 Bastar — before Sukma, Kondagaon and Narayanpur were carved out —
was 1,413,199. We model today's districts, so today's territory is the right denominator.
`scripts/verify-census.mts` pins this against an independent publisher of the same census and fails the
build if it drifts: the ten districts in the sample whose boundaries are unchanged agree to within **0.14%**.

**District risk rankings are no longer arbitrary.** Supply reliability used to be a hash of the district
code, which ranked Kerala below Chhattisgarh because a hash has no opinion about Kerala. The worst eight
districts are now in Jharkhand, Bihar and Uttar Pradesh, and Kerala's worst district ranks 35th of 128 —
because the anchoring indicator says so, not because we decided it should.

We do not have access to DVDMS / e-Aushadhi. `src/lib/pipeline.ts` is the seam where a real deployment swaps
in real data: everything downstream consumes `FacilityDrugState`, so nothing below the seam moves. Above it,
**three adapters** change — `generateNetwork` (`src/lib/sim/facilities.ts`) becomes an ABDM Health Facility
Registry pull, `simulateInventory` (`src/lib/sim/inventory.ts`) becomes a DVDMS stock extract, and
`buildResourceStates` (`src/lib/sim/resources.ts`) becomes an HMIS bed and attendance feed. The pipeline that
calls them, the forecaster, the risk model, the optimiser, the snapshot and every screen are untouched.

It used to say "one file and nothing else". That was the wiring file, not the adapters — the kind of claim
that is impressive until someone opens the directory, which is why `scripts/check-claims.mts` now counts
them.

## Running it

```bash
npm install
cp .env.example .env.local     # add GEMINI_API_KEY from https://aistudio.google.com/app/apikey
npm run dev                    # http://localhost:3000
```

The forecasting and redistribution core runs **without** an API key — only voice and register capture are
disabled. That is deliberate: a demo that dies on a missing env var is a demo that dies on stage.

### Scripts

Scripts are `.mts` (not `.ts`) because `tsx` compiles `.ts` as CommonJS in a package without
`"type": "module"`, which breaks top-level `await`.

```bash
npx tsx scripts/build-snapshot.mts     # rebuild the national snapshot (94-203s for the country)
npx tsx scripts/demo-district.mts DST-22-BASTAR
npx tsx scripts/test-resolve.mts       # drug entity resolution, 27 assertions
npx tsx scripts/test-capture.mts       # capture validation, 26 assertions
npx tsx scripts/test-agent.mts         # grid agent: live tool calls + number audit (spends quota)
npx tsx scripts/eval-censoring.mts     # measures the censoring-correction effect
npx tsx scripts/list-models.mts        # which Gemini models your key can reach
```

### The gate, and the one test a unit test cannot replace

```bash
node .claude/scripts/verify.mjs        # lint, types, test suites, build, live/repo parity
npm test                               # the suites on their own
npm run rehearse:voice                 # the Hindi voice path, end to end, in a real browser
npm run rehearse:live                  # commit -> SSE -> two tabs -> reload (needs a server)
npm run rehearse:restart               # commit -> KILL the process -> restart -> still there
npm run rehearse:dispatch              # approve -> dispatch -> receive short, in a browser
npm run verify:pubsub                  # pull the committed events back off the topic
npm run record:demo                    # the whole loop, one take, to docs/demo/*.webm
```

`verify.mjs` prints one table and treats `SKIPPED` as not green. Its last step asks the **deployed**
service whether it agrees with the committed snapshot, because every other step can pass while the
thing being evaluated is a different build.

`rehearse:voice` is the interesting one. It drives the real `/capture` page in a real browser —
`getUserMedia` → `MediaRecorder` → `onstop` → base64 → the 6 MB proxy ceiling → Gemini → Zod → the
drug resolver → the rendered draft. The only thing substituted is the microphone hardware: a
committed 113 KB fixture of Hindi speech is played through Web Audio, so anyone who clones this repo
can reproduce the run with no microphone and no TTS credentials.

It exists because the audio path once did `btoa(String.fromCharCode(...))`, which throws past
~100 KB — about **nine seconds** of Opus — inside a handler nothing awaits. No request, no error, no
spinner. The printed Hindi sample takes twelve seconds to read, so the flagship demo failed silently
for anyone who spoke a full sentence, and passed every test that spoke one word. The rehearsal
therefore asserts that the request body **exceeds what the old encoder could have produced**, or the
run proves nothing about the bug it exists to catch.

Measured against the live deployment: 14.3 s of Hindi, a 261,534-byte body, HTTP 200 in 9.8 s, and
four entries resolved — including *लाल गोली* ("red pill") to Iron + Folic Acid, and *बिल्कुल खत्म*
("completely finished") to a stock level of zero rather than a missing row.

## Architecture

```
src/lib/domain/      drug catalogue (NLEM), Indian geography, facility tiers, bed + staff norms
src/lib/sim/         inventory, facility and resource simulators  <- swap for DVDMS/HFR extract
src/lib/forecast/    Croston, seasonality, Monte Carlo risk
src/lib/optimize/    redistribution optimiser
src/lib/ai/          Gemini client, schemas, deterministic resolution, grid agent + tool surface
src/lib/pipeline.ts  the seam: facilities -> ledger -> demand fit -> risk -> transfers
scripts/             batch jobs and evaluation harnesses
src/app/             national console, district console, capture console, /api/ask
```

Evaluating one district — a year of ledger across ~630 stock positions, a demand fit and Monte Carlo risk on
each — takes about 1.5 seconds. Doing that for 128 districts on a page load would make the national view
unusable, so the national roll-up is a **precomputed batch artefact** (~95s for the country) and drill-downs
read per-district files. That is also how it works against real data: a nightly job writes the national
picture off an HMIS extract. The UI has no idea where the numbers came from.

## Scaling across India

The expensive stages — network generation, 365 days of ledger, the censored fit and the Monte Carlo risk
evaluation — are district-parallel with no shared state. Each is seeded on `(seed, facility, drug)`, so a
district computes byte-identically whether it runs alone or alongside every other; that is what lets the
build cache and reuse a district's state across the overlapping clusters that need it (71% reuse on the
128-district run).

**Planning is not district-parallel, and it cannot be.** Donor stock is a physical quantity that can be
promised exactly once, so cross-district planning shares one allocation state across the whole run and is
order-dependent by construction — districts earlier in the fixed table get first refusal on stock they
share. The order is fixed, so the result is deterministic and reproducible; it is simply not symmetric.
Parallelism survives at a coarser grain: two districts may be planned concurrently when their clusters are
disjoint, which on this table colours into **9 concurrent rounds** (largest 31 districts) rather than 128
independent tasks. Sharding by state is *not* clean — **78 of the 128 clusters reach across a state line**,
which is the same fact that produces the 74 cross-state corridors in the plan.

The 128-district batch takes **under two minutes** end to end on one laptop when nothing else is
running. Five runs ranged **94-203 s**, and the shipped snapshot carries the exact figure for its own
run in `buildSeconds`, which the site displays. A single second-precision figure is not quoted here
because the spread between a quiet machine and a busy one is larger than anything the code does — and
that is measurable rather than assumed: a Croston-only build (`AAROGYA_NO_BQ=1`) on the same quiet
machine takes 93.6 s, within 3 s of the TimesFM build, so moving the forecast onto TimesFM cost
essentially nothing in batch time. Clustering did cost: 156 district states are simulated
rather than 128, and each plan now searches a candidate pool roughly five districts wide. The demo
runs at a reduced facility density (2 CHC / 6 PHC / 12 SC per district); full IPHS density across all 780
districts is the same code with a different `NetworkScale`. Cluster size is capped at four neighbours, so
per-district planning cost stays roughly flat as the table fills — though a denser table puts neighbours
closer, which admits more candidate pairs under the 150 km cap and makes a linear extrapolation a floor
rather than a ceiling.

## Live

**https://aarogya-grid-215071922486.asia-south1.run.app** — Cloud Run, `asia-south1`.

`/` is the overview: what the system does, the plan's economics including the negative cash line, and
what in the data is real versus simulated. `/console` is the national control tower — the dense
operational view, and the page every drill-down returns to. `/district/<code>` is a single district,
`/capture` is the field reporting surface.

Compute and inference both run in Mumbai, and the container holds **no credential at all**: the
service account attaches to the Cloud Run service, so Application Default Credentials arrive from the
metadata server. There is no key to rotate, leak, or forget to revoke.

That was not a preference. This project's Google Cloud organisation disallows API keys *and* service
account key files:

```
API keys : "Your organization's security policy disallows API keys."
SA keys  : FAILED_PRECONDITION: Key creation is not allowed on this service account.
```

Which is a good policy, and it happens to force the deployment a government system should have had
anyway. It also means there is exactly **one** deployment: a Vercel mirror used to serve the static
consoles as a fallback, and it has been deleted. It could not reach Vertex, so the capture layer and
the assistant -- the part of this the brief actually asks about -- were dead there, and it went on
serving figures from an older build that contradicted every number here.

### Deploying it yourself

```bash
npm run provision:cloud        # BigQuery dataset + table, Pub/Sub topic + subscription
npm run provision:cloud -- --check   # report what is missing, create nothing

gcloud run deploy aarogya-grid --source=. --region=asia-south1   --service-account=<sa>@<project>.iam.gserviceaccount.com   --set-env-vars="GOOGLE_CLOUD_PROJECT=<project>,GOOGLE_CLOUD_LOCATION=asia-south1,GOOGLE_GENAI_USE_VERTEXAI=true"
```

**What this project creates in a Google Cloud project, and what it costs.**

| Resource | Why | Cost at this volume |
|---|---|---|
| BigQuery dataset `aarogya_grid` + table `stock_events` | the durable event log a restart reads back | a few thousand rows: effectively ₹0 |
| Pub/Sub topic `aarogya-events` + subscription `aarogya-events-audit` | the audit trail, and the seam a second instance would read | free tier |
| Cloud Run service, `min-instances=1`, `max-instances=1` | the only place workload identity can reach Vertex | ~₹1,200–1,800/month, and the only recurring cost here |

**Forecasting creates nothing.** `AI.FORECAST` over an inline subquery scans no table, so across the
whole WS1 ladder and every refresh BigQuery reported **0 bytes processed and 0 bytes billed** — there
was no dataset in the project at all until durability needed one. The only query in the codebase that
processes bytes is the restore, and it reads a table measured in kilobytes. So the marginal cloud cost
of a state pilot is a forecast query that is free at this volume.

The service account needs `roles/bigquery.jobUser` on the project, `WRITER` on the dataset, and
`roles/pubsub.publisher` on the topic. `npm run provision:cloud` prints the list; it does not grant
them, because a script that hands itself permissions is a script nobody should run.

`npm run overlay:purge -- --all` empties the durable log. Rehearsals commit the ledger value back, so
the board is correct either way, but a test row is now a permanent row and this is how it goes away.

## Licence and attribution

Code is original and licensed under the **Apache License 2.0** — see [`LICENSE`](LICENSE).

Third-party data and reference standards are credited in [`NOTICE`](NOTICE). The one bundled
third-party data file is the national outline:

> [India boundaries](https://github.com/datameet/maps/blob/master/Country/india-composite.geojson)
> by [DataMeet India community](http://datameet.org/)
> ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)) — simplified for browser delivery
> by `scripts/simplify-outline.mts`; geometry decimated, no boundary redrawn.

Drug names come from the National List of Essential Medicines, tier and bed norms from the Indian
Public Health Standards, and state codes from the Local Government Directory. `NOTICE` also states,
in one place, exactly which parts of this repository are **not** real data — the facility register,
the consumption ledger, district populations and unit costs are all generated or modelled, and none
of them should be quoted as a measurement about a real facility.

Runtime dependencies are used under their own licences, which ship with each package.
