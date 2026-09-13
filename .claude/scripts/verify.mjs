/**
 * THE LOCAL GATE.
 *
 * One command runs every check and prints one table. Part C of the masterplan ends every day on a
 * gate; this is the thing that decides whether the gate is green, so that "gate green" in a note is
 * a claim somebody can check rather than a memory.
 *
 * Run:  node .claude/scripts/verify.mjs [--fast] [--no-live] [--show N]
 *
 * WHY A RUNNER AND NOT A CHECKLIST
 * --------------------------------
 * A checklist of five commands gets run as three when someone is tired, and the note still says
 * "all green". The runner makes that impossible: every step is attempted, every step's own verdict
 * is the verdict, and **SKIPPED is not green** -- the run exits non-zero and prints NOT READY if
 * any step did not actually execute, including under --fast.
 *
 * Paste the table verbatim. Do not retype it, do not summarise it, and do not quote a subset of
 * its rows.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIVE = 'https://aarogya-grid-215071922486.asia-south1.run.app';

const argv = process.argv.slice(2);
const FAST = argv.includes('--fast');
const NO_LIVE = argv.includes('--no-live');
const SHOW = (() => {
  const i = argv.indexOf('--show');
  return i >= 0 ? Number(argv[i + 1]) : null;
})();

/** PASS / FAIL / SKIPPED, plus the captured output for --show. */
const results = [];

function run(cmd, args, { shell = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    shell,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: r.status ?? -1,
    out: (r.stdout ?? '') + (r.stderr ?? ''),
  };
}

