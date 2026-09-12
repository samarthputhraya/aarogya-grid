import type { Facility, SeasonalityProfile } from '@/lib/domain/types';
import { seasonalIndex } from '@/lib/forecast/seasonality';
import { createRng, hashSeed } from '@/lib/rng';
import { simulateStaffing, facilityRemoteness } from './resources';

/**
 * Outpatient footfall: the series an outbreak shows up in FIRST.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * A stock-out is a lagging indicator. By the time anti-malarials are running
 * short in a block, the malaria has been there for a fortnight -- the
 * consumption series only moves after people have already walked in, been seen,
 * and been treated. If the point of this project is to see a health emergency
 * coming, the earliest series it can watch is the one that records the walking
 * in. That is the OPD register, and every PHC in India already keeps one.
 *
 * So footfall is not a third dashboard. It is the leading edge of the same
 * signal the stock model sees late, and putting both on one district time axis
 * is what lets a surge be detected days before the shelf empties.
 *
 * MODELLED ON `simulateBeds`, AND CENSORED BY `simulateStaffing`
 * -------------------------------------------------------------
 * The shape of the day -- composite seasonality across disease archetypes,
 * day-of-week, overdispersed noise, a persistent per-facility pull factor --
 * is the bed simulator's, because the same machinery describes the same country
 * and two independently invented versions of it would disagree in ways nobody
 * could explain.
 *
 * The censoring is the part that matters, and it is the third appearance of one
 * idea in this codebase:
 *
 *   - a stock ledger cannot record a dispensation that had no stock;
 *   - an occupancy return cannot record a patient who was not admitted;
 *   - an OPD register cannot record a consultation nobody was there to give.
 *
 * An OPD with no Medical Officer present does not run at reduced quality. It
 * does not run. The patients are turned away, walk to a private clinic, or come
 * back on Thursday, and the register for that day is thin or empty -- and a
 * planner reading it concludes the block is healthy. So capacity is drawn from
 * the SAME attendance model the workforce panel shows, by asking
 * `simulateStaffing` for that particular day. Not a parallel roster: the same
 * one, which is what makes stock, beds, staff and footfall one country instead
 * of four.
 *
 * `demandSeries` is the ground truth only a simulation can see;
 * `attendedSeries` is what a real HMIS return would contain. Everything
 * downstream that wants to be production-honest reads the second.
 */

export interface FootfallConfig {
  /** Evaluation date. The LAST element of every emitted series is this day. */
  asOf: Date;
  historyDays: number;
  seed: number;
}

export interface FootfallState {
  facilityId: string;
  asOf: string;
  /** Patients who presented, before anyone was turned away. Simulation-only. */
  demandSeries: number[];
  /** Consultations actually recorded. What an HMIS OPD return contains. */
  attendedSeries: number[];
  attendedToday: number;
  /** Mean recorded attendance per day over the window. */
  meanDaily: number;
  /** Days on which the OPD could not see everyone who came. */
  daysCapped: number;
  /** Days on which no clinician was present and the OPD did not run at all. */
  daysClosed: number;
  /** Total consultations lost to the capacity ceiling over the window. */
  turnedAwayTotal: number;
  seasonalMultiplier: number;
  /** Clinicians present on the as-of date -- the mechanism behind the ceiling. */
  clinicalPresentToday: number;
  /** Consultations that establishment could deliver today. */
  capacityToday: number;
}

/**
 * Recorded OPD consultations per 1,000 catchment per day, by tier.
 *
 * PROVENANCE -- READ THIS BEFORE QUOTING ANY NUMBER HERE. These are modelling
 * assumptions of the same kind as `SEASONAL_PROFILES`, chosen so that a
 * facility of each tier sees roughly what facilities of that tier are commonly
 * reported to see against their IPHS catchment norm:
 *
 *   SC / HWC  5,000 catchment  ->  ~25 consultations a day
 *   PHC      30,000            ->  ~81
 *   CHC     120,000            ->  ~204
 *   SDH     400,000            ->  ~500
 *   DH    1,000,000            ->  ~1,200
 *
 * They are NOT measured constants, and nothing built on them should be
 * presented as an empirical finding. When real HMIS OPD returns are connected
 * the code path does not change, only the source of the numbers -- exactly as
 * with the seasonal curves.
 */
export const OPD_PER_1000_PER_DAY: Record<Facility['type'], number> = {
  SC: 5.0,
  PHC: 2.7,
  CHC: 1.7,
  SDH: 1.25,
  DH: 1.2,
  // A district warehouse has no outpatient department. Emitting empty series
  // rather than zeros keeps the payload honest and small.
  DW: 0,
};

