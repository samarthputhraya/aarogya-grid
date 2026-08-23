import type { Facility } from '@/lib/domain/types';
import {
  BASELINE_OCCUPANCY,
  BED_MIX,
  BED_NORMS,
  BEDS_PER_NURSE_NORM,
  CADRE_ABSENCE_BASE,
  CADRE_LABEL,
  CADRE_REMOTENESS_SENSITIVITY,
  CADRE_VACANCY_BASE,
  SANCTIONED_POSTS,
  SEASONAL_ADMISSION_SHARE,
  STOCK_CUSTODIAN,
  SUBSTITUTE_CUSTODIAN,
  occupancyPressure,
  type BedClassOccupancy,
  type BedState,
  type CadreStaffing,
  type DistrictResourceRollup,
  type MedicineLinkage,
  type ReportingClass,
  type ReportingReliability,
  type ResourceState,
  type StaffCadre,
  type StaffingState,
} from '@/lib/domain/resources';
import { seasonalIndex } from '@/lib/forecast/seasonality';
import { districtReliability } from './inventory';
import { createRng, hashSeed, type Rng } from '@/lib/rng';

/**
 * Bed occupancy and workforce attendance simulator.
 *
 * SAME CONTRACT AS THE INVENTORY SIMULATOR
 * ----------------------------------------
 * Seeded, deterministic, and replaceable. Every draw runs through `createRng`
 * off a `hashSeed` of stable identifiers, so the same facility on the same
 * as-of date produces the same numbers on every machine and every reload --
 * which is the only way a jury sees the same figure twice and the only way a
 * regression is detectable. When real HMIS occupancy returns and HRMIS
 * attendance feeds are connected, this file is deleted and everything
 * downstream keeps working, because consumers depend on `ResourceState`, not on
 * this generator.
 *
 * THREE THINGS THIS FILE REFUSES TO INVENT
 * ----------------------------------------
 * 1. A SECOND SEASONALITY. Admission pressure is driven by
 *    `@/lib/forecast/seasonality` -- the exact monthly curves the drug demand
 *    model runs on. A general ward filling in August and the chloroquine shelf
 *    emptying in August are the same monsoon, and the system says so with one
 *    set of numbers.
 * 2. A SECOND NOTION OF REMOTENESS. Vacancy and absence are amplified by
 *    `districtReliability` (already the persistent district-level property that
 *    makes shortages cluster geographically) combined with road distance to the
 *    parent stocking point, which the facility model already carries. No new
 *    hidden district attribute is introduced, so the map's staffing layer and
 *    its stock layer light up the same regions -- because in reality they are
 *    the same regions, and that correlation is a finding rather than an
 *    artefact.
 * 3. A SECOND BED NORM. Sanctioned strength comes from `BED_NORMS`, which is
 *    also what the facility generator builds the registry from.
 *
 * WHAT IS SEEDED SEPARATELY, AND WHY IT MATTERS
 * ---------------------------------------------
 * Vacancy and attendance run off DIFFERENT seed streams, and attendance
 * additionally mixes in the as-of DATE. That is not a stylistic choice: a
 * vacant post is a structural fact that persists for months while an absence is
 * a property of one particular Tuesday, and a model that redrew both together
 * would let a recruitment problem appear and vanish overnight.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BedSimConfig {
  /** Evaluation date. The LAST element of every emitted series is this day. */
  asOf: Date;
  /** Days of occupancy history to simulate, inclusive of `asOf`. */
  historyDays: number;
  seed: number;
}

export interface StaffingSimConfig {
  /** Evaluation date. Attendance is drawn for this specific day. */
  asOf: Date;
  seed: number;
}

export type ResourceSimConfig = BedSimConfig;

/** Default occupancy window. Long enough to contain a full monsoon swing. */
export const DEFAULT_BED_HISTORY_DAYS = 180;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Sum of `n` Bernoulli(p) draws. n is small here (largest establishment is 90 posts). */
function binomial(rng: Rng, n: number, p: number): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (rng.next() < p) k++;
  return k;
}

// ---------------------------------------------------------------------------
// Remoteness
// ---------------------------------------------------------------------------

