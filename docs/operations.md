# Operating Aarogya Grid

Everything a deployment needs, as the commands that create it. Every command
below was written against the live project; each is idempotent or says what
happens on a second run. Replace `PROJECT` with the project id and `SERVICE_URL`
with the service's URL (`gcloud run services describe aarogya-grid
--region=asia-south1 --format='value(status.url)'`).

## What runs where

```
                 Cloud Scheduler  02:30 IST
                        │  runs
                        ▼
  IDSP bulletins ─► Cloud Run Job  aarogya-batch ──► BigQuery AI.DETECT_ANOMALIES
  (dhs.kerala.gov.in)   │  rebuilds the feed, re-proves the plan
                        ▼
                 Cloud Storage  runs/<runId>/ , runs/latest.json
                        │                          ▲
                        │ batch.published          │ reads the run
                        ▼                          │
                 Pub/Sub aarogya-events ◄──► Cloud Run service aarogya-grid  (1–4 instances)
                        ▲   every commit and          │  ├─ Vertex AI Gemini (asia-south1)
                        │   ticket transition         │  ├─ BigQuery stock_events, dispatch_tickets
                        │   fans out to every         │  ├─ Cloud Storage tickets/ (conditional writes)
                        └── instance's subscription   │  └─ Secret Manager aarogya-session-secret
```

All of it is in `asia-south1`.

## One-time setup

**1. APIs** (the rest are already on):

```sh
gcloud services enable secretmanager.googleapis.com cloudscheduler.googleapis.com
```

**2. The durable log, the topic and the bucket.** Creates the BigQuery dataset
and both tables (and adds any column the code has since added), the Pub/Sub topic
and its audit subscription, and the Cloud Storage bucket with a bucket-scoped
grant for the service account:

```sh
npm run provision:cloud            # --check reports without creating anything
```

**3. Fan-out permissions.** Each instance creates, reads and deletes its own
subscription; a custom role gives the service account exactly that:

```sh
gcloud iam roles create aarogyaLiveFanout --project=PROJECT \
  --title="Aarogya live fan-out" --stage=GA \
  --permissions=pubsub.subscriptions.create,pubsub.subscriptions.delete,pubsub.subscriptions.consume,pubsub.subscriptions.get,pubsub.topics.attachSubscription
gcloud projects add-iam-policy-binding PROJECT \
  --member=serviceAccount:aarogya-vertex@PROJECT.iam.gserviceaccount.com \
  --role=projects/PROJECT/roles/aarogyaLiveFanout
```

**4. The session secret.** Every instance must verify a session any other
instance issued, so the key lives in Secret Manager. Without it the service
refuses every write (503) rather than signing with something guessable:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))" | \
  gcloud secrets create aarogya-session-secret --data-file=- \
    --replication-policy=user-managed --locations=asia-south1
gcloud secrets add-iam-policy-binding aarogya-session-secret \
  --member=serviceAccount:aarogya-vertex@PROJECT.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

**5. Google sign-in.** In Google Auth Platform → Clients → the web client
(`215071922486-bljepoq7kgqbuc30rtcv6noe6ou80qrt.apps.googleusercontent.com`):

- Authorised JavaScript origins: `SERVICE_URL` (and `http://localhost` plus
  `http://localhost:3000` for development; Google wants both)
- Authorised redirect URIs: `SERVICE_URL/api/auth/google`

The button posts back to whatever origin the page was opened on, and Cloud Run
answers on two (`gcloud run services describe aarogya-grid --region=asia-south1
--format='value(metadata.annotations."run.googleapis.com/urls")'`), so register
both.

In Branding: home page `SERVICE_URL`, privacy policy `SERVICE_URL/privacy`, terms
`SERVICE_URL/terms`. The authorised domain is the service's **full hostname**,
not `run.app`: `*.run.app` is on the Public Suffix List, so the console refuses
`run.app` and every `<region>.run.app` as "not a top private domain". Add one
per URL. Leave Data Access empty (sign-in needs only `openid`, `email` and
`profile`, which are not sensitive) and do not upload a logo: either would put
the app through Google's verification. Then **Audience → Publish app**. While
the app is in *Testing*, only the listed test users can sign in.

## Deploying the service

```sh
gcloud run deploy aarogya-grid --source=. --region=asia-south1 \
  --min-instances=1 --max-instances=4 \
  --service-account=aarogya-vertex@PROJECT.iam.gserviceaccount.com \
  --update-env-vars=AAROGYA_MAX_INSTANCES=4,AAROGYA_RUN_BUCKET=PROJECT-aarogya,AAROGYA_STATE_BUCKET=PROJECT-aarogya \
  --update-secrets=AAROGYA_SESSION_SECRET=aarogya-session-secret:latest \
  --quiet
```

Run it from a POSIX shell (Cloud Shell, bash, zsh). Windows PowerShell reads the
commas in `--update-env-vars` as an array and hands gcloud one space-joined
value, so the first deploy of this command set `AAROGYA_MAX_INSTANCES` to
`4 AAROGYA_RUN_BUCKET=… AAROGYA_STATE_BUCKET=…` and neither bucket at all; the
service then quietly served the bundled run and kept tickets per instance.
`curl -s SERVICE_URL/api/overlay | jq .run.source` says `gcs` when it is right.

