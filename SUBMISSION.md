# Submission — Build with AI: Code for Communities (Second Edition)

**Problem statement 03 — Smart Health & Supply Chain Resilience**

| | |
|---|---|
| **Live** | <https://aarogya-grid-215071922486.asia-south1.run.app> · Cloud Run, `asia-south1` |
| **Repository** | <https://github.com/samarthputhraya/aarogya-grid> · Apache-2.0 |
| **Deck** | [`docs/pitch-deck.pdf`](docs/pitch-deck.pdf) — 12 slides, 16:9 |
| **Video** | 3 min 32 s, one continuous captioned take against the live service. Script and timings: [`docs/demo-script.md`](docs/demo-script.md); regenerate with `npm run record:submission -- <url>` |
| **Defence pack** | [`DEFENSE.md`](DEFENSE.md) |
| **Gate** | `node .claude/scripts/verify.mjs` — lint, types, 25 suites, the build, and live/repo parity in one table |

---

## Description

> Aarogya Grid is a federated early-warning grid for India's primary health network. It forecasts
> demand at every facility–drug position — on Google's **TimesFM** wherever a held-out backtest says
> TimesFM wins, and Croston where it does not — an anomaly detector flags outbreak
> surges a median of four days before the first shelf empties — and, on Kerala's real IDSP bulletins, flags
> observed rises in notified cases — and the planner issues **cross-district
> dispatch orders** that move surplus stock which already exists — no new procurement. An ANM reports
> her stock by speaking Hindi into a phone; Gemini reads it, she confirms it, and the national board
> changes in under a second.
>
> All thirty-six states and union territories each fit their own model and share **only model
> statistics** — 56,660 numbers, and zero facility rows — so a state joining the grid with a month of
> history forecasts 36.0% closer to observed demand without handing over any data.

*(Two-line version, if the form is short: Aarogya Grid forecasts medicine stock-outs across India's
PHC network with Google's TimesFM, spots outbreak surges days early, and moves stock that already
exists across district lines before a shelf empties. States keep their data and share only models.)*

---

## What is here, and where to look first

A reviewer with ten minutes should spend it on the live link, not in this file. The
[README](README.md) opens with a three-step path through the product. If you only have three
minutes, watch the video; if you only have one, open `/console`.

| The brief asks for | Where it is |
|---|---|
| Entire PHC network | 12,010 facilities across 769 districts in all 36 states and union territories, Sub-Centre to District Warehouse — `/console` |
| Predictive modelling | BigQuery `AI.FORECAST` (TimesFM 2.0) over 36,143 series, 21 days ahead, with a 28-day held-out backtest that **publishes where it loses** — `docs/forecast-backtest.md` |
| Health emergencies | `AI.DETECT_ANOMALIES` + a rule tuned against 126 injected surges, publishing detection, lead time, false alarms **and 21% precision** — `docs/warning-tuning.md`; the same detector on **242 real Kerala IDSP bulletins** raises observed signals, each linked to its bulletin |
| Cross-district | 6,415 vehicle trips reach another district, carrying 15,930 orders over 2,348 corridors — and each one says who has to countersign it |
| Federated | 36 state and union-territory nodes at `/api/federated`, each fetchable and hashable — `docs/federated.md` |
| Shared modelling across states | Measured leave-one-state-out: 36.0% closer at 30 days of history |

---

## Verified before submitting

Everything below was run, not remembered. `node .claude/scripts/verify.mjs` prints the table.

- [x] **Public repository**, pushed, homepage field pointing at the Cloud Run URL.
- [x] **Live URL responds** on every route — `/`, `/console`, `/capture`, all 769 district pages, and
      six API routes — and cold-loads well inside three seconds.
- [x] **The full loop works on the live URL**: sign in → spoken Hindi → Gemini → a human confirms → commit →
      server re-score in 14 ms → both open tabs updated in 377 ms → approve → dispatch → receive
      short, with the variance recorded. Recorded in one take.
- [x] **SSE survives the load balancer** — `X-Accel-Buffering: no`, first frame flushed immediately,
      and the change survives a reload because every page fetches the overlay on mount as well as
      subscribing.
- [x] **Cross-browser**: Chromium, Firefox, WebKit and an iPhone viewport, all four routes, clean
      console, no failing request — `npm run rehearse:browsers -- <url>`.
- [x] **Assistant median 5.1 s** over five real questions against the real model (budget 8 s). The
      slowest, a national fan-out across ten tool calls, is 11.2 s and is stated as over budget.
- [x] **`npm test` green in a fresh clone**: 25 suites including a leakage sweep with a positive
      control, a donor-guardrail audit against an independent redraw, and 289 drift-guarded claims.
- [x] **Every figure on every surface** is derived from `src/data/national-snapshot.json` or from the
      script that measured it. The guard covers the README, the deck, the defence pack and the
      artefacts themselves.
- [x] **"Simulated" is labelled** in the console header, on the landing page, on every district page
      and itemised in `NOTICE`.
- [x] **The deck opens on a phone** — checked at 390 px, not in a narrowed desktop window, which is
      how the missing viewport meta went unnoticed until it was.

## What we own before being asked

- Facility-level stock, consumption, batches and expiries are **simulated**. Districts, LGD codes,
  Census 2011 populations, the NLEM catalogue, IPHS norms and the **Kerala IDSP disease counts** are real.
- **Roles are claimed.** Every write needs a Google sign-in and records who acted, but there is no role
  directory: the role an officer acts in is recorded as claimed.
- **More than one instance is rehearsed, not load-tested.** Two production servers against the real
  project agree on every report and approve a raced order once; nobody has put a district's traffic on it.
- The federated **τ² is synthetic** — one seeded simulator behind all thirty-six.
- **21% precision** on the outbreak warning, published next to the 78 rules that failed — and measured on
  simulated surges, not on the observed Kerala signals the same rule now raises.
- The video is **captioned, not narrated**.

Full answers, each with one number and a file you can open, are in [`DEFENSE.md`](DEFENSE.md).
