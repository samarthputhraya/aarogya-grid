# Defence pack

Eight questions this build should expect, each answered with one number and a
file you can open. Written for the demo-day Q&A, and kept in the repository
because an answer that only exists in somebody's head is an answer that will be
improvised under pressure.

Every figure below is checked against the shipped artefacts by
`npx tsx scripts/check-claims.mts`, which runs in `npm test`. If a rebuild moves
a number, this file stops agreeing and the test suite says so.

---

### "Is this just a Gemini wrapper?"

**No. Gemini never produces a number.** Demand is forecast by **TimesFM 2.0**
through BigQuery `AI.FORECAST`; stock-out probability and expected shortfall
come from a **Monte Carlo** over the procurement lead time; the redistribution
plan comes from a deterministic optimiser with twenty-three test suites and a
drift guard over it that checks every number on every judge-facing surface
against the artefact it describes. Gemini does three jobs a language model is actually
good at: reading a photographed paper register, understanding a spoken Hindi
stock report, and choosing which of twelve tools answers an officer's question.

The proof is on screen. Every answer ships with its **audit trail** — which tool
ran, with what arguments, how many rows it returned — written by our code, never
quoted from the model. Ask it something the data does not contain and it says so
rather than answering.

→ `src/lib/ai/grid-agent.ts` · the trace beside every answer on `/console`

---

### "Why simulated data?"

**Because the absence of this data is the problem.** If per-facility stock
positions across India's PHC network were available as an extract, the shortage
would already be visible and this project would be unnecessary.

What is real: the notified disease counts in Kerala's IDSP daily bulletins,
behind the observed early-warning signals; all 769 districts that have a published population, located at
their headquarters towns and carrying their LGD codes where Wikidata has one;
**Census 2011 district populations**, reconciled to each state's census total
where a district has since been split; the NLEM drug catalogue, IPHS tier and
staffing norms; and a real NFHS-5 indicator for every state and union territory
anchoring supply reliability. What is
simulated: facility-level stock, consumption, batches and expiries — and it is
labelled **SIMULATED FACILITY DATA** in the console header, on the landing page,
and in `NOTICE`. The one observed series is labelled the other way: its panel
says **real data**, and every signal from it links the bulletin it was read from.

The seam is small on purpose: **three adapter functions** stand between this and
a real DVDMS or e-Aushadhi extract. The forecasting, risk and optimisation code
does not change.

→ `NOTICE` section 3 · `src/lib/domain/geo.ts` · `src/data/india-districts.json`

---

### "What if the Google AI call fails?"

**The batch completes and the console still renders.** `AAROGYA_NO_BQ=1` builds a
valid national snapshot from censored Croston-SBA alone, with no network at all.
`npm test` builds a district both ways, with the forecast cache and without it,
and checks each is byte-identical across runs; the full offline national build is
a manual check. The snapshot records which model actually scored each position,
so an offline build ships `timesfmPositions: 0` and says so rather than looking
identical to one that used the model.

Gemini has a second fallback: if the primary model's daily allowance runs out, or
the model returns a 503 or an internal error mid-demo, the loop retries on the
fast model — with the thinking configuration rebuilt for that model's family —
and the trace records which one answered.

→ `src/lib/forecast/timesfm.ts` · the `forecast` block on `national-snapshot.json`

---

### "Is it really federated, or is that a word on a slide?"

**Thirty-six state and union-territory nodes, 56,660 numbers, and every one of
them is a URL you can fetch.** Each state fits its own model on its own data and publishes statistics
only: a monthly demand multiplier per catalogue item, its standard error, and one
vacancy rate per cadre. Against that, **65,05,740** daily consumption records
stay where they were recorded. **0 facility rows, 0 stock quantities, 0 patient
records, 0 district identifiers** cross a state line.

That is enforced, not promised. Every field in a node file is on an allowlist,
every count is pinned to a structural identity, and `npm test` sweeps all thirty-six
files for facility ids, district codes, batch numbers and district names — after
first proving on **five deliberately poisoned copies** that the sweep can still
see such a thing.

And it is worth something, measured leave-one-state-out: a state joining with
**30 days** of its own history forecasts **36.0% closer** to observed demand with
the national prior than without it, against a prior pooled from the other
thirty-five states and union territories only.

**Own the limitation before it is found:** one seeded simulator generates all
thirty-six, so between-state heterogeneity is small by construction and the
pooling weights are a demonstration of a mechanism rather than a finding about
Indian states. That sentence is on the console panel, not in an appendix.

→ `GET /api/federated` · `docs/federated.md` · `scripts/verify-federated.mts`

---

### "How is this different from HMIS, DVDMS or eVIN?"

**Those are systems of record. This is the decision layer over them.** They
answer "what was reported". This answers "what should the District Health Officer
do today, and what does it cost". No rip-and-replace: the dispatch plan exports
as a **batch-wise stock-issue CSV** with indent number, both facilities, batch,
expiry and three separate quantity columns for indented, issued and received —
the shape a storekeeper already files.

