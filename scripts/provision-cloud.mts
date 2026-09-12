/**
 * Create the two cloud resources WS2 durability needs. Idempotent.
 *
 * WHAT THIS CREATES AND WHY IT IS THE ONLY THING CREATED
 * -----------------------------------------------------
 * Until this point the project provisioned nothing at all: `AI.FORECAST` over
 * an inline subquery needs no dataset, scans no table and is billed for no
 * bytes, so the entire forecasting stack ran against a project with zero
 * BigQuery resources in it. Durability is the first feature that cannot work
 * that way -- a restart has to be able to read back what was written -- so it
 * gets a dataset, and nothing else does.
 *
 *   BigQuery dataset  aarogya_grid          (asia-south1)
 *     table           stock_events          partitioned by day, clustered by facility
 *   Pub/Sub topic     aarogya-events
 *     subscription    aarogya-events-audit  so messages are retained from now on
 *
 * WHY A SCRIPT RATHER THAN A CONSOLE CLICK-PATH
 * ---------------------------------------------
 * A reviewer must be able to reproduce the backend, and a resource whose
 * definition exists only in somebody's browser history is not reproducible. The
 * schema is read from `src/lib/durable/schema.ts`, so the table and the code
 * that writes to it cannot drift: change a column there and re-running this
 * patches the table.
 *
 * Run:  npm run provision:cloud            (create or patch)
 *       npm run provision:cloud -- --check (report only, create nothing)
 */
import {
  googleRequest,
  resolveProjectId,
  resolveLocation,
  GoogleApiError,
} from '../src/lib/gcp/request';
import {
  DATASET,
  PUBSUB_TOPIC,
  PUBSUB_SUBSCRIPTION,
  TABLE_SPECS,
  type TableSpec,
} from '../src/lib/durable/schema';

const BQ = 'https://bigquery.googleapis.com/bigquery/v2';
const PS = 'https://pubsub.googleapis.com/v1';

const checkOnly = process.argv.includes('--check');

const projectId = await resolveProjectId();
const location = resolveLocation();

console.log('Aarogya Grid -- cloud provisioning');
console.log('  project  :', projectId);
console.log('  location :', location);
console.log('  mode     :', checkOnly ? 'check only (creates nothing)' : 'create or patch');
console.log('');

const actions: string[] = [];
const missingInCheck: string[] = [];

function notFound(e: unknown): boolean {
  return e instanceof GoogleApiError && e.status === 404;
}

// ------------------------------------------------------------------ dataset

let datasetExists = true;
try {
  await googleRequest(BQ + '/projects/' + projectId + '/datasets/' + DATASET);
  console.log('dataset  ' + DATASET + ': exists');
} catch (e) {
  if (!notFound(e)) throw e;
  datasetExists = false;
  if (checkOnly) {
    missingInCheck.push('dataset ' + DATASET);
    console.log('dataset  ' + DATASET + ': MISSING');
  } else {
    await googleRequest(BQ + '/projects/' + projectId + '/datasets', {
      method: 'POST',
      data: {
        datasetReference: { projectId, datasetId: DATASET },
        location,
        description:
          'Aarogya Grid durable event log. Written by the live loop (WS2); ' +
          'read back on container start to restore the overlay.',
        labels: { app: 'aarogya-grid' },
      },
    });
    datasetExists = true;
    actions.push('created dataset ' + DATASET);
    console.log('dataset  ' + DATASET + ': CREATED in ' + location);
  }
}

// ------------------------------------------------------------------- tables

