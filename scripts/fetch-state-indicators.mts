/**
 * REAL PER-STATE HEALTH-SYSTEM INDICATORS, FROM THE SURVEY'S OWN PUBLISHER.
 *
 * Run:  npx tsx scripts/fetch-state-indicators.mts
 * Out:  src/data/state-indicators.json
 *
 * WHAT THIS REPLACES
 * ------------------
 * `districtReliability` was a HASH OF THE DISTRICT CODE. It produced the
 * spatial clustering the map needs, and it ranked Kerala below Chhattisgarh,
 * because a hash has no opinion about Kerala. Supply reliability feeds stock-out
 * risk, so that arbitrary number propagated into every ranking the console
 * shows and every dispatch the optimiser proposes.
 *
 * THE INDICATOR, AND WHY THIS ONE
 * -------------------------------
 * Institutional births by state, NFHS-5 (2019-21): the share of births in the
 * five years before the survey that took place in a health facility. It depends
 * on facilities being open, staffed, stocked and trusted enough to use.
 *
 * THE SOURCE, AND THE DEFECT THAT MOVED IT
 * ----------------------------------------
 * The first version of this script read a Wikipedia ranking page whose
 * introduction cites NFHS-5 and whose table does not consistently carry it:
 * it shipped Bihar at 63.8% and Jharkhand at 61.9%, which are the NFHS-4
 * (2015-16) figures. NFHS-5 has them at 76.2% and 75.8%. Every surface called
 * those numbers NFHS-5, and the two states it understated are two of the three
 * the map ranks worst.
 *
 * So the figures now come from The DHS Program's API, run by ICF, which is the
 * technical partner that publishes the NFHS reports with IIPS for the Ministry
 * of Health. Indicator `RH_DELP_C_DHF` ("Place of delivery: Health facility"),
 * survey `IA2020DHS`, subnational breakdown, "Five years preceding the survey"
 * -- the reference period of the NFHS-5 fact sheets' "Institutional births (%)".
 * It is structured JSON from the publisher, so nothing is read off a page.
 *
 * IT IS A PROXY AND IS LABELLED AS ONE
 * ------------------------------------
 * It is NOT a measurement of consignment reliability. Nobody publishes that --
 * its absence is the problem this whole product exists to address. What it buys
 * is that the ranking stops being arbitrary. Every surface says "modelled,
 * anchored to a real published state indicator" -- never "measured".
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API =
  'https://api.dhsprogram.com/rest/dhs/data?countryIds=IA&surveyIds=IA2020DHS' +
  '&indicatorIds=RH_DELP_C_DHF&breakdown=subnational&f=json&perpage=500';
const PERIOD = 'Five years preceding the survey';

interface DhsRow {
  CharacteristicLabel: string;
  Value: number;
  ByVariableLabel: string;
  RegionId: string;
  DenominatorUnweighted: number;
  CILow: number | null;
  CIHigh: number | null;
}

const registry = JSON.parse(readFileSync(resolve(process.cwd(), 'src/data/india-districts.json'), 'utf8')) as {
  states: { code: string; name: string }[];
};

/**
 * The survey's region label for each state, where it is not the state's name.
 * NFHS-5 predates nothing here -- Ladakh, J&K and the merged DNH&DD are all
 * surveyed separately -- but it names Delhi and the merged UT its own way.
 */
const SURVEY_LABEL: Record<string, string> = {
  '07': 'New Delhi',
  '01': 'Jammu & Kashmir',
  '38': 'Dadra and Nagar Haveli, Daman and Diu',
};

const res = await fetch(API, { headers: { 'User-Agent': 'aarogya-grid/1.0 (research)' } });
if (!res.ok) {
  console.error('DHS API returned ' + res.status);
  process.exit(1);
}
const body = (await res.json()) as { Data: DhsRow[] };
const rows = body.Data.filter((r) => r.ByVariableLabel === PERIOD);

/*
 * The survey reports some states twice: once inside a combined region
 * ("Bihar, inc Jharkhand") and once on its own with a ".." prefix. The combined
 * rows are aggregates of two states and are never matched.
 */
const byLabel = new Map<string, DhsRow>();
for (const r of rows) {
  const label = r.CharacteristicLabel.replace(/^\.\./, '').trim();
  if (/\binc\b|including/i.test(label)) continue;
  byLabel.set(label, r);
}
console.log('parsed ' + byLabel.size + ' survey regions');

const missing: string[] = [];
const out: Record<string, { institutionalDeliveryPct: number; surveyRegion: string; births: number }> = {};
for (const s of registry.states) {
  const label = SURVEY_LABEL[s.code] ?? s.name;
  const row = byLabel.get(label);
  if (!row) {
    missing.push(s.name + ' (looked for "' + label + '")');
    continue;
  }
  out[s.code] = {
    institutionalDeliveryPct: row.Value,
    surveyRegion: row.CharacteristicLabel.replace(/^\.\./, ''),
    // Unweighted births behind the estimate. Small UTs rest on a few hundred.
    births: row.DenominatorUnweighted,
  };
}

if (missing.length) {
  console.error('\nMISSING from the survey: ' + missing.join(', '));
  process.exit(1);
}

const vals = Object.values(out).map((v) => v.institutionalDeliveryPct);
const payload = {
  source: 'https://api.dhsprogram.com/rest/dhs/data?surveyIds=IA2020DHS&indicatorIds=RH_DELP_C_DHF&breakdown=subnational',
  sourceNote:
    'NFHS-5 (2019-21), institutional births in the five years preceding the survey, by state/UT, from The DHS ' +
    'Program API (ICF, technical partner to IIPS and the Ministry of Health and Family Welfare for NFHS-5). ' +
    'Re-run with: npx tsx scripts/fetch-state-indicators.mts',
  indicator: 'institutional births (%), NFHS-5, five years preceding the survey',
  isProxy: true,
  proxyNote:
    'Used as the anchor for modelled supply reliability. It measures whether a state health ' +
    'system reaches people, not whether consignments arrive complete and on time -- nobody ' +
    'publishes the latter, which is the problem this product addresses. Labelled as modelled ' +
    'on every surface that shows it.',
  retrievedAt: new Date().toISOString().slice(0, 10),
  states: Object.keys(out).length,
  range: { min: Math.min(...vals), max: Math.max(...vals) },
  indicators: out,
};

writeFileSync(resolve(process.cwd(), 'src/data/state-indicators.json'), JSON.stringify(payload, null, 1) + '\n');

console.log('\nwrote src/data/state-indicators.json');
console.log('  states : ' + Object.keys(out).length);
console.log('  range  : ' + payload.range.min + '% … ' + payload.range.max + '%');
const ranked = Object.entries(out)
  .map(([code, v]) => [registry.states.find((s) => s.code === code)!.name, v.institutionalDeliveryPct] as const)
  .sort((a, b) => b[1] - a[1]);
console.log('  best   : ' + ranked.slice(0, 3).map((r) => r[0] + ' ' + r[1] + '%').join(', '));
console.log('  worst  : ' + ranked.slice(-3).map((r) => r[0] + ' ' + r[1] + '%').join(', '));
