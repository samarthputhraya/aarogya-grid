/**
 * OPD footfall: the censoring, the calendar, and the arithmetic.
 *
 * Run with:  npx tsx scripts/test-footfall.mts   (part of `npm test`)
 *
 * WHAT THIS IS DEFENDING
 * ----------------------
 * One idea, mostly. `attendedSeries` is what an HMIS return would contain and
 * `demandSeries` is what only a simulation can know, and every claim this
 * project makes about seeing an outbreak early depends on the detector reading
 * the first and never the second. If the two ever became the same series -- a
 * capacity ceiling that never binds, a censoring step accidentally removed --
 * nothing would fail, no number would move, and the honest claim would quietly
 * become a dishonest one.
 *
 * So the relationship between them is pinned here from both directions: the
 * recorded series can never exceed what was possible, and the difference has to
 * equal the units the state reports as turned away.
 */
import { simulateFootfall, consultationCapacity, OPD_PER_1000_PER_DAY } from '../src/lib/sim/footfall';
import { simulateStaffing } from '../src/lib/sim/resources';
import { DISTRICTS } from '../src/lib/domain/geo';
import { generateNetwork, DEMO_SCALE } from '../src/lib/sim/facilities';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  -- ' + detail : ''));
  }
}

const ASOF = new Date(Date.UTC(2026, 8, 30));
const SEED = 20260930;
const DAYS = 180;

// The shipped network, so this exercises the same facilities the build does
// rather than a fixture that can drift away from them.
const purnia = DISTRICTS.find((d) => d.code === 'DST-10-PURNIA')!;
const network = generateNetwork(DEMO_SCALE, [purnia], SEED);
const run = (f: (typeof network)[number]) =>
  simulateFootfall(f, { asOf: ASOF, historyDays: DAYS, seed: SEED });

console.log('\nshape and calendar');
{
  const phc = network.find((f) => f.type === 'PHC')!;
  const s = run(phc);
  check('the series is exactly the window', s.attendedSeries.length === DAYS);
  check('both series share it', s.demandSeries.length === DAYS);
  check('the last element is the as-of day', s.attendedToday === s.attendedSeries[DAYS - 1]);
  check('the as-of date is reported', s.asOf === '2026-09-30', s.asOf);

  // A warehouse has no outpatient department. Empty series rather than 180
  // zeros: at demo scale the payload difference is real, and a column of zeros
  // invites somebody to average it.
  const dw = network.find((f) => f.type === 'DW');
  if (dw) {
    const w = run(dw);
    check('a warehouse has no OPD at all', w.attendedSeries.length === 0 && w.meanDaily === 0);
  } else {
    check('a warehouse has no OPD at all', OPD_PER_1000_PER_DAY.DW === 0);
  }
}