/** Structural remoteness of a tier, before district and distance effects. */
const TIER_REMOTENESS: Record<Facility['type'], number> = {
  SC: 1.0,
  PHC: 0.75,
  CHC: 0.45,
  SDH: 0.25,
  DH: 0.08,
  DW: 0.12,
};

/**
 * How hard this facility is to staff, 0 (easy) .. 1 (very hard).
 *
 * Built from properties the model ALREADY HAS rather than from a new attribute:
 *
 *   - district supply reliability, the persistent district property that makes
 *     stock failures cluster in regions instead of scattering at random;
 *   - road distance to the parent stocking point, which is the model's existing
 *     proxy for how far off the trunk route a facility sits;
 *   - tier, because a Sub-Centre is by construction the last building on the
 *     road and a district hospital is by construction in the headquarters town.
 *
 * Reusing these is what makes the workforce map and the stock map light up the
 * same blocks. That correlation is real -- the districts that cannot keep a
 * vehicle running are the districts that cannot keep a pharmacist -- and
 * inventing an independent remoteness score would have destroyed it.
 */
export function facilityRemoteness(facility: Facility): number {
  const reliability = districtReliability(facility.districtCode);
  // `districtReliability` spans roughly 0.45..0.97; map that onto 0..1 inverted.
  const reliabilityTerm = clamp((0.97 - reliability) / 0.5, 0, 1);
  const distanceTerm = clamp(facility.distanceToParentKm / 90, 0, 1);
  const tierTerm = TIER_REMOTENESS[facility.type];
  return clamp(0.45 * reliabilityTerm + 0.3 * distanceTerm + 0.25 * tierTerm, 0, 1);
}

// ---------------------------------------------------------------------------
// Beds
// ---------------------------------------------------------------------------

/**
 * Simulate inpatient occupancy for one facility.
 *
 * THE CENSORING, AGAIN
 * --------------------
 * This mirrors the inventory simulator's central point exactly, and it is worth
 * being explicit about because it is the same failure wearing a different
 * uniform. An HMIS occupancy return cannot record a patient who was not
 * admitted. A 30-bed CHC that had 34 people present itself reports 30 -- the
 * four who were referred onward, or who went home, or who went to a private
 * clinic they could not afford, leave no row anywhere.
 *
 * A planner reading the recorded series sees a ward at 100% and reads it as
 * "full". It is not full, it is SHORT, and the difference is the entire case
 * for adding beds rather than congratulating the facility on utilisation. So
 * both series are emitted: `occupiedSeries` is what a real return contains, and
 * `demandSeries` is the ground truth that only a simulation can see. Anything
 * downstream that wants to be production-honest reads the first.
 */
