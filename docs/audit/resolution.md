# Audit resolution — 13 Sep 2026

What happened to every finding in [findings.md](findings.md). Each line says what changed and what
now fails `npm test` if it comes back. "Guard" means a check in `scripts/check-claims.mts` or a test
suite that was shown to FAIL against the pre-fix code or text before it was accepted.

**Summary:** 47 of 47 confirmed findings addressed (45 fixed, 2 closed without a code change with the
reason stated). 12 unverified leads checked: 9 were real and fixed, 3 were not defects.

## Figures that moved

The critical risk-engine bug changed every risk number, so the snapshot was rebuilt. Three
consecutive builds were byte-identical apart from `builtAt`, at 118.9 / 119.0 / 122.7 s.

| | before | after |
|---|---:|---:|
| critical / high positions | 4,683 / 5,591 | 4,696 / 5,736 |
| dispatch orders / trips | 5,578 / 2,078 | 5,596 / 2,090 |
| cross-district trips / orders | 615 / 1,579 | 610 / 1,576 |
| corridors / cross-state | 174 / 29 | 178 / 32 |
| ride-alongs | 3,008 | 2,994 |
| shortfall averted | 5,42,644 | 5,89,873 |
| transport / net cash | ₹29.8 L / ₹26.0 L | ₹30.1 L / ₹26.3 L |
| break-even / net benefit | ₹4.79 / ₹1.92 Cr | ₹4.46 / ₹1.89 Cr |
| surge example (Purnia) | 14 of 76, 35 at emergency, ₹31,906 | 5 of 78, 13 at emergency, ₹9,752 |
| guardrail audit | 196 donors, worst 3.0%, rise 1.5 pp | 194 donors, worst 5.0%, rise 1.6 pp |
| federated headline | 38.4% | 38.3% |
| indicator feed | 297 signals | 278 signals |
| build band | 190-240 s | 115-240 s |
| drift-guarded claims | 121 | 177 |

The surge example fell because donors on monsoon drugs had been simulated at about half their real
demand, so the guardrail now binds on them honestly.

## CRITICAL

| # | Finding | Outcome | Guard |
|---|---|---|---|
| C1 | "TimesFM forecasts every facility–drug pair" | Reworded on README, SUBMISSION and the deck to per-class wording | `mustNot` on README, SUBMISSION, DEFENSE, deck and demo script; fired on the old text |
| C2 | "59 / 60 rules" | 80 scored, 78 failed on all four surfaces | Both counts derived from `docs/warning-tuning.json` with the gate re-applied; `mustNot /(59\|60) rules/` |
| C3 | `crostonDayParams` de-seasonalised smooth drugs twice | Size re-anchored so `p·E[Z] = meanDemand·mult` with the coefficient of variation kept; this also fixes the SBA deflator | `test-timesfm.mts`: Monte Carlo mean equals `forecastDailyDemand` for every method and profile. Old code 0.535, new code 0.988. The Lucknow row now reads 97%, critical |

## HIGH

| Finding | Outcome |
|---|---|
| `explain_forecast` / console name the Croston variant on TimesFM rows | `forecastSource` added to `positionView` and `explain_forecast` with a note; the console shows "TimesFM + sba". Offline agent test |
| `list_positions` national branch says "none" for Essential | Snapshot gains `alertTotals.byCriticality`; payload reports `boardScope`, the national matching count, and an explicit "do not say none" note. Offline agent test |
| README cold-chain ₹40,065 / 56 | Restated from payloads: 103 riders, 44 pay ₹33,169. Derived claim |
| Deck censoring table unreproducible | `eval-censoring.mts` computes error and writes `src/data/censoring-eval.json`; deck, ForecastPanel and guard all read it |
| README "Ten tools" (reported twice) | 12 registered, 11 default, `simulate_outbreak` opt-in and not a pure read. Claim + `mustNot` |
| Deck "four other orders ride the same vehicle" | "9 other orders: 3 more that justified it and 6 that ride along", derived from the corridor |
| `verify-guardrails` redrew the planner's own samples | `seedSalt` on `leadTimeDemandSamples`; the audit draws with an independent seed. Comments now say what independence buys and what it does not |
| "Both paths are checked in `npm test`" | README, DEFENSE and `client.ts` corrected to what is tested. `mustNot` |
| README 60-second path sent judges to `/` | Step 1 links `/console`; step 3 names the real control. Claim |
| 340 cards say "cutting stock-out risk to 100%" | `riskClause` branches when the percentage does not fall. Shipped-payload check in `verify-batch-bounds.mts` (340 → 0) |
| 19 fractional dispatch quantities | `rescuable` floored at build and `allocateFefo` floors its cap. Shipped-payload check (19 → 0) |
| 7 duplicate order ids | Passes 2 and 3 skip a donor/receiver/drug already issued. Shipped-payload check (7 → 0) |
| Demo script opens with an impossible subset | Two clauses in the generator and in the script; nine derived claims on `docs/demo-script.md` |