console.log('\nthe censoring, from both directions');
{
  let facilities = 0;
  let everInflated = 0;
  let everAboveCapacity = 0;
  let varianceMismatch = 0;
  let closedMismatch = 0;
  /** Days on which the register recorded FEWER than presented -- the ceiling binding. */
  let bindingDays = 0;
  let turnedAwayAll = 0;

  for (const f of network) {
    const s = run(f);
    if (s.attendedSeries.length === 0) continue;
    facilities++;

    let turnedAway = 0;
    let closed = 0;
    const cursor = new Date(ASOF.getTime());
    cursor.setUTCDate(cursor.getUTCDate() - (DAYS - 1));

    for (let i = 0; i < DAYS; i++) {
      if (s.attendedSeries[i] > s.demandSeries[i]) everInflated++;
      if (s.attendedSeries[i] < s.demandSeries[i]) bindingDays++;
      const { capacity } = consultationCapacity(f, cursor, SEED);
      if (s.attendedSeries[i] > capacity) everAboveCapacity++;
      if (capacity === 0) {
        closed++;
        if (s.attendedSeries[i] !== 0) closedMismatch++;
      }
      turnedAway += s.demandSeries[i] - s.attendedSeries[i];
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    if (turnedAway !== s.turnedAwayTotal) varianceMismatch++;
    turnedAwayAll += turnedAway;
    if (closed !== s.daysClosed) closedMismatch++;
  }

  check('every facility with an OPD was checked', facilities > 20, String(facilities));
  check('a register never records more than presented', everInflated === 0, String(everInflated));
  check(
    'and never more than the clinicians present could deliver',
    everAboveCapacity === 0,
    String(everAboveCapacity),
  );
  check(
    'a day with nobody present records nothing at all',
    closedMismatch === 0,
    String(closedMismatch),
  );
  check(
    'the turned-away total is the sum of the gap, not an estimate of it',
    varianceMismatch === 0,
    String(varianceMismatch),
  );

  // THE POSITIVE CONTROL. Every check above is an inequality, and both failure
  // modes the header names -- a ceiling that never binds, a censoring step
  // removed -- make recorded equal presented, which satisfies all of them. So
  // the censoring must be seen to HAPPEN: some days where the register holds
  // fewer patients than came, and a turned-away total above zero.
  check(
    'the ceiling actually binds on some days -- recorded is not simply presented',
    bindingDays > 0,
    bindingDays + ' binding facility-days',
  );
  check('and patients are turned away in total', turnedAwayAll > 0, String(turnedAwayAll));
}

console.log('\nthe ceiling comes from the SAME roster the workforce panel shows');
{
  // Not a parallel attendance model. If these two ever disagreed, a console
  // would say "no Medical Officer present today" beside an OPD count that
  // could only have happened with one.
  const phc = network.find((f) => f.type === 'PHC')!;
  const staffing = simulateStaffing(phc, { asOf: ASOF, seed: SEED });
  const { clinicalPresent } = consultationCapacity(phc, ASOF, SEED);
  const clinicalFromPanel = staffing.cadres
    .filter((c) => ['medical_officer', 'specialist', 'cho', 'staff_nurse', 'anm', 'mpw_male'].includes(c.cadre))
    .reduce((a, c) => a + c.presentToday, 0);
  check(
    'the clinicians counted are the ones on the roster',
    clinicalPresent === clinicalFromPanel,
    clinicalPresent + ' vs ' + clinicalFromPanel,
  );

  const s = run(phc);
  check('and today’s figure is reported alongside the count', s.clinicalPresentToday === clinicalPresent);
  check('with the capacity it implies', s.capacityToday > 0);
}

console.log('\ndeterminism');
{
  // The whole pipeline is reproducible by construction, and the artefacts are
  // asserted byte-identical across runs. A simulator with an unkeyed random
  // draw would break that quietly, in a file nobody diffs.
  const chc = network.find((f) => f.type === 'CHC')!;
  const a = run(chc);
  const b = run(chc);
  check(
    'the same inputs give the same series',
    JSON.stringify(a.attendedSeries) === JSON.stringify(b.attendedSeries),
  );
  check('and the same summary', a.meanDaily === b.meanDaily && a.turnedAwayTotal === b.turnedAwayTotal);

  const different = simulateFootfall(chc, { asOf: ASOF, historyDays: DAYS, seed: SEED + 1 });
  check(
    'a different seed gives a different one',
    JSON.stringify(a.attendedSeries) !== JSON.stringify(different.attendedSeries),
  );
}

console.log('\nthe week, and the year');
{
  const chc = network.find((f) => f.type === 'CHC')!;
  const s = run(chc);

  // Sunday is closed except for emergencies. Its absence is one of the things
  // that makes a simulated OPD series look simulated.
  const byDow: number[][] = [[], [], [], [], [], [], []];
  const cursor = new Date(ASOF.getTime());
  cursor.setUTCDate(cursor.getUTCDate() - (DAYS - 1));
  for (let i = 0; i < DAYS; i++) {
    byDow[cursor.getUTCDay()].push(s.demandSeries[i]);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const sunday = mean(byDow[0]);
  const midweek = mean([...byDow[2], ...byDow[3], ...byDow[4]]);
  check('Sunday is a fraction of a weekday', sunday < midweek * 0.4, sunday.toFixed(0) + ' vs ' + midweek.toFixed(0));
  check('Monday carries the backlog', mean(byDow[1]) > midweek, mean(byDow[1]).toFixed(0));

  // The window spans April to September -- the monsoon rises inside it -- so
  // the seasonal multiplier reported for the as-of date must not be 1.
  check('the as-of day carries a seasonal multiplier', s.seasonalMultiplier !== 1, String(s.seasonalMultiplier));
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + '  ' + (checks - failures) + '/' + checks + ' checks');
process.exit(failures === 0 ? 0 : 1);
