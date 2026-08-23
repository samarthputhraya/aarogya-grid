/**
 * Entity resolution tests.
 * Run with:  npx tsx scripts/test-resolve.ts
 *
 * These are safety tests, not accuracy tests. The failure mode that matters is
 * not "did not recognise the drug" -- that just prompts a human. It is
 * "confidently resolved to the WRONG drug", which writes a bad number into a
 * national ledger. So the assertions below care most about near-miss pairs and
 * about whether low-confidence cases correctly ask for confirmation.
 */
import { resolveDrug, resolveWithinFormulary, AUTO_ACCEPT } from '../src/lib/ai/resolve';
import { formularyFor } from '../src/lib/domain/drugs';

interface Case {
  query: string;
  expect: string | null;
  note?: string;
  mustConfirm?: boolean;
}

const CASES: Case[] = [
  // Plain English
  { query: 'paracetamol', expect: 'PARA-500-TAB' },
  { query: 'Paracetamol 500mg', expect: 'PARA-500-TAB' },
  { query: 'ORS sachets', expect: 'ORS-SACHET' },
  { query: 'anti snake venom', expect: 'ASV-POLY-10ML' },
  { query: 'ceftriaxone injection', expect: 'CEFTRIAXONE-1G' },
  { query: 'oxytocin', expect: 'OXYTOCIN-5IU-INJ' },
  { query: 'ringer lactate', expect: 'RL-500ML' },

  // Brand names a health worker would actually use
  { query: 'crocin', expect: 'PARA-500-TAB', note: 'brand name' },
  { query: 'dolo', expect: 'PARA-500-TAB', note: 'brand name' },
  { query: 'monocef', expect: 'CEFTRIAXONE-1G', note: 'brand name' },
  { query: 'metrogyl', expect: 'METRONIDAZOLE-400', note: 'brand name' },
  { query: 'ecosprin', expect: 'ASPIRIN-75', note: 'brand name' },

  // Vernacular
  { query: 'bukhar ki goli', expect: 'PARA-500-TAB', note: 'Hindi: fever tablet' },
  { query: 'lal goli', expect: 'IFA-ADULT-TAB', note: 'Hindi: red tablet = IFA' },
  { query: 'sugar ki dawa', expect: 'METFORMIN-500', note: 'Hindi: diabetes medicine' },
  { query: 'bp ki dawa', expect: 'AMLODIPINE-5', note: 'Hindi: BP medicine' },
  { query: 'kutta katne ka injection', expect: 'ARV-VACCINE', note: 'Hindi: dog bite injection' },
  { query: 'saap kaatne ka injection', expect: 'ASV-POLY-10ML', note: 'Hindi: snake bite injection' },

  // Transcription noise -- what speech-to-text actually produces
  { query: 'paracitamol', expect: 'PARA-500-TAB', note: 'misspelling' },
  { query: 'amoxycillin', expect: 'AMOXICILLIN-500', note: 'spelling variant' },
  { query: 'cetrizine', expect: 'CETIRIZINE-10', note: 'common misspelling' },

  // SAFETY: near-miss pairs that must not be confused
  { query: 'cetirizine', expect: 'CETIRIZINE-10', note: 'must NOT resolve to ceftriaxone' },
  { query: 'ceftriaxone', expect: 'CEFTRIAXONE-1G', note: 'must NOT resolve to cetirizine' },

  // Nonsense must ask for confirmation rather than guess
  { query: 'blue tablet', expect: null, mustConfirm: true, note: 'ambiguous -- must ask' },
  { query: 'qwertyuiop', expect: null, mustConfirm: true, note: 'garbage -- must ask' },
];

let pass = 0;
let fail = 0;
const failures: string[] = [];

console.log('Aarogya Grid -- drug entity resolution');
console.log('auto-accept threshold:', AUTO_ACCEPT);
console.log();
console.log(
  'query'.padEnd(30) + 'resolved'.padEnd(22) + 'conf'.padEnd(8) + 'via'.padEnd(8) + 'confirm?',
);
console.log('-'.repeat(80));

for (const c of CASES) {
  const r = resolveDrug(c.query);
  const gotId = r.best?.drug.id ?? null;
  const conf = r.best?.confidence ?? 0;

  let ok: boolean;
  if (c.expect === null) {
    // For garbage input we only require that it asks for confirmation.
    ok = r.needsConfirmation === true;
  } else {
    ok = gotId === c.expect;
    if (c.mustConfirm) ok = ok && r.needsConfirmation;
  }

  if (ok) pass++;
  else {
    fail++;
    failures.push(
      `  ${c.query}  ->  got ${gotId ?? 'null'} (${conf}), expected ${c.expect ?? 'confirmation'}`,
    );
  }

  console.log(
    (ok ? '' : 'X ') +
      c.query.slice(0, 28).padEnd(ok ? 30 : 28) +
      (gotId ?? '-').slice(0, 21).padEnd(22) +
      conf.toFixed(2).padEnd(8) +
      (r.best?.via ?? '-').padEnd(8) +
      (r.needsConfirmation ? 'YES' : 'no') +
      (c.note ? '   // ' + c.note : ''),
  );
}

// --- formulary scoping -----------------------------------------------------
console.log('\n--- formulary scoping ---');
const scTest = resolveWithinFormulary('ceftriaxone', formularyFor('SC'));
const scOk = scTest.best?.drug.id !== 'CEFTRIAXONE-1G';
console.log(
  (scOk ? '  PASS  ' : '  FAIL  ') +
    'a Sub-Centre cannot resolve to Ceftriaxone (not in its formulary) -> got ' +
    (scTest.best?.drug.id ?? 'null'),
);
if (scOk) pass++;
else fail++;

const phcTest = resolveWithinFormulary('ceftriaxone', formularyFor('PHC'));
const phcOk = phcTest.best?.drug.id === 'CEFTRIAXONE-1G';
console.log(
  (phcOk ? '  PASS  ' : '  FAIL  ') +
    'a PHC resolves Ceftriaxone normally -> got ' +
    (phcTest.best?.drug.id ?? 'null'),
);
if (phcOk) pass++;
else fail++;

console.log('\n' + '='.repeat(80));
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(f));
}
process.exit(fail === 0 ? 0 : 1);
