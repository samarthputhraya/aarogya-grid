/**
 * Remove rows from the durable stock-event log.
 *
 * WHY THIS EXISTS
 * ---------------
 * Durability cuts both ways. Before day 8, a rehearsal that left "4,242
 * sachets" on the board was cleaned up by the next deployment, because the
 * overlay lived in RAM. It does not any more: a test commit is now a permanent
 * row, and the live board will show it to a judge next month unless something
 * takes it out. So the same commit that made the loop trustworthy created the
 * need for a way to say "that one was us".
 *
 * The rehearsals already commit the ledger value back, which is the right fix
 * for the BOARD. This is for the LOG -- the rows themselves.
 *
 * Run:
 *   npm run overlay:purge -- --all                (both tables)
 *   npm run overlay:purge -- --facility DST-22-RAIPUR-DH-001
 *   npm run overlay:purge -- --before 2026-09-19T00:00:00Z
 *   npm run overlay:purge -- --all --recreate     (when DML is refused)
 *
 * "The durable log" is two tables -- committed stock corrections and dispatch
 * ticket transitions -- and a purge that cleared one would leave a board
 * showing tickets against positions that no longer remember them.
 *
 * THE STREAMING-BUFFER TRAP
 * -------------------------
 * Rows appended with `tabledata.insertAll` are queryable immediately but cannot
 * be touched by UPDATE/DELETE/MERGE for up to about 30 minutes. A purge run
 * straight after a rehearsal will therefore be refused, and the refusal looks
 * like a permissions error if you are not expecting it. `--recreate` is the way
 * through: it drops the table and rebuilds it from `schema.ts`, which the
 * streaming buffer cannot object to. It is only accepted with `--all`, because
 * "delete everything" is the only intent it can actually carry out.
 */
import { runQuery, bigQueryEnabled } from '../src/lib/bq/client';
import { googleRequest, resolveProjectId, asGoogleApiError } from '../src/lib/gcp/request';
import {
  DATASET,
  STOCK_EVENTS_SPEC,
  DISPATCH_TICKETS_SPEC,
  tableRef,
  type TableSpec,
} from '../src/lib/durable/schema';

const BQ = 'https://bigquery.googleapis.com/bigquery/v2';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes('--' + name);
const value = (name: string) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (!bigQueryEnabled()) {
  console.error('BigQuery is disabled (AAROGYA_NO_BQ=1). Nothing to purge.');
  process.exit(1);
}

const all = flag('all');
const facility = value('facility');
const before = value('before');
const recreate = flag('recreate');

if (!all && !facility && !before) {
  console.error(
    'Refusing to guess. Pass one of --all, --facility <id>, --before <ISO timestamp>.',
  );
  process.exit(1);
}
if (recreate && !all) {
  console.error('--recreate drops the whole table, so it is only accepted with --all.');
  process.exit(1);
}

const projectId = await resolveProjectId();

/**
 * Which rows this run is about, per table.
 *
 * The two tables name facilities differently -- a stock event has one facility,
 * a ticket transition has a donor and a receiver -- so the predicate is built
 * per table rather than once. `--facility` on the ticket table matches EITHER
 * end, because a rehearsal that drew a shelf down is equally visible from the
 * receiving side.
 */
