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

**1. Sees the network.** A national control tower over 128 districts across 16 states — 2,816 facilities,
80,896 tracked facility × drug positions, 33,017 functional beds and 33,920 sanctioned posts, covering a
modelled catchment of 232 million people.

**2. Forecasts what will fail.** Demand at a primary health facility is *intermittent*: long runs of zeros
punctuated by bursts. That is precisely the regime where a moving average misleads, so the forecast uses
**Croston's method** with epidemiological seasonality layered on top, and reports **stock-out probability and
expected shortfall from a Monte Carlo simulation** over the procurement lead time — not a single point
estimate, because "you will run out on the 14th" is a promise the data cannot support.

**3. Corrects for censored history.** A stock ledger records what was *dispensed*, not what was *needed*.
Once a facility hits zero, demand keeps arriving and stops being recorded. Fitting naively on that ledger
systematically under-forecasts exactly the facilities that are already failing — the worst-served districts.
The pipeline fits on the ledger with stocked-out periods excluded.

**4. Finds the stock that is already there.** The optimiser pairs facilities heading for a stock-out with
facilities heading for expiry, scoring each candidate transfer on averted shortfall weighted by **VED**
(Vital / Essential / Desirable) class, waste averted, and transport cost. Every recommendation names the
**specific batch and its expiry date** — a recommendation a storekeeper cannot act on is not a recommendation.

**5. Tracks the other two resources the network runs on.** Medicines are one of three things a facility can
run out of. **Bed availability** is modelled per IPHS norms with ward-level seasonality; **personnel
attendance** is modelled as *sanctioned* vs *in-position* vs *present-today*, because in rural India the
vacancy gap and the absence gap are different problems and the distance between those three numbers is the
finding.

They are not three dashboards on one page. They are one system, and the hinge is this: **219 stock-holding
facilities have no pharmacist in position to keep the register, and 393 facilities covering 8.5 million
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

Nine tools are exposed, all pure functions over already-computed data: `resolve_district`,
`national_overview`, `district_status`, `facility_snapshot`, `list_positions`,
`list_dispatch_orders`, `explain_forecast`, `explain_unmet_need` and `drug_reference`.

Adversarial testing (`scripts/test-agent.mts`) found and fixed two real defects: the model was **computing**
percentages from raw probabilities (`0.998` → "99.8%") — faithful arithmetic, but a violation of the rule
that it may never manipulate a quantity, now fixed by giving every ratio a precomputed percent companion to
quote; and Hindi was not being honoured under the weight of English tool payloads. The suite audits every
numeric token in the model's prose against the tool payloads it actually saw, and **proves the audit can
fail** by tampering a known-good answer.

Models: `gemini-3.5-flash` primary, with automatic fallback to `gemini-3.5-flash-lite` on quota exhaustion.
Configurable via `.env.local`.

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

**Real:** the districts, their coordinates and state assignments; the facility tier structure
and bed norms (IPHS 2022); the sanctioned staffing establishment by tier (IPHS 2022); the catalogue of
46 drugs from India's **National List of Essential Medicines** plus one tracked consumable, with VED
classification, pack units, cold-chain flags and indicative unit costs.

**Simulated:** the stock ledger, bed occupancy, staff attendance, **and district catchment populations**.
All are generated by a seeded, deterministic simulator parameterised from IPHS norms and published
epidemiological seasonality. None of it is **fitted to observed data**, and district rankings therefore reflect a synthetic
supply-reliability parameter, not real performance. Vacancy and absence rates are shaped by the published
literature but are modelling assumptions, not measurements of any real district.

We do not have access to DVDMS / e-Aushadhi. `src/lib/pipeline.ts` is the seam where a real deployment swaps
in real data: everything downstream consumes `FacilityDrugState`, so replacing `simulateInventory` with a
DVDMS extract and `generateNetwork` with an ABDM Health Facility Registry pull changes **that one file and
nothing else.**

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
npx tsx scripts/build-snapshot.mts     # rebuild the national snapshot (~95s for the country)
npx tsx scripts/demo-district.mts DST-22-BASTAR
npx tsx scripts/test-resolve.mts       # drug entity resolution, 27 assertions
npx tsx scripts/test-capture.mts       # capture validation, 26 assertions
npx tsx scripts/test-agent.mts         # grid agent: live tool calls + number audit (spends quota)
npx tsx scripts/eval-censoring.mts     # measures the censoring-correction effect
npx tsx scripts/list-models.mts        # which Gemini models your key can reach
```

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

The pipeline is district-parallel with no shared state, so the country scales linearly. The demo runs at a
reduced facility density (2 CHC / 6 PHC / 12 SC per district) to keep the batch under two minutes; full IPHS
density across all 780 districts is the same code with a different `NetworkScale`.

## Live

**https://aarogya-grid-215071922486.asia-south1.run.app** — Cloud Run, `asia-south1`.

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
anyway. (A Vercel mirror exists at `aarogya-grid.vercel.app` for the static consoles; it cannot reach
Vertex, so its AI panel reports itself unconfigured rather than pretending.)

### Deploying it yourself

```bash
gcloud run deploy aarogya-grid --source=. --region=asia-south1   --service-account=<sa>@<project>.iam.gserviceaccount.com   --set-env-vars="GOOGLE_CLOUD_PROJECT=<project>,GOOGLE_CLOUD_LOCATION=asia-south1,GOOGLE_GENAI_USE_VERTEXAI=true"
```

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