/**
 * How a tier's outpatient load splits across disease archetypes.
 *
 * A district hospital's OPD is more specialist and less seasonal than a
 * sub-centre's, which is almost entirely primary morbidity; the shares differ
 * accordingly. The `flat` share is everything with no epidemiological calendar
 * -- follow-ups, antenatal visits, hypertension and diabetes review, injuries.
 */
const OPD_MIX: Record<Facility['type'], { profile: SeasonalityProfile; share: number }[]> = {
  SC: [
    { profile: 'flat', share: 0.34 },
    { profile: 'monsoon_vector', share: 0.2 },
    { profile: 'winter_respiratory', share: 0.22 },
    { profile: 'summer_enteric', share: 0.16 },
    { profile: 'summer_heat', share: 0.08 },
  ],
  PHC: [
    { profile: 'flat', share: 0.36 },
    { profile: 'monsoon_vector', share: 0.2 },
    { profile: 'winter_respiratory', share: 0.21 },
    { profile: 'summer_enteric', share: 0.15 },
    { profile: 'summer_heat', share: 0.08 },
  ],
  CHC: [
    { profile: 'flat', share: 0.44 },
    { profile: 'monsoon_vector', share: 0.18 },
    { profile: 'winter_respiratory', share: 0.19 },
    { profile: 'summer_enteric', share: 0.12 },
    { profile: 'summer_heat', share: 0.07 },
  ],
  SDH: [
    { profile: 'flat', share: 0.5 },
    { profile: 'monsoon_vector', share: 0.16 },
    { profile: 'winter_respiratory', share: 0.17 },
    { profile: 'summer_enteric', share: 0.11 },
    { profile: 'summer_heat', share: 0.06 },
  ],
  DH: [
    { profile: 'flat', share: 0.54 },
    { profile: 'monsoon_vector', share: 0.15 },
    { profile: 'winter_respiratory', share: 0.16 },
    { profile: 'summer_enteric', share: 0.1 },
    { profile: 'summer_heat', share: 0.05 },
  ],
  DW: [],
};

/**
 * Consultations one present clinician can deliver in a working day, by cadre.
 *
 * DELIBERATELY HIGH, AND THAT IS THE POINT. An MO at a busy PHC seeing a
 * hundred patients in a four-hour morning session is ordinary in the Indian
 * public system rather than exceptional -- it is a widely documented quality
 * problem, not a capacity headroom. Setting these at a comfortable
 * fifteen-minute consultation would make the ceiling bind on most days at most
 * facilities, and the attended series would then be a picture of clinic
 * throughput rather than of how many people came.
 *
 * Pitched here, the ceiling binds when somebody is ABSENT, which is the thing
 * worth modelling: an OPD with no clinician present does not run at reduced
 * quality, it does not run. Nursing and community cadres carry a lower weight
 * because they run screening, dressings and the HWC clinic rather than the full
 * consultation load. These are modelling assumptions, not measured constants.
 */
const CADRE_CONSULTATIONS: Record<string, number> = {
  medical_officer: 110,
  specialist: 70,
  cho: 60,
  staff_nurse: 18,
  anm: 30,
  mpw_male: 10,
};

/** Share of the day's load that moves with the disease calendar. */
const SEASONAL_OPD_SHARE = 0.45;

/**
 * Day-of-week pattern.
 *
 * Sunday is closed except for emergencies, Monday carries the weekend's
 * backlog, Saturday is a half-day in most states. It is small, it is visible in
 * every real OPD series, and its absence is one of the things that makes a
 * simulated one look simulated.
 */
const DOW_FACTOR = [0.2, 1.24, 1.06, 1.0, 1.0, 0.98, 0.8];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Consultations the clinicians present at this facility today could deliver.
 *
 * Reads the SAME roster the workforce panel shows. Calling `simulateStaffing`
 * per day is what keeps the two honest: its attendance stream is seeded with
 * the date, so each day is a genuinely different roster rather than a replay,
 * and a parallel model here would have quietly disagreed with the number on
 * screen.
 */
export function consultationCapacity(
  facility: Facility,
  day: Date,
  seed: number,
): { capacity: number; clinicalPresent: number } {
  const staffing = simulateStaffing(facility, { asOf: day, seed });
  let capacity = 0;
  let clinicalPresent = 0;
  for (const cadre of staffing.cadres) {
    const per = CADRE_CONSULTATIONS[cadre.cadre];
    if (!per) continue;
    capacity += cadre.presentToday * per;
    clinicalPresent += cadre.presentToday;
  }
  return { capacity, clinicalPresent };
}