function predicate(spec: TableSpec): string {
  if (all) return 'TRUE';
  const clauses: string[] = [];
  if (facility) {
    const id = facility.replace(/"/g, '');
    clauses.push(
      spec.name === STOCK_EVENTS_SPEC.name
        ? 'facility_id = "' + id + '"'
        : '(from_facility_id = "' + id + '" OR to_facility_id = "' + id + '")',
    );
  }
  if (before) clauses.push('`at` < TIMESTAMP("' + before.replace(/"/g, '') + '")');
  return clauses.join(' AND ');
}

async function purge(spec: TableSpec): Promise<void> {
  const ref = tableRef(projectId, spec.name);
  const where = predicate(spec);
  const tableUrl =
    BQ + '/projects/' + projectId + '/datasets/' + DATASET + '/tables/' + spec.name;

  console.log('');
  console.log(spec.name);
  console.log('  where: ' + where);

  const counted = await runQuery<{ n: number }>(
    'SELECT COUNT(*) AS n FROM ' + ref + ' WHERE ' + where,
    { jobLabel: 'overlay_purge_count' },
  );
  const n = counted.rows[0]?.n ?? 0;
  console.log('  rows matched: ' + n);

  if (n === 0 && !recreate) {
    console.log('  nothing to do');
    return;
  }

  if (recreate) {
    await googleRequest(tableUrl, { method: 'DELETE' });
    await googleRequest(BQ + '/projects/' + projectId + '/datasets/' + DATASET + '/tables', {
      method: 'POST',
      data: {
        tableReference: { projectId, datasetId: DATASET, tableId: spec.name },
        description: spec.description,
        schema: { fields: spec.fields },
        ...(spec.partitionField
          ? { timePartitioning: { type: 'DAY', field: spec.partitionField } }
          : {}),
        ...(spec.clustering ? { clustering: { fields: spec.clustering } } : {}),
      },
    });
    console.log('  dropped and rebuilt from schema.ts; ' + n + ' row(s) gone');
    return;
  }

  try {
    const del = await runQuery('DELETE FROM ' + ref + ' WHERE ' + where, {
      jobLabel: 'overlay_purge',
    });
    console.log(
      '  deleted ' + n + ' row(s) in ' + del.stats.elapsedMs + ' ms (' +
        del.stats.totalBytesProcessed.toLocaleString('en-IN') + ' bytes processed)',
    );
  } catch (e) {
    const err = asGoogleApiError(e);
    if (/streaming buffer/i.test(err.message)) {
      console.error(
        '  BigQuery refused: the rows are still in the streaming buffer (up to ~30 ' +
          'minutes after an insertAll). Wait, or re-run with --all --recreate.',
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

// `--facility` is meaningful for both tables; `--all` and `--before` clear the
// whole durable log, which is what somebody asking for either almost always
// means before a demo.
for (const spec of [STOCK_EVENTS_SPEC, DISPATCH_TICKETS_SPEC]) {
  await purge(spec);
}

/*
 * THE TICKET BUCKET. Since the service can run more than one instance, a
 * ticket's current state lives in Cloud Storage as well as in the log, and a
 * fresh instance restores tickets from there. Clearing the log and leaving the
 * bucket would bring every purged ticket back on the next restart -- so `--all`
 * clears both, and so does `--facility`, for tickets touching that facility.
 */
const ticketBucket = process.env.AAROGYA_STATE_BUCKET?.trim() || process.env.AAROGYA_RUN_BUCKET?.trim();
if (ticketBucket && (all || facility)) {
  const GCS = 'https://storage.googleapis.com/storage/v1/b/' + ticketBucket + '/o';
  const names: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await googleRequest<{ items?: { name: string }[]; nextPageToken?: string }>(GCS, {
      params: { prefix: 'tickets/', ...(pageToken ? { pageToken } : {}) },
    });
    for (const item of page.items ?? []) names.push(item.name);
    pageToken = page.nextPageToken;
  } while (pageToken);

  let removed = 0;
  for (const name of names) {
    if (!all) {
      const ticket = await googleRequest<{ from?: { facilityId?: string }; to?: { facilityId?: string } }>(
        GCS + '/' + encodeURIComponent(name) + '?alt=media',
      );
      if (ticket.from?.facilityId !== facility && ticket.to?.facilityId !== facility) continue;
    }
    await googleRequest(GCS + '/' + encodeURIComponent(name), { method: 'DELETE' });
    removed++;
  }
  console.log('');
  console.log('gs://' + ticketBucket + '/tickets/');
  console.log('  ' + removed + ' ticket object(s) removed');
} else if (!ticketBucket) {
  console.log('');
  console.log('(no AAROGYA_STATE_BUCKET set: the ticket bucket, if the service uses one, was not touched)');
}
console.log('');
console.log('A running instance still holds what it restored. Replace it (redeploy the same image) to clear the board.');