function step(n, name, fn, { skip = false, skipWhy = '' } = {}) {
  if (skip) {
    results.push({ n, name, status: 'SKIPPED', detail: skipWhy, out: '' });
    process.stdout.write(`  ${n}. ${name} … SKIPPED (${skipWhy})\n`);
    return;
  }
  process.stdout.write(`  ${n}. ${name} … `);
  const t0 = Date.now();
  let r;
  try {
    r = fn();
  } catch (e) {
    r = { ok: false, detail: e instanceof Error ? e.message : String(e), out: '' };
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push({
    n,
    name,
    status: r.ok ? 'PASS' : 'FAIL',
    detail: r.detail ?? '',
    out: r.out ?? '',
    secs,
  });
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${secs}s  ${r.detail ?? ''}\n`);
}

console.log('\nAarogya Grid — local gate' + (FAST ? '  (--fast)' : '') + '\n');

// ---------------------------------------------------------------------------- 1 · lint
step(1, 'lint     npx eslint --max-warnings 0', () => {
  const r = run('npx', ['eslint', '--max-warnings', '0'], { shell: true });
  return { ok: r.code === 0, out: r.out, detail: r.code === 0 ? '' : 'see --show 1' };
});

// ---------------------------------------------------------------------------- 2 · types
/*
 * `next typegen` first. `PageProps`, `LayoutProps` and `RouteContext` are globals Next GENERATES
 * into .next/types during dev, build or typegen -- and this step runs before the build. On a
 * working copy that has built once they are already there, so a bare `tsc --noEmit` passed here
 * for weeks and failed with four TS2304s on the first fresh clone of the pushed repository.
 */
step(2, 'types    npm run typecheck', () => {
  const r = run('npm', ['run', 'typecheck'], { shell: true });
  const errors = (r.out.match(/error TS/g) ?? []).length;
  return {
    ok: r.code === 0,
    out: r.out,
    detail: r.code === 0 ? '' : `${errors} error${errors === 1 ? '' : 's'}`,
  };
});

// ---------------------------------------------------------------------------- 3 · tests
// Includes the claim-drift guard, so a stale figure on the README or the deck fails here.
step(3, 'tests    npm test', () => {
  const r = run('npm', ['test'], { shell: true });
  const suites = (r.out.match(/^> aarogya-grid@[\d.]+ test:/gm) ?? []).length;
  const claims = r.out.match(/claims: (\d+) checked/);
  return {
    ok: r.code === 0,
    out: r.out,
    detail: `${suites} suites` + (claims ? `, ${claims[1]} claims` : ''),
  };
});

// ---------------------------------------------------------------------------- 4 · build
step(
  4,
  'build    npm run build',
  () => {
    const r = run('npm', ['run', 'build'], { shell: true });
    const pages = r.out.match(/Generating static pages using .* \((\d+)\/(\d+)\)/g);
    const last = pages?.[pages.length - 1]?.match(/\((\d+)\/(\d+)\)/);
    return {
      ok: r.code === 0,
      out: r.out,
      detail: last ? `${last[2]} routes prerendered` : '',
    };
  },
  { skip: FAST, skipWhy: '--fast' },
);

// ------------------------------------------------------------------- 5 · live/repo parity
//
// The defect this step exists for: for weeks the live URL served a build that had been rejected and
// rolled back in git, while the deck quoted the committed figures. A judge meets the deployment, not
// the repository. So the gate asks the running service what it thinks the numbers are.
step(
  5,
  'live     deployed build matches the committed one',
  () => {
    const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'src/data/national-snapshot.json'), 'utf8'));
    const t = snapshot.totals;
    const r = run(
      'curl',
      ['-s', '--max-time', '30', `${LIVE}/console`],
      { shell: true },
    );
    if (r.code !== 0 || r.out.length < 500) {
      return { ok: false, out: r.out, detail: 'could not fetch /console' };
    }
    // Indian grouping, the way every surface renders a count.
    //
    // ENTROPY IS THE POINT HERE, and it was learned the hard way. An earlier
    // version of this list checked four smallish numbers with `includes` over a
    // 660 KB document, and on 12 Sep it reported "live matches HEAD" against a
    // deployment that was a whole build stale: the new dispatch-order count
    // happened to appear somewhere in the page, as four-digit numbers do. A
    // parity check that passes by coincidence is worse than no parity check,
    // because it is believed.
    //
    // So the list is longer, every entry must be present, and it leans on values
    // that cannot collide by accident -- a seven-digit shortfall figure in Indian
    // grouping is effectively a fingerprint of the run. Every string below is
    // verified to be rendered on /console; if a redesign drops one, this step
    // fails loudly rather than silently weakening.
    const want = [
      ['districts', t.districts],
      ['facilities', t.facilities],
      ['tracked positions', t.trackedPositions],
      ['dispatch orders', t.transfers],
      ['vehicle trips', t.trips],
      ['critical positions', t.criticalPositions],
      ['cross-district orders', t.crossDistrictOrders],
      ['shortfall averted', t.shortfallAverted],
    ];
    const missing = want.filter(([, v]) => !r.out.includes(v.toLocaleString('en-IN')));

    /*
     * FIGURES ARE NOT ENOUGH, AND DAY 13 PROVED IT.
     *
     * Days 8 to 13 added durability, dispatch tickets, outpatient footfall and
     * the early-warning feed WITHOUT moving a single stock figure -- the model
     * did not change, so every number above still matched a deployment that was
     * six days old. This step printed "live matches HEAD" at a moment when the
     * live URL a judge would visit had none of it.
     *
     * That is the same defect this step already carries a paragraph about, one
     * level up: a check that passes for a reason unrelated to what it claims.
     * So the API SURFACE is probed as well. Each of these exists only in a build
     * that carries the feature, and none of them costs a model call.
     */
    const surface = [
      ['/api/overlay', 'durability', 'WS2 durable event log (day 8)'],
      ['/api/dispatch', 'tickets', 'WS2B dispatch tickets (day 9)'],
      ['/api/indicators', 'schemaVersion', 'WS3 early-warning feed (day 13)'],
      ['/api/federated', 'aarogya.federated.prior/1', 'WS4 federated state nodes (day 14)'],
      ['/api/federated/10', 'aarogya.federated.node/1', '...and one state node, byte for byte'],
    ];
    const absent = [];
    for (const [path, marker, why] of surface) {
      const probe = run('curl', ['-s', '--max-time', '20', `${LIVE}${path}`], { shell: true });
      if (probe.code !== 0 || !probe.out.includes(`"${marker}"`)) absent.push(why);
    }

    const stale = missing.length > 0;
    return {
      ok: !stale && absent.length === 0,
      out: r.out.slice(0, 4000),
      detail: stale
        ? 'live is stale: ' + missing.map(([k, v]) => `${k}=${v}`).join(', ')
        : absent.length > 0
          ? 'figures match but the deployment predates: ' + absent.join('; ')
          : 'live matches HEAD, figures and API surface',
    };
  },
  { skip: FAST || NO_LIVE, skipWhy: FAST ? '--fast' : '--no-live' },
);

// ------------------------------------------------------------------------------- the table
const W = Math.max(...results.map((r) => r.name.length));
console.log('\n' + '='.repeat(W + 34));
console.log('  #  ' + 'step'.padEnd(W) + '  status   detail');
console.log('-'.repeat(W + 34));
for (const r of results) {
  console.log(
    `  ${r.n}  ${r.name.padEnd(W)}  ${r.status.padEnd(7)}  ${r.detail}`.trimEnd(),
  );
}
console.log('='.repeat(W + 34));

if (SHOW !== null) {
  const hit = results.find((r) => r.n === SHOW);
  console.log(`\n--- full output of step ${SHOW} ---\n${hit?.out ?? '(nothing captured)'}`);
}

const failed = results.filter((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'SKIPPED');

if (failed.length === 0 && skipped.length === 0) {
  console.log('\nREADY\n');
  process.exit(0);
}

console.log('\nNOT READY');
for (const r of failed) console.log(`  FAIL     step ${r.n} ${r.name} — ${r.detail || 'see --show ' + r.n}`);
for (const r of skipped) console.log(`  SKIPPED  step ${r.n} ${r.name} — ${r.detail}`);
console.log(
  skipped.length && !failed.length
    ? '\nA skipped step is not a passing step. Re-run without --fast/--no-live before claiming a gate.\n'
    : '',
);
process.exit(1);
