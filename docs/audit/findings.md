# Audit findings — 2026-09-13

*Produced by the adversarial audit described in [docs/audit-prompt.md](audit-prompt.md): twelve
independent lenses over the code, the artefacts and the live deployment, then up to three independent
skeptics per finding, each prompted to REFUTE it rather than agree. A finding is listed as CONFIRMED
only if a majority of its skeptics could not refute it after checking the cited line themselves.*

**Coverage.** 12 lenses · 78 candidate findings triaged ·
**47 confirmed** · 19 refuted and discarded ·
12 unverified (the run hit a session rate limit before their skeptics ran —
they are listed at the end, clearly marked, and must not be treated as established).

| Severity | Confirmed |
|---|---:|
| critical | 3 |
| high | 14 |
| medium | 16 |
| low | 14 |

---

## CRITICAL (3)

### Three judge-facing surfaces claim TimesFM forecasts every facility-drug pair; the artefact says 30,535 of 81,104

- **Where** `SUBMISSION.md:19` · lens `ai-integration` · category `claim-drift`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
SUBMISSION.md:19 (inside the `> Description` block that is pasted into the submission form): "> **TimesFM** forecasts demand for every facility–drug pair, an anomaly detector flags outbreak"

README.md:4 (first paragraph): "demand for every facility–drug pair, spots outbreak surges days before a shelf empties, and moves"

docs/pitch-deck.html:334 (title slide lead): "<b>TimesFM</b> forecasts demand for every facility&ndash;drug pair, the detector spots an"

The artefact, src/data/national-snapshot.json -> forecast: {"model":"TimesFM 2.0","timesfmPositions":30535,"crostonPositions":50569,"byPattern":{"smooth":"croston","intermittent":"timesfm","erratic":"croston","lumpy":"croston"}}

README.md contradicts itself 71 lines later, at :75-76: "It won **intermittent** demand by 6.5% and holds **30,535** of the **81,104** shipped positions; Croston keeps the rest."

docs/pitch-deck.html contradicts its own title slide at :495: "It wins intermittent demand by 6.5% and holds <b>30,535</b> of <b>81,104</b> shipped positions. <b>We publish where it loses.</b>"

scripts/check-claims.mts:879 only checks the correct figure is PRESENT: `must: '**' + n(snapshot.forecast.timesfmPositions) + '** of the **' + n(t.trackedPositions) + '**'` — there is no `mustNot` anywhere in the file for the contradicting universal claim, so `npm test` passes with both sentences in the same file.

`git log -S "forecasts demand for every facility"` -> 411239e, the same commit that introduced the corrected 30,535 figure: the fix landed in the body and the stale framing stayed in the lede.
```

**Failure scenario**

A judge reads the SUBMISSION.md Description (or slide 1 of the deck, or README paragraph 1) and takes away 'TimesFM scores all 81,104 positions'. They then reach docs/forecast-backtest.md or README:75, which says TimesFM took exactly one demand class and holds 30,535 — 37.6% — and that Croston beat it on smooth, erratic and lumpy. The strongest thing about this project's AI work (a held-out backtest that publishes where the model loses) now reads as a walk-back from an overclaim, and the drift-guard discipline the whole submission is built on is falsified by its own first paragraph. This is the exact failure scripts/check-claims.mts exists to prevent, on the single most consequential AI claim in the submission.

**Suggested fix**

Replace the phrase in all three files with the per-class wording the homepage already uses and the README body already proves: 'Google's TimesFM forecasts demand in the class a held-out backtest says it wins — 30,535 of 81,104 positions; Croston keeps the rest.' Then close the hole in the guard: add `{ file: 'README.md', mustNot: /TimesFM[^.]{0,80}every facility/i }` and the same for SUBMISSION.md and docs/pitch-deck.html, so a universal TimesFM claim fails npm test the way a wrong number does.

---

### "59 rules that failed" / "60 candidate rules" is stale on four judge-facing surfaces; the artefact scores 80 and 78 fail

- **Where** `README.md:295` · lens `claims` · category `claim-drift`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
README.md:284-285 — "runs the real detector, and scores 60 candidate rules against 258 clean district-observations"
README.md:295 — "**23% precision is not a good number and it is published anyway**, next to the 59 rules that failed, in [docs/warning-tuning.md](docs/warning-tuning.md)."
README.md:563 — "npm run tune:warning   # inject surges, score 60 rules, publish the table"
SUBMISSION.md:88 — "published next to the 59 rules that failed."
DEFENSE.md:197-198 — "published next to the 59 rules that failed."
docs/pitch-deck.html:531-532 — "tuned against 126 injected surges and scored on 60 candidate rules" … "next to the 59 rules that failed"

The artefact the same sentence links to: `grep -c "^| k=" docs/warning-tuning.md` → 80 rows; `grep -c "pass\*\*"` → 2. `docs/warning-tuning.json` → `evaluations: 80`, and the doc itself says "Chosen from the 2 rules that clear the gate". 80 − 2 = 78 failed.

The grid in scripts/tune-warning.mts:325-326 and 585-586:
  for (const k of [1, 2, 3, 4, 5]) for (const e of [0, 0.1, 0.25, 0.5]) RULES.push({ k, e });
  for (const rule of RULES) for (const source of ['footfall', 'consumption', 'either', 'both'] as Source[])
= 20 × 4 = 80. The figures 60/59 are from when there were three sources.
```

**Failure scenario**

A judge reads "next to the 59 rules that failed" on the pitch deck, clicks through to docs/warning-tuning.md as the sentence invites, and finds an 80-row table with 2 passes. check-claims verifies the chosen rule, its four measured outcomes and that `tuning.scenarios.length >= 100`, but never asserts anything about `evaluations.length` — so `npm test` stays green while four surfaces publish a count that is wrong by 19.

**Suggested fix**

Derive both counts in check-claims from `docs/warning-tuning.json` (`evaluations.length` and `evaluations.length − passing`) and update all four surfaces to 80 scored / 78 failed. It understates rather than flatters, which is why it survived.

---

### Croston-path Monte Carlo de-seasonalises the smooth class twice, so stock-out risk on seasonal drugs is computed against ~half the demand the same record publishes