→ `GET /api/dispatch/export?districtCode=…`

---

### "Does it not just create a stock-out somewhere else?"

**No, and that is a test rather than a promise.** Three limits: no donor gives
away more than **40%** of its shelf, every donor keeps **21/14/7 days** of cover
by VED class, and after giving, a donor's stock-out probability must be **≤ 10%**
and no more than **2 percentage points** above where it started. The third is
enforced *inside* the selection loop — the donor's own lead-time demand is
simulated at the stock the order would leave it holding, and a candidate that
breaches is never considered.

`npm test` re-derives it from the finished plan with an independent redraw and
fails on any breach: **230 donor positions audited, worst post-donation risk
2.4%, largest rise 1.9 percentage points.** The redraw uses an independent seed,
so the plan is checked against dice the planner never saw. It also re-plans a
district with the caps lifted, because a guardrail that never binds is
indistinguishable from no guardrail: Howrah falls from **108 orders to 96**, and
its worst donor improves from **6.8% to 1.4%**.

→ `scripts/verify-guardrails.mts` · `docs/guardrail-gate.json`

---

### "Would anyone actually be allowed to do this?"

**Not always — and the software knows which.** Inside a district, the district
officer issues it. Across a district boundary, the donor district must
countersign. Across a state line, only between CHC-and-above institutional
stores, and only under an inter-state supply agreement. Below that tier across a
state line it is **refused outright**, because no requisition procedure exists
between two states' sub-centres.

`POST /api/dispatch` answers `approve` on a cross-boundary order with a **409 and
the action that unblocks it**, and the console disables Approve until a
`countersign` row exists in the same append-only history as everything else. The
gate is not free: when it landed on the 128-district grid, cross-state corridors
fell from **74 to 29**.

Every one of those rows is signed: a write needs a Google sign-in, the row names
who acted, and **the officer who countersigned an order cannot approve it** —
the state machine answers that with a `409 four_eyes`, and the dispatch
rehearsal checks it does.

→ `src/lib/optimize/admissibility.ts` · `src/lib/dispatch/ticket.ts`

---

### "Does it scale to the whole country?"

**It runs on it.** The grid models **769 districts** in all 36 states and union
territories — every district with a published population. All **36,143**
district × drug series forecast in **13 concurrent BigQuery statements**, 21 days
ahead from a 90-day context, **0 bytes billed** — `AI.FORECAST` takes an inline
subquery, so there is no table to scan. The national batch runs
in **900-1,300 s** on one laptop; the expensive stages are district-parallel with
no shared state, and planning, which is not, colours into **10 concurrent rounds**
rather than 769 tasks in a line.

And it runs on more than one instance. Each instance subscribes to the topic the
commit path publishes to and hears every other; a dispatch transition is a
conditional write to Cloud Storage, so two instances cannot approve one order.
Rehearsed on two production servers against the real project: a report reached
the other instance in a median of **483 ms**, and the same order approved on
both at once answered **200 and 409**.

→ `docs/forecast-runtime.md` · `docs/scale-gate.md` · README, *Scaling across India*

---

### "Your plan loses money."

**In cash, yes, and we lead with that number rather than burying it.** The plan
spends **₹125.9 L** on transport to recover **₹18.9 L** of stock that would have
expired: a net cash cost of **₹107.0 L**. What it buys is **34,39,003 units** of
unmet demand that does not happen, which means it breaks even at **₹3.11 per
averted unit**.

Whether a dose of a Vital medicine reaching a patient is worth ₹3.11 is a policy
judgement, not an engineering one — so the shortage penalty is an explicit
parameter a ministry can set, and the cash arithmetic is shown in full, including
its sign, on the console's own plan-economics panel. Consolidation is what makes
even that possible: the same orders on dedicated vehicles would have cost
**₹277.0 L**.

→ `/console`, plan economics · `src/lib/optimize/redistribute.ts`

---

## Owned first, before anybody asks

- **Facility-level stock is simulated.** Labelled on every surface.
- **Roles are claimed, identities are not.** Every write needs a Google
  sign-in and the audit row names who acted; there is no role directory, so
  the role they acted in is recorded as claimed.
- **Two instances are rehearsed, not load-tested.** They agree on every report
  and approve a raced order once; nobody has put a district's traffic on them.
- **The federated τ² is synthetic** — one simulator behind all thirty-six.
- **21% precision on the outbreak warning**, published next to the 78 rules that
  failed. Two tighter rules reach 53% and 42% and miss the four-day lead; the
  gate was not moved after seeing the table.
- **The observed signals are unvalidated.** The rule's precision and lead time
  were measured on simulated surges; there is no record of past Kerala outbreaks
  here to measure the same rule against.
- The assistant's slowest measured question is **11.2 s**, over the 8 s budget:
  a national fan-out across ten tool calls. The median is 5.1 s.
