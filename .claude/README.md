# The harness

Adapted from the `modelpin` project's `.claude/` setup on 12 Sep 2026. **Adapted, not copied** —
Modelpin is a Python CLI published to PyPI, so most of its roster has no analogue here. What was
brought over is listed below, with what was deliberately left behind and why.

## What is here

| | | |
|---|---|---|
| `agents/claims-auditor.md` | opus | Audits judge-facing prose against the shipped payloads. The **judgement** layer above `scripts/check-claims.mts`, which is the mechanical one. |
| `agents/judge-path-auditor.md` | opus | Runs the entry cold, on the live URL and from a fresh clone, and reports time-to-differentiator. |
| `agents/bug-reproducer.md` | opus | First step on any suspected bug. A reproduction before a fix, or a report that there is none. |
| `commands/verify.md` + `scripts/verify.mjs` | — | The local gate: lint, types, tests, build, live/repo parity. One table, and `SKIPPED` is not green. |
| `settings.json` | — | A read-only command allowlist, and a **deny on `.env*`** — `.env.local` carries a live key. |

## Why these three agents and not the other nine

Each maps onto a failure this project has actually produced, or that a judge's-eye audit predicted:

- **claims-auditor** — "claims don't match artefacts" is the repeat elimination cause across this
  maintainer's rejected entries. The deck cited a district payload by filename and disagreed with it
  in every field; a Vercel mirror contradicted the deck for weeks.
- **judge-path-auditor** — "the differentiator is unreachable in ten minutes" is the other one. The
  live link served a rejected build; the flagship capture loop ends at a disabled button.
- **bug-reproducer** — provider-agnostic, and it encodes the trap this repo produced on 12 Sep: the
  alert-board payload was perfectly balanced while the rendered first screen was unchanged. Every
  data-level assertion passed.

## What was left behind, deliberately

- `live-run` and `release` — Modelpin's only two actual *skills*. BYO-key Python provider calls and
  PyPI publishing. Nothing here to map them onto.
- `fp-guardian`, `mutation-sentinel`, `provider-sdk-verifier`, `packaging-verifier` — all bound to
  Modelpin's statistics, its provider adapters, or its wheel.
- `traction-analyst`, `wedge-warden`, `backlog-ranker` — product-strategy roles for a solo founder
  choosing what to build. This project's backlog is fixed: the approved Part C calendar to 30 Sep.
- `harness-medic` — audits hooks. There are none here.
- `/next`, `/wrap`, `/where`, `/adr` — all read `ops/BACKLOG.md`, `ops/NOW.md`, `ops/LOG.md` and
  `ops/decisions/`. That whiteboard does not exist in this repo, and standing it up 18 days from a
  deadline would be new process rather than new progress.

## What would have been actively harmful

`hooks/pre_bash_guard.py` blocks `git push` from `main`. Modelpin works on branches; **this project
commits and pushes to `main` daily by design**, and the live service deploys from that tree. Copying
it would have blocked the workflow the plan depends on.

`includeCoAuthoredBy: false` likewise: this repo's commits carry an attribution trailer.

## House rules every agent here carries

**Never revert, discard, or delete anything you did not create in your own invocation.** Agents share
the caller's live working tree, not a sandbox. Work that contradicts your brief is a finding you
report, never a thing you correct.

**Never run `npm run snapshot`** from a subagent. Four minutes, 129 rewritten artefacts.

**Never deploy and never push** from a subagent.
