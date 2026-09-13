# The audit prompt

*A reusable prompt for a hostile, evidence-bound audit of this repository, and for scoring it the way
the Hack2Skill panel will. Run it with a fresh model that has not seen the work being audited — an
auditor who wrote the code grades its own homework.*

*This is the prompt; `scripts/` holds the things that check automatically. The two are complementary:
`npm test` proves the invariants somebody already thought of, and this prompt exists to find the ones
nobody did.*

---

## Part 1 — The audit

> You are auditing **Aarogya Grid**, a finished and deployed hackathon submission.
> Repo root: `<path>`. Live: `<url>`.
>
> You are not here to be encouraging. You are here to find the thing that, discovered by a judge on
> demo day, would cost this project the round. Assume it exists. Your success is measured in defects
> found and proven, not in reassurance offered.
>
> ### Hard rules — violating any of these invalidates your work
>
> 1. **Read-only.** Do not edit, create or delete any file. Do not commit, push or deploy. Do not run
>    `npm test`, `npm run build` or `npm run snapshot` — they take minutes. Cheap read-only commands
>    (`grep`, `sed`, `node -e`, `curl` against the live URL) are encouraged.
> 2. **Evidence or it did not happen.** Every finding cites a real `file:line` and quotes the actual
>    code or command output. If you cannot point at the line, you do not report it.
> 3. **No style opinions.** Naming, formatting, "could use a library", and "add more tests" in the
>    abstract are not findings. Neither is any trade-off the codebase has explicitly documented — read
>    the docstrings before disagreeing with them; this project argues for its decisions at length and
>    re-litigating one is noise, not signal.
> 4. **Calibrate severity honestly.**
>    `critical` = a wrong number reaches a judge, data is lost, there is a security hole, or a
>    published claim is false. `high` = a real defect a user or judge would hit. `medium` = a latent
>    bug or a real, quantified inefficiency. `low` = genuine but minor.
>    **An empty findings list is a valid and respectable answer.** Padding is worse than silence.
> 5. **Refute yourself before reporting.** For each candidate finding, spend one honest attempt
>    trying to prove it is wrong — construct the inputs, walk the path, check whether anything
>    upstream already prevents it. Report only what survives your own attack, and say what you tried.
>
> ### The lenses — cover every one, and say which found nothing
>
> | # | Lens | The question it asks |
> |---|---|---|
> | 1 | **Optimiser correctness** | Across three passes that mutate shared state — donor capacity, batch reservations, waste budget, cumulative giving — is any quantity decremented twice or missed on one path? Can one batch be promised to two orders? Does a district's result depend on the order districts are planned in? |
> | 2 | **Statistical correctness** | Is the DerSimonian–Laird algebra right? Is the log-scale round-trip consistent? Is the leave-one-state-out protocol *actually* leave-one-out — trace whether any information from the scored state reaches the prior it is scored against. Is the held-out backtest genuinely held out? |
> | 3 | **Security and untrusted input** | Attacker-controlled text (a photographed register, a spoken report) reaches an LLM. Can its output cause a write the user did not intend? What is the worst an anonymous user can do to unauthenticated write endpoints? Path traversal on request-derived file reads? SQL built by concatenation? |
> | 4 | **Durability and concurrency** | Is the event fold *total* — does every legal row sequence produce a sane state? Out-of-order sequence numbers, duplicates, unknown actions, rows written before a schema change? Two concurrent commits to one position? Can a restart double-apply? |
> | 5 | **Efficiency** | Where is the code doing more work than it needs to? Name the algorithmic hot spots, the repeated parsing, the loop-invariant recomputation, and the browser payload. **Quantify the expected saving and say how you estimated it.** Propose the smallest change with the largest effect, never a rewrite. |
> | 6 | **Claim integrity** | Extract *every* numeric claim from every judge-facing surface. For each, determine whether the drift guard verifies it; for each it does not, verify it yourself against the shipped artefact. Report only numbers that are actually wrong or unverifiable — then report the coverage percentage separately. |
> | 7 | **Intent conformance** | Where do the docstring and the code disagree? Test every claim of the form "X is enforced", "this never happens because Y", "measured at N", "the only place that does X". One divergence and a reviewer stops trusting all the others. |
> | 8 | **The judge's path** | Follow the README's own 60-second path, step by step, against the live URL. Does each step describe something that exists? What is above the fold at 1366×768 and on a phone? Is the jargon explained? Do the API routes self-describe? |
> | 9 | **Test quality** | Which tests pass *for the wrong reason*? What would have to break for each to go red — if the answer is "almost nothing", that is the finding. Tautologies, `includes` with a short needle on a long document, samples too small to catch the invariant, silent skips reported as passes. What is the highest-risk untested path? |
> | 10 | **AI integration** | Is the foundation model load-bearing or decorative? Trace one shipped number from the model's output to the screen. Is there **any** path where a model-generated number reaches a user-visible surface without passing through a tool result? |
> | 11 | **Data integrity** | Do the national totals equal the sum over the per-district payloads? Do the per-order costs sum to the trip totals? Any NaN, null, Infinity, negative or absurd value in a shipped numeric field? Do all payloads share one schema? |
> | 12 | **Completeness** | What did the other eleven lenses miss — a file nobody opened, a claim nobody checked, a failure that only appears where two lenses meet? Then go and check the most important gap yourself. |
>
> ### Output contract
>
> For each lens: what you actually read and ran; the findings; and — equally important — what you
> checked and found genuinely sound. For each finding: title, severity, category, `file:line`,
> quoted evidence, a **concrete** failure scenario (inputs → wrong output, not "could cause
> problems"), the smallest fix, and your confidence.

---

## Part 2 — The judge panel

> Score this submission as the Hack2Skill panel will.
>
> **The event.** Google Cloud × Hack2skill, *Build with AI: Code for Communities — Second Edition*,
> Problem Statement 03, *Smart Health & Supply Chain Resilience*. PS-03 asks verbatim for a federated
> AI platform at national scale with real-time visibility into **medicine stocks, bed availability and
> medical personnel attendance** across the PHC network; demand forecasting; early warnings **during
> health emergencies**; automated **cross-district** redistribution; and **shared predictive modelling
> across states**.
>
> **The rubric — this is the whole of it.**
>
> | Criterion | Weight |
> |---|---:|
> | AI / Technical Execution | 25 |
> | Problem–Solution Fit | 20 |
> | Depth & Reach Across India | 20 |
> | Deployability & Scalability | 20 |
> | Impact Potential | 15 |
>
> **Hard requirements**: Google AI integration is mandatory; five artefacts (public repo, 3–5 min
> video, 10–12 slide deck, 2–3 line description, live link); designed for cross-border applicability
> to BRICS nations.
>
> **The funnel.** 11,853 registrations. Only the **Top 20** advance. Score accordingly: *good* does
> not advance — only *distinctly better than the twentieth-best of twelve thousand* advances.
>
> **The benchmark.** Edition 1's Smart Health winner was **HealthGrid AI** — two people, four days,
> one district, playbook public. Edition 2's PS-03 is that brief scaled up, and the words it **adds**
> are: *entire PHC network, federated, health emergencies, cross-district, shared predictive modelling
> across states*. A submission that does not visibly beat HealthGrid AI on those five has not earned a
> slot.
>
> **Score from five independent personas**, each reading the artefacts first-hand, and do not let
> them converge:
>
> 1. **The screening reviewer** — 40 submissions today, eight minutes each, scores the rubric and not
>    the vibe, unimpressed by engineering that is not visible in the first two minutes.
> 2. **The Google Cloud engineer** — reads the code, asks whether the AI is load-bearing, whether the
>    ML is sound, whether claims are measured or asserted. Has opinions about MASE versus MAPE and
>    about people who say "federated" when they mean "we have a state column".
> 3. **The state health official** — winners are evaluated for ministry pilots. Does not care about
>    the model. Asks what a district officer does differently on Monday morning, whether anyone is
>    *allowed* to do what it recommends, and how honestly the simulated data is labelled.
> 4. **The Edition 1 judge** — scored HealthGrid AI. Judges purely by comparison. Alert to scope
>    inflation masquerading as ambition, and to work that impresses engineers and is illegible to
>    everyone else.
> 5. **The adversary** — assumes every impressive number is wrong until checked; picks three at
>    random from the deck and tries to reproduce them from the repo. One false claim and they argue
>    to reject. But they weight *honesty about limitations* positively.
>
> Each persona: score every line with a justification citing something specific they looked at; a
> total out of 100 and out of 10; an honest **Top-20 probability** with reasoning against the base
> rate; which of the five added words this beats HealthGrid AI on; and the **highest-leverage fixes
> ranked by score moved per unit of work**, given the days remaining.
>
> A 9/10 means *one of the twenty best of twelve thousand*. Do not be generous. Do not be contrarian
> either — if it is genuinely strong, say so and say why.

---

## Why the prompt is shaped this way

Five things make an audit prompt work, and each maps to a rule above.

**Assume the defect exists.** "Check whether there are bugs" invites "looks good to me". "Find the
thing that would cost you the round; assume it exists" makes absence a claim the auditor has to
defend.

**Bind every claim to evidence.** `file:line` plus a quote converts an opinion into something
falsifiable. It is also the cheapest possible filter against a confident hallucination.

**Pre-refute.** The single highest-yield instruction in the whole prompt is *try to prove your own
finding wrong before reporting it*. In the run that produced this file, independent skeptics refuted
a large share of first-pass findings — every one of which would otherwise have cost a reader the time
to check.

**Name the lenses.** An open-ended "audit this" collapses onto whatever the model is best at. Twelve
named lenses with their own questions force coverage of the parts nobody enjoys reading, and asking
each lens to report what it found *sound* stops silence being mistaken for absence.

**Make "nothing found" respectable.** Without that permission, an auditor pads. Padding is worse than
silence: it costs the reader real time and it trains them to skim the next report.
