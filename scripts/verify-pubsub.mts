/**
 * Prove the audit trail leaves the process.
 *
 * WHY A 200 FROM `topics:publish` IS NOT EVIDENCE
 * -----------------------------------------------
 * The commit path publishes every committed event to `aarogya-events` and marks
 * the event `published` when the call succeeds. That is a claim about one HTTP
 * response. It says nothing about whether a message with the right attributes
 * and a readable body can actually be pulled off the other end by something
 * that is not us -- which is the entire point of putting it on a topic.
 *
 * So this creates the subscription a district's own systems would create,
 * publishes a probe, pulls it back, and checks the bytes. It then drains
 * whatever real `stock.committed` messages are waiting and prints them, which
 * is the closest thing to a demonstration that the audit trail is real: those
 * messages were produced by commits, not by this script.
 *
 * Run:  npm run verify:pubsub
 *
 * NOT PART OF `npm test`. It needs the network and a provisioned topic, and the
 * offline suite is deliberately offline.
 */
import { googleRequest, resolveProjectId, asGoogleApiError } from '../src/lib/gcp/request';
import { PUBSUB_TOPIC, PUBSUB_SUBSCRIPTION } from '../src/lib/durable/schema';

const PS = 'https://pubsub.googleapis.com/v1';

/**
 * The subscription a consumer would own.
 *
 * It exists permanently rather than being created and torn down per run,
 * because the interesting property is that messages ACCUMULATE for a subscriber
 * that was not listening at the time -- that is what makes a topic an audit
 * trail rather than a broadcast.
 */
const SUBSCRIPTION = PUBSUB_SUBSCRIPTION;

const projectId = await resolveProjectId();
const topicPath = 'projects/' + projectId + '/topics/' + PUBSUB_TOPIC;
const subPath = 'projects/' + projectId + '/subscriptions/' + SUBSCRIPTION;

let failures = 0;
const ok = (m: string) => console.log('  ok    ' + m);
const fail = (m: string) => {
  failures++;
  console.error('  FAIL  ' + m);
};

console.log('Pub/Sub round trip on ' + topicPath);
console.log();

// ------------------------------------------------------------- subscription

try {
  await googleRequest(PS + '/' + subPath);
  ok('subscription ' + SUBSCRIPTION + ' exists');
} catch (e) {
  if (asGoogleApiError(e).status !== 404) throw e;
  await googleRequest(PS + '/' + subPath, {
    method: 'PUT',
    data: {
      topic: topicPath,
      // Long enough that a subscriber can be down for a day and still catch up,
      // short enough that nothing accumulates cost. Pub/Sub's own default.
      messageRetentionDuration: '604800s',
      ackDeadlineSeconds: 30,
      labels: { app: 'aarogya-grid' },
    },
  });
  ok('subscription ' + SUBSCRIPTION + ' created on the topic');
}

// -------------------------------------------------------------------- probe

const nonce = 'verify-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const published = await googleRequest<{ messageIds: string[] }>(
  PS + '/' + topicPath + ':publish',
  {
    method: 'POST',
    data: {
      messages: [
        {
          attributes: { type: 'verify', nonce },
          data: Buffer.from(JSON.stringify({ type: 'verify', nonce })).toString('base64'),
        },
      ],
    },
  },
);
ok('published a probe (message id ' + published.messageIds[0] + ')');

interface PullResponse {
  receivedMessages?: {
    ackId: string;
    message: { data?: string; attributes?: Record<string, string>; publishTime?: string };
  }[];
}

/**
 * Pull with a short deadline, repeatedly.
 *
 * A single pull often returns nothing even when a message is waiting: delivery
 * is not instant and `returnImmediately` means exactly that. Retrying for a few
 * seconds is the difference between checking the pipe and checking the timing.
 */
async function drain(budgetMs: number) {
  const deadline = Date.now() + budgetMs;
  const seen: { attributes: Record<string, string>; body: unknown }[] = [];
  const ackIds: string[] = [];
  while (Date.now() < deadline) {
    const res = await googleRequest<PullResponse>(PS + '/' + subPath + ':pull', {
      method: 'POST',
      data: { maxMessages: 50 },
    });
    const got = res.receivedMessages ?? [];
    for (const m of got) {
      ackIds.push(m.ackId);
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.from(m.message.data ?? '', 'base64').toString('utf8'));
      } catch {
        body = '<undecodable>';
      }
      seen.push({ attributes: m.message.attributes ?? {}, body });
    }
    if (seen.some((s) => s.attributes.nonce === nonce)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (ackIds.length > 0) {
    await googleRequest(PS + '/' + subPath + ':acknowledge', {
      method: 'POST',
      data: { ackIds },
    });
  }
  return seen;
}

const messages = await drain(15_000);

const probe = messages.find((m) => m.attributes.nonce === nonce);
if (!probe) {
  fail('the probe never came back within 15 s -- the topic accepted it but nothing delivered it');
} else {
  ok('the probe was pulled back off the subscription');
  const body = probe.body as { nonce?: string };
  if (body?.nonce === nonce) ok('and its body survived the round trip byte for byte');
  else fail('the body did not decode to what was sent: ' + JSON.stringify(probe.body).slice(0, 200));
}

// ------------------------------------------------- what the app itself sent

const committed = messages.filter((m) => m.attributes.type === 'stock.committed');
if (committed.length === 0) {
  console.log(
    '        no stock.committed messages were waiting. Run a commit (or ' +
      '`npm run rehearse:restart`) and re-run this to see the real ones.',
  );
} else {
  ok(committed.length + ' real stock.committed message(s) were waiting on the subscription');
  for (const m of committed.slice(0, 5)) {
    const event = (m.body as { event?: { facilityName?: string; drugName?: string; onHand?: number; seq?: number } })
      .event;
    console.log(
      '        seq ' + event?.seq + '  ' + event?.facilityName + ' / ' + event?.drugName +
        ' = ' + event?.onHand + '  [' + m.attributes.districtCode + ', ' + m.attributes.source + ']',
    );
  }
}

console.log();
console.log(failures === 0 ? 'PASS  the audit trail leaves the process' : 'FAIL  ' + failures + ' check(s)');
process.exit(failures === 0 ? 0 : 1);