- **Where** `src/lib/forecast/risk.ts:155` · lens `forecast` · category `correctness`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
risk.ts:150-156 builds the per-day demand parameters from the OCCURRENCE RATE and the CONDITIONAL SIZE:

  function crostonDayParams(fit: DemandFit, multipliers: number[]): DayParams[] {
    const p = fit.demandProbability;
    const scaleOccurrence = fit.pattern === 'intermittent' || fit.pattern === 'lumpy';
    return multipliers.map((mult) => {
      if (!scaleOccurrence) {
        return { p, sizeMean: fit.meanSize * mult, sizeSd: fit.sigmaSize * mult };

The multipliers come from relativeMultipliers (risk.ts:104-113), which divides the forward curve by the as-of month's index:

  const fitSeason = seasonalIndex(profile, asOf);
  ...
  return mult.map((m) => m / fitSeason);

Its docstring (risk.ts:75-85) justifies that division for ONE quantity only: "`fit.meanDemand` is an exponentially-weighted level with alpha = 0.15 ... lately already includes the current month's seasonality." But for the smooth class the method is `ses`, and croston.ts:200-202 sets

    meanDemand = ses(series, alpha);      // EWMA level -- seasonally current
    meanSize = meanSizeObs;               // ANNUAL mean of non-zero days
    probability = nonZeroPeriods / periods; // ANNUAL occurrence frequency

so p * meanSize is the ANNUAL mean, which was never seasonalised to the as-of month and must not be divided by it. computeStockRisk publishes forecastDailyDemand from fit.meanDemand (risk.ts:410) but draws stockoutProbability / reorderPoint / expectedShortfallUnits from crostonDayParams (risk.ts:432).

Measured (probe2, all 915 Lucknow positions, median of MonteCarlo mean daily demand / published risk.forecastDailyDemand):

  method/profile                      n   median ratio   sept index
  ses / flat                        246          0.996        1.000
  ses / monsoon_vector               12          0.483        1.935
  ses / summer_enteric               27          0.928        1.048
  ses / winter_respiratory           29          1.196        0.768

The ratio is 1/seasonalIndex(profile, asOf), exactly.

Ground truth (probe4: the simulator's own future demand over the lead time, simulateInventory extended past as-of):

  method/profile             n   MonteCarlo/truth   published/truth
  ses / flat               246              1.022             1.026
  ses / monsoon_vector      12              0.488             1.003
  ses / summer_enteric      27              0.964             1.095
  ses / winter_respiratory  29              1.272             1.011

forecastDailyDemand is right; the Monte Carlo is wrong. probe6 over Lucknow + Pune + Ernakulam (2,972 positions, flat drugs as a control group):

  positions: 2972  smooth/ses: 1021 (34.4%)
  flat      n=789  sev up 25  down 20  low/mod->high/crit 12 | leadtime demand vs truth: shipped 1.008  consistent 0.998
  seasonal  n=232  sev up 17  down  3  low/mod->high/crit 10 | leadtime demand vs truth: shipped 0.791  consistent 1.000
```

**Failure scenario**

Lucknow district hospital, paracetamol (probe9, the shipped pipeline with no modification):

  {"facility":"DST-09-LUCKNOW-DH-001","drug":"PARA-500-TAB","seasonality":"monsoon_vector",
   "pattern":"smooth","method":"ses","source":"croston","onHand":3387,
   "forecastDailyDemand":534.17,"daysOfCover":6.3,"leadTimeDays":10,
   "stockoutProbability":0.0575,"reorderPoint":3426,"riskScore":4,"severity":"low",
   "impliedLeadTimeDemand":5342}

The same record says the shelf holds 6.3 days of cover against a 10-day lead time, that 3,387 units are below the 3,426 reorder point, and that the stock-out probability is 5.8% and the severity "low". Those cannot all be true. With the Monte Carlo drawing from the level forecastDailyDemand reports, it is 98% and "critical".

smooth is 34.4% of all positions (~27,900 of the 81,104 tracked nationally) and byPattern.smooth = "croston", so every one of them runs this path; ~23% of those carry a non-flat profile (~6,300 positions). 17 of 232 seasonal smooth positions in the 3-district sample change severity, 10 of them upward from low/moderate to high/critical. That propagates into national-snapshot.json totals.criticalPositions (4,683) and totals.highPositions (5,591) — both under-counted — into the alert board, and into the redistribution plan, which ranks receivers by expected shortfall. The suppression is worst on monsoon_vector drugs in September, which is the submission's own headline narrative.

**Suggested fix**

Make the Monte Carlo's per-day mean agree with the mean the record publishes. In crostonDayParams, scale the conditional size so that p * sizeMean_d == fit.meanDemand * mult_d rather than fit.meanSize * mult_d — e.g. take `const base = p > 0 ? fit.meanDemand / p : 0;` and use `sizeMean: base * mult` with sigmaSize scaled by the same factor to preserve the CV. probe6 shows that construction gives 1.000 against the simulator's true lead-time demand for the seasonal smooth class (vs 0.791 shipped) and leaves flat drugs unchanged (0.998 vs 1.008). It also removes the separate SBA discrepancy below. Add an assertion to scripts/test-timesfm.mts or a new test that mean(leadTimeDemandSamples(...)) / leadDays agrees with risk.forecastDailyDemand to within Monte-Carlo error, for every fit method and every seasonality profile — that single invariant would have caught this.

---

## HIGH (14)

### explain_forecast and the console report the Croston variant as 'the method' on positions TimesFM actually forecast

- **Where** `src/lib/ai/grid-tools.ts:1278` · lens `ai-integration` · category `correctness`
- **Verification** 2/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
The pipeline records both fields. src/lib/district-detail.ts:591-592:
      forecastMethod: s.fit.method,      // 'sba' | 'tsb' | 'ses' — the Croston fit
      forecastSource: s.forecastSource,  // 'timesfm' | 'croston' — who produced the mean path

src/lib/forecast/timesfm.ts states why forecastSource exists: "Recorded per position rather than assumed globally ... a judge asking \"is this row actually TimesFM?\" deserves an answer from the artefact rather than from a README."

But neither surface reads it. grid-tools.ts:1278, inside the tool whose description (:1219-1221) promises "How the forecast for one worked example in the district was produced: the fitted daily demand, the method, ...":
          forecastMethod: position?.forecastMethod ?? 'not recorded',
grid-tools.ts:331, in positionView, the payload behind every list_positions / facility_snapshot row:
    forecastMethod: p.forecastMethod,
Neither emits forecastSource. src/components/DistrictConsole.tsx:678 renders the same field on screen:
                          {p.demandPattern} · {p.forecastMethod}

Measured over the committed artefacts: 17 of the 128 district probes resolve to a position with forecastSource 'timesfm', and the forecastMethod mix across all 128 probes is {tsb: 52, sba: 62, ses: 14} — never 'timesfm'. Example: src/data/districts/DST-08-AJMER.json position DST-08-AJMER-SC-009 / OXYTOCIN-5IU-INJ has "forecastMethod": "sba", "forecastSource": "timesfm".

The system instruction (grid-agent.ts, WHAT YOU MUST NEVER DO clause 4) forbids the model stating a method from memory, so it can only quote what the tool hands it.
```

**Failure scenario**

A judge opens /console on Ajmer, sees the row 'Oxytocin ... intermittent · sba', and asks the assistant 'how was this forecast produced — did TimesFM do this?'. explain_forecast returns forecastMethod: 'tsb' (or 'sba'); the model is forbidden from adding anything it was not given, so it answers 'this was produced by the TSB method', naming a Croston variant for a position whose mean path came out of BigQuery AI.FORECAST. The product states the wrong model for its own headline AI integration, on the 25%-of-rubric question, using the one tool built to answer it. The correct answer is committed in the artefact one field away.

**Suggested fix**

Add `forecastSource: p.forecastSource` to positionView (grid-tools.ts:310-334) and to the explain_forecast payload (grid-tools.ts:1278), with a one-line note such as 'forecastSource is who produced the mean path (TimesFM 2.0 via BigQuery AI.FORECAST, or Croston); forecastMethod is the Croston variant fitted to this facility's own occurrence process — both apply on a TimesFM row.' Render forecastSource alongside forecastMethod at DistrictConsole.tsx:678.

---

### list_positions national branch returns nothing for any Essential/Desirable or high-severity query while quoting national totals that include them

- **Where** `src/lib/ai/grid-tools.ts:862` · lens `ai-integration` · category `data-integrity`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
grid-tools.ts:846-865, the national branch payload:
            filters: {
              severity: args.severity ?? 'critical and high',      // line 848
              criticality: args.criticality ?? 'all',              // line 849
            ...
            matchedOnBoard: rows.length,                           // line 853
            nationalTotals: {
              criticalPositions: snapshot.alertTotals.critical,
              highPositions: snapshot.alertTotals.high,
            ...
            note:
              'This is the NATIONAL alert board: a ranked sample, two rows per district and facility tier, of ' +
              snapshot.alertTotals.critical + ' critical and ' + snapshot.alertTotals.high +
              ' high positions. It carries no reorder point or censored-day count — name a district to get those.',

Measured over src/data/national-snapshot.json: all 250 rows in `alerts` are severity 'critical' and ved 'V'. Board severity mix {critical: 250}; board VED mix {V: 250}. alertTotals = {critical: 4683, high: 5591, shown: 250}.

Measured over all 128 files in src/data/districts/: critical positions by VED = {V: 2033, E: 2650, D: 0}; high by VED = {V: 710, E: 4826, D: 55}. So 2,650 critical Essential and 4,826 high Essential positions exist in the shipped artefacts and none of them can ever appear on this board.

This is structural, not incidental: scripts/build-snapshot.mts:613-617 takes the top ALERTS_PER_TIER by riskScore per (district, tier), and riskScore weights VED criticality, so Vital rows always outrank Essential at comparable probability.

The note's shape claim is also wider than the shipped board: measured rows per (district, tier) = {1: 172, 2: 39}, and only 104 of 128 districts appear at all, because stratifiedCut (build-snapshot.mts:753-780) trims the top-2 selection down to MAX_ALERTS = 250.
```

**Failure scenario**

The documented reason this branch exists is an officer on /console with no district open. They ask 'which Essential medicines are at risk across the country?'. The model calls list_positions({criticality: 'E'}), the filter at grid-tools.ts:839 matches nothing, and the payload comes back matchedOnBoard: 0, positions: [], filters.severity: 'critical and high', alongside a note asserting the board samples 4,683 critical and 5,591 high positions — with no statement anywhere that the board holds only Vital rows. The model is forbidden from inferring numbers, so the honest reading of what it was handed is 'no Essential positions are flagged nationally'. The truth in the same repo is 2,650 critical Essential positions. Same failure for severity: 'high' (0 of 250 rows are high) and for facilityTier: 'DW' (0 rows, while alertTotals.byTier reports DW 0/0 — correct there, but the pattern is identical).

**Suggested fix**

Make the payload describe the board it actually shipped. Compute the board's own composition rather than asserting the pre-cut rule: emit `boardScope: { severities: [...new Set(rows.map(a=>a.severity))], criticalities: [...], districtsRepresented: n }`, and when a filter matches zero rows return an explicit `note: 'The national board carries only <these> rows; <N> positions matching your filter exist nationally but are not on it. Name a district to see them.'` Also replace 'two rows per district and facility tier' with the measured shape, since stratifiedCut trims it to 1 row for 172 of 211 strata.

---

### README's cold-chain upgrade figures contradict the shipped payloads: ₹40,065 claimed, ₹32,914 actually billed

- **Where** `README.md:120` · lens `claims` · category `claim-drift`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
README.md:119-121 — "The upgrade is now priced into the gate and billed to the order that causes it: of 325 cold-chain ride-alongs, **56 still clear the gate** at their true cost and pay **₹40,065** of upgrade between them, and the rest are declined."

Summed over all 128 shipped district payloads (5,578 orders, every one carrying a numeric `coldUpgradeInr`):
  { allOrders: 5578, rideAlong: 3008, coldOrders: 535, coldChain+rideAlong: 103, ordersWithUpgrade: 43, upgradeSum: 32914 }

Semantics confirmed in scripts/verify-cross-district.mts:167-174 — anchors never carry an upgrade (`filter((t) => !t.rideAlong).every((t) => t.coldUpgradeInr === 0)`) and "no trip is charged the cold-chain upgrade twice" — so ₹32,914 across 43 orders is the whole of what the plan bills. grep shows 40,065 exists nowhere else in the repo: only README.md:121.
```

**Failure scenario**

A judge reads "56 still clear the gate ... and pay ₹40,065 of upgrade between them", opens the district payloads the sentence is derived from (or asks the assistant, whose `list_dispatch_orders` tool surfaces `coldUpgradeInr` per order), and sums 43 orders paying ₹32,914. The rupee figure is overstated by ₹7,151 and the count by 13. Nothing in `npm test` catches it: check-claims has no claim mentioning cold-chain, 325, 56 or 40,065.

**Suggested fix**

Re-derive all three numbers from the shipped payloads in a script that writes an artefact (or add a check-claims derivation summing `coldUpgradeInr` and counting `coldChain && rideAlong` over `src/data/districts/*.json`), then restate the sentence from it. On the current build that is 103 cold-chain ride-alongs, 43 paying ₹32,914.

---

### Deck's censoring table is unreproducible: the bias figures re-measure at −4.4%/−0.9%, and the "Error" column has no source in the repo

- **Where** `docs/pitch-deck.html:499` · lens `claims` · category `claim-drift`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
docs/pitch-deck.html:499-500 —
  <tr><td>The raw ledger</td><td class="n tnum bad">−3.8%</td><td class="n tnum">18.4%</td></tr>
  <tr><td>Stock-outs excluded</td><td class="n tnum ok">−1.0%</td><td class="n tnum ok">15.5%</td></tr>
under the header "And the fit is on corrected history | Bias | Error".

docs/README.md:8-10 says exactly how this is meant to be reproduced: "Every figure on it is reproducible from the repository at a fixed seed: … npx tsx scripts/eval-censoring.mts  # the forecast-bias figures".

I ran it (read-only, 1.8 s, seeded `createRng(7)`, SAMPLE_PAIRS = 4000):
  OVERALL         naive bias -4.4% | corrected bias -0.9%
  functioning -3.0% / -0.8% · strained -4.6% / -0.8% · disrupted -7.8% / -1.4%

So the Bias column should read −4.4% and −0.9%, not −3.8% and −1.0%. The "Error" column has no producer at all: eval-censoring.mts:124 prints only ['district tier','pairs','stockout days/yr','unmet demand','naive bias','corrected bias'] and computes no error metric; 18.4 and 15.5 appear in no artefact, and `docs/forecast-backtest.md` (the slide's own footnote citation) carries no censoring table.
```

**Failure scenario**

A judge on the AI slide sees a four-cell table of measured model quality, follows docs/README.md's instruction to reproduce it, and gets different bias numbers and no error numbers at all. The script writes no artefact and is not in `npm test` (`eval:censoring` is a separate npm script), so nothing re-derives it and check-claims has no claim on it.

**Suggested fix**

Make eval-censoring.mts write a JSON artefact, add a check-claims derivation against it, and either re-measure the Error column into existence or drop it from the slide.

---

### README says "Ten tools are exposed" and lists ten; the code registers twelve and exposes eleven by default

- **Where** `README.md:446` · lens `claims` · category `claim-drift`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
README.md:446-449 — "Ten tools are exposed, all pure functions over already-computed data: `resolve_district`, `national_overview`, `district_status`, `facility_snapshot`, `list_positions`, `list_dispatch_orders`, `cross_district_flows`, `explain_forecast`, `explain_unmet_need` and `drug_reference`."

src/lib/ai/grid-tools.ts declares twelve (grep "^    name: '"): resolve_district, national_overview, district_status, list_positions, list_dispatch_orders, cross_district_flows, explain_unmet_need, facility_snapshot, explain_forecast, drug_reference, early_warnings (line 1353), simulate_outbreak (line 1442). Only `simulate_outbreak` is `tier: 'on_request'` (line 1443), and `availableTools()` (line 1624) filters on that alone — so eleven are in front of the model by default. `early_warnings` is default-exposed and missing from the README's list.

The guard derives the count correctly (check-claims.mts:70, toolCount = 12), publishes it on the deck (`<b>12 tools</b>`), and DEFENSE.md:23 says "twelve tools" — but the mustNot guard that would catch this is scoped to the deck only:
  check-claims.mts:1015 — { file: 'docs/pitch-deck.html', mustNot: /Nine tools|Ten tools/i, why: 'there are ' + toolCount + ' tools' }
```

**Failure scenario**

A judge reads "Ten tools are exposed" in the README, then "12 tools" on the deck and "twelve tools" in DEFENSE.md, and has to decide which document to believe about the AI surface — on a submission whose pitch is that no figure is typed by hand. The guard already knows the answer and already forbids this exact string, one file away.

**Suggested fix**

Extend check-claims.mts:1015 to README.md (or better, assert `toolWord + ' tools are exposed'`), and update the README to eleven default-exposed tools of twelve registered, adding `early_warnings` to the list.

---

### Deck's hero slide says "four other orders ride the same vehicle"; the artefact it cites has ten others, five of them ride-alongs

- **Where** `docs/pitch-deck.html:463` · lens `claims` · category `claim-drift`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
docs/pitch-deck.html:463-464 — "<b>₹427</b> rather than <b>₹2,261</b> because four other orders ride the same vehicle." with the slide's own footnote at line 465: "Verbatim from the artefact the live site reads: src/data/districts/DST-10-PURNIA.json".

That artefact, filtered on the hero order's corridorId `DST-10-BHAGALPU-DH-001|DST-10-PURNIA-DH-001`, carries 11 orders:
  RL-500ML 110 bottle  cost 427  rideAlong false   <- the hero order
  ASPIRIN-75 / AZITHRO-500 / GLOVES-STERILE / ATT-4FDC  cost 427  rideAlong false
  SALBUTAMOL-MDI  cost 426  rideAlong false
  METFORMIN-500 / IFA-ADULT-TAB / PRIMAQUINE-7.5 / PRALIDOXIME-INJ / ZINC-20-DT  cost 60  rideAlong true
So: 10 other orders on the trip, of which 5 are ride-alongs and 5 are the other anchors that split the ₹427. No reading of the artefact yields four.

check-claims pins five fields of this exact order (quantity, distanceKm, estimatedCostInr, standaloneCostInr, both pick-list lines — lines 1019-1063) but not the co-rider count.
```

**Failure scenario**

This is the same slide, and the same class of error, as the "778 tablets / ×781" drift the guard's own header docstring (lines 12-18) was written to end: a sentence on the solution slide disagreeing with the file the slide names. A judge who opens DST-10-PURNIA.json — which the slide explicitly invites — counts eleven orders on that corridor.

**Suggested fix**

Derive the co-rider count in check-claims (`heroPayload.orders.filter(o => o.corridorId === heroOrder.corridorId).length - 1`, and separately the ride-along subset) and restate the sentence from it.

---

### verify-guardrails.mts's "independent" audit redraws the planner's own sample vector bit-for-bit, so a sampler bug cannot fail it

- **Where** `scripts/verify-guardrails.mts:57` · lens `forecast` · category `test-quality`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
scripts/verify-guardrails.mts:57-58

  /** Independent of the planner's own draw, so a bug in the sampler cannot hide itself. */
  const AUDIT_SIMS = 2000;

and :178-188

    // Redrawn at a different simulation count from the planner's own, so a
    // guardrail that only holds against one particular sample vector fails here.
    const samples = leadTimeDemandSamples(
      donor.ctx.facility.id, donor.ctx.drug, donor.ctx.fit,
      donor.ctx.leadTimeDays, ASOF, AUDIT_SIMS, donor.ctx.forecast,
    );

The planner's donor draw, src/lib/optimize/redistribute.ts:678-686, is the same call with the same arguments:

      samples = leadTimeDemandSamples(
        ctx.facility.id, ctx.drug, ctx.fit, ctx.leadTimeDays, o.asOf,
        DONOR_GUARDRAILS.donorSimulations, ctx.forecast,
      );

and redistribute.ts:278 is `donorSimulations: 2000` — the same count, not a different one. leadTimeDemandSamples seeds with hashSeed(facilityId, drug.id, asOf) (risk.ts:251) and simulateDays creates a fresh mulberry32 from that seed every call (risk.ts:218), so the function is pure and both calls return the identical array. Measured (probe1):

  CROSTON PATH: first 500 of the 2000-draw identical to the 500-draw ? true
  two 2000-draws identical ? true
  TIMESFM PATH: first 500 of the 2000-draw identical to the 500-draw ? true

The draw is not even a different prefix length — it is the same 2,000 numbers. Two further comments rest on the same false premise: :203-207 ("The audit redraws the distribution, so a donor sitting exactly on the threshold can land a hair either side of it for sampling reasons alone", justifying `tolerance = 1 / AUDIT_SIMS`) and redistribute.ts:266-270 ("the margin is how it is made to survive being checked by somebody else's draw", justifying enforcementMargin: 0.005).
```

**Failure scenario**

Change drawSize's gamma parameterisation in risk.ts so every demand size is systematically understated (say, swap shape and scale, or drop the Math.max(1, ...) clamp). The planner then computes donor stock-out probabilities that are too low and hands out stock it should have kept. verify-guardrails.mts recomputes P(out) from the identical understated vector, sees the identical too-low numbers, reports "0 breaches", and npm test goes green — the exact failure mode the comment at :57 says is impossible. The published claim "we never create a stock-out to fix one" would then be resting on a check that can only confirm the planner's own arithmetic, not the distribution underneath it.

**Suggested fix**

Make the audit draw actually independent by perturbing the seed rather than the count — add an optional seedSalt parameter to leadTimeDemandSamples that is mixed into hashSeed (default '' so production is unchanged), and pass a distinct salt from verify-guardrails.mts. Then AUDIT_SIMS, the 1/AUDIT_SIMS tolerance and redistribute.ts's enforcementMargin all mean what their docstrings say. Until that lands, the three comments at verify-guardrails.mts:57, :178-179, :203-206 and redistribute.ts:266-270 overstate what the check provides and should be corrected.

---

### "AAROGYA_NO_BQ=1 ... Both paths are checked in npm test" is false — npm test never builds a snapshot and never sets the variable

- **Where** `DEFENSE.md:59` · lens `forecast` · category `claim-drift`
- **Verification** 2/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
DEFENSE.md:56-61 (the judge-facing document):

  **The batch completes and the console still renders.** `AAROGYA_NO_BQ=1` builds a
  valid national snapshot from censored Croston-SBA alone, with no network at all,
  and `npm test` builds it both ways.

README.md:90-91:

  ... and `AAROGYA_NO_BQ=1` builds a valid
  snapshot from censored Croston alone with no network at all. Both paths are checked in `npm test`.

src/lib/bq/client.ts:79-83:

   * `AAROGYA_NO_BQ=1` is the switch that proves the fallback works: the snapshot
   * build must produce a valid artefact with no network at all, using the
   * committed forecast cache and Croston. It is checked in the build, so the
   * fallback cannot quietly rot.

package.json "test" expands to 22 scripts: test:outline, test:forecast, test:resolve, test:capture, test:capture-rules, test:rate-limit, test:batch-bounds, test:cross-district, test:bq-series, test:timesfm, test:determinism, test:overlay, test:base64, test:alerts, test:census, test:dispatch, test:footfall, test:surge, test:markdown, test:federated, test:guardrails, test:claims. None of them is `snapshot`. `grep -rn "build-snapshot|run snapshot" scripts/*.mts scripts/*.mjs .claude/scripts/*.mjs package.json` returns only docstring cross-references plus package.json:23 ("snapshot": "tsx scripts/build-snapshot.mts"), which nothing invokes. .claude/scripts/verify.mjs:136 only READS the committed src/data/national-snapshot.json; its five steps are lint, tsc, npm test, npm run build, live/repo parity.

The closest thing that exists is scripts/test-determinism.mts:69-81, which builds ONE district (DST-10-PURNIA) twice with the cache off and twice with it on. It never sets AAROGYA_NO_BQ and never builds a national snapshot. scripts/test-bq-series.mts:258-263 sets the variable only to assert bigQueryEnabled() returns false, then restores it.

client.ts:80-81 also mis-describes the mode: "using the committed forecast cache and Croston". scripts/build-snapshot.mts:107 is `if (FORECASTS_DISABLED) return null;` — the cache is dropped entirely, as build-snapshot.mts:97 correctly says.
```

**Failure scenario**

A judge reads DEFENSE.md, asks "what if the Google AI call fails?", and is told the offline path is covered by the test suite. It is not: the offline snapshot build has no automated coverage at all. If build-snapshot.mts grows a dependency on FORECAST_CACHE being non-null — the block at :793-799 already dereferences it with ?? fallbacks, and any new field that forgets one would throw — the offline build breaks and nothing catches it. The check also cannot simply be added as claimed: an offline build writes seriesForecast: 0 / model: null into national-snapshot.json, and the very next step, test:claims (check-claims.mts:864), asserts the README says "**6,016** district x drug series" against that file, so the suite would fail on the step after.

**Suggested fix**

Either add a real guard — a script that runs build-snapshot.mts with AAROGYA_NO_BQ=1 to a temp output path, asserts the artefact parses and that forecast.model === null and forecast.timesfmPositions === 0, and does not overwrite the committed snapshot — and wire it into npm test; or correct the three claims to say what is actually checked (that the Croston path is exercised per-district by test:determinism, and that the offline snapshot build is a manual check). Also fix src/lib/bq/client.ts:80-81, which describes AAROGYA_NO_BQ=1 as using the committed cache when build-snapshot.mts:107 drops it.

---

### README says "Ten tools are exposed" and lists ten; grid-tools.ts registers twelve (eleven in the default set)

- **Where** `README.md:446` · lens `intent` · category `claim-drift`
- **Verification** 6/6 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
README.md:446-449:

"Ten tools are exposed, all pure functions over already-computed data: `resolve_district`, `national_overview`, `district_status`, `facility_snapshot`, `list_positions`, `list_dispatch_orders`, `cross_district_flows`, `explain_forecast`, `explain_unmet_need` and `drug_reference`."

`grep -n "    name: '" src/lib/ai/grid-tools.ts` returns twelve: the ten above plus `early_warnings` (line 1353, default tier) and `simulate_outbreak` (line 1442, `tier: 'on_request'`). `availableTools()` (grid-tools.ts:1624-1627) exposes eleven by default.

The project already knows this number drifts. scripts/check-claims.mts:70 derives `const toolCount = (read('src/lib/ai/grid-tools.ts').match(/^ {4}name: '/gm) ?? []).length;` and asserts it — but only against the deck:
  line 992: `must: '<b>' + toolCount + ' tools</b>'`, file `docs/pitch-deck.html`
  line 1015: `{ file: 'docs/pitch-deck.html', mustNot: /Nine tools|Ten tools/i, why: 'there are ' + toolCount + ' tools' }`
No claim in the 79 README entries covers the tool count. DEFENSE.md:23 already says "twelve tools", so the two judge-facing documents contradict each other.

The secondary clause is also false for one of the twelve: "all pure functions over already-computed data" — grid-tools.ts:135-140 describes `simulate_outbreak` as a tool that "re-scores a district cluster and runs the planner twice, which is half a second of CPU".
```

**Failure scenario**

A judge following the README's own discipline ("every published number is derived from a shipped artefact") opens src/lib/ai/grid-tools.ts to count the tools, finds twelve, then finds DEFENSE.md:23 saying "twelve" and the deck saying twelve. The one surface that is wrong is the repo homepage — and the guard that would have caught it exists and is pointed everywhere except there.

**Suggested fix**

Push a claim for the README into scripts/check-claims.mts alongside the deck one (a `must` on the count and a `mustNot` on /Nine tools|Ten tools/i for README.md), and update line 446 to the derived count plus the two missing names — noting `simulate_outbreak` is opt-in and is not a pure read.

---

### README's "Try this in 60 seconds" steps 1 and 2 describe /console but tell the judge to open /

- **Where** `README.md:24` · lens `judge-path` · category `intent-divergence`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
README.md:8 gives the live link as the root: `| **Live** | **<https://aarogya-grid-215071922486.asia-south1.run.app>** · Cloud Run, `asia-south1` |`

README.md:24-28 then says:
  "1. Open the live link. The KPI strip is the whole country: **2,824 facilities, 81,104 stock positions, 4,683 of them critical today.**
   2. Scroll one screen to **Ask the grid** and press *\"Where is it worst tonight?\"*"

But on `/` those things do not exist. Measured on the rendered page:
  $ grep -o '<button[^>]*>' home.html | wc -l   ->  0
  $ grep -c '<textarea\|<input' home.html        ->  0
The only occurrences of "Ask the grid" and "Where is it worst tonight?" in home.html are inside the instruction text itself:
  `<span>Scroll one screen to <strong class="text-mist-200">Ask the grid</strong> and press <em>"Where is it worst tonight?"</em>`
The real assistant is on /console (console.txt:114, tab stops 19-27 include BUTTON:"Where is it worst tonight?"). The hero KPI trio on `/` is "5.4 L units of shortfall averted / 174 inter-district corridors / 37.22 Cr people in catchment" — not facilities/positions/critical.

The project's own on-page copy has it right. src/app/page.tsx:173 reads "Open the console" where the README reads "Open the live link", and page.tsx:190 reads "Open any district" where README.md:29 reads "Click any bubble on the map".
```

**Failure scenario**

A judge opens https://aarogya-grid-215071922486.asia-south1.run.app, reads README step 1, and scans the hero for "2,824 facilities / 81,104 stock positions / 4,683 critical". Those numbers appear only inside a numbered list item that says "Open the console" — contradicting the instruction they are following. They proceed to step 2, scroll one screen looking for "Ask the grid", and hit "What the plan actually does", then "The part most decks leave out", then "How it works" — a page with zero buttons and zero inputs. The two steps the README promises take 60 seconds both fail on the page the README sends them to, and the judge concludes either the deployment is stale or the demo is broken, at exactly the moment the submission is trying to prove the opposite. scripts/check-claims.mts guards the three numbers in that sentence against the snapshot but has no way to check that the page named is the page linked.

**Suggested fix**

Make README.md:24-32 match the on-page list at src/app/page.tsx:167-195: step 1 "Open the live link, then **Open the live console**. The KPI strip…", step 2 unchanged (it is then correct), step 3 "Open any district…". Or link the Live row at README.md:8 to /console. Either way the two copies of the same three steps should be derived from one source, the way every number on these surfaces already is.

---

### 340 dispatch order cards say "cutting stock-out risk to 100%" — a reduction that did not happen

- **Where** `src/lib/optimize/redistribute.ts:929` · lens `judge-path` · category `claim-drift`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
The rationale is built unconditionally, with no check that probAfter < probBefore:

  src/lib/optimize/redistribute.ts:928-930
    `${best.shortfallAverted.toFixed(1)} ${drug.unit}s of unmet demand, cutting stock-out risk to ` +
    `${(best.probAfter * 100).toFixed(0)}%.`

  src/lib/optimize/redistribute.ts:1436-1437 (ride-along variant)
    `...cutting stock-out risk ` + `from ${(probBefore*100).toFixed(0)}% to ${(best.probAfter*100).toFixed(0)}%.`

Measured over all 128 shipped district payloads (5,578 orders):
  orders: 5578 | rationale says risk was cut but after >= before: 340 (6.1%) across 103 districts

Live on https://…/district/DST-10-PURNIA, order #78, rendered text in document order:
  "risk ↓ 0 pp" … "CHC Purnia-01 can spare 12 bottles (batch B014-HC001, expires in 625 days) while DH Purnia-01 holds 5 bottles against a 100% chance of running short within its 10-day resupply window. Moving them 34 km costs ₹1,057 and averts an expected 12.0 bottles of unmet demand, cutting stock-out risk to 100%." … "P(out) 100 % → 100 %"

All three sit inside a panel headed (src/components/DistrictConsole.tsx:440) "ranked by risk removed", and the badge at DistrictConsole.tsx:1144 renders `↓ {(order.riskReduction * 100).toFixed(0)} pp`.
```

**Failure scenario**

A judge opens any of 103 district pages and scrolls the dispatch list (Purnia has 5 such cards of 83, Ajmer has them at #30-#33 of 37). They read a card that says, in one sentence, that ₹1,057 of transport cuts stock-out risk — to the same 100% it started at — beside a badge reading "↓ 0 pp" and chips reading "P(out) 100 % → 100 %", under a header promising the list is ranked by risk removed. The economics are actually defensible (12 bottles of expected shortfall are genuinely averted even when P(out) stays pinned at 1), but the sentence asserts something the two numbers next to it flatly deny. On a submission whose entire pitch is "open it and go looking for the seams", the judge concludes the narration is decorative rather than derived — which is the one thing this codebase cannot afford them to conclude.

**Suggested fix**

Branch the clause on whether the probability actually moved. When `best.probAfter >= probBefore` (or rounds to the same percent), say what is true — e.g. "…averts an expected 12.0 bottles of unmet demand, though the shelf is short enough that stock-out remains near-certain at 100%". The same guard covers the ride-along string at :1437, which currently emits "cutting stock-out risk from 100% to 100%".

---

### Expiry-rescue pass emits fractional dispatch quantities; 19 shipped orders cannot be dispatched at all

- **Where** `C:/Users/samar/aarogya-grid/src/lib/optimize/redistribute.ts:1010` · lens `optimiser` · category `correctness`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
redistribute.ts:1008-1010 (pass 2):
    const rescueRoom =
      donor.risk.onHand - (state.given.get(capKey(donor)) ?? 0) - mustRetainUnits(donor);
    let rescuable = Math.min(wasteBudget.get(capKey(donor)) ?? 0, donor.risk.onHand, rescueRoom);

mustRetainUnits (line 290) returns a FLOAT: `ctx.risk.onHand * (1 - DONOR_GUARDRAILS.maxDonorFraction)`. That float is passed straight through as the cap at line 1062-1068: `allocateFefo(donor, Math.min(rescuable, absorbable), 3, committed, o.asOf)`. Inside allocateFefo only the BATCH is floored, never the cap:
    line 356:  const free = Math.floor(batch.quantity) - (committed.get(...) ?? 0);
    line 358:  const take = Math.min(free, cap - quantity);
and line 1069 only rejects `qty < 1`. Pass 1 has no such hole because donatableUnits (line 304) applies Math.floor.

Shipped consequence — 19 orders across src/data/districts/, every one a pass-2 rescue (riskReduction 0, waste == quantity):
  DST-09-GORAKHPU ARV-VACCINE      q=25.799999999999997
  DST-19-PURULIA  DEXTROSE-5-500ML q=141.20000000000002  lines=[{B012-DH001,19},{B013-DH001,122.20000000000002}]
  DST-36-HYDERABA CIPRO-500        q=2429.2000000000003
  DST-22-KORBA    CALCIUM-500-TAB  q=3772.8   ... (19 in total)
Numerically verified: 531.2 = 1328 - 1328*0.6, 228.8 = 572 - 572*0.6, 3772.8 = 9432 - 9432*0.6, 1495.6 = 3739 - 3739*0.6 — i.e. exactly rescueRoom with the fraction floor binding.
```

**Failure scenario**

Open DST-09-GORAKHPU, the CHC Gorakhpur-01 -> CHC Gorakhpur-03 ARV-VACCINE order. The card renders `count(order.quantity)` = "26 vials" (src/lib/format.ts:27 rounds). DispatchTicketStrip.tsx:81 seeds the input with the raw plannedUnits and line 218 POSTs it, so the officer clicks Dispatch and the server runs src/lib/dispatch/ticket.ts:311-318: `const units = requested ?? ticket.plannedUnits; if (!Number.isInteger(units) || units <= 0) throw` -> "Dispatch quantity must be a positive whole number of vials." If they instead type the 26 the card showed, ticket.ts:320-326 fires: "The order is for 25.799999999999997 vials; 26 would exceed it." The order is undispatchable by either route, and the number input renders value=25.799999999999997 with step=1. The exported indent (src/lib/dispatch/csv.ts:158, `cell(line.quantity)`) writes the literal string 25.799999999999997 into qty_indented — in a file whose own docstring (csv.ts:88-92) says fractional units "disagree with the physical shelves". This also falsifies HARD CONSTRAINT 4 in the module header (line 48-50) and the stated purpose of allocateFefo (line 357: "a pick list cannot ask for a fraction of a dispensing unit").

**Suggested fix**

Floor the cap where it is built, not only the batch: `let rescuable = Math.floor(Math.min(wasteBudget..., donor.risk.onHand, rescueRoom));` at line 1010, and/or make allocateFefo defensive with `cap = Math.floor(cap)` at its top (line 344). Flooring at line 1010 also keeps state.capacity and state.given integral, so a fractional rescue cannot leak into a later district's pass-1 cap via `Math.min(available, need)`.

---

### Pass 2 and pass 3 can re-issue an order on a (donor, receiver, drug) triple pass 1 already used, producing duplicate order ids that collide in the ticket log and the CSV

- **Where** `C:/Users/samar/aarogya-grid/src/lib/optimize/redistribute.ts:1103` · lens `optimiser` · category `data-integrity`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
Nothing in planForDrug stops the expiry-rescue pass from selecting a receiver the anchor pass already served from the same donor. Pass 1 pushes at line 932 keyed only by (best.donor, receiver, drug); pass 2 pushes at line 1103 with `fromFacilityId: donor.facility.id, toFacilityId: cand.ctx.facility.id, drugId: drug.id` and its candidate filter (lines 1021-1032) excludes only `c.facility.id !== donor.facility.id`. Pass 3 has the same gap against pass 2's output.

src/lib/district-detail.ts:527 derives the order identity from exactly that triple:
      id: t.fromFacilityId + '|' + t.toFacilityId + '|' + t.drugId,

7 collisions are in the shipped artefacts:
  DST-08-KOTA    DST-08-KOTA-DH-001|DST-08-KOTA-CHC-001|CEFTRIAXONE-1G   x2  (30u anchor, 182u rescue)
  DST-09-GORAKHPU ...|ARV-VACCINE      x2  (21u, 25.8u)
  DST-18-KAMRUPME ...|GLOVES-STERILE   x2  (759u, 1555u)
  DST-19-PURBABAR ...|DICLOFENAC-INJ   x2  (27u ride-along, 242u)
  DST-20-RANCHI   ...|TELMISARTAN-40   x2  (72u ride-along, 1473u)
  DST-24-VADODARA ...|ORS-SACHET       x2  (82u ride-along, 1182u)
  DST-27-CHHATRAP ...|GLOVES-STERILE   x2  (9u ride-along, 147u)
```

**Failure scenario**

In Kota the plan contains two separate CEFTRIAXONE-1G orders from DH Kota-01 to CHC Kota-01: a 30-vial anchor and a 182-vial rescue, with identical ids. src/lib/dispatch/service.ts:262 resolves the order with `detail.orders.find((o) => o.id === input.orderId)` — always the 30-vial one — and line 270 builds `ticketId = districtCode + ':' + order.id`, so both cards write to ONE ticket. Clicking Dispatch on the 182-vial card creates a ticket whose plannedUnits is 30 (service.ts:122), caps the dispatch at 30 (ticket.ts:320), and applies the 30-unit projection to the donor and receiver (service.ts:307,315). The 182 vials can never be issued or tracked; the audit log records one movement where the plan ordered two. src/lib/dispatch/csv.ts writes two rows sharing one indent number — under a comment at csv.ts:136-138 asserting "The order id is already unique per donor x receiver x drug" — and `ticketsByOrderId.get(order.id)` (csv.ts:125) apportions one ticket's issued/received units onto both orders' pick lines. In the console, DistrictConsole.tsx:505 (`selected={o.id === selectedOrderId}`) expands both cards at once.

**Suggested fix**

Either make the identity unique (add a pass/sequence discriminator to the order id in district-detail.ts:527), or — better, since two vehicles are not wanted — make the planner merge: keep a per-plan Set of `from|to|drug` triples already pushed and have pass 2 and pass 3 skip or extend an existing line rather than emit a second order. Merging also removes the odd artefact of one corridor carrying two lines of the same drug from the same donor.

---

### docs/demo-script.md opens the submission video with an arithmetically impossible sentence, and carries zero check-claims coverage

- **Where** `C:\Users\samar\aarogya-grid\docs\demo-script.md:16` · lens `tests` · category `claim-drift`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
docs/demo-script.md:16
| 0:03 | 2,824 facilities. 128 districts, 16 states. Tonight 4,683 stock positions are critical — 5,030 of them already at zero. |

snapshot totals: criticalPositions = 4683, zeroStockPositions = 5030
scripts/build-snapshot.mts:487  totals.criticalPositions += summary.criticalPositions;
scripts/build-snapshot.mts:489  totals.zeroStockPositions += Math.round(summary.zeroStockShare * summary.trackedPositions);

`zeroStockPositions` is a share of trackedPositions (81,104), not a subset of criticalPositions.

grep -oP "file: '[^']+'" scripts/check-claims.mts | sort | uniq -c
     79 README.md / 24 docs/pitch-deck.html / 8 DEFENSE.md / 7 SUBMISSION.md / 1 FederatedPanel.tsx / 1 page.tsx / 1 guardrail-gate.json / 1 assistant-latency.json
  -> docs/demo-script.md: not present
```

**Failure scenario**

The narrator says "4,683 stock positions are critical — 5,030 of them already at zero": a subset larger than its superset. Both figures are individually correct against the snapshot, so no guard could catch the sentence even if demo-script.md were listed — but it is not listed at all, so nothing checks any of its 12 artefact-derived figures (2,824 / 128 / 16 / 4,683 / 5,030 / 6,016 / 30,535 / 81,104 / 25,184 / 10,82,880 / 38.4% / 4.04 d / 23%). When the snapshot is next rebuilt, every one of them silently becomes stale in the spoken script while `npm test` stays green. The same ambiguity is on the live console (NationalConsole.tsx:211-213 renders Critical positions = 4,683 with sub-label "5,030 at zero stock").

**Suggested fix**

Reword to "4,683 stock positions are critical, and 5,030 positions are already at zero" (they are disjoint counts over different denominators), and add docs/demo-script.md to the `claims` array in check-claims.mts with `must` entries for each figure it speaks, exactly as docs/pitch-deck.html already has.

---

## MEDIUM (16)

### The daily-quota fallback sends gemini-3's thinkingLevel to gemini-2.5-flash and dies on a 400

- **Where** `src/lib/ai/grid-agent.ts:527` · lens `ai-integration` · category `correctness`
- **Verification** 2/2 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
grid-agent.ts:519-541, inside the per-turn loop:
    const request = {
      model: opts.model,
      contents,
      config: {
        ...
        thinkingConfig: thinkingFor(activeModel),      // line 527 — bound ONCE per turn
        ...
    let response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await ai.models.generateContent({ ...request, model: activeModel });   // line 540
        break;
      } catch (e) {
        if (isDailyQuota(e) && activeModel !== fallbackModel) {
          ...
          activeModel = fallbackModel;               // line 557
          continue;                                  // re-sends the SAME request object
        }

Only `model` is overridden on the retry; `config.thinkingConfig` still holds whatever thinkingFor() returned for the ORIGINAL model.

thinkingFor (grid-agent.ts:105-118) returns `{ thinkingLevel: ThinkingLevel.MINIMAL }` for /gemini-3/ and `{ thinkingBudget: 0 }` otherwise. The deployed pairing is gemini-3.5-flash primary / gemini-2.5-flash fallback — .env.local:11-12 (`GEMINI_MODEL=gemini-3.5-flash`, `GEMINI_MODEL_FAST=gemini-2.5-flash`) and README.md:460 ("The deployed service runs **`gemini-3.5-flash`** with **`gemini-2.5-flash`** behind it").

The file's own docstring, grid-agent.ts:91-96, states the consequence: "Two parameter names, because two model generations are supported and they do not share one: Gemini 3.x takes `thinkingLevel`, 2.5 takes a token `thinkingBudget`. Sending the wrong one is a 400, so the family is decided from the active model id rather than from a guess."

The resulting 400 is neither a daily quota (isDailyQuota, :425-426, requires 'PerDay' in the message) nor a throttle (rateLimitDelayMs, :436-438, requires status 429 or 'RESOURCE_EXHAUSTED'), so control reaches `throw e` at :568 and the whole run fails.
```

**Failure scenario**

Demo day. gemini-3.5-flash exhausts its daily allowance mid-answer. The fallback fires exactly as designed, logs '[grid-agent] daily quota exhausted on gemini-3.5-flash; falling back to gemini-2.5-flash', and immediately re-sends a request carrying thinkingLevel: MINIMAL to gemini-2.5-flash. That is a 400 INVALID_ARGUMENT; it matches neither the quota branch nor the throttle branch, so it is rethrown, /api/ask:160 returns 502 'The assistant could not complete this question', and the officer/judge sees the assistant dead. The fallback exists precisely so 'a demo that dies on stage' cannot happen, and this is the only code path where it runs — so the defect is invisible until the moment it matters.

**Suggested fix**

Build the config from the model actually being sent: move the request construction inside the retry loop, or at line 540 send `{ ...request, model: activeModel, config: { ...request.config, thinkingConfig: thinkingFor(activeModel) } }`. Adding a fallback assertion to scripts/test-agent.mts (force activeModel to the fast model on turn 1) would keep it from regressing.

---

### Cache hits make the audit trail repeat step numbers, and the trace rows share a React key

- **Where** `src/lib/ai/grid-agent.ts:621` · lens `ai-integration` · category `correctness`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
grid-agent.ts:591-621. `toolCallCount++` happens at :591 for every call; the cache branch assigns the step and then rolls the counter back:
        entry = {
          step: toolCallCount,                       // line 613
          ...
          summary: 'repeat call — served from cache, not charged to the budget',
        };
        toolCallCount--;                             // line 621

So for the sequence [A, A, B] in one turn: A executes -> step 1, count 1. A is a cache hit -> count 2, step 2, count back to 1. B executes -> count 2, step 2. Two trace entries carry step 2.

The docstring for the field (grid-agent.ts:117-119) says: "/** 1-based, in execution order. */ step: number;"

src/components/GridAssistant.tsx:722 uses it as the list key, and :741 prints it as the step number a judge reads:
            <TraceRow key={entry.step} entry={entry} />
        <span className="tnum text-[10px] text-mist-500 w-4 shrink-0">{entry.step}</span>

The triggering condition is not hypothetical — the cache comment at grid-agent.ts:585-589 records it happening live: "the model called `list_positions` with identical arguments five times, spent the entire turn budget". In that exact run every cache hit is stamped step 2.
```

**Failure scenario**

The model repeats a call (the observed behaviour the cache was built for). The trace panel — which DEFENSE.md calls 'the proof ... written by our code, never quoted from the model' and which grid-agent.ts:47-53 calls 'the evidence' — renders 'step 2' three times in a row, and React reconciles those rows against one duplicate key, so row content and the expand/collapse state can attach to the wrong entry on re-render. A judge auditing the trail sees an evidence panel that cannot count its own steps.

**Suggested fix**

Separate the two counters: keep `toolCallCount` as the budget meter and add a monotonic `traceStep` that is incremented once per trace entry and never decremented. Assign `step: ++traceStep` in all four entry constructions (:613, :624, :636, :654); the cache branch then still leaves the budget untouched.

---

### The same measurement is published as 326 ms and as 178 ms, both attributed to the live deployment, with no artefact to adjudicate

- **Where** `README.md:19` · lens `claims` · category `claim-drift`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
README.md:18-19 — "the real-time loop closes through Cloud Run's load balancer — **two open tabs updated 326 ms after a commit**, `X-Accel-Buffering: no` set, first SSE frame flushed immediately (`npm run rehearse:live <url>`)."
SUBMISSION.md:60 — "server re-score in 7–14 ms → both open tabs updated in 326 ms"
README.md:185-187 — "Measured end to end by `npm run rehearse:live`, in a real browser, **against the live Cloud Run deployment**: **server-side re-score 11 ms** (budget 100 ms) and **178 ms to reach two open tabs** (budget 2 s)."
docs/pitch-deck.html:412 — "Measured against the live Cloud Run deployment: re-score 11 ms (budget 100) · two open tabs updated in 178 ms (budget 2 s)"

Unlike every other rehearsal, `scripts/rehearse-live.mjs` writes no artefact — `grep -n "writeFile\|docs/" scripts/rehearse-live.mjs` returns nothing; the figure exists only in console output (line 180: `ok('both tabs showed the new number in ' + delta + ' ms ...')`). There is no `docs/live-gate.json` to compare against, and check-claims has no claim on either number.
```

**Failure scenario**

A judge reads 326 ms in the README's opening block and on the submission page, then 178 ms in the README's own §4b and in the deck footnote — four statements of one measurement, all credited to the live Cloud Run deployment, differing by 83%. Neither can be checked, because the only script that produces it prints and forgets. On the one surface whose thesis is "every number comes from a shipped artefact", this is the only headline figure with no artefact behind it.

**Suggested fix**

Have rehearse-live.mjs write `docs/live-gate.json` the way rehearse-dispatch and rehearse-restart do, then either quote one measured figure everywhere or quote a band, checked in check-claims like BUILD_BAND.

---

### docs/forecast-runtime.md publishes a stale 80,896 position count in a document that claims nothing in it is typed by hand

- **Where** `docs/forecast-runtime.md:42` · lens `claims` · category `claim-drift`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
docs/forecast-runtime.md:3-4 — "Generated by `npm run forecast:ladder`. Every figure below is read from the run that wrote `docs/forecast-runtime.json`; none of it is typed by hand."
docs/forecast-runtime.md:42 — "There are 80,896 facility × drug positions — 13× the district × drug count measured above."

It is typed by hand, in the generator: scripts/forecast-ladder.mts:482-483 —
  'There are 80,896 facility × drug positions — ' + (top ? (80896 / o.seriesPool).toFixed(0) : '13') +

The shipped snapshot says `trackedPositions: 81104`, and every other surface agrees: README ("81,104 tracked facility × drug positions"), the deck ("81,104 stock positions"), demo-script.md ("30,535 of 81,104 positions"), and the live console (`curl .../console | grep -c '81,104'` → 1). `docs/forecast-runtime.json` contains no position count for the line to have been read from.

DEFENSE.md:166 points a judge straight at this file: "→ `docs/forecast-runtime.md` · README, *Scaling across India*".
```

**Failure scenario**

A judge following the defence pack's "Can it scale to 800 districts?" citation opens docs/forecast-runtime.md and reads 80,896 positions three clicks after reading 81,104 on the console — in a file that opens by promising none of its figures were typed. check-claims never opens docs/forecast-runtime.md.

**Suggested fix**

Read the count from `src/data/national-snapshot.json` in forecast-ladder.mts instead of hard-coding 80896, and add a check-claims assertion on docs/forecast-runtime.md.

---

### README's closing provenance paragraph lists district populations as "not real data", contradicting NOTICE, the deck and the README itself

- **Where** `README.md:720` · lens `claims` · category `claim-drift`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
README.md:718-721 — "`NOTICE` also states, in one place, exactly which parts of this repository are **not** real data — the facility register, the consumption ledger, district populations and unit costs are all generated or modelled, and none of them should be quoted as a measurement about a real facility."

Every other statement on every surface says the opposite:
README.md:489-490 (Data provenance, **Real:**) — "**district populations, from the 2011 Census**"
NOTICE:57-64 lists "Census of India 2011, district population totals" under section 2 (real reference tables), and section 3 ("What in this repository is NOT real data") does not mention populations at all.
DEFENSE.md:40-42 — "What is real: … **Census 2011 district populations**"
docs/pitch-deck.html slide 11 — "Real … Census 2011 district populations"
And it is defended with a cross-check: scripts/verify-census.mts pins ten unchanged districts against an independent publisher (worst divergence 0.1447%, which I recomputed).
```

**Failure scenario**

A judge assessing data provenance — the question DEFENSE.md ranks second — reads the README's last paragraph and concludes the Census populations are modelled, discarding the one genuinely-real, independently-cross-checked dataset in the submission. The sentence also misdescribes NOTICE, which a judge can open in ten seconds.

**Suggested fix**

Drop "district populations" from that list (unit costs and the facility register belong there; populations do not), or reword to "district populations are apportioned to current boundaries".

---

### README says Kerala's worst district ranks 35th of 128; by the ranking the product actually uses it is 32nd

- **Where** `README.md:509` · lens `claims` · category `claim-drift`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `likely`

**Evidence**

```
README.md:507-510 — "**District risk rankings are no longer arbitrary.** … The worst eight districts are now in Jharkhand, Bihar and Uttar Pradesh, and Kerala's worst district ranks 35th of 128 — because the anchoring indicator says so, not because we decided it should."

The product ranks districts by `meanRiskScore` descending — src/components/NationalConsole.tsx:86: `[...snapshot.districts].sort((a, b) => b.meanRiskScore - a.meanRiskScore).slice(0, 12)` (and IndiaMap.tsx:143, 517 colour by the same field). Applying that to all 128 districts in national-snapshot.json puts Kerala's worst (Idukki, meanRiskScore 15.6) at rank 32, not 35. By `reliability` ascending it is 96th; by criticalPositions 53rd; no field in the snapshot yields 35.

(The companion claim in the same sentence is correct: the eight worst by meanRiskScore are East Singhbhum/JH, Gaya/BR, West Champaran/BR, Hazaribagh/JH, Muzaffarpur/BR, Lucknow/UP, Patna/BR, Purnia/BR.)
```

**Failure scenario**

A judge checking the "rankings are not arbitrary" claim opens /console, sorts the district table, and counts to Idukki at 32. Small, but it is the one sentence in the README offering a specific rank as evidence that the model is anchored to real data, and check-claims has no claim on it.

**Suggested fix**

Derive the rank in check-claims from `snapshot.districts` sorted by meanRiskScore and quote it, or drop the specific ordinal.

---

### A dispatch-ticket append that fails or is disabled is invisible on every surface, and sink.ts claims a ticket `durability` field that does not exist

- **Where** `src/lib/durable/sink.ts:362` · lens `durability` · category `claim-drift`
- **Verification** 3/5 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
sink.ts:361-363 — " * dispatch note failed because a warehouse in another region was busy. If the append never lands, the ticket\n * survives only in memory and a restart loses it -- which is bounded, visible\n * (the ticket's `durability`) and far better than refusing the action."

sink.ts:370 — `if (added.length === 0 || !durabilityEnabled()) return Promise.resolve();`

sink.ts:419-421 — the terminal catch:
```
      } catch {
        // Bounded and visible: the ticket lives in memory and a restart loses
        // it. Failing the storekeeper's action instead would be worse.
      }
```

But `grep -n "durability" src/lib/dispatch/ticket.ts` returns ZERO hits. `interface DispatchTicket` (ticket.ts:166-210) has ticketId, districtCode, orderId, state, from, to, drugId, drugName, unit, plannedUnits, dispatchedUnits, receivedUnits, varianceUnits, crossDistrict, admissibility, escalateTo, admissibilityNote, history, effects, createdAt, updatedAt, seq — and no durability. `grep -rn "durability" src/lib/dispatch/ src/components/DispatchTicketStrip.tsx` returns only service.ts:21 (an import) and service.ts:209 (`durability: durabilityEnabled() ? 'pending' : 'disabled'`), which is set on the StockEvent, not the ticket. There is no `markDurability` equivalent for tickets and no ticket durability anywhere in src.
```

**Failure scenario**

Start the service with `AAROGYA_NO_BQ=1` — the supported no-network mode the build and local dev use, per bq/client.ts:75-83 — or simply let the dataset be unreachable. POST /api/dispatch {districtCode, orderId, action:'approve'}. `actOnTicket` produces no stock events for approve (service.ts:298-319 pushes only projected effects, `stockEvents` stays empty), so `persistStockEvents` is never called (service.ts:369 is guarded by `stockEvents.length > 0`). `persistTicketTransitions` returns at line 370 without appending and without recording anything anywhere. The route answers 200 with a ticket whose every field is byte-identical to a ticket that IS durable. The console and the `/api/overlay` seed show an approved order; nothing on any surface says it will not survive. Restart the container and the approval — and, for a cross-district order, the `countersign` row that is the system's only answer to "who allowed this" (README.md:174) — is gone, with no prior warning. A stock event in the identical situation reports `durability:'disabled'` and the capture console renders the chip (CaptureConsole.tsx:34,497). The same silence covers `cancel` and `countersign`, the other two transitions that emit no stock event.

**Suggested fix**

Either add `durability: Durability` to `DispatchTicket`, set it in `actOnTicket` exactly as `emitStockEvent` does (service.ts:209), and have `persistTicketTransitions` re-emit the ticket on the existing ticket cursor (`nextTicketSeq` + `putTicket`) when the append settles — the SSE `ticket` frame already carries whole tickets, so the chip costs one field; or, if that is out of scope before 30 Sep, change sink.ts:362-363 and 420-421 to say the failure is silent, because as written they assert a visibility mechanism that is not in the codebase.

---

### /api/events wires its only cleanup after an await that blocks for a second or more, so a disconnect during the cold-start restore orphans the poll and heartbeat intervals for the life of the container

- **Where** `src/app/api/events/route.ts:185` · lens `durability` · category `performance`
- **Verification** 2/2 skeptics could not refute it · reporter confidence `likely`

**Evidence**

```
route.ts:83 — `await ensureRestored();` (the first statement of GET). The restore behind it is two BigQuery jobs with `deadlineMs: 30_000` (sink.ts:570 and 635); measured on the live service just now it took 1032 ms and 968 ms concurrently.

route.ts:96 — `const stream = new ReadableStream<Uint8Array>({` ... the underlying source declares `start(controller)` ONLY. There is no `cancel()`.

route.ts:142 `const poll = setInterval(..., POLL_MS)` (POLL_MS = 250, line 69) and route.ts:166 `const beat = setInterval(..., HEARTBEAT_MS)` (15_000, line 67).

route.ts:173-185 — `shutdown` clears both, and it is reached exactly one way:
```
      request.signal.addEventListener('abort', shutdown);
```
That registration happens after the await at line 83. Per the AbortSignal spec an `abort` listener added to an already-aborted signal is never invoked.

route.ts:99-106 — the other path that notices trouble sets the flag but clears nothing:
```
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
```
```

**Failure scenario**

Cold container (every deploy; also every scale-from-zero if the min-instances setting is ever not what the docs say). A judge opens /console; `useGridEvents` seeds and then constructs the EventSource (useGridEvents.ts:146). The GET blocks in `ensureRestored()`. The judge reloads — a normal thing to do when a page seems slow — and the browser aborts the in-flight stream request. `request.signal` aborts while execution is still inside line 83, so when `start()` finally runs at line 96 the listener added at line 185 attaches to a signal that already fired and `shutdown` never runs. `poll` and `beat` are left scheduled with no owner: 4 timer wakeups per second, forever, per abandoned connection, on a `min-instances=1` container that lives for days (the live instance has been up since 2026-09-12T19:58Z). `closed` is never set on this path either, so each wakeup also runs `eventsSince`/`durabilitySince`/`ticketsSince` and calls `send`, which either grows an unread stream queue or throws once and sets `closed` — in neither case are the timers cleared. Repeat per reload during any cold start.

**Suggested fix**

Three one-liners, all inside the same file: (1) at the top of `start(controller)` add `if (request.signal.aborted) { shutdown(); return; }` (hoisting `shutdown` above the intervals); (2) add `cancel() { shutdown(); }` to the underlying source object at line 96, so a consumer that goes away without an abort also cleans up; (3) call `shutdown()` rather than `closed = true` in `send`'s catch at line 104.

---

### `ladder[].seriesSkipped` is published as 0 for every non-headline history window; the true values are 4 and 13

- **Where** `scripts/build-federated.mts:466` · lens `federated` · category `correctness`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
The counter is only incremented on the headline rung (build-federated.mts:466):

    if (blockScores.some((x) => x === null) || dailyScores.some((x) => x === null)) {
        if (J === HEADLINE_J) skipped += 1;
        continue;
    }

but it is written into EVERY ladder row (build-federated.mts:505): `seriesSkipped: skipped,`. `skipped` is declared at :391 inside the `for (const J of LADDER)` loop, so it resets to 0 and stays 0 for J=60/90/120.

Shipped consequence — the identity scored + skipped = total series (6016, from summed `scope.series`) holds only at J=30:
  J=30  scored 5969 skipped 47  sum 6016  OK
  J=60  scored 6012 skipped  0  sum 6012  4 series unaccounted for
  J=90  scored 6016 skipped  0  sum 6016  OK
  J=120 scored 6003 skipped  0  sum 6003  13 series unaccounted for

My independent re-run of the same protocol counts exactly 4 skipped at J=60 and 13 at J=120.
```

**Failure scenario**

A reviewer auditing `/api/federated` adds `seriesScored + seriesSkipped` per rung and compares it with the 6,016 series the same file says exist (`shared.rowsRetainedInStates` 1,082,880 / `window.days` 180). Two of the four rungs come up short, with no explanation in the payload. The field is documented as "were dropped from every arm alike for having no demand in the fit window or none in the evaluation window" — so a published 0 is an affirmative statement that nothing was dropped, and it is false for two of the four rungs.

**Suggested fix**

Drop the `if (J === HEADLINE_J)` condition — `skipped` already resets per rung, so `skipped += 1;` alone gives the correct per-rung count and leaves the J=30 value (47) unchanged. Then add an assertion in the build that `seriesScored + seriesSkipped` equals the total series count on every rung, so the identity is enforced rather than left for a reader to discover.

---

### `indexSe` is the standard error of a contrast the node never publishes; measured 15-25% too large, which biases every published pooling weight low

- **Where** `src/lib/federated/node.ts:213` · lens `federated` · category `correctness`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
node.ts:209-213 computes the variance of log(mean_m / mean_rest) and then rescales it by the published multiplier:

    const vMonth = (sd(vs) / Math.sqrt(vs.length) / mMean) ** 2;
    const vRest  = (sd(rest) / Math.sqrt(rest.length) / rMeanRest) ** 2;
    // Published on the natural scale, as a standard error OF the multiplier,
    // so that se / index recovers the log-scale error the pool works in.
    return round(index[m] * Math.sqrt(vMonth + vRest), 8);

The variance formula is correct for R_m = mean_m/mean_rest. But `index[m]` is not R_m: `fitSeasonalIndex` (seasonality.ts:110-117) computes mean_m/overallMean (overallMean CONTAINS month m, so the two sides are positively correlated), shrinks it toward 1 by `weight = Math.min(1, counts[i]/minObs)`, then `normalise`s across all 12 buckets. Measured on the shipped fit for PARA-500-TAB in state 08:

  m  n_m   R_m      raw=m/overall  index[m]   index[m]/R_m
  3  28   0.3883      0.4291        0.4675      1.204
  4  31   0.5074      0.5544        0.5547      1.093
  5  30   0.7403      0.7738        0.7743      1.046
  6  31   1.2388      1.1899        1.1906      0.961
  7  31   1.6172      1.4618        1.4626      0.904
  8  29   1.7552      1.5648        1.5469      0.881

Empirical calibration (all 16 states share one true curve by construction, so their spread IS the sampling sd of index[m]), mean published log-scale se vs empirical sd across the 16 nodes:
  Apr 0.05393 vs 0.04686 (x1.151)  May x1.157  Jun x1.147  Jul x1.241  Aug x1.157  Sep x1.249
```

**Failure scenario**

Every se is ~15-25% too large, so se^2 is 1.3-1.6x too large. `poolNodes` uses it twice: it inflates the inverse-variance weights in Q (pool.ts:105-112), which depresses tau^2 = max(0,(Q-df)/C), and it appears again in B = tau^2/(tau^2 + se^2) (pool.ts:135-138). Both push the same way. The number this lands on is published and rendered: `federated-summary.json.nodes[].ownWeight` drives the panel's "Keeps own" column (FederatedPanel.tsx:262) and README.md:341 ("across the sixteen, between **8.8% and 13.3%**"). A correctly specified se would move that range up. The headline 38.4% is unaffected because at J=30 every indexSe is null.

**Suggested fix**

Either publish the statistic the error bar describes, or the error bar of the statistic published. The second is a two-line change: apply the delta method to what `fitSeasonalIndex` actually returns — d log(index_m)/d log(mean_m) = (1 - f*raw) * (w*raw)/(w*raw + 1 - w), with f = n_m/N and w = min(1, n_m/minObs) — and multiply `Math.sqrt(vMonth + vRest)` by that factor. Both quantities are already in scope at node.ts:202-213 (`vs.length`, `fitDays`, `minObs`). Keep MIN_CONTRAST_DAYS as is; that part is right and well argued.

---

### `vacancyRateSe` is the standard error of a different estimator than the `vacancyRate` it is published beside

- **Where** `src/lib/federated/node.ts:262` · lens `federated` · category `correctness`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
node.ts:250 and :257-263:

    const rate = 1 - inPosition / sanctioned;            // ratio of SUMS
    ...
    const perFacility = records.map((r) => 1 - r.inPosition / r.sanctioned);
    workforce.push({ ..., vacancyRate: round(rate),
      vacancyRateSe: perFacility.length >= 2 ? round(sd(perFacility) / Math.sqrt(perFacility.length), 8) : null });

`vacancyRate` is the size-weighted aggregate; `vacancyRateSe` is the standard error of the UNWEIGHTED mean of facility rates. Recomputed over all 160 state-cadre pairs from src/data/districts/*.json:
  - 21 of 160 pairs have the two point estimates more than 5 points apart. Worst: state 23 `specialist` published 0.45283 vs unweighted mean 0.58095 (12.8 points); 27/specialist 0.4194 vs 0.5400; 24/specialist 0.4322 vs 0.5519; 33/specialist 0.3929 vs 0.5083; 18/lab_technician 0.2911 vs 0.4043.
  - Against the correct linearised SE of the ratio estimator, the published se is inflated by a median factor of 1.117 and up to 3.291 (state 36, `staff_nurse`). Example, state 08 `staff_nurse`: published se 0.01929236, ratio-estimator se 0.01178315 (x1.637).
```

**Failure scenario**

`poolCadre` (build-federated.mts:235-243) feeds `{ value: w.vacancyRate, se: w.vacancyRateSe }` into `poolNodes` as a matched pair, and DerSimonian-Laird's whole arithmetic assumes se_i is the sampling error OF y_i. For `specialist` — the cadre with the largest published tau^2 (0.01006202) and I^2 (0.8286) — the error bars describe a rate up to 12.8 points away from the one being pooled, and are up to 3.3x too wide. The resulting `workforce[].prior` (0.489746 for specialist), `tauSquared`, `iSquared` and the per-state `shrunk[].ownWeight` in `_national.json` are all published at /api/federated and carried into `federated-summary.json.workforce`. The docstring at node.ts:251-256 correctly argues for clustering at the facility; the implementation just clusters the wrong estimator.

**Suggested fix**

Keep `vacancyRate` as the ratio of sums (it is the right policy quantity) and publish the linearised ratio standard error for it: with e_i = (sanctioned_i - inPosition_i) - rate * sanctioned_i and mbar = sanctioned/n, se = sqrt(sum(e_i^2)/(n-1)/n) / mbar. This is still clustered at the facility — it is the same cluster, correctly linearised — and every term is already in `records` at node.ts:257.

---

### The backtest's Croston comparator is not the mean path the risk engine simulates, so the per-class winner was decided on a model production does not run

- **Where** `scripts/backtest-forecast.mts:352` · lens `forecast` · category `claim-drift`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `likely`

**Evidence**

```
docs/forecast-backtest.md:11 and scripts/backtest-forecast.mts:588 both publish:

  | comparator | Croston/SBA/TSB **as shipped** - `relativeMultipliers` and all, the same code the fallback path runs |

and backtest-forecast.mts:219-221 says "Croston exactly as production runs it". But both scoring loops use fit.meanDemand:

  backtest-forecast.mts:227   const eCr = fit.meanDemand * mult[d] - actual[d];
  backtest-forecast.mts:352   const eCr = m.fit.meanDemand * mult[d] - m.truth[d];   // Phase B, the deciding one

The shipped risk engine never uses fit.meanDemand for the distribution it draws from. src/lib/forecast/risk.ts:150-160 uses fit.demandProbability * fit.meanSize * mult[d], and those are different numbers:
  - sba (intermittent, erratic): croston.ts:110 sets meanDemand = raw * (1 - alpha/2), while p * meanSize = raw. The engine simulates 1/0.925 = 8.1% more than the backtest scored.
  - ses (smooth): meanDemand is the EWMA level, p * meanSize is the annual mean — the discrepancy quantified in the finding above.

Measured against the simulator's true lead-time demand (probe6, Lucknow + Pune + Ernakulam, smooth/ses positions on a seasonal profile, n=232): the backtested path lands at 1.000 of truth, the path the risk engine actually draws from lands at 0.791. probe2's per-method medians of MonteCarlo/published show the sba offset independently: sba/flat 1.098, sba/summer_enteric 1.085, sba/monsoon_vector 1.082 — the 1/(1-alpha/2) deflator, visible even where seasonality cannot contribute.
```

**Failure scenario**

forecast-method.json awards the smooth class to Croston on a Phase B margin of -1.3% (timesfmMase 0.7611 vs crostonMase 0.7711) — inside the 5% WIN_MARGIN, so it is a tie that goes to the incumbent. That 0.7711 was earned by fit.meanDemand * mult[d], a path 0.791/1.000 more accurate on seasonal smooth positions than the one the engine actually simulates. Had the comparator been the shipped simulation's own mean, Croston's MASE would have been worse and the smooth class — 26,789 of the 74,568 scored positions, and 34.4% of the network — could have gone to TimesFM instead. The published sentence "A demand class is served by TimesFM only if it beat Croston by more than 5% MASE on this holdout" is therefore resting on a comparator that is labelled "as shipped" but is not.

**Suggested fix**

Score the Croston arm from the same construction the risk engine draws from, so the table measures the incumbent that actually ships (fixing the finding above collapses the two into one number and makes the "as shipped" label true). Until then, soften docs/forecast-backtest.md:11 and backtest-forecast.mts:588 to say the comparator is the published mean path (risk.forecastDailyDemand), not the Monte Carlo's, and re-run the backtest after the risk fix lands since the per-class winners may move.

---

### Quota fallback sends the Gemini-3 `thinkingLevel` to the Gemini-2.5 fallback model, which the file itself says is a 400

- **Where** `src/lib/ai/grid-agent.ts:527` · lens `intent` · category `correctness`
- **Verification** 4/6 skeptics could not refute it · reporter confidence `likely`

**Evidence**

```
The docstring on `thinkingFor` (lines 94-97): "Two parameter names, because two model generations are supported and they do not share one: Gemini 3.x takes `thinkingLevel`, 2.5 takes a token `thinkingBudget`. Sending the wrong one is a 400, so the family is decided from the active model id rather than from a guess."

But the request object is built ONCE per turn, before the retry loop:

```
519:    const request = {
520:      model: opts.model,
...
527:        thinkingConfig: thinkingFor(activeModel),
```

and the retry only overrides `model`, never `config`:

```
540:        response = await ai.models.generateContent({ ...request, model: activeModel });
...
554:        if (isDailyQuota(e) && activeModel !== fallbackModel) {
556:          stripThoughtSignatures(contents);
557:          activeModel = fallbackModel;
558:          continue;
```

So on the fallback attempt `config.thinkingConfig` still holds `{ thinkingLevel: MINIMAL }` computed for the PREVIOUS model's family. `src/lib/ai/client.ts:40` sets `DEFAULT_FAST_MODEL_FALLBACK = 'gemini-2.5-flash'`, and a live probe of the deployment returned `"model": "gemini-3.5-flash"` — so the deployed configuration crosses the family boundary on exactly this path.
```

**Failure scenario**

The free-tier daily allowance for gemini-3.5-flash runs out mid-demo. `isDailyQuota(e)` is true, `activeModel` flips to gemini-2.5-flash, and the loop re-issues the same `request` whose config still carries `thinkingLevel`. Per the file's own comment that is a 400 INVALID_ARGUMENT. That error is not `PerDay` (so `isDailyQuota` is false) and has no `RESOURCE_EXHAUSTED`/429 (so `rateLimitDelayMs` returns null at line 561), therefore `throw e` — the whole agent run fails and /api/ask returns its generic failure message. The fallback that exists specifically to stop "a demo that dies on stage" is the thing that kills it. Note the author already handled the OTHER cross-family hazard on this same path (`stripThoughtSignatures`), so the omission is asymmetric rather than intentional.

**Suggested fix**

Recompute the thinking config at send time rather than at turn-build time, e.g. `generateContent({ ...request, model: activeModel, config: { ...request.config, thinkingConfig: thinkingFor(activeModel) } })`, or move the `const request = {...}` construction inside the attempt loop.

---

### Population renders as 37.22 Cr on the landing page and 37.21 Cr on the console and the deck

- **Where** `src/lib/format.ts:64` · lens `judge-path` · category `claim-drift`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
One value, three surfaces, two answers. Snapshot: `totals.populationCovered = 372164015` (= 37.2164 Cr).

  live `/`        -> "37.22 Cr"  "people in catchment" and "people covered"  (src/app/page.tsx:205, :440 via `population()`)
  live `/console` -> "37.21 Cr"  "Population covered"                        (src/components/NationalConsole.tsx:215 via `compactCount()`)
  docs/pitch-deck.html:367 -> `<div class="v tnum">37.21 Cr</div><div class="k">people in catchment</div>`

The deck and the console use the same label as the landing page and disagree with it. The two formatters sit eleven lines apart:

  src/lib/format.ts:56  if (abs >= 1_00_00_000) return truncateTo(value, 1_00_00_000, 2) + ' Cr';   // -> 37.21
  src/lib/format.ts:64  if (value >= 1_00_00_000) return (value / 1_00_00_000).toFixed(2) + ' Cr';  // -> 37.22

And format.ts:31-43 states the policy that `population()` breaks: "A compact display is a promise that the reader is losing precision, not gaining magnitude. Truncating keeps the abbreviation strictly a floor: … can never be accused of inflating the case."

scripts/check-claims.mts carries 119 guarded claims — 79 in README.md, 24 in docs/pitch-deck.html, 8 in DEFENSE.md, 7 in SUBMISSION.md, and exactly one each in src/app/page.tsx and src/components/FederatedPanel.tsx. None of them is the population figure, and none cross-checks two rendered surfaces against each other.

(For completeness: every other headline figure I re-derived from the snapshot matches all surfaces exactly — ₹1.92 Cr, ₹29.84 L, ₹70.87 L, ₹3.84 L, −₹26 L, ₹4.79, ₹41.04 L, 5,42,644, 5,578, 2,078, 615, 1,579, 3,008, 2,824, 81,104, 4,683, 5,030, ₹14.52 L. This is the only one that drifts.)
```

**Failure scenario**

A judge reads "37.22 Cr people in catchment" in the hero, clicks "Open the live console →", and the KPI strip on the very next screen says "POPULATION COVERED 37.21 Cr" — visible in the same ten seconds, in the largest type on the page. If they then open the deck, slide figure says 37.21 Cr against the identical label "people in catchment". The gap is 100,000 people and materially nothing, but the judge does not know that yet: they know that the first number they happened to check twice came back two different ways, on a project whose closing line is "Drill into any district, follow any corridor, and check the arithmetic." The direction makes it worse — the landing page is the one rounding up, which is precisely the inflation format.ts:31-43 says the project set out to prevent.

**Suggested fix**

Have src/app/page.tsx:205 and :440 use `compactCount()` like the console and the deck, deleting `population()` or making it truncate. Then add one entry to scripts/check-claims.mts binding the rendered population string to `totals.populationCovered`, so the guard covers the figure rather than only the surfaces around it.

---

### 116 of the 128 district pages cannot be reached without a mouse — the map bubbles are click-only circles

- **Where** `src/components/IndiaMap.tsx:1296` · lens `judge-path` · category `ux`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
The district bubble is a bare SVG circle with a click handler and nothing else:

  src/components/IndiaMap.tsx:1296-1308
    <circle
      cx={xy[0]} cy={xy[1]} r={r}
      fill={color} …
      className="cursor-pointer"
      onMouseEnter={() => onHover(d)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect?.(d.code)}
    />

No tabIndex, no onKeyDown, no role, no aria-label, no <title>. And the enclosing svg is IndiaMap.tsx:721 `role="img"`, which removes its children from the accessibility tree entirely — so the 128 bubbles are not controls to assistive tech either. Verified live:

  circleCount: 136, sample[0]: {cls:"cursor-pointer", tabindex:null, role:null, aria:null, hasTitle:false}
  document.querySelectorAll('a[href*="/district/"]').length  ->  0
  focusableCount: 45

The full tab order on /console is: "Field capture →", 5 map metric buttons, then exactly 12 district buttons (Gumla … Gaya), then the assistant chips/textarea/language toggles, then "/api/federated" and 16 state links. Selecting a district reveals a real link (NationalConsole.tsx:355 `href={`/district/${selectedDistrict.districtCode}`}`), but selection itself is the mouse-only step for everything outside the top 12. There is no district search — the only text field on the page is the assistant textarea.
```

**Failure scenario**

A judge who navigates by keyboard, or who is presenting from a lectern with no mouse, can reach exactly 12 of 128 districts. Purnia — the district README step 3 sends them to, and the one the demo video uses — happens to be #11, so it survives; any judge who wants to check their own home district, or any of the 116 others, tabs through 45 stops and finds no way in. The same absence means /console ships zero crawlable links to 128 prerendered pages, so nothing outside the map knows they exist. On a rubric that scores accessibility and inclusion for a public-health brief aimed at ANMs with feature phones, "the national map is mouse-only" is the kind of thing a judge writes down.

**Suggested fix**

Give the district circle `tabIndex={0}`, `role="button"`, an `aria-label` naming the district and its risk, and an `onKeyDown` for Enter/Space; drop `role="img"` from the svg to a `<g role="img" aria-label=…>` around the non-interactive layers so the bubbles stay in the tree. Cheaper alternative that also fixes discoverability: render the existing "Highest-risk districts" panel as `<a href="/district/CODE">` rows and add a plain text index of all 128 districts somewhere on the page.

---

### The live landing page and the live console render the same population field as two different figures (37.22 Cr vs 37.21 Cr), and check-claims guards neither

- **Where** `C:\Users\samar\aarogya-grid\src\lib\format.ts:63` · lens `tests` · category `claim-drift`
- **Verification** 3/3 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
src/lib/format.ts:63  export function population(value: number): string { if (value >= 1_00_00_000) return (value / 1_00_00_000).toFixed(2) + ' Cr'; ...}   // ROUNDS
src/lib/format.ts:45  function truncateTo(...) { const cut = Math.trunc(scaled * factor) / factor; ...}  // TRUNCATES, used by compactCount

src/app/page.tsx:205        { v: population(f.populationCovered), l: 'people in catchment' },
src/components/NationalConsole.tsx:215  <Kpi label="Population covered" value={compactCount(t.populationCovered)} sub="modelled catchment" />
docs/pitch-deck.html:367    <div class="v tnum">37.21 Cr</div><div class="k">people in catchment</div>

src/lib/landing-figures.ts:167   populationCovered: t.populationCovered,   // same field, no transform
snapshot totals.populationCovered = 372164015

Live, just now:
  curl .../ | grep -o "37.2[0-9] Cr"        ->  4 x "37.22 Cr"
  curl .../console | grep -o "37.2[0-9] Cr" ->  1 x "37.21 Cr"

grep -n "populationCovered" scripts/check-claims.mts  ->  (no match)
```

**Failure scenario**

A judge opens https://aarogya-grid-215071922486.asia-south1.run.app/, reads "37.22 Cr — people in catchment", clicks through to /console and reads "37.21 Cr — Population covered", then opens docs/pitch-deck.html slide and reads "37.21 Cr — people in catchment" under a label identical to the landing page's. Same artefact field (372,164,015), three surfaces, two numbers. `npm test` is green throughout: check-claims.mts has 79 README claims, 24 deck claims and 8 DEFENSE claims but not one on `populationCovered`, so nothing compares the deck's hardcoded tile to the snapshot or the two renderers to each other.

**Suggested fix**

Add a check-claims entry for the deck tile, e.g. { file: 'docs/pitch-deck.html', must: '<div class="v tnum">' + compactCount(t.populationCovered) + '</div><div class="k">people in catchment</div>', why: 'catchment population' }, and make the landing page use the same formatter as the console (compactCount) so the identical label cannot render two values. If the rounding difference is intentional, the two labels must differ.

---

## LOW (14)

### README says the fallback model covers 'rate-limited or unavailable'; the code falls back only on a daily-quota message

- **Where** `README.md:459` · lens `ai-integration` · category `claim-drift`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
README.md:457-459: "Models are configuration, not constants: `GEMINI_MODEL` for the agent, `GEMINI_MODEL_FAST` for capture and for the agent's retry when the primary is rate-limited or unavailable."

The code falls back on exactly one condition. grid-agent.ts:556:
        if (isDailyQuota(e) && activeModel !== fallbackModel) {
grid-agent.ts:425-426:
function isDailyQuota(e: unknown): boolean {
  return e instanceof Error && e.message.includes('PerDay');
}

A per-minute throttle does NOT switch models — it sleeps and retries the SAME model, grid-agent.ts:560-564 (`const waitMs = rateLimitDelayMs(e); ... await new Promise(...)`), and rateLimitDelayMs (:436-438) requires status 429 or 'RESOURCE_EXHAUSTED'. A 500/503 'unavailable' matches neither isDailyQuota nor rateLimitDelayMs and is rethrown at :568 without the fallback ever being tried.

grid-agent.ts:418-424 documents the narrow intent correctly ("True when the throttle is the DAILY cap rather than the per-minute one"), so it is the README sentence that is wrong, not the code's intent.
```

**Failure scenario**

gemini-3.5-flash returns 503 UNAVAILABLE during a demo — the most common transient failure for a hosted model. A reader of README.md:459 expects gemini-2.5-flash to take over. It is never attempted: the error matches no branch and /api/ask returns 502. The resilience story the README tells is broader than the resilience the code has, on the one subsystem a judge is most likely to stress-test.

**Suggested fix**

Either narrow the README to 'for the agent's retry when the primary's daily allowance is exhausted', or widen the code — add 503/UNAVAILABLE and a generic non-retryable upstream failure to the fallback predicate at grid-agent.ts:556, which would also make README:459 true as written.

---

### check-claims contains a hard-coded '29' claim whose stated reason does not match what it checks, duplicating a derived claim

- **Where** `scripts/check-claims.mts:1002` · lens `claims` · category `claim-drift`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
scripts/check-claims.mts:1000-1004 —
  {
    file: 'docs/pitch-deck.html',
    must: '29 cross-state corridors',
    why: 'one-large-state extrapolation, from the slow end of the measured rate',
  },

This is a typed literal in the one file whose stated rule (lines 20-22) is "never publish a figure that is not read from a re-run script or a shipped payload. A claim that cannot be derived here does not belong on a surface." It passes only because `links.filter(l => l.crossState).length` currently equals 29 — which lines 845-848 already check on the same file with the derived string:
  { file: 'docs/pitch-deck.html', must: n(links.filter((l) => l.crossState).length) + ' cross-state corridors', why: 'deck scaling slide: cross-state corridors' }

The `why` is also wrong: the deck text it matches (slide 12, REACH) is "174 district-to-district corridors carry medicine in the shipped plan, 29 cross-state corridors among them" — the shipped plan, not an extrapolation. The genuine extrapolation claim is the separate `'<b>~' + roundTo(...) + ' min</b>'` claim at line 1007.
```

**Failure scenario**

If the plan's cross-state corridor count ever moves, the deck gets corrected to the new figure and this hard-coded claim fails for a reason its `why` line misdescribes, sending whoever debugs it looking for a broken extrapolation. Meanwhile it gives the file's own coverage count a claim that proves nothing the line above it does not already prove.

**Suggested fix**

Delete the duplicate claim, or if the intent was to pin a second sentence, anchor it to that sentence's surrounding words and derive the number.

---

### simulateInventory calls Date.toISOString() once per simulated day: ~29 s of the 229 s build

- **Where** `src/lib/sim/inventory.ts:268` · lens `efficiency` · category `performance`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `likely`

**Evidence**

```
src/lib/sim/inventory.ts:190-192
  function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

src/lib/sim/inventory.ts:266-268
  for (let day = 0; day < historyDays; day++) {
    const month = cursor.getUTCMonth();
    const today = isoDate(cursor);

Measured (730,000 ops over a realistic 2025-09-30 + 365-day window):
  cursor.toISOString().slice(0,10)   581 ms  (797 ns/op)
  manual getUTCFullYear/Month/Date   105 ms  (144 ns/op)
  precomputed day-string table         2 ms  (3 ns/op)

Measured simulateInventory for Patna's 1,170 positions: 638 ms total.
1,170 x 365 x 797 ns = 340 ms -> toISOString is ~53% of simulateInventory.
```

**Failure scenario**

Every build. The 365 day-strings are identical for every position in a run: build-snapshot.mts pins ASOF (line 74) and historyDays defaults to 365 (pipeline.ts:105), and buildStates passes the same pair to every simulateInventory call. The LRU replay shows 156 buildDistrictState calls x ~634 positions avg = 98,904 position-sims x 365 days = 36.1 M toISOString() calls at 797 ns = 28.8 s of pure string formatting, recomputing the same 365 strings 98,904 times. That is 12.6% of the 228.6 s recorded in national-snapshot.json.

**Suggested fix**

Hoist the day strings out of the per-position loop. A module-level Map keyed by `asOf.getTime() + ':' + historyDays` holding a `string[]` of the 365 ISO dates (and, for free, a parallel `number[]` of getUTCMonth values, which removes the second Date read at line 267). Then line 268 becomes `const today = DAYS[day];`. Roughly 8 lines; the strings are byte-identical so nothing downstream changes. Same pattern at src/lib/sim/resources.ts:99 and src/lib/sim/footfall.ts:200, though those loops are 180 days x 2,824 facilities and worth perhaps 2-3 s more.

---

### computeStockRisk copies and fully sorts 600 samples to read a single quantile: ~7 s of the build

- **Where** `src/lib/forecast/risk.ts:446` · lens `efficiency` · category `performance`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
src/lib/forecast/risk.ts:446-447
    const sorted = [...samples].sort((a, b) => a - b);
    reorderPoint = Math.ceil(quantile(sorted, serviceLevel));

and quantile (line 291-295) reads exactly one index:
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
    return sorted[idx];

Measured over Patna's 1,170 positions:
  full computeStockRisk(600)              643 ms
  MC draw only (600)                      465 ms
  copy + sort 600 samples per position      83 ms   <- 13% of computeStockRisk
  single linear pass over the same arrays    6 ms
```

**Failure scenario**

Every build and every live recompute. The sort is O(n log n) with a JS comparator (~5,500 comparator calls per position at n=600) plus a 600-element copy, and 599 of the 600 resulting order statistics are discarded. 98,904 position-sims x 71 us = 7.0 s of the 228.6 s build, plus one throwaway 600-element array allocated per position.

**Suggested fix**

Replace the sort with a quickselect (Hoare partition / nth_element) on a single copy, selecting index floor(q*(n-1)). Same value returned for the same input, O(n) expected instead of O(n log n), and it keeps `quantile`'s contract if you keep the helper and add a `selectQuantile(samples, q)` beside it. Measured headroom is the 83 ms -> ~15-20 ms per district, about 8 s over the run.

---

### check-claims.mts parses the 21.4 MB district directory three separate times

- **Where** `scripts/check-claims.mts:58` · lens `efficiency` · category `performance`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
Three independent readdirSync + readFileSync + JSON.parse walks of the same 128-file directory:
  line 58-59  (lead-time min/max)      for (const f of readdirSync(districtDir)) { const payload = JSON.parse(readFileSync(resolve(districtDir, f), 'utf8')) as {
  line 164-165 (notPermitted)          for (const f of readdirSync(districtDir)) { const payload = JSON.parse(readFileSync(resolve(districtDir, f), 'utf8')) as {
  line 240-241 (plan roll-up)            for (const f of readdirSync(districtDir)) { const payload = JSON.parse(readFileSync(resolve(districtDir, f), 'utf8')) as {
plus a fourth single-file parse at line 340 (src/data/districts/DST-10-PURNIA.json).

Measured: one full pass = 128 files, 21.4 MB, 143 ms. The two extra passes cost 216 ms.
src/data/warning-rule.json is also read twice (line 73 and line 1338).
```

**Failure scenario**

Every `npm run test:claims`, which is in the `npm test` chain and in the local gate. 64 MB of JSON parsed where 21.4 MB would do, for 216 ms. Genuinely minor in absolute terms - reported because the fix is mechanical and because it is the gate script that runs most often.

**Suggested fix**

One pass that accumulates all four quantities (leadMin/leadMax, notPermitted, the economics roll-up, gateKm) into locals, or a single `const districtPayloads = readdirSync(districtDir).map(...)` hoisted above the first use. The three loops read disjoint fields of the same object, so nothing about the assertions changes.

---

### /console ships 67 KB of snapshot fields its client tree never reads

- **Where** `src/app/console/page.tsx:21` · lens `efficiency` · category `performance`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
src/app/console/page.tsx:21
  return <NationalConsole snapshot={snapshot as unknown as NationalSnapshot} />;

The whole 349,462-byte snapshot crosses the server/client boundary. Live measurement of https://.../console: 639,743 B HTML, of which 396,456 B (62%) is the inline RSC flight payload; 90,898 B gzipped.

Grepping every snapshot field against NationalConsole.tsx + IndiaMap.tsx + FederatedPanel.tsx + GridAssistant.tsx + ui/primitives.tsx + format.ts + useGridEvents.ts, these are never referenced at runtime:
  districts[].resources (11 of 29 fields: facilitiesWithBeds, freeBeds, pressure, staffInPosition, specialistVacancyRate, opdAttendedToday, opdMeanDaily, opdTurnedAway, opdDaysClosed, facilitiesWithoutMedicalOfficer, unverifiedReportingFacilities) = 34,116 B
  crossDistrictLinks[] (fromDistrictCode, fromStateCode, toDistrictCode, toStateCode, shortfallAvertedUnits) = 24,042 B
  alerts[].facilityType = 5,125 B; districts[].netBenefitInr = 2,888 B; states[] three fields = 1,143 B
  TOTAL 67,314 B raw -> 8,245 B gzipped (measured with zlib level 6).
```

**Failure scenario**

Every /console load on a district-hospital connection. 8.2 KB gzipped of the ~326 KB total transfer (91 KB HTML + 223 KB JS + 11 KB CSS). Small, and I am reporting it as small: there is no third-party bloat to cut (the 229 KB chunk is react-dom, the 100 KB chunk is the india-outline geometry the map needs), and the 250-row alerts array is genuinely required because selecting a district filters it client-side.

**Suggested fix**

If it is worth doing at all, the smallest version is a projection in src/app/console/page.tsx that strips the five unread crossDistrictLinks fields and the eleven unread resources fields before handing the object to NationalConsole - about 6 lines, no change to the snapshot artefact itself or to the district pages and check-claims that read the full file. Given 8 KB gzipped, I would not spend the risk budget on it before the deadline.

---

### `method.pooledStatistics` in the shipped prior says the seasonal index is pooled "per therapeutic group"; it is pooled per catalogue item

- **Where** `scripts/build-federated.mts:568` · lens `federated` · category `claim-drift`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
build-federated.mts:568:

    pooledStatistics: ['monthly seasonal index, per therapeutic group', 'vacancy rate, per cadre'],

The pooling function is keyed on the item (build-federated.mts:213): `function poolIndex(item: string, month: number, only: string[])` and the prior is built at :246 with `const priorSeasonality = ITEMS.map((item) => ...)`. src/data/federated/_national.json carries 47 `seasonality` entries, one per item, spanning only 17 distinct `group` values. docs/federated.md:26 says the opposite: "The fitted unit is the **item**, not the therapeutic group." types.ts:39-56 documents at length why the group was abandoned ("three groups came back WORSE than assuming no seasonality at all").
```

**Failure scenario**

A reviewer fetches `/api/federated`, reads `method.pooledStatistics`, and concludes the model is fitted at the therapeutic-group level — the exact design the project says it tried, measured as broken, and replaced. They then either (a) discount the `perGroup` table as circular, or (b) ask in the Q&A why the artefact and `docs/federated.md` disagree about the unit of the model. This is the one modelling decision the submission most loudly claims to have measured rather than assumed, and the machine-readable record of it names the superseded version.

**Suggested fix**

`pooledStatistics: ['monthly seasonal index, per catalogue item', 'vacancy rate, per cadre']`, and derive the count from the data it describes so it cannot go stale again (e.g. `'monthly seasonal index, per catalogue item (' + ITEMS.length + ')'`).

---

### docs/federated.md presents one state's retained weight as the figure for a newcomer generally

- **Where** `scripts/build-federated.mts:812` · lens `federated` · category `claim-drift`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
build-federated.mts:811-814 interpolates:

    By ${LADDER[1]} days it keeps
    ${pctS(perState.find((p) => p.historyDays === LADDER[1])!.meanOwnWeight)} of its own estimate on the
    months it has evidence for, and by ${LADDER[LADDER.length - 1]} days
    ${pctS(perState.find((p) => p.historyDays === LADDER[LADDER.length - 1])!.meanOwnWeight)}.

`perState` holds 64 rows (16 states x 4 rungs, pushed at :489), so `.find` returns the first state in `STATES` order — Rajasthan — not an average. Rendered in docs/federated.md:112-115 as "By 60 days it keeps 8.1% of its own estimate ... and by 120 days 10.9%". From `_national.json.evaluation.perState`:
  J=60  RJ 0.0808   cross-state mean 0.0733   range 0.0514 - 0.0917
  J=120 RJ 0.1091   cross-state mean 0.1014   range 0.0720 - 0.1215
```

**Failure scenario**

A reader takes "By 60 days it keeps 8.1%" as the behaviour of a newcomer and finds, on opening the `perState` array in the same repository, fifteen other states ranging from 5.1% to 9.2% with a mean of 7.3%. The quoted figure is the 3rd-highest of the sixteen, so the sentence rounds in the flattering direction. It is small, but `docs/federated.md` is not covered by `check-claims.mts` (which only pins README/SUBMISSION/DEFENSE against `federated-summary.json`), so nothing catches it.

**Suggested fix**

Average across the sixteen rather than taking the first: `const ownWeightAt = (J: number) => { const rows = perState.filter((p) => p.historyDays === J); return rows.reduce((a, p) => a + p.meanOwnWeight, 0) / rows.length; };` and use `pctS(ownWeightAt(LADDER[1]))`. Quoting the range alongside the mean would be stronger still, since the spread is itself the interesting fact.

---

### IndiaMap docstring's "State mean risk spans 11.2 to 19.6" is stale; the shipped snapshot spans 6.9 to 23.1

- **Where** `src/components/IndiaMap.tsx:45` · lens `intent` · category `claim-drift`
- **Verification** 2/2 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
IndiaMap.tsx:45-48:

```
 * It also bought us very little. State mean risk spans 11.2 to 19.6 across the
 * whole country, rendered at 0.16 fill opacity, so the layer was visually an
 * undifferentiated wash.
```

Computed from src/data/national-snapshot.json as shipped: population-weighted state mean risk runs 6.89 (Andhra Pradesh) to 23.12 (Bihar); the unweighted state mean runs 6.93 to 22.60. Neither matches 11.2–19.6. The figure predates the 12 Sep re-score (the memory index records that TimesFM and the per-class method gate moved the figures twice that day).
```

**Failure scenario**

The sentence is present-tense and is the quantitative justification offered for removing the state polygon layer ("an undifferentiated wash"). A reviewer who recomputes it from national-snapshot.json gets a 3.4x span rather than a 1.75x one, and the stated reason no longer holds on its own numbers — even though the other, stronger reason given in the same block (the boundary file was pre-2011 vintage, no Telangana) is untouched and sufficient.

**Suggested fix**

Re-derive the span from the current snapshot, or drop the number and lean on the boundary-vintage argument, which does not decay when the model is re-scored.

---

### redistribute.ts header cites `evaluatePlan` as the mechanism for comparing against a min-cost-flow solver; no such symbol exists anywhere in the repo

- **Where** `src/lib/optimize/redistribute.ts:39` · lens `intent` · category `claim-drift`
- **Verification** 2/2 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
redistribute.ts:36-40:

```
 * Greedy is not optimal, and we do not claim it is. It is chosen because it is
 * explainable ... `evaluatePlan` reports the objective value so a
 * min-cost-flow solver can be dropped in later and compared directly.
```

`grep -rn "evaluatePlan" . --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git` returns exactly one hit: that comment line. The objective value IS available — `RedistributionPlan.netBenefitInr` is documented at line 512 as "Objective value: total benefit minus total cost, INR" — but it is reached through a field, not through the named function.
```

**Failure scenario**

A reviewer testing the "a min-cost-flow solver can be dropped in and compared directly" claim greps for `evaluatePlan`, finds nothing, and concludes the comparison story is aspirational. The claim is in fact true via `netBenefitInr`, so the only thing the phantom name costs is credibility.

**Suggested fix**

Point the sentence at what exists: `planRedistribution` returns `netBenefitInr` (and `grossBenefitInr` / `totalCostInr`) as the objective value.

---

### grid-tools.ts claims "EVERY RESULT IS STAMPED ... Each payload carries `asOf` and `builtAt`"; three of the twelve tools carry neither or only one

- **Where** `src/lib/ai/grid-tools.ts:62` · lens `intent` · category `claim-drift`
- **Verification** 2/2 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
grid-tools.ts:60-64:

```
 * EVERY RESULT IS STAMPED
 * -----------------------
 * Each payload carries `asOf` and `builtAt`. An answer about a stock position
 * is worthless without knowing the position is from last night's batch, and the
 * only way the model can say so is if the tool tells it every time.
```

Six tools spread `...stamp(detail)` (lines 758, 895, 960, 1104, 1177, 1269); three read `asOf`/`builtAt` off the snapshot directly (lines 715-716, 845-846, 1042-1043). The remaining three do not:
  - `resolve_district`, data block at line 662: keys are `query, district, state, matchConfidence, needsConfirmation, alternatives, note` — no stamp.
  - `drug_reference`, data block at line 1321: keys are `query, drug, strength, form, unit, criticality, onNlem, coldChain, shelfLifeMonths, indicativeUnitCostInr, therapeuticGroup, seasonality, matchConfidence, matchedVia, alternatives, note` — no stamp.
  - `early_warnings`, line 1392: `asOf: feed.dataThrough` only, no `builtAt`.
```

**Failure scenario**

The model answers "Anti-Snake Venom is a Vital cold-chain item costing about Rs X" from `drug_reference`, or reports an outbreak signal from `early_warnings`, with no build stamp in the payload to quote. The stated remedy — "the only way the model can say so is if the tool tells it every time" — is unavailable for those calls. The three unstamped tools are catalogue/resolution/feed lookups rather than stock positions, so the practical exposure is small; the overclaim is in the word "every".

**Suggested fix**

Either stamp the three (the catalogue and the early-warning feed both have a build date available) or narrow the docstring to "every payload derived from a district or national build".

---

### The "100 KB file, 140 stock positions, 36 dispatch orders, 40 needs" illustration is stale in three files and is attributed to Lucknow, which now has 203/117/40

- **Where** `src/lib/ai/grid-tools.ts:29` · lens `intent` · category `claim-drift`
- **Verification** 2/2 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
grid-tools.ts:28-30: "What they produce is a 100 KB JSON file per district containing 140 stock positions, 36 dispatch orders and 40 needs the optimiser declined". Repeated verbatim at grid-agent.ts:25-27. GridAssistant.tsx:28-31 names the source: "They were hard-coded -- \"140 stock positions, 36 dispatch orders and 40 needs\" -- which are Lucknow's figures."

Measured across all 128 shipped payloads: file size median 136 KB (range 108-466 KB); positions median 62, mean 80.3 (only 19 of 128 districts reach 140); orders median 36 (matches); unserved rows median 40 (matches — it is capped at `MAX_UNSERVED_ROWS = 40`, district-detail.ts:435). src/data/districts/DST-09-LUCKNOW.json is 361 KB with 203 positions, 117 orders and 40 unserved rows, so the figures attributed to Lucknow are not Lucknow's.
```

**Failure scenario**

A reviewer opens src/data/districts/DST-09-LUCKNOW.json to see the artefact the agent's rationale is built around, finds 361 KB and 203 positions against a comment promising 100 KB and 140, and has no way to tell whether the number is stale or the file is the wrong one. GridAssistant.tsx already fixed the user-visible version of this bug by passing the counts as props; the prose explaining the fix kept the wrong numbers.

**Suggested fix**

Quote the median or a range derived from the shipped payloads (or drop the specific counts, since the argument — "the most valuable output is a table no DHO will read" — does not depend on them), and correct GridAssistant.tsx:29-31 so it does not attribute figures to Lucknow that Lucknow no longer has.

---

### `anyInitialSurplus` reads the cross-district shared capacity map, so a need whose stock a neighbouring district already took is published as "the stock does not exist"

- **Where** `C:/Users/samar/aarogya-grid/src/lib/optimize/redistribute.ts:704` · lens `optimiser` · category `claim-drift`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `likely`

**Evidence**

```
redistribute.ts:704:
  const anyInitialSurplus = contexts.some((c) => (capacity.get(capKey(c)) ?? 0) > 0);

`capacity` is `state.capacity` (line 657), lazily seeded at line 661 only `if (!capacity.has(k))`. scripts/build-snapshot.mts:278 creates ONE `nationalPlannerState` and line 408 passes it to all 128 district plans, so by the time district B is planned the capacities of the neighbours it shares with district A have already been decremented — and are never re-seeded. "Initial" therefore means "at the start of this district's pass", not "before anything was planned".

The comment immediately above (lines 700-703) reasons about exactly this hazard and fixes only the cross-DRUG half: "With state shared across drugs, [...capacity.values()] would answer 'did anything, anywhere, have surplus of any drug'". The cross-DISTRICT half is left, and it produces the inverse of the error the comment describes.

The flag is the last rung of the ladder at lines 891-893: `: anyInitialSurplus ? 'donor_stock_committed' : 'no_surplus'`. The published gloss of the losing branch is src/components/DistrictConsole.tsx:107 "No surplus held anywhere in the district" and src/lib/ai/grid-tools.ts:432 "Nobody else in the district holds this item above their own reorder point. The stock does not exist here."
```

**Failure scenario**

District A is planned first and its cluster drains every facility's surplus of, say, anti-snake venom, including the shared neighbour N. When N's own turn comes, every capacity entry for that drug in N's cluster is 0, so anyInitialSurplus is false and N's unmet venom need is filed as `no_surplus`. The console and the AI tool then tell a district officer the stock does not exist, when in fact it existed this morning and a district planned ten rows earlier in the table took it — the two diagnoses the taxonomy at lines 397-402 exists to keep apart ("one needs procurement, the other needs a better allocation"). Nationally 9 rows carry `no_surplus` (against 13 `donor_stock_committed`), so the blast radius is at most those 9; I could not confirm from the artefacts alone which of the 9 are genuine, because the pre-plan capacity is not serialised.

**Suggested fix**

Snapshot the untouched surplus rather than reading the running map: `const anyInitialSurplus = contexts.some((c) => donatableUnits(c) > 0);` at line 704. donatableUnits is a pure function of the context (line 302) and is already exported, so this costs nothing and makes the flag mean what its two consumers say it means. The cross-drug property the comment defends is preserved, because it is still scoped to `contexts`.

---

### test-alerts: the "green-panel bug" check is a tautology — it asserts the exact predicate it filtered on

- **Where** `C:\Users\samar\aarogya-grid\scripts\test-alerts.mts:147` · lens `tests` · category `test-quality`
- **Verification** 1/1 skeptics could not refute it · reporter confidence `certain`

**Evidence**

```
lines 143-151:
  const onBoard = new Set(snapshot.alerts.map((a) => a.districtCode));
  const severeButUnlisted = snapshot.districts.filter(
    (d) => d.criticalPositions + d.highPositions > 0 && !onBoard.has(d.districtCode),
  );
  check(
    'every district still reports its own severe counts, listed or not',
    severeButUnlisted.every((d) => d.criticalPositions + d.highPositions > 0),
    severeButUnlisted.length + ' districts hold severe positions with no row on the board',
  );

The array is built by filtering on `d.criticalPositions + d.highPositions > 0`; `.every()` then re-asserts it. True by construction, and also vacuously true on an empty array.

Two more in the same file:
  line 123  const boardTiers = totals.byTier.filter((r) => r.critical + r.high > 0).map((r) => r.tier);
  line 124  check('byTier reports every tier that has a severe position', boardTiers.every((t) => typeof t === 'string'), ...)
  line 129  check('byTier reaches tiers the truncated board cannot', boardTiers.length >= tiersOnBoard.size, ...)

Measured against the shipped snapshot: severeButUnlisted = 24, boardTiers.length = 4, tiersOnBoard.size = 4.
```

**Failure scenario**

The header comment (lines 136-142) says this section guards the bug where "a district holding 21-41 critical positions rendered the green 'no position reached the threshold' panel". Delete `criticalPositions` and `highPositions` from the per-district snapshot rows entirely and `severeButUnlisted` becomes [], `.every()` returns true, and the check prints PASS with the detail "0 districts hold severe positions with no row on the board" — which reads like good news. The console's green-panel branch is now reading undefined for all 24 affected districts and the test that exists to prevent exactly that says PASS. Separately, line 129's name claims byTier reaches tiers the board cannot, but 4 >= 4 is satisfied by equality: byTier currently reaches no tier the board does not already carry, so a check printing PASS is asserting something the data does not support.

**Suggested fix**

Assert the property the console actually branches on, against the district rows rather than against the filtered list: `check('the console can tell a quiet district from an unlisted one', snapshot.districts.every((d) => typeof d.criticalPositions === 'number' && typeof d.highPositions === 'number') && severeButUnlisted.length > 0, ...)`. Replace line 124 with a comparison to the tiers actually present in the population, and make line 129 strict (`>`) or rename it to what it measures.

---

## UNVERIFIED — the rate limit stopped their skeptics

These are first-pass reports that no skeptic checked. Historically about a quarter of
first-pass findings in this audit were refuted on contact, so treat each as a lead, not a defect.

- **[high]** test-footfall has no positive control: both failure modes its own docblock names leave all five censoring checks green — `C:\Users\samar\aarogya-grid\scripts\test-footfall.mts:103` (lens `tests`, reporter confidence `certain`)
- **[high]** 12 published surge signals carry observedValue 0 against expectedUpperBound 0 under a "Rising consumption" label — `src/data/early-warnings.json:1` (lens `data-integrity`, reporter confidence `certain`)
- **[medium]** thinkingFor has no safe default: any model outside /gemini-3/ is sent thinkingBudget: 0, which gemini-2.5-pro rejects — `src/lib/ai/grid-agent.ts:117` (lens `ai-integration`, reporter confidence `likely`)
- **[medium]** test-surge: the whole outbreak-scenario section uses >= and <=, so a surge that does nothing passes green — `C:\Users\samar\aarogya-grid\scripts\test-surge.mts:312` (lens `tests`, reporter confidence `certain`)
- **[medium]** verify-batch-bounds passes if the planner produces zero orders, and one of its checks prints a failure without failing — `C:\Users\samar\aarogya-grid\scripts\verify-batch-bounds.mts:74` (lens `tests`, reporter confidence `certain`)
- **[medium]** The assistant's offline guarantees — no identifier reaches the model, every number is byte-identical to the payload — are the largest suite in the repo and are not in `npm test` — `C:\Users\samar\aarogya-grid\package.json:11` (lens `tests`, reporter confidence `certain`)
- **[medium]** exceedanceRatio is not observedValue / expectedUpperBound for 21 of 297 signals in the interop feed — `src/lib/surge/warnings.ts:103` (lens `data-integrity`, reporter confidence `certain`)
- **[low]** test-capture's schema needle collides with the JSON Schema `items` keyword, so the assertion survives the property being renamed — `C:\Users\samar\aarogya-grid\scripts\test-capture.mts:36` (lens `tests`, reporter confidence `certain`)
- **[low]** verify-cross-district and verify-guardrails sample the identical three districts, so running both covers 3 of 128, not 6 — `C:\Users\samar\aarogya-grid\scripts\verify-guardrails.mts:64` (lens `tests`, reporter confidence `certain`)
- **[low]** The pitch deck says 37.21 Cr people in catchment; the live site says 37.22 Cr from the same snapshot total — `docs/pitch-deck.html:367` (lens `data-integrity`, reporter confidence `certain`)
- **[low]** forecast-cache.json ships 54 inverted 90% prediction intervals (lower bound above upper bound) — `src/data/forecast-cache.json:1` (lens `data-integrity`, reporter confidence `certain`)
- **[low]** The live-loop latency figures on the README and deck have no committed artefact and no claim guard — `README.md:186` (lens `data-integrity`, reporter confidence `certain`)

## What each lens found SOUND

**security** — Prompt-injection-to-write is genuinely closed. capture/route.ts returns a DRAFT and never writes; commit/route.ts Body schema (lines 74-92) accepts only facilityId + {drugName, onHand, strengthHint} + source — no drugId and no status — and re-runs resolveDrug + the AUTO_ACCEPT (0.82) threshold + the facility formulary check server-side (lines 121-154), so a model string can never become a catalogue id. schemas.ts forces every drug field to be a natural-language name (drugNameGuess), never a code. The ask agent is read-only: grep of grid-tools.ts shows no call to recordStockEvent/actOnTicket/putTicket/persist* in any of the 12 tool bodies, and enableTools is filtered to onRequestToolNames() (ask/route.ts:122-124) so a malicious prompt cannot enable arbitrary tools; the agent loop is bounded (grid-agent.ts:79 MAX_TURNS=4, MAX_TOOL_CALLS, bounded retry loop at 538). Path traversal is closed: federated/[state]/route.ts uses dynamicParams=false + generateStaticParams over STATES and an explicit STATES.some(code) guard before readFile (lines 30-53); every loadDistrictDetail caller (dispatch/export:24, dispatch/service:247, grid-tools resolution) validates the code against DISTRICTS_BY_CODE or the registry before the `code + '.json'` read. BigQuery injection is closed: series.ts quoteSid (line 109-111) escapes sids that are server-derived from district/drug codes anyway; the commit/overlay write path uses tabledata.insertAll with a JSON body (sink.ts appendOnce), not SQL string concatenation; the restore SQL (sink.ts:618-629) is built from constant column/table names and an ADC-resolved projectId with no request input. Secret/stack-trace leakage is handled: ask and capture deliberately never echo upstream error messages (ask:137-173, capture:150-186, with the documented API-key-in-header incident), and backend()/the GET probes return only enums/booleans, no project id. Body-size exhaustion is handled at the edge (proxy.ts:164-168 Content-Length check against MAX_BODY_BYTES=6MB) with route-level .max() bounds as the second line; the metered write endpoints (commit's up-to-40-entry re-simulation) are correctly rate-limited. CSV export escapes RFC-4180 correctly; note it does not neutralize spreadsheet formula-injection (a cell beginning =,+,-,@ is emitted unquoted per csv.ts cell()), but every field written comes from server-side planner/catalogue data, not from anonymous input, so it is not reachable here. The unauthenticated-writes and permanent-BigQuery-log consequences are real but are the explicitly owned no-auth tradeoff (DEFENSE.md 'Owned first'; ticket.ts actor_claimed), so they are not re-litigated as findings.

**durability** — Things I specifically went after and found genuinely sound:

THE TICKET FOLD IS TOTAL FOR THE SEQUENCES THE WRITER PRODUCES. `applyTransition` (ticket.ts:374) deliberately does not re-run `assertTransition`, which looks like a hole and is not, because of fold.ts:112 `const current = byTicket.get(row.ticketId) ?? baseTicket(row)`. The one ordering ambiguity the log actually contains is real — a first action writes its `propose` and its action row with an IDENTICAL `at` (both take service.ts:269's `at`) and an identical `seq` column (sink.ts:376 writes `seq: ticket.seq` on every row of the batch), so `ORDER BY at ASC, seq ASC` (sink.ts:566) cannot separate them — but both arrival orders fold to the same ticket: action-first synthesises the base and the later propose hits the `byTicket.has` guard at fold.ts:107. A duplicate row (insertId dedup missing its window) is idempotent in state because every `TRANSITIONS[a].to` is a fixed target; it leaves a cosmetic `approved -> approved` row in history, which I did not rank. An unknown action is skipped at fold.ts:110 before it can reach `TRANSITIONS[action]`. `countersign` does not break old logs: it only adds a member to ACTIONS, and a log without countersign rows folds exactly as before.

THE READ-MODIFY-WRITE SECTIONS ARE ACTUALLY ATOMIC. I expected a TOCTOU on donor stock (two dispatches from one shelf both passing `units > donorOnHand`) and a defeated double-submit guard. Neither exists: `actOnTicket`'s only await is `loadDistrictDetail` at service.ts:252, and getTicket -> assertTransition -> currentOnHand -> resolveUnits -> recomputePosition -> applyTransition -> nextTicketSeq -> putTicket (lines 275-358) is one synchronous run, so the event loop serialises it. `recomputePosition` is `export function` (recompute.ts:109) with no awaits in the file, which is what makes this hold. `/api/commit` is the same shape. `++state().seq` needs no lock for the same reason.

THE COLD-START ORDERING IS RIGHT. My main hypothesis was that a commit could land before `hydrate()` and be erased by `s.entries = new Map()` (store.ts:264). It cannot: all five routes that read or write the overlay await `ensureRestored()` first — commit/route.ts:104, dispatch/route.ts:72 and :82, dispatch/export/route.ts:21, overlay/route.ts:46, events/route.ts:83 — and `ensureRestored` single-flights on `Symbol.for('aarogya.overlay.restore')` (sink.ts:670-680). I grepped every caller of overlayFor/overlaySnapshot/eventsSince/currentSeq to confirm there is no sixth reader that skips it.

THE THREE-CURSOR SSE DESIGN HOLDS UP. Durability and ticket frames correctly carry no `id:`, so they cannot advance a browser's Last-Event-ID past a stock event it never saw. `eventsSince`'s gap test (store.ts:419-420, `lastSeq < oldest - 1`) is off-by-one-correct at the boundary. A dropped frame cannot strand a tab: stock frames replay from Last-Event-ID; ticket frames replay because the EventSource URL's `?tickets=` param is frozen at subscribe time (useGridEvents.ts:146) and therefore always resumes from at-or-before the client's true position, and re-application is idempotent by ticketId; and `durabilityMap()` (store.ts:368) is sent on every open specifically to repair a chip whose update aged out. I also checked the restore decode for a trap I half-expected — BigQuery returning TIMESTAMP as epoch-seconds strings into `event.at`, which would both misorder `hydrate`'s sort and render as garbage — and bq/client.ts:167-172 converts TIMESTAMP to ISO before it ever reaches sink.ts:151.

One drift I noticed and deliberately did not rank: events/route.ts:110-112 says the hello frame "gives the client its cursor so a `since` of 0 does not mean replay everything ever", but useGridEvents registers listeners for open/stock/durability/ticket/refetch/error and none for `hello`. The frame's other stated job (flushing a buffering proxy) is real, so this is a stale half-sentence rather than a defect.

**intent** — Claims I checked and found the code genuinely honours:

README architectural claims specifically named in the brief —
- **Three adapter functions.** `generateNetwork` (src/lib/sim/facilities.ts:203), `simulateInventory` (src/lib/sim/inventory.ts:207), `buildResourceStates` (src/lib/sim/resources.ts:693) all exist as exported functions; the first two are called from src/lib/pipeline.ts:155 and :259. scripts/check-claims.mts:180-188 re-derives the count by regex and gates the deck's headline on it, and even guards against the retired "one file and nothing else" wording (line 1010-1014).
- **Mount-time overlay fetch plus SSE.** src/lib/hooks/useGridEvents.ts does exactly what its docstring says: `seed()` fetches `/api/overlay` with `cache: 'no-store'`, sets `seqRef`/`ticketSeqRef` from the response, and only then `void seed().then(subscribe)` opens `EventSource('/api/events?since=' + seqRef.current + '&tickets=' + ticketSeqRef.current)`. The third frame type (`durability`) is applied without moving the cursor, as documented. Both consoles call it (NationalConsole.tsx:38, DistrictConsole.tsx via `useGridEvents`).
- **Server-side drug resolution in POST /api/commit.** The Zod `Body` (src/app/api/commit/route.ts:74-92) accepts only `facilityId`, `entries[{drugName, onHand, strengthHint}]` and `source` — there is no `drugId` and no `status` field to trust. Line 127 calls `resolveDrug(entry.drugName, ...)` and line 131-133 re-applies `AUTO_ACCEPT` with the comment "the draft arrived over the wire and its status is not evidence"; line 145 re-checks the tier formulary. Exactly as advertised.
- **`--max-instances=1` load-bearing.** Referenced with a consistent rationale in six places (src/app/api/events/route.ts:58, src/lib/district-cache.ts:19, src/lib/durable/schema.ts:83, src/lib/durable/sink.ts:52 and :68, src/lib/overlay/store.ts:28, src/lib/rate-limit.ts:246); each reason is different and each is true of the code it sits in. The claimed non-existence of the Pub/Sub subscriber checks out — nothing in the repo subscribes.

Docstring claims in the twelve files that verified clean —
- IndiaMap.tsx:99-103: `RAMP_BREAKS = [6, 11, 16, 22, 30]` and `RAMP_COLORS` match `riskColor` in src/lib/format.ts:108-115 break-for-break and colour-for-colour.
- IndiaMap.tsx:15-18: the outline "reaches 37.10 N ... and 97.40 E" — computed bbox of src/data/india-outline.json is 37.096 N / 97.395 E, file size 34.4 KB against the claimed 34 KB.
- domain/resources.ts:70-72: "This table is the SINGLE definition of sanctioned beds" — `BED_NORMS` has exactly one declaration; sim/facilities.ts:121 and sim/resources.ts:174 both import it.
- sim/resources.ts:66-71: vacancy and attendance really do run off different seed streams and attendance really does mix in the date (`hashSeed(seed, facility.id, 'posts')` at line 392 vs `hashSeed(seed, facility.id, 'attendance', isoDate(asOf))` at line 393). "largest establishment is 90 posts" matches `SANCTIONED_POSTS.DH.staff_nurse = 90`.
- redistribute.ts:231-235: `coverFloorDays { V: 21, E: 14, D: 7 }` described as "the simulator's own safety days" matches sim/inventory.ts:228 `drug.ved === 'V' ? 21 : drug.ved === 'E' ? 14 : 7` exactly.
- redistribute.ts:511-513 "`unservedReceivers` ... Equals `unserved.length`" holds after the ride-along pass rescues needs (line 1665-1669 filters `merged.unserved` and line 1683 re-derives the count).
- DistrictConsole.tsx:109-110: the "150 km road cap" / "60 km cold-box cap" labels match `DEFAULTS.maxDistanceKm = 150` / `coldChainMaxDistanceKm = 60`; nothing in src or scripts overrides them for the shipped build.
- DistrictConsole.tsx:38-49: the documented panel order (plan economics → dispatch orders → positions → censored demand → unserved → beds/workforce → roster) is the render order (sections at 319, 432, 548, ForecastPanel 739, 742, ResourcePanel 870, 873).
- grid-agent.ts "twelve tools" (line 89) matches the registry; MAX_TURNS = 4 with tools withdrawn on the last turn (`turn < MAX_TURNS - 1`, line 517) is implemented as described; the measured latency figures the README quotes (median 5.1 s, slowest 11.2 s, ten tool calls) match docs/assistant-latency.json exactly (medianMs 5107, slowestMs 11243, toolCalls 10).
- grid-tools.ts "NO IDENTIFIER EVER REACHES THE MODEL": I read every `data:` block. The only id-shaped keys emitted are batch numbers (`batchNo`, line 351), which are pick-list references the docstring does not claim to strip. No district code, facility id or drug id reaches a payload.
- ForecastPanel.tsx:34-46: `EVAL.pairs = 3870` reconciles with `SAMPLE_PAIRS = 4000` in scripts/eval-censoring.mts minus the 130 skipped; the movedPp figures are internally consistent with the docstring's own explanation of why they are copied rather than derived.
- CaptureConsole.tsx:15-19 "there is deliberately no path from 'the model heard something' to 'the ledger changed'" — the only call to `/api/commit` is behind an explicit `onClick={commit}` on a reviewed draft (line 675).
- Cross-checked the shipped artefacts for internal consistency: `reasonHistogram` sums to `unservedReceivers` in 128 of 128 district files; DEFENSE.md's economics (₹29.8 L transport, ₹3.8 L recovered, ₹26.0 L net, 5,42,644 units, ₹4.79 break-even, ₹70.9 L unconsolidated) all re-derive exactly from national-snapshot.json totals.

**ai-integration** — TimesFM is genuinely load-bearing and I traced it end to end. src/data/forecast-cache.json key `DST-08-AJMER|OXYTOCIN-5IU-INJ` holds mean path [17.97, 18.40, 18.07, 18.36, ...]; the mean over the position's 15-day lead window is 18.0913; the shipped position DST-08-AJMER-SC-009 / OXYTOCIN-5IU-INJ carries districtShare 0.021 and forecastDailyDemand 0.379, and 18.0913 x 0.021 = 0.3799. That is the number the /console positions table divides on-hand by for days-of-cover. The disaggregation contract in src/lib/forecast/timesfm.ts (facilityShares normalised to 1, scaleForecast, forecastWindow) is implemented as documented.

The per-class gate is real and enforced, not decorative. src/lib/pipeline.ts:215 (`cfg.forecastMethod[p.fit.pattern] === 'timesfm'`) reads src/data/forecast-method.json, whose byPattern sends only 'intermittent' to TimesFM. Across all 10,274 shipped critical+high positions in src/data/districts/, 2,134 are on forecastSource 'timesfm' and every single one has demandPattern 'intermittent' — zero leaks. The deck's backtest table (docs/pitch-deck.html:489: Intermittent, 24,187, 0.896, 0.958) matches forecast-method.json facilityClasses.intermittent exactly (positions 24187, timesfmMase 0.8963, crostonMase 0.9584), and the 6.5% figure is the real delta.

The BigQuery path is the real AI.FORECAST, not a stub. src/lib/bq/series.ts builds a genuine `FROM AI.FORECAST((...subquery...), data_col => 'y', timestamp_col => 'ts', id_cols => ['sid'], horizon => 21, confidence_level => 0.9, model => 'TimesFM 2.0')`, the UNNEST/WITH OFFSET encoding and ARRAY<INT64> cast are as described, and the chunker measures against the real 1,024K character ceiling instead of guessing. docs/forecast-runtime.json carries server-side evidence from actual jobs — slotMs 33,800 on the 200-series rung, bytesProcessed 0 (confirming the inline-subquery design bills nothing), rowsReturned 4,200 = 200 x 21. decodeForecastRows carries ai_forecast_status through rather than silently zeroing declined series, and the committed cache records seriesDeclined: [] and seriesMissing: [] for 6,016 of 6,016.

Gemini is doing work a regex cannot. The capture layer (src/lib/ai/stock-report.ts) reads handwritten Indian PHC registers and spoken Hindi/Marathi stock reports into structured items, with extraction split from commitment (extract* impure, draft* pure and unit-testable, human confirms). The agent is a planning-and-retrieval problem over a ~100 KB structured payload across three tables and a drug taxonomy. The tool registry, not the model, does every deterministic mapping — resolve.ts for drug/place names, drugIdFor for catalogue ids.

No path found where a model-generated number reaches a user-visible surface without a tool result or a human confirmation. /api/commit is the strongest part of this: it refuses a client-supplied drugId and refuses the draft's status (route.ts:34-46), re-resolves the drug name server-side against the facility's own formulary, and bounds onHand in Zod. The model's register/voice reading passes through draft* flags and an explicit human confirm before it writes. The agent's prose is the only model-authored text on any surface, and the codebase is explicit that it is prose (grid-agent.ts:168-172: 'Everything else is prose, deliberately: a numeric field in this envelope would be an invitation for the model to recompute rather than quote').

Grounding discipline holds where it is implemented. runTool (grid-tools.ts:1647-1670) gates on the registry then on Zod before touching data, and the 'no tool called X' error is the right response to the observed 'default_api:list_critical_positions' invention. `grounded` is populated by the tool code, never quoted from the model. normalise() (resolve.ts:110-116) is conservative — lowercase, non-alphanumerics to spaces, collapse — so 'SC Lucknow-04' and 'SC Lucknow-40' stay distinct and no false-positive citation match is possible.

Every probability ships with a precomputed percent companion — 13 call sites verified across positionView, orderView, unservedView, districtView, alertView, explain_forecast and the economics payloads — and percent() returns a string specifically so it cannot be arithmetic'd further. I checked the one place that could have been wrong: riskReduction across all 5,578 shipped orders ranges 0 to 0.986, so percent() is applied to a genuine 0..1 probability delta, not a 0-100 score.

No identifier leakage into any tool payload. I read every view function and the facility_snapshot construction: facility ids, drug ids and district codes are used only for filtering and are never emitted. The first half of the GridAssistant footer claim ('shown no district codes, facility ids or drug codes') is true.

The tool-call budget arithmetic is correct: toolCallCount is incremented before the `> MAX_TOOL_CALLS` test, so exactly 14 executions can occur; tools are withdrawn on the final turn (budgetLeft at :517) so the model always has a turn in which it must answer; and a run in which the model never produces a final envelope throws AiValidationError ('The model produced no final answer after its tool calls.') rather than returning something empty. /api/ask never echoes upstream error text, for the documented and correct reason that an SDK error can quote the credential.

The early_warnings and simulate_outbreak payloads are models of honest tool design — early_warnings states its own 23% measured precision inside the note and instructs the model to say so; simulate_outbreak labels itself 'A SCENARIO, not a forecast' and forces both routine and emergency valuations to be reported. Neither over-claims.

**optimiser** — Things I attacked hard and could not break:

CORRIDOR CONSOLIDATION AND THE COLD UPGRADE — clean, and provably so. I rebuilt every trip total from first principles out of the shipped orders (Rs450 + Rs18/km, x1.8 if any order on the corridor is cold, + Rs60 per extra line) and compared it to the sum of the per-order estimatedCostInr: 2,078 corridors across 128 districts, zero mismatches. The largest-remainder apportionment at redistribute.ts:1545-1560 sums EXACTLY to the trip in every case. The upgrade is billed exactly once per trip: 0 anchors carry a coldUpgradeInr, 0 corridors carry more than one, and all 3,008 riders are billed exactly 60 + coldUpgradeInr. The mechanism that guarantees it — `best.corridor.coldChain = true` at redistribute.ts:1396 mutating the shared OpenCorridor object that byReceiver holds by reference, plus the OR-merge when the corridor map is built (planRedistribution, "OR, not first-wins") — is correct, and the `owed` subtraction leaves anchors paying exactly the ambient trip they cleared the gate against.

BATCH DOUBLE-PROMISING — I could not find a path. allocateFefo is called speculatively for many candidate donors per receiver but commitAllocation runs only on the accepted `best`, in the same tick, with no intervening mutation; `committed` is keyed facility|drug|batchNo and lives in shared state across drugs and districts; all three passes read and write the same map. sum(lines) === quantity on all 5,578 shipped orders.

state.given AT EVERY PUSH SITE — yes, all three: line 918 (anchor), line 1097 (rescue), and the ride-along site alongside the capacity decrement. None is decremented twice; capacity, wasteBudget and committed are each mutated once per accepted order on every path.

THE WASTE BUDGET — no double-count. Pass 2 pre-bounds `rescuable` by the remaining budget before its candidate loop and decrements it per accepted order, so a donor's total rescue can never exceed the budget pass 1 left; pass 1 and pass 3 each take `Math.min(qty, wasteBudget)` and debit. Verified indirectly: national wasteAvertedInr reconciles to the sum of the 128 districts within Rs2 of per-district rounding.

THE UNSERVED LADDER AND HISTOGRAM — sums to unservedReceivers in all 128 districts. The pass-3 subtraction (`unservedByReason.failed_bc_gate -= extra.rescued.size`) cannot go negative or over-remove: every rescued need is a distinct object reference drawn from merged.unserved with reason === 'failed_bc_gate', and rescued.size equals extra.transfers.length by construction. Precedence order (sawDonorSafe > sawFillable > sawAdmissible > sawInRange > sawSurplus) matches the code's actual give-up points one for one. Only the last rung is wrong, and that is finding 4.

resolveOptions — correct. The four excluded keys (asOf, shortagePenalty, eligibleReceiver, admissibility) are each read directly from `options` at their use sites (lines 642, 665, 713, and the planRideAlongs call), so nothing is silently dropped, and `rideAlongs: false` survives the `v !== undefined` test.

THE PASS-3 DONOR GUARDRAIL — I spent real time on the conditional at the ride-along site (`if (rideSamples && rideBefore !== undefined)`), which skips the stock-out check entirely and publishes donorStockoutAfter: 0 when a donor's samples were never drawn. I could not make it reachable: every pass-1 `continue` that precedes `donorDistribution()` (available <= 0, distance > maxDist, refused, qty <= 0, and the mustRetainUnits floor) is monotone in the plan's own state, so a donor that survives all of them in pass 3 must have survived them in pass 1 and had its samples drawn. The data agrees — rider donorStockoutAfter values are quantised to 1/2000 (DONOR_GUARDRAILS.donorSimulations) exactly like anchors', and the zero-share is 78.1% for riders against 80.6% for anchors, i.e. the zeros are genuine low-risk donors, not skipped checks. Worth knowing it is one refactor away from being load-bearing, but it is not a defect today.

ORDER-DEPENDENCE ACROSS DISTRICTS — real, but deliberate and documented at build-snapshot.mts:216-228, with a fixed district table making it deterministic. Not a finding.

ARTEFACT RECONCILIATION — national-snapshot.json totals match the sum of the 128 district detail files exactly for transfers, transportCostInr, netBenefitInr, trips, crossDistrictTrips, crossDistrictOrders, rideAlongOrders and unconsolidatedCostInr; wasteAvertedInr and shortfallAverted differ by Rs2 and 1 unit respectively, which is per-district Math.round, not a modelling gap. Per-district snapshot rows match their detail files on all seven planner fields, 0 mismatches. The README's 5,578 orders is the current figure and it correctly explains 7,097 as the pre-guardrail count; I found no stale headline anywhere in src or README.md.

**tests** — Genuinely sound, checked line by line:

**scripts/verify-federated.mts** — the best suite here and the model the others should copy. Lines 179-222 plant five distinct leaks (facility id, district code, batch number, raw quantity, district name) into a copy of a real node file and fail if any survives, then report the catch count in the green line. Line 339 refits a state from src/data/demand-district-daily.json and the raw district payloads and requires byte equality with the committed file — independent derivation, not a shape assertion. Lines 358-365 prove the leave-one-out prior actually excludes. Lines 292-295 hash every node file against _national.json. The allowlist at 69-111 is closed by construction (anything not listed is a leak) rather than blocklist-based.

**scripts/test-base64.mts:72-81** — a real positive control: it asserts the OLD `btoa(String.fromCharCode(...))` expression still throws on 250 KB, so the regression test cannot quietly stop testing anything.

**scripts/test-timesfm.mts** — four independent positive controls. Line 177 doubles the forecast and requires expected demand to double (catches Croston silently driving). Line 186 requires a wider interval to widen the sampled spread. Line 215 requires the Croston path NOT to equal the bare fit. Lines 293-297 require a horizon crossing a month boundary to still move, so the double-counting fix cannot degenerate into switching seasonality off. Tolerances are stated and derived (0.03 on 20k Monte Carlo draws).

**scripts/verify-guardrails.mts** — redraws each donor's lead-time distribution at AUDIT_SIMS=2000, deliberately different from the planner's PLAN_SIMS=500 (line 57-58), so a guardrail holding only against one sample vector fails. Lines 339-343 re-plan with the caps lifted and fail if nothing changes — the "is this guardrail load-bearing" control the lens asks about. Tolerance of 1/AUDIT_SIMS is stated rather than hidden.

**scripts/verify-cross-district.mts:234-236** — three positive controls (at least one cross-district trip, at least one ride-along, fewer trips than orders). The last one also covers the zero-orders case that verify-batch-bounds misses. Section 4 (lines 241-265) tests the `{...DEFAULTS, ...options}` explicit-undefined trap directly.

**scripts/test-markdown.tsx:120-126** — the safety assertion is correctly scoped to *tags* (every emitted tag must be in an allowlist of eight) rather than to substrings, with the reasoning written out; `onerror=` is expected in the output and the test says so.

**scripts/test-capture-rules.mts** — written specifically because "a fixture that supplies the condition under test is not a test" (its own line 28, about test-capture.mts hardcoding `kind: 'closing_balance'`). B4-B6 and A4-A7 are regression cases keeping the fix narrow, which is the right shape.

**scripts/test-rate-limit.mts** — injected clock, boundary asserted at exactly startedAt+windowMs and at -1 ms, memory bound driven with 500 keys against a cap of 50, invalid rules must throw (line 109), and Part 2 drives the real proxy with real NextRequest objects rather than trusting the limiter in isolation.

**scripts/verify-census.mts** — cross-checks a committed fixture from an independent publisher, and distinguishes unchanged-boundary districts (must agree within 2%) from split districts (must be materially smaller than the 2011 parent). The spread check at line 74 (`spread > 10`) is the control that catches a revert to hashed populations and also catches an emptied payload.

**.claude/scripts/verify.mjs step 5** — already carries the exact lesson this audit looks for, written out at length: an earlier parity check passed by coincidence because four-digit numbers appear anywhere in a 660 KB page, so the list was lengthened to high-entropy values, and after day 13 the API surface was added because the figures alone matched a six-day-old deployment. That reasoning is right and is applied.

**check-claims.mts machinery** — the derivations at lines 39-190 are read from artefacts (snapshot totals, guardrail-gate.json, warning-rule.json, federated-summary.json, forecast-method.json) and the prose is held to them, which is the correct direction. buildSeconds is checked as a band rather than a figure; the restart gate is checked as bounds plus one non-negotiable boolean (browserSawRestoredValue); the warning rule is cross-checked against the tuning table's own row and against a gate fixed before measurement. The four unguarded figure classes are the coverage boundary reported above: populationCovered, zeroStockPositions, opdTurnedAway, and the whole of docs/demo-script.md, docs/federated.md, docs/forecast-backtest.md and docs/warning-tuning.md.

Verified and NOT findings: every figure in docs/demo-script.md other than the 4,683/5,030 sentence matches its artefact (25,184 / 10,82,880 / 38.4% / 16 nodes from federated-summary.json; 4.04 d / 23% / 100% from warning-rule.json; 6,016 from demand-district-daily.json; 30,535 of 81,104 from snapshot.forecast; the 49-capsule Doxycycline order at 129.3 km, ₹60 vs ₹2,777 exactly matches src/data/districts/DST-22-BASTAR.json). The nine other pitch-deck figure tiles match the snapshot exactly. The hazard-pattern map in src/lib/surge/indicator.ts currently covers all seven patterns the 47-drug catalogue uses.

**federated** — **The headline claim is real and I reproduced it exactly.** I re-implemented `fitSeasonalIndex`, the node fit, `poolNodes`, `shrinkToPrior` and `scoreSeries` from scratch in plain JS and re-ran the whole ladder from `src/data/demand-district-daily.json`. Every published figure matched to five decimals on all four rungs — J=30 flat 0.25890 / local 0.25552 / federated 0.15740 / priorOnly 0.15740 / oracle 0.15129, improvementOverLocal 0.3840, improvementOverFlat 0.3920, ceilingRecovered 0.9432, seriesScored 5969, seriesSkipped 47. The 25,184 figure is a correct walk of the sixteen node files (1,574 each), and 10,82,880 is exactly the sum of `scope.observations` across them. No number-fabrication anywhere in this layer.

**The DerSimonian-Laird algebra in `pool.ts` is textbook-correct.** Q from fixed-effect weights around the fixed-effect mean (pool.ts:104-110), df = k-1, C = sumW - sumW2/sumW (:119), tau^2 = max(0,(Q-df)/C) with the C>0 guard (:120), random-effects weights 1/(se^2+tau^2) (:126), B_i = tau^2/(tau^2+se_i^2) (:136). I^2 = (Q-df)/Q truncated at 0 (:121) is the standard Higgins form, not one of the common wrong variants. The `informative` filter correctly treats NaN values and null/non-finite/zero se as "no information" and hands those nodes the pooled mean at weight 0; the `fallback` / throw split is a good design and the arithmetic tests at verify-federated.mts:373-410 exercise the right corners.

**The log-scale round trip is consistent at every point I could find.** `poolIndex` takes log(v) with the delta-method se/v (build-federated.mts:222-226); the prior is published as `Math.exp(p.mean)` and the between-node variance is named `tauSquaredLog` and documented as being on the estimation scale (:255-259); the federated arm shrinks on logs and exps back (:430-440); the priorOnly arm is `prior.map((p) => Math.exp(p.mean))` (:445); the fallback is `0`, which is log(1), correctly the neutral multiplier (:232). `poolCadre` stays on the natural scale and says so. No mixed-scale blending.

**The evaluation really is leave-one-state-out.** `others = ALL.filter(c => c !== state.code)` (build-federated.mts:407) feeds `poolIndex(item, m, others)`, which reads only `nodes.get(code)` for those codes; `nodes` is partitioned by `DISTRICTS_BY_CODE[s.districtCode].stateCode`, so no state's series ever reach another state's fit. The oracle arm reads `nodes.get(state.code)` — the scored state's own full-history fit — but that is the explicitly labelled ceiling, excluded from the prior, and it does beat the federated arm on every rung as it should. I also checked for a temporal look-ahead (the prior is fitted on the same calendar days being forecast) and found none that bites: `simulateInventory` seeds per `(seed, facility.id, drug.id)` and applies a fixed calendar multiplier, so there is no shared shock the concurrent prior could carry.

**The scale-invariance claim in `evaluate.ts` is exactly true.** Replacing `index` with `c*index` makes `level = (1/levelDays) * sum(y_t/(c*index))` divide by c, and `pred = level * c * index` is unchanged; `levelDays`, `fitTotal`, `blocks` and `scale` are all independent of the index. So the metric depends only on the index's shape, which is what lets a locally normalised index and a pooled one be compared without renormalising. The block grid depends only on `fitDays`, and the "every arm must be scorable at both resolutions or the series is dropped from all of them" rule (build-federated.mts:462-467) is correctly enforced.

**Byte-for-byte serving holds on the live deployment.** `curl https://aarogya-grid-215071922486.asia-south1.run.app/api/federated/{08,10,33} | sha256sum` matches both the committed file and the digest recorded in `_national.json`, for all three. The routes read bytes off disk rather than re-serialising, and `/api/federated/[state]` validates against `STATES` before touching the filesystem with `dynamicParams = false`, so there is no path-traversal surface.

**The disclosures are present and honest.** `federated == priorOnly` at J=30 is not hidden — it is called out in `docs/federated.md:109-112` and explained correctly (every `indexSe` is null at 30 days because the window covers 28 April days and 2 May days, and `MIN_CONTRAST_DAYS = 7` needs seven on both sides). The synthetic-between-state-variance limitation is in `_national.json`, in the doc, in the README and rendered on the panel. The Antidotes row, where federation makes things worse, is published rather than dropped. I also tested the window-edge shrinkage I suspected (`minObs = 30` against a 28-day April) — re-running the full ladder at minObs 28 and 20 moves the headline from 38.40% to 38.58%, so it is real but immaterial and I am not reporting it.

**`shared.numbers` is genuinely counted, not asserted.** `countNumbers` walks the object, the build re-walks every written file and exits non-zero on mismatch (build-federated.mts:877-884), and my independent walk of all sixteen files reproduced 1,574 each and 25,184 total. The three structural identities the sweep does check (series = sum of per-item series, observations = series x days, monthObs sums to the window) all hold on all sixteen files and are genuinely unforgeable for those three fields.

**judge-path** — **The ten-second test on `/` — passes cleanly.** HTTP 200 in 448ms total, 308ms TTFB from a cold curl. At 1366x768 the fold carries the headline ("The medicine was *already* in the country."), a three-line value proposition, both AI systems named in the sub-paragraph ("Demand is forecast by **TimesFM 2.0** through BigQuery `AI.FORECAST`… **Gemini** reads a paper register or a spoken Hindi report… Neither model invents a number"), and three separate routes into the product — a header "Open the console →" plus "Open the live console →" and "Read the honest ledger". No hunting required. `<title>` and `<meta name="description">` are both substantive.

**`/console` above the fold at 1366x768 — genuinely strong.** Measured: KPI strip at y=73 (all six tiles fully visible), map panel at y=170, "Highest-risk districts" list at y=170 showing 11 ranked rows. The map's bottom ~250px (Tamil Nadu, the colour-ramp and size legends, the scale bar) falls below a 732px viewport, but the ramp is decoded in text by the ranked list beside it, so nothing is colour-only above the fold. Screenshot confirms it reads well on a projector.

**Phone layout — clean at a real 390x844x3 mobile viewport.** `documentElement.scrollWidth === clientWidth` on both /console and the district page; I walked every element for `getBoundingClientRect().right > innerWidth` with an ancestor `overflow-x` check and found **0** unscrollable overflows on a 22,750px-tall district page. The 13-column, 752px risk table sits correctly inside an `overflow-x: auto` container. KPI tiles reflow to two columns; the disclosure banner and the assistant (with its Hindi prompt chips) are legible without zoom.

**Severity contrast — passes AA everywhere, including the tinted chips.** Computed all four `--color-sev-*` tokens against `ink-950 #010409`, `ink-900`, `ink-850` and `ink-800`, and against each colour's own `/10` chip background: worst case is `#ff4d5e` critical on the `bg-sev-critical/10` chip over `ink-800`, at **4.53:1** — still above the 4.5 AA threshold for normal text. Best case 14.22:1. Colour is also never the sole channel: every severity chip carries a number, VED shows as V/E/D letters, and the order cards use text badges (COLD CHAIN, CROSS-DISTRICT, RIDES ALONG).

**README step 3 is accurate, and Approve really is disabled.** The named order exists on the page it points at: `DST-10-BHAGALPU-DH-001|DST-10-PURNIA-DH-001|RL-500ML`, 110 bottles of Ringer Lactate, two named batches with expiry dates (B010-DH001 exp 2027-10-28, B011-DH001 exp 2028-04-27), ₹427 against ₹2,261 standalone — a real share of a shared vehicle, exactly as claimed. It renders `admissibility: requires_district_countersign`, and the live HTML carries `<button title="Crosses a district boundary — needs the donor district to countersign before it can be approved." disabled="">Approve</button>` beside an enabled "Countersign". The state-line variant renders its own distinct reason. This is the strongest moment in the demo and it works.

**Every headline number matches the snapshot.** I re-derived 18 figures from `src/data/national-snapshot.json` and compared them to the rendered strings on `/` and `/console`: ₹1.92 Cr net benefit, ₹29.84 L transport, ₹70.87 L unconsolidated, ₹3.84 L waste averted, −₹26 L net cash, ₹4.79 break-even, ₹41.04 L consolidation saving, 5,42,644 units, 5,578 / 2,078 / 615 / 1,579 / 3,008, 2,824 / 81,104 / 4,683 / 5,030, ₹14.52 L expiry. All exact. Population is the single exception, reported above.

**`/api/federated` and `/api/indicators` self-describe properly.** Both lead with a schema identifier (`aarogya.federated.prior/1`, `schemaVersion: 1.0`), carry a `method` block, and carry an unprompted `disclosure` block saying the facility data is simulated. `/api/indicators` points at `/docs/indicator-schema.json`, which I confirmed serves live (HTTP 200, 7,076 bytes) — a judge can validate the feed without reading any code.

**Jargon on the district page is explained.** All ten jargon column headers carry real definitions in `title` (RoP → "Reorder point: expected demand over the resupply lead time plus safety stock, at the 95th percentile"; P(out) → "Probability of reaching zero before replenishment lands, from a Monte Carlo over the lead time — not a point estimate"; AMC, MOS, Cover, Lead, VED, Shortfall, Risk likewise), and the table footer states the AMC/MOS arithmetic and names the one place Cover and P(out) can legitimately disagree. These are hover-only and so invisible to keyboard users, but the content is there and it is good — I am not reporting it separately, because the definitions also appear in prose elsewhere on the page.

**`/capture` is well designed for a stranger.** Pre-filled with a Hinglish sample, a "Type" mode so no microphone is needed, and a "Deliberately wrong" adversarial sample sitting right there for a sceptic — a judge can exercise the Gemini path in one click on an unfamiliar machine.

**Checked and found not material:** no skip link on any page, but the repeated header block is one or two links, so there is no block to bypass. Choropleth adjacent bands sit at 1.14–1.48:1 against each other, which is inherent to a sequential ramp and is decoded in text by the legend and the ranked list. The exported CSV's `indent_date` (2026-09-12, the build date) differs from the snapshot's as-of date (2026-09-30), but `src/lib/dispatch/csv.ts:113` documents that choice explicitly.

**forecast** — **The backtest holdout is genuinely held out.** I checked the index arithmetic end to end rather than trusting the assertion. demand-district-daily.json has startDate 2026-04-03, days 180, lastDate 2026-09-29, asOf 2026-09-30. Phase A's contextFrom = 180-28-90 = 62 (2026-06-04) and holdoutFrom = 152 (2026-09-02) are disjoint, and the length assertion at backtest-forecast.mts:151 is real. Phase B's simulator indices (SIM_HISTORY 365, holdStart 337, trainFrom 247) map exactly onto artefact indices 152 and 62 via sliceFrom = 365-180 = 185 in export-demand.mts, so the two phases score the same 28 calendar days. No holdout day reaches a context window, a share denominator, or a MASE scale: the fit, the uncensoredMean level and the trainTruth scale are all sliced to [0, holdStart). The AI.FORECAST horizon starts the day after the last context day, so the wire format cannot leak either.

**MASE/RMSSE denominators.** Taken from the training window only, and identically for both arms, so the non-seasonal-naive choice (documented at length at backtest-forecast.mts:29-40) cannot bias the comparison. Zero-denominator series are excluded and counted (seriesSkippedFlat, facilityPositionsSkipped) rather than given a 0 or an Infinity.

**The 5% win margin is applied exactly where it claims.** `winner: delta < -WIN_MARGIN ? 'timesfm' : 'croston'` on the Phase B facility x drug table, and forecast-method.json's byPattern matches those winners row for row: smooth -1.3% croston, intermittent -6.5% timesfm, erratic +1.4% croston, lumpy -4.2% croston. The gate is keyed on the facility fit's pattern in both the batch (pipeline.ts:211) and the live recompute (recompute.ts:141-144), so a committed report cannot move a row onto a different model than the one that scored it.

**The disaggregation does what the docstring says.** facilityShares normalises to exactly 1 (test-determinism.mts:99-110 asserts it to 1e-9), scaleForecast clamps the share at 0, and the all-zero district case spreads evenly instead of dividing by zero. The share window (last 90 days of uncensoredMean) is the same calendar window TimesFM read. The recompute path rebuilds the same carrier set with the same default seed 20260930 (facility-lookup.ts:37 vs facilities.ts:206), so districtShare agrees between batch and runtime.

**No NaN, Infinity or negative forecast reaches a shipped number.** I scanned all 6,016 x 21 cache values: no NaN, no negative means (decodeForecastRows clamps at 0). 54 (series, day) pairs have hi < lo and 644 have mean < lo, but all are at magnitudes <= 0.1 units/day on near-zero anti-venom series and intervalSigma's `Math.max(0, ...)` absorbs them. Scanning national-snapshot.json and all 154 district payloads for non-finite numbers returned 0; the only nulls are the intentional `escalateTo: null`. daysOfCover's Infinity is converted to the documented -1 sentinel at district-detail.ts:582.

**A truncated interval in the cache degrades safely.** I fed computeStockRisk a hand-built cache entry whose `m` is 21 long but whose `lo`/`hi` are 3 long — districtForecast accepts it (it only validates `m.length`), but forecastWindow's `arr[Math.min(i, arr.length - 1)]` clamp repeats the last bound instead of producing undefined, and the result was a finite, sane risk (P(out) 0.996, reorderPoint 77). Worth a note in districtForecast, but not a live defect.

**The TimesFM path itself is arithmetically sound.** forecastDayParams sets sizeMean = mean/p so p*E[Z] = mean exactly, guards p <= 0 and mean <= 0 before dividing, clamps the interval-implied variance at zero, and correctly does NOT apply the seasonal multipliers on top of a path that already learned them. probe2 shows the TimesFM positions carry none of the seasonal bias the Croston smooth class does. build-snapshot.mts:124-140 hard-fails on a cache whose forecastStart, horizon or confidenceLevel disagrees with the snapshot, so the z-table assumption in intervalSigma cannot silently drift.

**The offline snapshot is honest about itself, when it runs.** With AAROGYA_NO_BQ=1 the cache and the method map are both dropped (build-snapshot.mts:107, :157), every position falls back to Croston, and the snapshot writes model: null and timesfmPositions: 0 — the DEFENSE.md claim about `timesfmPositions: 0` is accurate by code reading. Only the claim that npm test exercises it is not (reported above).

**efficiency** — Three of the brief's hypotheses I tested and found WRONG. Reporting them so nobody spends time on them:

1. roadDistanceKm is NOT a hot spot, and a distance matrix or spatial index would buy nothing. Measured on the real Patna cluster: pass 1 enumerates 44,454 (receiver, donor) pairs, of which 22,064 reach the haversine and 15,313 survive the range test. At ~0.1 us per haversine that is ~2 ms of a 2,932 ms plan. Across 128 clusters it is under half a second. The pair loop is also not quadratic in any dangerous sense: planForDrug is called per drug, so the real shape is 47 drugs x (7.6 receivers x 100 contexts), not 355 x 4,700.

2. The 2,000-element linear scans in stockoutProbabilityAt / expectedShortfall do not matter. Measured 1.444 us per scan over 2,000 samples (200,000 iterations); the upper bound of 15,313 in-range pairs per cluster gives 22 ms of a 2,932 ms plan. Sorting the samples once and binary-searching would save ~20 ms per cluster, ~2.5 s over the run, for a much larger change than the two above. Not worth it.

3. donorDistribution's memoisation IS keyed correctly. capKey(ctx) = facility.id + '|' + drug.id, and the sample vector is a pure function of (facilityId, drug.id, fit, leadTimeDays, asOf, forecast) - all constant for a given position, and statesFor is deterministic per district code so an LRU eviction and rebuild reproduces the same context. state.donorStockoutBefore is likewise computed once at ctx.risk.onHand, which does not change. Sharing nationalPlannerState across all 128 turns means each (facility, drug) is drawn at most once for the whole build, bounded at 81,104 draws. The expensive part is the sample count, not the key.

Also checked and clean:
- Repeated parsing of the big payloads in the BUILD (the brief's concern). forecast-cache.json (2.5 MB) is parsed exactly once per build, in loadForecastCache at build-snapshot.mts:111. demand-district-daily.json (4.4 MB) is not read by build-snapshot.mts at all. The only genuine triple-parse is in check-claims.mts and it costs 216 ms (reported as low).
- src/lib/overlay/runtime-forecast.ts statically importing the 2.5 MB forecast cache is correct, not a leak: it carries `import 'server-only'` at line 1 and is imported only by api/ask, api/commit and dispatch/service. I confirmed against the live bundles that no chunk served to /console contains it.
- The client bundle has no dead weight to cut. 717 KB raw / 223 KB gzipped across 10 chunks: 229 KB is react-dom, 100 KB is the india-outline MultiPolygon the map renders, the rest is app code. No markdown/chart/date library is shipped.
- localeCompare on ISO date strings (inventory.ts:337, redistribute.ts:350/1015/1043) looks like a classic waste but measured as noise: 15 ns vs 2 ns per comparison, and on the 2-3 element batch arrays actually used the sort overhead dominates completely (sort3 with localeCompare 49 ns, with lexical compare 53 ns). Leave it alone.
- The LRU at STATE_CACHE_SIZE=32 does its job. Replaying the real district order gives 531 statesFor calls, 375 hits, 156 misses - a 22% rebuild overhead over the ideal 128, which is a reasonable price for the documented memory bound. Raising it to 48 would recover some of that but the docstring at build-snapshot.mts:238-245 explicitly trades this against hundreds of MB, and that is a decision already made.
- planRideAlongs re-drawing the receiver's samples (redistribute.ts:1266-1274) is documented at line 1264 as costing time and not determinism, and I measured it at roughly 25,000 draws x 275 us = 7 s over the run. Real, but it is a documented trade-off and small next to the donor draw.

**claims** — COVERAGE, MEASURED
232 distinct numeric tokens across the six primary judge-facing surfaces (README 272 raw / SUBMISSION 42 / DEFENSE 58 / NOTICE 25 / demo-script 89 / deck visible text 192; deduped to 232). check-claims makes 121 claims — 79 on README.md, 24 on docs/pitch-deck.html, 8 on DEFENSE.md, 7 on SUBMISSION.md, 2 on source files, 2 on JSON gates — plus 12 restart-gate bounds, 8 dispatch-gate rows, 11 warning-rule rows and 1 build-band assertion checked separately. Several claims pin more than one number (the "four zeros" claim pins four; the guardrail-cost claims pin two each), so the 121 claims pin roughly 130 distinct numbers: **about 56% coverage of the numbers a judge can read.** Zero claims touch NOTICE or docs/demo-script.md (114 numeric tokens between them) or any generated doc under docs/ other than guardrail-gate.json and assistant-latency.json.

I ran the guard read-only: "claims: 121 checked, all agree with the shipped artefacts." Everything it covers is genuinely correct — I spot-verified the derivations rather than trusting the PASS lines.

VERIFIED CORRECT AND GENUINELY SOUND (checked, not assumed)
- Live/repo parity is exact. curl against /console found all of 2,824 · 81,104 · 4,683 · 5,578 · 2,078 · 1,579 · 5,42,644 · 174 · 128 · 37.22 Cr · ₹1.92 Cr; /api/federated returns kind aarogya.federated.prior/1, 16 nodes, shared.numbers 25,184, the four zeros, rowsRetainedInStates 1,082,880 — byte-for-byte with src/data/federated-summary.json. Root cold-loads in 0.46 s against SUBMISSION's "well inside three seconds".
- The scaling section, which is the least guarded and which I most expected to have drifted, is exact. I re-derived the clustering from src/lib/domain/geo.ts at NEIGHBOUR_RADIUS_KM=250 / MAX_NEIGHBOURS=4: 78 of 128 clusters cross a state line (README: "78 of the 128 clusters"), greedy colouring gives 9 rounds with the largest at 31 (README and DEFENSE: "9 concurrent rounds (largest 31 districts)"), and replaying the LRU in build-snapshot.mts (STATE_CACHE_SIZE=32) gives 156 misses and 71% reuse (README: "156 district states are simulated rather than 128", "71% reuse on the 128-district run"). Four unguarded numbers, four exact matches.
- The census cross-check holds: worst divergence among the ten unchanged districts is 0.1447% → README's "0.14%" is right (the script's own docstring says 0.15%, but that is an internal comment). Bastar 578,326 vs undivided 1,413,199, Pune 48 facilities, Adilabad 12 — all exact. The worst eight districts by meanRiskScore are indeed all in Jharkhand, Bihar and Uttar Pradesh.
- README's "27 assertions" for test-resolve is right and I nearly reported it wrong: CASES has 25 entries, plus two formulary assertions at lines 106-125 = 27. test-capture's "26 assertions" = 26 check() calls. Five poisoned copies in verify-federated.mts POISON = 5.
- The forecast/backtest block is clean: 6,016 series, 21-day horizon, 90-day context, 28-day holdout, 5% win margin, intermittent won by 6.5%, 30,535 of 81,104 — all match forecast-method.json, and the deck's per-class MASE table (24,187/0.896/0.958 etc.) matches docs/forecast-backtest.md row for row. DEFENSE's "three BigQuery statements" matches MAX_QUERIES=3 in forecast-refresh.mts. Anomaly scale 6,144 series in 7 statements = 128+6,016 series and 1+6 batches in anomaly-runtime.json; "flagged 90 of 128 districts on footfall" exact.
- The economics are clean: ₹29.8 L / ₹70.9 L / ₹26.0 L / ₹3.8 L / ₹4.79 / 5,42,644 / 10% uplift over the 495,166 baseline all re-derive from totals. The deck's declined-needs prose (10,353 needs, 95.0% benefit/cost, median 26.8 km, only 9 for want of stock) re-derives from the 128 payloads. The "1,746 sachets" example exists (DH Durg-01 → DH Raipur-01, ORS, crossDistrict true). The demo script's Doxycycline order (49 capsule, PHC Dantewada-03, 129.3 km, ₹60 vs ₹2,777) and Ceftriaxone order (CHC Dantewada-01, 100 km, batch B011-HC001, 371 days) are both verbatim from DST-22-BASTAR.json.
- Federated: 47 catalogue items matches 47 ids in drugs.ts; 5,969 series, 38.4%/39.2%/94%, 8.8–13.3% own weights, −2.2% on Antidotes, 64%/62% on antibiotics/antimalarials — all match federated-summary.json and docs/federated.md. The disclosure is rendered on the panel, not just in the file.
- No hard-coded figure in any rendered component. src/app/page.tsx and src/components/*.tsx pull every number from the snapshot facade; the only literals are in comments explaining removed bugs.
- Counts I checked that hold: 12 deck slides, 22 test suites in `npm test`, 121 guarded claims, 297 indicator signals, 126 injected surges, 228 facilities without a pharmacist, 394 unverified-reporting facilities covering 8.5 M people, 3,11,709 consultations, the 7–18 day lead-time window, 3 adapters, 12 tools (in the deck and DEFENSE), the dispatch-gate chain (14 planned / 11 arrived / 100%→2% projected / 17% actual), and the restart-gate bounds.

CHECKED AND DELIBERATELY NOT REPORTED
- DEFENSE.md's "Eight questions" against nine `###` headings: eight end in a question mark; the ninth ("Your plan loses money.") is an objection, so "eight questions" is defensible.
- SUBMISSION.md's "six API routes": the repo has 10 route.ts files and verify.mjs probes 5, but nothing in the repo enumerates a "six" for me to contradict — unverifiable rather than wrong, and too speculative to report.
- DEFENSE.md's "twenty test scripts" against 22 suites: a round word in prose, not a precise claim.
- The 113 KB voice fixture (115,200 bytes = 112.5 KiB) and "under 4 seconds" for simulate_outbreak (measured 463 ms) both round or understate honestly.
- The BUILD_BAND docstring in check-claims (lines 197-213) describes 95.8–202.8 s readings while BUILD_BAND is [190,240]; the README reconciles this correctly as pre-guardrail (94–203 s) vs post-guardrail (190–240 s), and the shipped buildSeconds 228.6 falls inside the band. Stale comment, not a published number.
- Every "documented trade-off" I found (truncation in format.ts, the pinned BASELINE_SHORTFALL_AVERTED, the band-not-a-figure reasoning, the 2,798/2,083/7,097/74 historical constants, `--max-instances=1`) is deliberate and argued at length; I did not re-litigate any of them.

The repo was left untouched — `git status --porcelain` shows only files I did not create (docs/audit-prompt.md, resp.json). Two throwaway derivation scripts were run from the repo root and deleted in the same command; the instrumented copy of the guard lives in the scratchpad.

**data-integrity** — The artefact set is in unusually good shape. Everything below was checked and holds.

NATIONAL vs 128 DISTRICT PAYLOADS — exact, field by field. facilities 2,824; trackedPositions 81,104; criticalPositions 4,683; highPositions 5,591; transfers 5,578; transportCostInr 2,983,675; netBenefitInr 19,168,778; trips 2,078; crossDistrictTrips 615; crossDistrictOrders 1,579; rideAlongOrders 3,008; populationCovered 372,164,015; projectedWasteInr 1,452,191 — all zero delta. Only three fields differ at all and only by rounding: wasteAvertedInr by Rs 2 of 383,949, shortfallAverted by 1 unit of 542,644, expectedShortfallUnits by 0.4 of 1,243,354. Those are per-district rounding, not drift.

PER-ORDER ARITHMETIC — sum of estimatedCostInr over all 5,578 orders in all 128 payloads is exactly 2,983,675 = totals.transportCostInr. Sum of standaloneCostInr is exactly 7,087,178 = totals.unconsolidatedCostInr. orders.length equals economics.transfers in every district; distinct corridorId count equals trips in every district; order lines sum to quantity in every order; no consolidated cost exceeds its standalone cost; no order breaches the 10% donorStockoutAfter guardrail; no batch is dispatched past expiry; the crossDistrict flag matches the district codes on both ends in all 5,578.

RESOURCE ROLLUPS — 18 fields summed district -> national exact (beds, staff, specialists, OPD, unverified reporting). state rows match district sums exactly for all 7 summable resource fields across all 16 states. bedOccupancyRate, vacancyRate and absenteeismRate all reproduce from their published numerators and denominators.

REASON HISTOGRAM — sums to economics.unservedReceivers in all 128 files with zero mismatches, and matches the unserved array per-reason in the 16 districts where the array is not capped. The array is capped (4,988 rows carried of 10,353 counted) and both the UI (DistrictConsole.tsx:796-798 "worst N of M") and the AI tool layer (grid-tools.ts:1116-1117) say so explicitly.

SCHEMA UNIFORMITY — 246 distinct key paths, every one present in all 128 district files. No field present in some and missing in others.

NUMERIC HYGIENE — no NaN and no Infinity anywhere in any shipped JSON. Every negative found is a legitimate delta (maseDelta, improvementOverLocal, medianLeadDays on rejected rules) or a band lower bound. Every null is a legitimate absence (parentId on a top-level facility, escalateTo on an intra-district order, indexSe where a state has no evidence for a month).

CENSUS — census-2011.json has 128 entries summing to exactly 372,164,015. Every district row in the snapshot matches its census population exactly; every state row matches the sum of its districts; geo.ts throws rather than inventing a population for an unmatched code.

FORECAST CACHE — exactly 128 districts x 47 drugs = 6,016 keys, matching seriesForecast, seriesRequested, forecast-method.json seriesScored and the demand artefact's series count. Zero unknown district or drug ids. forecast-method.json facilityClasses positions sum to 74,568 = facilityPositionsScored, and +6,536 skipped = 81,104. timesfmPositions 30,535 + crostonPositions 50,569 = 81,104. The per-class winner in both tables is consistent with the declared 5% winMargin, and byPattern follows the facility-level table (the one that actually routes). In the shipped positions, all 2,134 intermittent rows carry forecastSource timesfm and all 8,140 others carry croston — zero routing violations.

DEMAND ARTEFACT — 6,016 series x 180 days = 1,082,880 values, no negatives, dates consistent with the declared window. This is the 10,82,880 the deck and README quote.

FEDERATED — independent leakage sweep for district codes, facility ids and batch numbers across all 17 node files: zero hits. Per-node byte counts and sha256 match federated-summary.json exactly. The 1,574 "numbers" figure is verifiably scope+seasonality+workforce (3+1,551+20), excluding 6 metadata values — a defensible scoping the build itself asserts. GET /api/federated/10 on the live deployment returns 30,223 bytes identical to src/data/federated/10.json with sha256 2be699c2f011, exactly as the index and the README claim. The headline arm's "federated equals prior-only at 30 days, meanOwnWeight 0" is not hidden — docs/federated.md:109 leads with it in bold.

ALERTS — all 250 national alert rows resolve to a position in the corresponding district payload with zero field mismatches across onHand, daysOfCover, stockoutProbability, expectedShortfallUnits, riskScore, severity and leadTimeDays. alertTotals.byTier sums to 4,683 critical and 5,591 high.

DECK WORKED EXAMPLE — slide 05 is verbatim against src/data/districts/DST-10-PURNIA.json: 43 bottles on hand, 97% stock-out probability, 110 sparable, 100.6 km, Rs 427 consolidated vs Rs 2,261 standalone, 53.3 bottles averted, 92 pp risk reduction, batches B010-DH001 x12 and B011-DH001 x98, requires_district_countersign. Every figure present.

OTHER DECK/DOC CLAIMS RE-DERIVED — 10,353 declined needs; 95.0% failed_bc_gate (9,839/10,353 = 95.04%); 9 no_surplus; median 26.8 km over the failed_bc_gate rows; break-even Rs 4.79/unit; Rs 14.52 L expiry; 5,030 zero-stock; the federated MAE ladder 0.2589/0.2555/0.1574/0.1513 and 38.4%; the four backtest class rows 24,187/26,789/15,964/7,628 and the 6.5% intermittent win; 6,144 series in 7 statements; 196 donors audited, worst 3.0% (pct(0.0305,1) genuinely renders "3.0%"); 25,184 numbers over 16 nodes; docs/surge-example.md's 14/76, 35, Rs 31,906 all internally consistent with docs/surge-example.json.

WARNING TUNING — the chosen rule (k=2, e=0.1, consumption) is present in docs/warning-tuning.json with detectionRate at 2x of 36/36 = 1, medianLeadDays 4.040, falseAlarmsPerDistrictWeek 0.3953, precision 0.2258 — matching src/data/warning-rule.json and the feed's method.validation block. 3 rounds x 42 districts = 126 surges as stated. The unflattering numbers (23% precision, 59 rules that failed, the slowest assistant answer at 11.2 s being over budget) are all published rather than hidden — README.md:401-402 says so in as many words.

FEED SCHEMA — src/data/early-warnings.json validates cleanly against docs/indicator-schema.json (required fields, types, enums, bounds): zero violations. Signal ids are unique; every area code, name, region and population matches the snapshot exactly. public/docs/indicator-schema.json is byte-identical to docs/indicator-schema.json and serves 200 at the URL the feed advertises.

UI SURFACES — no hard-coded figure in any .tsx under src/app or src/components. The landing page routes everything through src/lib/landing-figures.ts derive(), which passes published totals straight through and derives only netCash, consolidation saving and break-even from two published totals each.

GIT — src/data/india-raw-outline.geojson (10.7 MB) and docs/demo/*.webm (25 MB) are correctly gitignored; the simplified india-outline.json the build actually uses is tracked. Nothing large or secret is committed. No app code imports the multi-megabyte demand/anomaly/footfall artefacts, so they stay out of the bundle.

