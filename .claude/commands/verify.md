---
description: Run the full local gate (lint, types, tests, build, live/repo parity) and report exactly what a judge and CI would see.
---

Run Aarogya Grid's complete gate. **One command runs all five steps and prints a table:**

```bash
node .claude/scripts/verify.mjs
```

**Paste the runner's table verbatim.** Do not retype it, do not summarise it, and do not quote a
subset of its rows. A checklist of five commands gets run as three when someone is tired, and the
note still says "all green" — the runner exists so that cannot happen silently, but only the table
proves it.

The step's own verdict is the verdict. **`SKIPPED` is not green**: the runner exits non-zero and
says `NOT READY` if any step did not run, including under `--fast`.

### The five steps

| # | step | passes when |
|---|---|---|
| 1 | lint — `npx eslint --max-warnings 0` | exit 0. Warnings are errors here; the config allows none. |
| 2 | types — `npx tsc --noEmit` | exit 0. Note the snapshot is imported as `as unknown as NationalSnapshot`, so **tsc cannot see a field the committed payload is missing** — a green type check is not evidence the data has the shape the code expects. |
| 3 | tests — `npm test` | exit 0 across all suites. This includes `check-claims.mts`, so **a stale figure on the README or the deck fails here**, and `test-alerts.mts`, which asserts the board's first screen spans the facility network rather than just the payload. |
| 4 | build — `npm run build` | exit 0, ~136 routes prerendered. The slowest step; `--fast` omits it. |
| 5 | live/repo parity | the deployed Cloud Run service serves the same headline figures as the committed snapshot. |

### Why step 5 exists

`[M]` For weeks the live Cloud Run URL served a landing page that had been **rejected and rolled back
in git**, while the deck and README quoted the committed figures — and the repo's homepage field
pointed at a Vercel mirror showing numbers from a build months older still. A judge meets the
deployment, not the repository. Steps 1–4 can all be green while the thing being evaluated is a
different product.

If step 5 fails with `live is stale`, the fix is a deploy, not an edit:

```bash
"C:\Users\samar\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd" \
  run deploy aarogya-grid --source=. --region=asia-south1 --quiet
```

Env vars and the service account persist across redeploys — do not re-pass them.

### What this gate does NOT cover

Say so explicitly rather than letting a green table imply it:

- **The snapshot is not rebuilt.** `npm run snapshot` takes ~4 minutes and rewrites 129 committed
  artefacts, so it is deliberately not a step. If you changed the pipeline, the simulator, the
  optimiser or the risk model, the committed payload is stale and every downstream number is a lie
  the guard cannot detect — rebuild before you trust this table.
- **Nothing exercises a microphone or a camera.** The voice and register-photo paths are covered by
  a unit test of the encoder only. The demo's highest-stakes 30 seconds is still a manual rehearsal.
- **No model call is made.** Assistant latency and groundedness are not measured here.

### Flags

- `--fast` — omits steps 4 and 5, the two slow ones. They are then reported `SKIPPED` and the
  verdict is `NOT READY` **on purpose**: a fast pass is for iterating, never for claiming a gate.
- `--no-live` — omits step 5 only, for working offline. Same rule: `NOT READY`.
- `--show N` — dump step N's full captured output, for when a step fails and you need the detail.

Finish with the runner's own verdict line: `READY` or `NOT READY`, and the specific blocking items.