export function simulateBeds(facility: Facility, config: BedSimConfig): BedState {
  const { asOf, historyDays, seed } = config;
  const sanctioned = facility.bedsSanctioned || BED_NORMS[facility.type];
  const mix = BED_MIX[facility.type];
  const baseRate = BASELINE_OCCUPANCY[facility.type];

  // Sub-Centres and warehouses hold no inpatient beds. Emitting empty series
  // rather than arrays of zeros keeps the payload honest AND small: at demo
  // scale, sub-centres are more than half of every district's facility list.
  if (sanctioned <= 0 || mix.length === 0 || baseRate <= 0) {
    return {
      facilityId: facility.id,
      asOf: isoDate(asOf),
      sanctionedBeds: 0,
      functionalBeds: 0,
      occupied: 0,
      free: 0,
      occupancyRate: 0,
      pressure: 'low',
      occupiedSeries: [],
      demandSeries: [],
      meanOccupancyRate: 0,
      peakOccupancyRate: 0,
      daysAtCapacity: 0,
      unmetBedDays: 0,
      seasonalMultiplier: 1,
      byClass: [],
    };
  }

  const rng = createRng(hashSeed(seed, facility.id, 'beds'));
  const reliability = districtReliability(facility.districtCode);
  const remoteness = facilityRemoteness(facility);

  /**
   * Functional beds < sanctioned beds, always.
   *
   * A bed is sanctioned on paper and functional only if it has a mattress, a
   * ward with a roof that does not leak in July, and an oxygen point that
   * works. The gap tracks district reliability because the same district
   * administration that cannot keep a supply vehicle running cannot keep a ward
   * in repair -- these are not independent failures, they are one failure
   * observed twice.
   */
  const functionalShare = clamp(
    0.55 + 0.45 * reliability - 0.15 * remoteness + rng.real(-0.05, 0.05),
    0.45,
    1,
  );
  const functionalBeds = Math.max(1, Math.round(sanctioned * functionalShare));

  /**
   * Persistent facility pull factor.
   *
   * Two CHCs with identical sanctioned strength do not run at the same
   * occupancy: one sits on a highway with a functioning specialist and absorbs
   * referrals from three blocks, the other is bypassed entirely for the
   * district hospital. Drawn once and held for the whole window, because this
   * is a property of the facility's position in the referral network, not
   * day-to-day noise.
   */
  const pull = rng.real(0.78, 1.28);

  const occupiedSeries: number[] = new Array(historyDays).fill(0);
  const demandSeries: number[] = new Array(historyDays).fill(0);
  let daysAtCapacity = 0;
  let unmetBedDays = 0;
  let occupiedTotal = 0;
  let peak = 0;

  // The window ENDS on `asOf`, so the last element of every series is today.
  const cursor = new Date(asOf.getTime());
  cursor.setUTCDate(cursor.getUTCDate() - (historyDays - 1));

  for (let day = 0; day < historyDays; day++) {
    // Composite seasonal index across this facility's ward mix. Each ward runs
    // on its own epidemiological calendar -- maternity is near-flat, the general
    // ward tracks the vector-borne monsoon peak, paediatrics tracks the summer
    // enteric season -- and the facility feels the share-weighted sum of them.
    let composite = 0;
    for (const w of mix) composite += w.share * seasonalIndex(w.seasonality, cursor);
    const seasonal = 1 - SEASONAL_ADMISSION_SHARE + SEASONAL_ADMISSION_SHARE * composite;

    // Elective and OPD-referred admissions do not happen on a Sunday, and
    // Monday carries the backlog. Small, but it is visible in every real
    // occupancy series and its absence makes a simulated one look synthetic.
    const dow = cursor.getUTCDay();
    const weekly = dow === 0 ? 0.88 : dow === 1 ? 1.06 : 1.0;

    const noise = Math.max(0.4, rng.normal(1, 0.13));
    const demand = Math.round(functionalBeds * baseRate * pull * seasonal * weekly * noise);
    const occupied = Math.min(demand, functionalBeds);

    demandSeries[day] = demand;
    occupiedSeries[day] = occupied;
    occupiedTotal += occupied;
    if (occupied > peak) peak = occupied;
    if (occupied >= functionalBeds) daysAtCapacity++;
    if (demand > functionalBeds) unmetBedDays += demand - functionalBeds;

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const occupied = occupiedSeries[historyDays - 1];
  const occupancyRate = functionalBeds > 0 ? occupied / functionalBeds : 0;

  // Today's composite multiplier, recomputed on the as-of date for reporting.
  let compositeToday = 0;
  for (const w of mix) compositeToday += w.share * seasonalIndex(w.seasonality, asOf);
  const seasonalToday = 1 - SEASONAL_ADMISSION_SHARE + SEASONAL_ADMISSION_SHARE * compositeToday;

  return {
    facilityId: facility.id,
    asOf: isoDate(asOf),
    sanctionedBeds: sanctioned,
    functionalBeds,
    occupied,
    free: Math.max(0, functionalBeds - occupied),
    occupancyRate: +occupancyRate.toFixed(4),
    pressure: occupancyPressure(occupancyRate),
    occupiedSeries,
    demandSeries,
    meanOccupancyRate:
      functionalBeds > 0 ? +(occupiedTotal / historyDays / functionalBeds).toFixed(4) : 0,
    peakOccupancyRate: functionalBeds > 0 ? +(peak / functionalBeds).toFixed(4) : 0,
    daysAtCapacity,
    unmetBedDays,
    seasonalMultiplier: +seasonalToday.toFixed(3),
    byClass: splitByClass(facility, occupied, functionalBeds, asOf),
  };
}

/**
 * Attribute today's occupied beds across the wards.
 *
 * Weighted by ward share TIMES that ward's seasonal index, so a September
 * snapshot puts the crowding in the general ward where the dengue admissions
 * actually are, rather than spreading it evenly and quietly implying the
 * maternity ward doubled too. The rounding remainder is given to the largest
 * ward so the parts sum to the whole -- a bed breakdown that does not add up to
 * the headline count is the fastest way to lose a room.
 */
function splitByClass(
  facility: Facility,
  occupied: number,
  functionalBeds: number,
  asOf: Date,
): BedClassOccupancy[] {
  const mix = BED_MIX[facility.type];
  if (mix.length === 0) return [];

  const weights = mix.map((w) => w.share * seasonalIndex(w.seasonality, asOf));
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  const rows: BedClassOccupancy[] = mix.map((w, i) => ({
    bedClass: w.bedClass,
    label: w.label,
    beds: Math.round(functionalBeds * w.share),
    occupied: Math.floor((occupied * weights[i]) / total),
    seasonalMultiplier: +seasonalIndex(w.seasonality, asOf).toFixed(3),
  }));

  const assigned = rows.reduce((a, r) => a + r.occupied, 0);
  let largest = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].beds > rows[largest].beds) largest = i;
  rows[largest].occupied += occupied - assigned;

  // Clamp each ward to its own bed count, pushing any overflow to the next ward
  // with room. Wards are not fungible on the ground, but a row reading "9 of 6
  // occupied" is a rounding artefact, not a finding.
  for (let i = 0; i < rows.length; i++) {
    const over = rows[i].occupied - rows[i].beds;
    if (over <= 0) continue;
    rows[i].occupied = rows[i].beds;
    let spill = over;
    for (let j = 0; j < rows.length && spill > 0; j++) {
      if (j === i) continue;
      const room = rows[j].beds - rows[j].occupied;
      if (room <= 0) continue;
      const take = Math.min(room, spill);
      rows[j].occupied += take;
      spill -= take;
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Workforce
// ---------------------------------------------------------------------------

/**
 * Simulate the establishment, vacancies and today's attendance for one facility.
 *
 * SANCTIONED -> IN-POSITION -> PRESENT-TODAY, and the gaps between them are the
 * output. This is not three ways of saying "staff count":
 *
 *   sanctioned -> in-position   is a RECRUITMENT gap. It is owned by the state,
 *                               it moves on a timescale of years, and no amount
 *                               of district supervision closes it.
 *   in-position -> present      is an ATTENDANCE gap. It is owned by the block
 *                               and district, it moves in weeks, and it is
 *                               invisible in every workforce return that
 *                               reports only "posts filled".
 *
 * A facility with 8 of 10 posts filled and 40% absence has 4.8 people. A state
 * dashboard that reports 80% is not slightly optimistic, it is reporting a
 * number that is wrong by more than a third, and the two gaps have to be
 * carried separately all the way to the screen for that to be visible.
 */
export function simulateStaffing(facility: Facility, config: StaffingSimConfig): StaffingState {
  const { asOf, seed } = config;
  const posts = SANCTIONED_POSTS[facility.type];
  const remoteness = facilityRemoteness(facility);

  // Two streams, deliberately. Vacancy is a structural fact that persists for
  // months; attendance is a property of one particular day and mixes the date
  // into its seed so that asking about a different day genuinely gives a
  // different answer instead of replaying the same roster.
  const postRng = createRng(hashSeed(seed, facility.id, 'posts'));
  const dayRng = createRng(hashSeed(seed, facility.id, 'attendance', isoDate(asOf)));

  const cadres: CadreStaffing[] = [];
  let sanctionedTotal = 0;
  let inPositionTotal = 0;
  let presentTotal = 0;

  for (const [cadre, sanctioned] of Object.entries(posts) as [StaffCadre, number][]) {
    if (!sanctioned) continue;

    const sensitivity = CADRE_REMOTENESS_SENSITIVITY[cadre];
    /**
     * Remoteness amplifier, centred so that a facility at remoteness 0.4 --
     * about the national median in this network -- sits on the published
     * cadre base rate. Easy postings come in below it, hard postings above,
     * and the spread is proportional to how transferable the cadre is.
     */
    const amplifier = 1 + sensitivity * (remoteness - 0.4) * 1.6;
    const vacancyP = clamp(
      CADRE_VACANCY_BASE[cadre] * amplifier * postRng.real(0.8, 1.2),
      0.02,
      0.92,
    );
    const vacant = binomial(postRng, sanctioned, vacancyP);
    const inPosition = sanctioned - vacant;

    const absenceP = clamp(
      CADRE_ABSENCE_BASE[cadre] * (0.75 + 0.85 * remoteness) * dayRng.real(0.8, 1.2),
      0.02,
      0.6,
    );
    const absent = binomial(dayRng, inPosition, absenceP);
    const presentToday = inPosition - absent;

    cadres.push({
      cadre,
      label: CADRE_LABEL[cadre],
      sanctioned,
      inPosition,
      presentToday,
      vacancyRate: +(1 - inPosition / sanctioned).toFixed(4),
      absenteeismRate: inPosition > 0 ? +(1 - presentToday / inPosition).toFixed(4) : 0,
    });

    sanctionedTotal += sanctioned;
    inPositionTotal += inPosition;
    presentTotal += presentToday;
  }

  return {
    facilityId: facility.id,
    asOf: isoDate(asOf),
    cadres,
    sanctioned: sanctionedTotal,
    inPosition: inPositionTotal,
    presentToday: presentTotal,
    vacancyRate: sanctionedTotal > 0 ? +(1 - inPositionTotal / sanctionedTotal).toFixed(4) : 0,
    absenteeismRate: inPositionTotal > 0 ? +(1 - presentTotal / inPositionTotal).toFixed(4) : 0,
    effectiveAvailability: sanctionedTotal > 0 ? +(presentTotal / sanctionedTotal).toFixed(4) : 0,
    remoteness: +remoteness.toFixed(3),
    criticalGaps: describeGaps(facility, cadres),
  };
}

/**
 * The gaps worth a district officer's attention, worst first.
 *
 * Written as sentences rather than codes because this is the output that goes
 * in front of a human, and "specialist: 4/0" does not tell a CMO that the CHC
 * on their referral map cannot perform a caesarean tonight. Returns an empty
 * list for an adequately staffed facility -- a real and common outcome that
 * must not be dressed up into a finding to fill a panel.
 */
function describeGaps(facility: Facility, cadres: CadreStaffing[]): string[] {
  const by = new Map(cadres.map((c) => [c.cadre, c]));
  const gaps: string[] = [];

  const specialist = by.get('specialist');
  if (specialist && specialist.sanctioned > 0) {
    if (specialist.inPosition === 0) {
      gaps.push(
        `No specialist in position against ${specialist.sanctioned} sanctioned posts — this facility cannot function as a referral unit.`,
      );
    } else if (specialist.vacancyRate >= 0.5) {
      gaps.push(
        `${specialist.sanctioned - specialist.inPosition} of ${specialist.sanctioned} specialist posts vacant.`,
      );
    }
  }

  const mo = by.get('medical_officer');
  if (mo && mo.sanctioned > 0) {
    if (mo.inPosition === 0) gaps.push('No Medical Officer in position — the facility is nurse-run.');
    else if (mo.presentToday === 0) gaps.push('No Medical Officer present today.');
  }

  const pharmacist = by.get('pharmacist');
  if (pharmacist && pharmacist.sanctioned > 0) {
    if (pharmacist.inPosition === 0) {
      gaps.push('Pharmacist post vacant — nobody is in position to keep the stock register.');
    } else if (pharmacist.presentToday === 0) {
      gaps.push('Pharmacist in position but absent today — stock figures are unattested.');
    }
  }

  const anm = by.get('anm');
  if (anm && anm.sanctioned > 0 && anm.inPosition === 0) {
    gaps.push('No ANM in position — this Sub-Centre has no resident health worker.');
  }

  const cho = by.get('cho');
  if (cho && cho.sanctioned > 0 && cho.inPosition === 0) {
    gaps.push('Community Health Officer post vacant — the HWC package is not being delivered.');
  }

  const nurse = by.get('staff_nurse');
  if (nurse && nurse.sanctioned > 0 && nurse.vacancyRate >= 0.4) {
    gaps.push(
      `${nurse.sanctioned - nurse.inPosition} of ${nurse.sanctioned} nursing posts vacant — ward capacity is constrained by staff, not by beds.`,
    );
  }

  const mpw = by.get('mpw_male');
  if (mpw && mpw.sanctioned > 0 && mpw.inPosition === 0 && facility.type === 'SC') {
    gaps.push('Male MPW post vacant — no field vector-control or surveillance cover.');
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// The derived link back to the medicine layer
// ---------------------------------------------------------------------------

/**
 * How much the stock figure from this facility can be believed.
 *
 * THIS IS THE FUNCTION THAT MAKES THIS ONE SYSTEM RATHER THAN THREE DASHBOARDS.
 *
 * Every stock number in this product arrives from a facility as a report, and a
 * report is an act performed by a named person holding a post. At a PHC and
 * above that person is the pharmacist; at a Sub-Centre it is the ANM. When that
 * post is vacant the return does not stop arriving -- it is filed by a staff
 * nurse or a storekeeper, later, from memory, on top of a clinical shift. The
 * figure is still a number, still renders in the same table, and is no longer a
 * measurement.
 *
 * A supply dashboard that cannot say which of its numbers were counted by the
 * person responsible for counting them is presenting an inference as an
 * observation. This is what stops that happening, and it is why the workforce
 * layer is not a separate tab: it is the provenance of the medicine layer.
 *
 * Ward pressure enters too, with a small weight. A facility running at 98%
 * occupancy has a pharmacist who spent the day issuing to wards rather than
 * reconciling a register, and the month-end return shows it.
 */
export function deriveReporting(
  facility: Facility,
  staffing: StaffingState,
  occupancyRate: number,
): ReportingReliability {
  const custodian = STOCK_CUSTODIAN[facility.type];
  const substitute = SUBSTITUTE_CUSTODIAN[facility.type];
  const by = new Map(staffing.cadres.map((c) => [c.cadre, c]));

  const custodianRow = by.get(custodian);
  const substituteRow = by.get(substitute);
  const custodianInPosition = (custodianRow?.inPosition ?? 0) > 0;
  const custodianPresentToday = (custodianRow?.presentToday ?? 0) > 0;
  const substitutePresent = (substituteRow?.presentToday ?? 0) > 0;

  let score: number;
  if (custodianInPosition && custodianPresentToday) score = 1;
  else if (custodianInPosition) score = 0.72; // post filled, person away today
  else score = substitutePresent ? 0.42 : 0.18; // post empty; someone covering, or nobody

  // District reliability again -- the districts that cannot deliver stock are
  // the districts whose returns arrive late and incomplete. Same property, and
  // deliberately not a second "reporting discipline" attribute.
  score *= 0.78 + 0.22 * districtReliability(facility.districtCode);

  // Ward pressure crowds out the paperwork, but only once the ward is genuinely
  // full; below 85% occupancy this term is exactly zero.
  const capacityPressure = clamp((occupancyRate - 0.85) / 0.15, 0, 1);
  score *= 1 - 0.12 * capacityPressure;
  score = clamp(score, 0.05, 1);

  let cls: ReportingClass;
  if (!custodianInPosition && !substitutePresent) cls = 'unattended';
  else if (!custodianInPosition) cls = 'unverified';
  else if (!custodianPresentToday || score < 0.75) cls = 'attested';
  else cls = 'verified';

  const custodianName = CADRE_LABEL[custodian];
  const substituteName = CADRE_LABEL[substitute];
  const note =
    cls === 'verified'
      ? `Stock position counted and signed by the ${custodianName} in post.`
      : cls === 'attested'
        ? `${custodianName} post is filled but was not present on the reporting date — figures are attested, not counted.`
        : cls === 'unverified'
          ? `${custodianName} post vacant. The register is being kept by the ${substituteName} alongside clinical duties; treat quantities as indicative.`
          : `${custodianName} post vacant and no ${substituteName} present. Nobody at this facility is in position to verify the stock figures shown.`;

  return {
    score: +score.toFixed(3),
    class: cls,
    custodian,
    custodianInPosition,
    custodianPresentToday,
    note,
  };
}

/**
 * Occupancy elasticity of drug consumption.
 *
 * A ward running above its tier's baseline occupancy consumes IV fluids,
 * antibiotics, oxytocin and consumables faster than the annual average the
 * forecast was fitted on. The elasticity is deliberately WELL BELOW 1: most of
 * a primary facility's dispensing volume is outpatient, which an empty ward
 * does not stop and a full ward does not double. Setting it to 1 would be
 * claiming a PHC's entire drug consumption is inpatient, which is false by a
 * wide margin.
 *
 * Bounded on both sides so a quiet February cannot be used to argue a facility
 * needs almost nothing.
 */
const OCCUPANCY_CONSUMPTION_ELASTICITY = 0.35;

function deriveLinkage(
  facility: Facility,
  beds: BedState,
  reporting: ReportingReliability,
): MedicineLinkage {
  const baseline = BASELINE_OCCUPANCY[facility.type];
  const consumptionPressure =
    baseline > 0 && beds.functionalBeds > 0
      ? clamp(
          1 + OCCUPANCY_CONSUMPTION_ELASTICITY * (beds.occupancyRate / baseline - 1),
          0.85,
          1.5,
        )
      : 1;

  return {
    consumptionPressure: +consumptionPressure.toFixed(3),
    stockReportTrust: reporting.score,
    // A thinly attested ledger does not produce a wrong forecast; it produces a
    // forecast with a wider honest error bar. Capped, because past a point the
    // right answer is to go and count the shelf, not to widen an interval.
    reportingUncertaintyFactor: +clamp(1 + 1.2 * (1 - reporting.score), 1, 2.2).toFixed(3),
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Full resource state for one facility: beds, workforce, and what they imply about the stock ledger. */
export function buildResourceState(facility: Facility, config: ResourceSimConfig): ResourceState {
  const beds = simulateBeds(facility, config);
  const staffing = simulateStaffing(facility, { asOf: config.asOf, seed: config.seed });
  const reporting = deriveReporting(facility, staffing, beds.occupancyRate);
  const linkage = deriveLinkage(facility, beds, reporting);

  // Beds a present nursing establishment can actually cover today. Capped at
  // the functional count -- surplus nurses do not conjure beds -- and it is
  // routinely the binding constraint: a ward with 30 functional beds and four
  // nurses on duty is a 12-bed ward, whatever the board outside says.
  const nurses = staffing.cadres.find((c) => c.cadre === 'staff_nurse')?.presentToday ?? 0;
  const staffedBeds = Math.min(beds.functionalBeds, nurses * BEDS_PER_NURSE_NORM);

  return {
    facilityId: facility.id,
    facilityName: facility.name,
    facilityType: facility.type,
    districtCode: facility.districtCode,
    districtName: facility.districtName,
    stateCode: facility.stateCode,
    stateName: facility.stateName,
    lat: facility.lat,
    lon: facility.lon,
    population: facility.population,
    asOf: isoDate(config.asOf),
    beds,
    staffing,
    reporting,
    linkage,
    staffedBeds,
  };
}

/** Resource state for a whole facility list, in input order. */
export function buildResourceStates(
  facilities: Facility[],
  config: ResourceSimConfig,
): ResourceState[] {
  return facilities.map((f) => buildResourceState(f, config));
}

/**
 * Roll facility states up to the district picture.
 *
 * Bed occupancy is a district-wide ratio of occupied to FUNCTIONAL beds, not a
 * mean of per-facility rates: averaging rates would let twenty empty six-bed
 * PHCs cancel out a district hospital with patients on the floor, which is
 * exactly the arithmetic that keeps bed shortages invisible in state reporting.
 *
 * Report trust is population-weighted for the same reason -- an unverified
 * Sub-Centre serving 4,000 people and an unverified district hospital serving
 * 900,000 are not one problem each.
 */
export function rollUpDistrictResources(states: ResourceState[]): DistrictResourceRollup {
  let facilitiesWithBeds = 0;
  let sanctionedBeds = 0;
  let functionalBeds = 0;
  let staffedBeds = 0;
  let occupiedBeds = 0;
  let facilitiesAtCapacity = 0;
  let unmetBedDays = 0;

  let staffSanctioned = 0;
  let staffInPosition = 0;
  let staffPresent = 0;
  let specialistSanctioned = 0;
  let specialistInPosition = 0;

  let facilitiesWithoutPharmacist = 0;
  let facilitiesWithoutMedicalOfficer = 0;
  let subCentresWithoutAnm = 0;
  let unverifiedReportingFacilities = 0;

  let trustWeighted = 0;
  let populationWeight = 0;
  let populationUnverified = 0;

  for (const s of states) {
    if (s.beds.functionalBeds > 0) {
      facilitiesWithBeds++;
      sanctionedBeds += s.beds.sanctionedBeds;
      functionalBeds += s.beds.functionalBeds;
      staffedBeds += s.staffedBeds;
      occupiedBeds += s.beds.occupied;
      unmetBedDays += s.beds.unmetBedDays;
      if (s.beds.occupancyRate >= 0.95) facilitiesAtCapacity++;
    }

    staffSanctioned += s.staffing.sanctioned;
    staffInPosition += s.staffing.inPosition;
    staffPresent += s.staffing.presentToday;

    for (const c of s.staffing.cadres) {
      if (c.cadre === 'specialist') {
        specialistSanctioned += c.sanctioned;
        specialistInPosition += c.inPosition;
      }
      if (c.cadre === 'pharmacist' && c.sanctioned > 0 && c.inPosition === 0) {
        facilitiesWithoutPharmacist++;
      }
      if (c.cadre === 'medical_officer' && c.sanctioned > 0 && c.inPosition === 0) {
        facilitiesWithoutMedicalOfficer++;
      }
      if (c.cadre === 'anm' && c.sanctioned > 0 && c.inPosition === 0 && s.facilityType === 'SC') {
        subCentresWithoutAnm++;
      }
    }

    const weight = Math.max(1, s.population);
    trustWeighted += s.reporting.score * weight;
    populationWeight += weight;
    if (s.reporting.class === 'unverified' || s.reporting.class === 'unattended') {
      unverifiedReportingFacilities++;
      populationUnverified += s.population;
    }
  }

  const bedOccupancyRate = functionalBeds > 0 ? occupiedBeds / functionalBeds : 0;

  return {
    facilitiesWithBeds,
    sanctionedBeds,
    functionalBeds,
    staffedBeds,
    occupiedBeds,
    freeBeds: Math.max(0, functionalBeds - occupiedBeds),
    bedOccupancyRate: +bedOccupancyRate.toFixed(4),
    pressure: occupancyPressure(bedOccupancyRate),
    facilitiesAtCapacity,
    unmetBedDays,

    staffSanctioned,
    staffInPosition,
    staffPresent,
    vacancyRate: staffSanctioned > 0 ? +(1 - staffInPosition / staffSanctioned).toFixed(4) : 0,
    absenteeismRate: staffInPosition > 0 ? +(1 - staffPresent / staffInPosition).toFixed(4) : 0,
    effectiveAvailability:
      staffSanctioned > 0 ? +(staffPresent / staffSanctioned).toFixed(4) : 0,
    specialistSanctioned,
    specialistInPosition,
    specialistVacancyRate:
      specialistSanctioned > 0
        ? +(1 - specialistInPosition / specialistSanctioned).toFixed(4)
        : 0,

    facilitiesWithoutPharmacist,
    facilitiesWithoutMedicalOfficer,
    subCentresWithoutAnm,
    unverifiedReportingFacilities,
    meanReportTrust: populationWeight > 0 ? +(trustWeighted / populationWeight).toFixed(3) : 0,
    populationUnderUnverifiedReporting: populationUnverified,
  };
}