async function ensureTable(spec: TableSpec): Promise<void> {
  const base = BQ + '/projects/' + projectId + '/datasets/' + DATASET + '/tables';
  const body = {
    tableReference: { projectId, datasetId: DATASET, tableId: spec.name },
    description: spec.description,
    schema: { fields: spec.fields },
    ...(spec.partitionField
      ? { timePartitioning: { type: 'DAY', field: spec.partitionField } }
      : {}),
    ...(spec.clustering ? { clustering: { fields: spec.clustering } } : {}),
  };

  try {
    const existing = await googleRequest<{ schema?: { fields?: { name: string }[] } }>(
      base + '/' + spec.name,
    );
    const have = new Set((existing.schema?.fields ?? []).map((f) => f.name));
    const missing = spec.fields.filter((f) => !have.has(f.name)).map((f) => f.name);
    if (missing.length === 0) {
      console.log('table    ' + spec.name + ': exists, schema matches');
      return;
    }
    if (checkOnly) {
      missingInCheck.push(spec.name + ' columns ' + missing.join(', '));
      console.log('table    ' + spec.name + ': exists, MISSING columns ' + missing.join(', '));
      return;
    }
    // Adding columns is the only schema change BigQuery accepts in place, and
    // it is the only one this project should ever need: the log is append-only,
    // so an old row simply has NULL where a new column was added.
    await googleRequest(base + '/' + spec.name, { method: 'PATCH', data: { schema: body.schema } });
    actions.push('patched ' + spec.name + ' (+' + missing.join(', ') + ')');
    console.log('table    ' + spec.name + ': PATCHED, added ' + missing.join(', '));
  } catch (e) {
    if (!notFound(e)) throw e;
    if (checkOnly) {
      missingInCheck.push('table ' + spec.name);
      console.log('table    ' + spec.name + ': MISSING');
      return;
    }
    await googleRequest(base, { method: 'POST', data: body });
    actions.push('created table ' + spec.name);
    console.log(
      'table    ' + spec.name + ': CREATED (' +
        spec.fields.length + ' columns, partitioned by ' + spec.partitionField + ')',
    );
  }
}

if (datasetExists) {
  for (const spec of TABLE_SPECS) await ensureTable(spec);
} else {
  console.log('table    (skipped -- no dataset)');
}

// ------------------------------------------------------------------ pub/sub

const topicPath = 'projects/' + projectId + '/topics/' + PUBSUB_TOPIC;
try {
  await googleRequest(PS + '/' + topicPath);
  console.log('topic    ' + PUBSUB_TOPIC + ': exists');
} catch (e) {
  if (!notFound(e)) throw e;
  if (checkOnly) {
    missingInCheck.push('topic ' + PUBSUB_TOPIC);
    console.log('topic    ' + PUBSUB_TOPIC + ': MISSING');
  } else {
    await googleRequest(PS + '/' + topicPath, {
      // Pub/Sub creates a topic with PUT on the topic path, not POST to a
      // collection -- the one place this project departs from the BigQuery shape.
      method: 'PUT',
      data: { labels: { app: 'aarogya-grid' } },
    });
    actions.push('created topic ' + PUBSUB_TOPIC);
    console.log('topic    ' + PUBSUB_TOPIC + ': CREATED');
  }
}

const subFullPath = 'projects/' + projectId + '/subscriptions/' + PUBSUB_SUBSCRIPTION;
try {
  await googleRequest(PS + '/' + subFullPath);
  console.log('sub      ' + PUBSUB_SUBSCRIPTION + ': exists');
} catch (e) {
  if (!notFound(e)) throw e;
  if (checkOnly) {
    missingInCheck.push('subscription ' + PUBSUB_SUBSCRIPTION);
    console.log('sub      ' + PUBSUB_SUBSCRIPTION + ': MISSING');
  } else {
    await googleRequest(PS + '/' + subFullPath, {
      method: 'PUT',
      data: {
        topic: topicPath,
        messageRetentionDuration: '604800s',
        ackDeadlineSeconds: 30,
        labels: { app: 'aarogya-grid' },
      },
    });
    actions.push('created subscription ' + PUBSUB_SUBSCRIPTION);
    console.log('sub      ' + PUBSUB_SUBSCRIPTION + ': CREATED');
  }
}

console.log('');
if (checkOnly) {
  console.log(
    missingInCheck.length === 0
      ? 'Everything is in place.'
      : 'MISSING (' + missingInCheck.length + '): ' + missingInCheck.join(' · '),
  );
  // A check that finds something missing must fail, or a CI step that calls it
  // reports success against a backend that cannot store anything.
  if (missingInCheck.length > 0) process.exitCode = 1;
} else if (actions.length === 0) {
  console.log('Everything already in place.');
} else {
  console.log('Changes: ' + actions.join(' · '));
}
console.log('');
console.log('The Cloud Run service account also needs:');
console.log('  roles/bigquery.jobUser   (project)  -- to run the restore query');
console.log('  roles/bigquery.dataEditor (dataset) -- to append and read rows');
console.log('  roles/pubsub.publisher   (topic)    -- to fan out the audit trail');