`AAROGYA_MAX_INSTANCES` must equal `--max-instances`: it is what the rate
limiter divides its bill ceiling by. `--update-env-vars` adds to the variables
already set (the Vertex project, location and model names); `--set-env-vars`
would replace them.

## The nightly batch

```sh
# The image: the repository plus tsx and pdf.js (Dockerfile.batch).
gcloud builds submit --config=cloudbuild.batch.yaml --region=asia-south1 .

# The job. The long stage is the plan rebuild that the reproduction gate needs
# (1,020 s on four laptop threads; 268 s and 361 s in the job's first two
# successful runs, which sized their pools at 8 and 7 threads). The hour is a
# ceiling.
gcloud run jobs deploy aarogya-batch --region=asia-south1 \
  --image=asia-south1-docker.pkg.dev/PROJECT/cloud-run-source-deploy/aarogya-batch:latest \
  --cpu=8 --memory=16Gi --task-timeout=3600s --max-retries=0 \
  --service-account=aarogya-vertex@PROJECT.iam.gserviceaccount.com \
  --set-env-vars=GOOGLE_CLOUD_PROJECT=PROJECT,GOOGLE_CLOUD_LOCATION=asia-south1,AAROGYA_RUN_BUCKET=PROJECT-aarogya

# Run it once by hand and watch it publish (five to seven minutes). Each execution
# resolves :latest when it starts, so a rebuilt image is picked up by the next
# run without redeploying the job.
gcloud run jobs execute aarogya-batch --region=asia-south1 --wait

# Schedule it.
gcloud iam service-accounts create aarogya-scheduler --display-name="Aarogya nightly batch trigger"
gcloud run jobs add-iam-policy-binding aarogya-batch --region=asia-south1 \
  --member=serviceAccount:aarogya-scheduler@PROJECT.iam.gserviceaccount.com --role=roles/run.invoker
gcloud scheduler jobs create http aarogya-batch-nightly --location=asia-south1 \
  --schedule="30 2 * * *" --time-zone="Asia/Kolkata" \
  --uri="https://run.googleapis.com/v2/projects/PROJECT/locations/asia-south1/jobs/aarogya-batch:run" \
  --http-method=POST \
  --oauth-service-account-email=aarogya-scheduler@PROJECT.iam.gserviceaccount.com
```

What a run does, and what it refuses to do, is in the header of
`scripts/batch-job.mts`. In short: new IDSP bulletins → the detector → the
early-warning feed; a full rebuild of the simulated plan that must match the
committed reference or nothing is published; then `runs/<runId>/`, the
`runs/latest.json` pointer, and a `batch.published` message that moves every
instance to the new run at once.

**Is it working?**

```sh
curl -s SERVICE_URL/api/overlay | jq '.run | {runId, source, publishedAt, fallbackReason}'
gcloud run jobs executions list --job=aarogya-batch --region=asia-south1 --limit=5
gcloud scheduler jobs describe aarogya-batch-nightly --location=asia-south1 --format='value(lastAttemptTime,status)'
```

`source: "bundled"` means no run has been published, or the published one could
not be read -- `fallbackReason` says which.

## Rehearsals against the deployment

Every write needs a signed-in actor. The rehearsal and recording scripts mint a
short operator session per role with the secret above (they read it through
`gcloud secrets versions access`, so only someone who can read the secret can
act as an operator), and every row they write says `operator · <role>`:

```sh
npm run rehearse:live -- SERVICE_URL
npm run rehearse:dispatch -- SERVICE_URL
npm run rehearse:browsers -- SERVICE_URL
npm run record:submission -- SERVICE_URL
```

The recording also needs `ffmpeg`/`ffprobe` on PATH and the Text-to-Speech API: the narration is
synthesized (and cached under `docs/demo/voice-cache/`) before the browser starts. Hear and check a
changed line without touching the live board first:

```sh
npm run record:submission -- SERVICE_URL --voice-only
npx tsx scripts/check-narration.mts docs/demo/voice-cache/lines.json
```

A take commits a report and moves a ticket, so clear the board afterwards (below).

Two-instance behaviour is rehearsed locally against the real project, because
Cloud Run will not be told which instance to route a request to:

```sh
npm run build && AAROGYA_STATE_BUCKET=PROJECT-aarogya npm run rehearse:scale
```

## Clearing the board before a demonstration

```sh
AAROGYA_STATE_BUCKET=PROJECT-aarogya npm run overlay:purge -- --all --recreate
```

That empties both log tables and the ticket objects. Running instances still hold
what they restored, so replace them afterwards by redeploying the same image:

```sh
gcloud run deploy aarogya-grid --region=asia-south1 --quiet \
  --image="$(gcloud run services describe aarogya-grid --region=asia-south1 --format='value(spec.template.spec.containers[0].image)')"
```

## Re-checking the observed data

```sh
npm run idsp:verify
```

Re-downloads every bulletin the manifest lists, checks each is byte-identical to
the recorded SHA-256, and re-parses it to the committed numbers.
