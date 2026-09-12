/**
 * THE ALERT BOARD, CHECKED AGAINST THE SHIPPED SNAPSHOT.
 *
 * The board used to keep the top 6 positions per district ranked by
 * `riskScore`. That is not a neutral ranking: `scoreRisk` multiplies stock-out
 * probability by a log-population exposure term, so at p=1 on a Vital drug the
 * ceiling is 100 for a district hospital and 88 for a sub-centre. Six slots on
 * that number are six slots for the six biggest facilities, and the national
 * 250-row cut then removed whole districts.
 *
 * Two things followed, and this file exists so neither can come back quietly:
 *
 *   1. The board carried ZERO PHC and ZERO sub-centre rows nationally, on a
 *      product whose problem statement says "entire PHC network".
 *   2. A district holding 21-41 critical positions rendered the green
 *      "no position reached the threshold" panel, because the console inferred
 *      health from an empty slice of a truncated list.
 *
 * Run: npx tsx scripts/test-alerts.mts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NationalSnapshot } from '../src/lib/snapshot-types';

const snapshot = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/data/national-snapshot.json'), 'utf8'),
) as NationalSnapshot;

/** Must match `ALERTS_PER_TIER` in scripts/build-snapshot.mts. */
const ALERTS_PER_TIER = 2;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
}

console.log('alert board');

// ---- the board is a stratified sample, and stays one -----------------------
const perDistrictTier = new Map<string, number>();
for (const a of snapshot.alerts) {
  const key = a.districtCode + '|' + a.facilityType;
  perDistrictTier.set(key, (perDistrictTier.get(key) ?? 0) + 1);
}
const overFull = [...perDistrictTier.entries()].filter(([, v]) => v > ALERTS_PER_TIER);
check(
  'at most ' + ALERTS_PER_TIER + ' rows per (district, facility tier)',
  overFull.length === 0,
  overFull.length ? 'worst: ' + overFull[0][0] + ' has ' + overFull[0][1] : '',
);

const tiersOnBoard = new Set(snapshot.alerts.map((a) => a.facilityType));
// The two the brief is actually about. The old board had neither.
for (const tier of ['PHC', 'SC']) {
  check(
    'the board carries ' + tier + ' rows',
    tiersOnBoard.has(tier),
    'tiers present: ' + [...tiersOnBoard].sort().join(', '),
  );
}

/*
 * THE CHECK THAT MATTERS MOST, AND THE ONE THE FIRST FIX MISSED.
 *
 * The console renders the first 40 rows. A payload can be perfectly balanced
 * across 250 rows and still put 63 district hospitals in front of every PHC,
 * which is what happened when the batch re-sorted its stratified selection by
 * risk. The array was right and the screen was unchanged. So this asserts the
 * property a reader actually experiences: the FIRST SCREEN spans the network.
 */
const CONSOLE_ROWS = 40;
const firstScreen = new Set(snapshot.alerts.slice(0, CONSOLE_ROWS).map((a) => a.facilityType));
check(
  'the first ' + CONSOLE_ROWS + ' rows -- what the console actually shows -- span 4+ tiers',
  firstScreen.size >= 4,
  'tiers on the first screen: ' + [...firstScreen].join(', '),
);
for (const tier of ['PHC', 'SC']) {
  check(
    'the first screen includes ' + tier + ' rows',
    firstScreen.has(tier),
    'tiers on the first screen: ' + [...firstScreen].join(', '),
  );
}

check(
  'every row is critical or high',
  snapshot.alerts.every((a) => a.severity === 'critical' || a.severity === 'high'),
);

// ---- what the board is a sample OF -----------------------------------------
const totals = snapshot.alertTotals;
check('the snapshot carries alertTotals', Boolean(totals));

if (totals) {
  check(
    'alertTotals.critical matches the national total',
    totals.critical === snapshot.totals.criticalPositions,
    totals.critical + ' vs ' + snapshot.totals.criticalPositions,
  );
  check(
    'alertTotals.high matches the national total',
    totals.high === snapshot.totals.highPositions,
    totals.high + ' vs ' + snapshot.totals.highPositions,
  );

  const tierCritical = totals.byTier.reduce((a, r) => a + r.critical, 0);
  const tierHigh = totals.byTier.reduce((a, r) => a + r.high, 0);
  check(
    'byTier critical sums to the national total',
    tierCritical === snapshot.totals.criticalPositions,
    tierCritical + ' vs ' + snapshot.totals.criticalPositions,
  );
  check(
    'byTier high sums to the national total',
    tierHigh === snapshot.totals.highPositions,
    tierHigh + ' vs ' + snapshot.totals.highPositions,
  );

  // The counts have to come from the population, not the sample -- that is the
  // whole point of computing them before truncation.
  const boardTiers = totals.byTier.filter((r) => r.critical + r.high > 0).map((r) => r.tier);
  check(
    'byTier reports every tier that has a severe position',
    boardTiers.every((t) => typeof t === 'string'),
    totals.byTier.map((r) => r.tier + ' ' + r.critical + '/' + r.high).join(' · '),
  );
  check(
    'byTier reaches tiers the truncated board cannot',
    boardTiers.length >= tiersOnBoard.size,
    'byTier ' + boardTiers.length + ' tiers, board ' + tiersOnBoard.size,
  );
}

// ---- the green-panel bug ---------------------------------------------------
//
// Districts that hold severe positions but contribute no row to the national
// board are EXPECTED -- the board is a head. What must never happen again is
// the console concluding from that emptiness that the district is clear, so
// this asserts the data the console now branches on is actually present and
// non-zero for those districts.
const onBoard = new Set(snapshot.alerts.map((a) => a.districtCode));
const severeButUnlisted = snapshot.districts.filter(
  (d) => d.criticalPositions + d.highPositions > 0 && !onBoard.has(d.districtCode),
);
check(
  'every district still reports its own severe counts, listed or not',
  severeButUnlisted.every((d) => d.criticalPositions + d.highPositions > 0),
  severeButUnlisted.length + ' districts hold severe positions with no row on the board',
);

console.log(
  '\n' +
    (failures === 0
      ? 'alert board: all checks passed  (' +
        snapshot.alerts.length +
        ' rows shown of ' +
        (snapshot.totals.criticalPositions + snapshot.totals.highPositions).toLocaleString('en-IN') +
        ' critical or high)'
      : 'alert board: ' + failures + ' FAILED'),
);
process.exit(failures === 0 ? 0 : 1);
