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
step(2, 'types    npx tsc --noEmit', () => {
  const r = run('npx', ['tsc', '--noEmit'], { shell: true });
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
  'live     deployed figures match the committed snapshot',
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
    const want = [
      ['districts', t.districts],
      ['facilities', t.facilities],
      ['tracked positions', t.trackedPositions],
      ['dispatch orders', t.transfers],
    ];
    const missing = want.filter(([, v]) => !r.out.includes(v.toLocaleString('en-IN')));
    return {
      ok: missing.length === 0,
      out: r.out.slice(0, 4000),
      detail:
        missing.length === 0
          ? 'live matches HEAD'
          : 'live is stale: ' + missing.map(([k, v]) => `${k}=${v}`).join(', '),
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