## MEDIUM

| Finding | Outcome |
|---|---|
| Fallback sends `thinkingLevel` to 2.5 (reported twice) | Thinking config rebuilt per attempt; fallback also on 503 / UNAVAILABLE / INTERNAL; `thinkingFor` returns the model default for unknown families. Offline agent test |
| Cache hits repeat trace step numbers | A monotonic `traceStep`, separate from the budget counter |
| 326 ms vs 178 ms, no artefact | `rehearse-live.mjs` writes `docs/live-gate.json` on a passing run only. **Surfaces still to be restated from its first live run after deploy** |
| `forecast-runtime.md` 80,896 | Generator reads the snapshot; doc restated. Claim |
| README says populations are not real | Corrected. `mustNot` |
| Kerala "35th" | 32nd, and the worst eight now include West Bengal. Both derived |
| Ticket append failure invisible | `DispatchTicket.durability`; the append resolves to its outcome and the ticket is re-issued over SSE; the strip says "not saved to the audit log" |
| `/api/events` orphaned intervals | `aborted` checked up front, `cancel()` cleans up, a failed enqueue shuts down |
| `seriesSkipped` 0 on three rungs | Counted per rung (47 / 4 / 0 / 13); the build throws if scored + skipped ≠ series |
| `indexSe` 15-25% too wide | Delta method through the overall mean and the shrinkage. se/sd across the sixteen went from 1.08-1.15 to 0.90-0.93. This moved the headline from 38.4% to 38.3% and own-weights from 8.8-13.3% to 19.5-27.3%; every surface was restated |
| `vacancyRateSe` of the wrong estimator | Linearised standard error of the ratio of sums |
| Backtest comparator "as shipped" | True by construction after C3: the Monte Carlo now draws the mean path the backtest scores |
| Population 37.22 vs 37.21 (reported twice) | Landing page uses `compactCount`; rounding `population()` deleted. Claim on the deck tile |
| 116 districts unreachable by keyboard | Bubbles get `role="button"`, `tabIndex`, `aria-label`, Enter/Space; the svg is a `group` when interactive |

## LOW

| Finding | Outcome |
|---|---|
| README fallback wording | Now describes daily quota or unavailable, and says throttles retry the same model |
| Duplicate hard-coded `'29'` claim | Deleted |
| `toISOString` per simulated day | Per-window day table; byte-identical output |
| Full sort for one quantile | Quickselect; 200k fuzzed arrays match a full sort |
| check-claims parses districts three times | One pass |
| `/console` ships 67 KB unread | **Not changed.** The auditor's own advice: 8 KB gzipped, and a projection that drops a field the client reads renders `undefined` on the main screen |
| `pooledStatistics` "per therapeutic group" | "per catalogue item (47)", derived |
| `federated.md` first state's weight | Mean across the sixteen with the range beside it |
| IndiaMap stale 11.2-19.6 | Number dropped |
| Phantom `evaluatePlan` | Points at `netBenefitInr`; hard constraint 1 also corrected to the guardrails |
| "Every result is stamped" | Narrowed, naming the three registry and feed tools |
| Stale "100 KB, 140 positions" illustration | Replaced in `grid-tools.ts`, `grid-agent.ts` and `GridAssistant.tsx` |
| `anyInitialSurplus` read the shared map | `donatableUnits(c) > 0` on the untouched context |
| `test-alerts` tautologies | Asserts board tiers and counts against the population, the VED sums, and that the unlisted-severe case actually occurs |

## UNVERIFIED leads, checked

| Lead | Verdict |
|---|---|
| test-footfall has no positive control | Real: added "the ceiling binds on some days" and "patients are turned away" |
| 12 signals with observed 0 against bound 0 | Real: `warnings.ts` now requires strictly above the bound, the predicate the tuning scored. Feed 297 → 278 signals, none at zero |
| `thinkingFor` sends a 0 budget to Pro | Real: unknown families get the model default |
| test-surge uses >= and <= | Real: made strict |
| verify-batch-bounds passes on zero orders; one check only printed | Real: rewritten with a non-empty check, a failing `batchNo` check, and the shipped-payload half |
| Offline agent guarantees not in `npm test` | Real: `test:agent-offline` added (23 suites) |
| exceedanceRatio ≠ observed / bound for small bounds | Real but intended: the ratio floors the bound at one unit. The contract now says so |
| test-capture `"items"` needle | Real: reads the property's type |
| cross-district and guardrails sample the same districts | Real: cross-district offset by half a stride |
| Deck 37.21 vs live 37.22 | Real; see the population finding |
| 54 inverted prediction intervals | Not a defect: `intervalSigma` clamps at 0, and `forecastDayParams` takes the wider of that and Croston's spread, so an inverted interval falls back to Croston |
| Live-loop latency has no artefact | Same as the MEDIUM finding; closed after the post-deploy run |