export function simulateFootfall(facility: Facility, config: FootfallConfig): FootfallState {
  const { asOf, historyDays, seed } = config;
  const perThousand = OPD_PER_1000_PER_DAY[facility.type];
  const mix = OPD_MIX[facility.type];

  if (perThousand <= 0 || mix.length === 0 || facility.population <= 0) {
    return {
      facilityId: facility.id,
      asOf: isoDate(asOf),
      demandSeries: [],
      attendedSeries: [],
      attendedToday: 0,
      meanDaily: 0,
      daysCapped: 0,
      daysClosed: 0,
      turnedAwayTotal: 0,
      seasonalMultiplier: 1,
      clinicalPresentToday: 0,
      capacityToday: 0,
    };
  }

  const rng = createRng(hashSeed(seed, facility.id, 'footfall'));
  const remoteness = facilityRemoteness(facility);

  /**
   * Persistent facility pull factor.
   *
   * Two PHCs with the same catchment do not see the same number of patients:
   * one is on a bus route with a doctor everybody trusts, the other is bypassed
   * for the CHC. Drawn once and held, because this is a property of the
   * facility's standing in its block rather than day-to-day noise. Remote
   * facilities pull slightly less, since their catchment is dispersed and the
   * journey itself deters attendance.
   */
  const pull = clamp(rng.real(0.75, 1.3) - 0.12 * remoteness, 0.5, 1.4);
  const baseline = (facility.population / 1000) * perThousand * pull;

  const demandSeries: number[] = new Array(historyDays).fill(0);
  const attendedSeries: number[] = new Array(historyDays).fill(0);
  let attendedTotal = 0;
  let daysCapped = 0;
  let daysClosed = 0;
  let turnedAwayTotal = 0;
  let clinicalPresentToday = 0;
  let capacityToday = 0;

  // The window ENDS on `asOf`, so the last element of every series is today.
  const cursor = new Date(asOf.getTime());
  cursor.setUTCDate(cursor.getUTCDate() - (historyDays - 1));

  for (let day = 0; day < historyDays; day++) {
    let composite = 0;
    for (const m of mix) composite += m.share * seasonalIndex(m.profile, cursor);
    // The shares do not sum to 1 -- the remainder is load with no calendar --
    // so the composite is renormalised against the share that IS seasonal.
    const seasonalShareTotal = mix.reduce((a, m) => a + m.share, 0);
    const seasonal =
      1 - SEASONAL_OPD_SHARE + SEASONAL_OPD_SHARE * (composite / seasonalShareTotal);

    const weekly = DOW_FACTOR[cursor.getUTCDay()];
    // Overdispersed rather than Poisson: real OPD counts have a variance well
    // above their mean, because attendance arrives in correlated bursts -- a
    // camp, a market day, a wedding season, a funeral.
    const noise = Math.max(0.35, rng.normal(1, 0.16));

    const demand = Math.round(baseline * seasonal * weekly * noise);
    const { capacity, clinicalPresent } = consultationCapacity(facility, cursor, seed);
    const attended = Math.min(demand, capacity);

    demandSeries[day] = demand;
    attendedSeries[day] = attended;
    attendedTotal += attended;
    if (demand > capacity) {
      daysCapped++;
      turnedAwayTotal += demand - capacity;
    }
    if (capacity === 0) daysClosed++;

    if (day === historyDays - 1) {
      clinicalPresentToday = clinicalPresent;
      capacityToday = capacity;
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  let compositeToday = 0;
  for (const m of mix) compositeToday += m.share * seasonalIndex(m.profile, asOf);
  const seasonalShareTotal = mix.reduce((a, m) => a + m.share, 0);
  const seasonalToday =
    1 - SEASONAL_OPD_SHARE + SEASONAL_OPD_SHARE * (compositeToday / seasonalShareTotal);

  return {
    facilityId: facility.id,
    asOf: isoDate(asOf),
    demandSeries,
    attendedSeries,
    attendedToday: attendedSeries[historyDays - 1],
    meanDaily: +(attendedTotal / historyDays).toFixed(1),
    daysCapped,
    daysClosed,
    turnedAwayTotal,
    seasonalMultiplier: +seasonalToday.toFixed(3),
    clinicalPresentToday,
    capacityToday,
  };
}
