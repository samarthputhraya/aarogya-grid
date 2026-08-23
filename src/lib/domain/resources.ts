import type { FacilityType, SeasonalityProfile } from './types';

/**
 * Domain model for the two resources this system tracks alongside medicines:
 * INPATIENT BEDS and HEALTH WORKFORCE ATTENDANCE.
 *
 * WHY THESE TWO SIT IN THE SAME SYSTEM AS THE DRUG LEDGER
 * -------------------------------------------------------
 * A stock dashboard that knows nothing about beds or people will confidently
 * mis-read its own data, in two specific and repeatable ways:
 *
 *   1. CONSUMPTION IS DRIVEN BY OCCUPANCY. A 30-bed CHC running at 96% in
 *      September burns IV fluids, antibiotics and oxytocin materially faster
 *      than the same CHC running at 45% in February. A forecast fitted on
 *      last quarter's ledger and applied flat across the monsoon under-orders
 *      exactly when the ward is fullest.
 *
 *   2. DATA QUALITY IS A STAFFING FACT. The stock register is kept by one
 *      person -- the pharmacist at a PHC or above, the ANM at a Sub-Centre.
 *      When that post is vacant, the return is filed by whoever is free, late,
 *      from memory. The number on the dashboard is then not a measurement, it
 *      is an estimate with an unstated error bar, and the system has no
 *      business presenting it in the same typeface as a verified count.
 *
 * So beds and people are not two extra dashboards bolted on. They are the
 * denominator and the provenance of the medicine layer, and this file is where
 * both are defined.
 *
 * PROVENANCE -- READ BEFORE QUOTING ANY NUMBER HERE
 * -------------------------------------------------
 * - Bed counts by tier and the staffing establishment by tier follow the
 *   INDIAN PUBLIC HEALTH STANDARDS (IPHS), 2022 revision. These are norms:
 *   what a facility of that tier is SUPPOSED to have. They are structural, and
 *   they are the right thing to hard-code, because the whole point of the
 *   vacancy metric is the gap between the norm and reality.
 * - Baseline occupancy rates, vacancy rates and absence rates encode the SHAPE
 *   of what Rural Health Statistics and the facility-survey literature report
 *   (specialist posts at CHCs are the emptiest; male multi-purpose worker posts
 *   run a distant second; absence is measured in the 25-40% band in unannounced
 *   visit studies). They are MODELLING ASSUMPTIONS, not measurements, and they
 *   are the first thing replaced when real HRMIS / HMIS attendance feeds and
 *   HMIS bed-occupancy returns are connected. Nothing derived from them should
 *   be presented as an empirical finding.
 * - The seasonal shape of admissions is NOT invented here. It reuses the same
 *   epidemiological calendar the drug demand model runs on
 *   (`@/lib/forecast/seasonality`), because a system that claimed dengue drives
 *   drug demand in September but not bed demand in September would be
 *   contradicting itself on screen.
 */

// ---------------------------------------------------------------------------
// Beds
// ---------------------------------------------------------------------------

/**
 * Sanctioned bed strength by tier, per IPHS 2022.
 *
 *   Sub-Centre / HWC   : no inpatient beds. An SC conducts deliveries only
 *                        where it is a designated delivery point, and even then
 *                        holds no sanctioned inpatient strength.
 *   PHC                : 6 beds.
 *   CHC                : 30 beds.
 *   Sub-District Hosp. : IPHS gives a 31-100 band by sub-district population;
 *                        60 is taken as the indicative mid-point.
 *   District Hospital  : IPHS gives 100-500 by district population; 200 is
 *                        taken as the indicative mid-point.
 *   District Warehouse : a stocking point, not a care delivery point.
 *
 * This table is the SINGLE definition of sanctioned beds in the codebase.
 * `sim/facilities.ts` imports it rather than keeping its own copy -- two tables
 * of bed norms is precisely how a facility register and an occupancy report
 * start quoting different denominators for the same ward.
 */
export const BED_NORMS: Record<FacilityType, number> = {
  SC: 0,
  PHC: 6,
  CHC: 30,
  SDH: 60,
  DH: 200,
  DW: 0,
};

/** Ward types a bed can belong to. Admission pressure on each follows a different calendar. */
export type BedClass = 'maternity' | 'general' | 'paediatric' | 'emergency' | 'isolation';

export interface BedClassNorm {
  bedClass: BedClass;
  label: string;
  /** Share of the tier's sanctioned beds assigned to this ward. Sums to 1 within a tier. */
  share: number;
  /**
   * Which epidemiological archetype drives admissions here.
   *
   * Reused verbatim from the drug demand model. A general ward filling in
   * August is the same dengue and malaria wave that empties the chloroquine
   * shelf; a paediatric ward filling in May is the same enteric season that
   * empties the ORS shelf. One calendar, two consequences.
   */
  seasonality: SeasonalityProfile;
}

/**
 * How a tier's sanctioned beds split across wards.
 *
 * Shares are indicative and follow what the tiers are actually used for: a PHC
 * bed is overwhelmingly a labour or observation bed, a CHC adds paediatrics and
 * a real casualty function, and a district hospital carries the full mix
 * including isolation capacity retained after COVID-19.
 */
export const BED_MIX: Record<FacilityType, BedClassNorm[]> = {
  SC: [],
  DW: [],
  PHC: [
    { bedClass: 'maternity', label: 'Labour / post-natal', share: 0.5, seasonality: 'obstetric' },
    { bedClass: 'general', label: 'General / observation', share: 0.5, seasonality: 'monsoon_vector' },
  ],
  CHC: [
    { bedClass: 'maternity', label: 'Maternity', share: 0.3, seasonality: 'obstetric' },
    { bedClass: 'general', label: 'General ward', share: 0.45, seasonality: 'monsoon_vector' },
    { bedClass: 'paediatric', label: 'Paediatric', share: 0.15, seasonality: 'summer_enteric' },
    { bedClass: 'emergency', label: 'Casualty / observation', share: 0.1, seasonality: 'monsoon_envenomation' },
  ],
  SDH: [
    { bedClass: 'maternity', label: 'Maternity', share: 0.2, seasonality: 'obstetric' },
    { bedClass: 'general', label: 'General ward', share: 0.48, seasonality: 'monsoon_vector' },
    { bedClass: 'paediatric', label: 'Paediatric', share: 0.14, seasonality: 'summer_enteric' },
    { bedClass: 'emergency', label: 'Casualty / observation', share: 0.1, seasonality: 'monsoon_envenomation' },
    { bedClass: 'isolation', label: 'Isolation', share: 0.08, seasonality: 'winter_respiratory' },
  ],
  DH: [
    { bedClass: 'maternity', label: 'Maternity', share: 0.18, seasonality: 'obstetric' },
    { bedClass: 'general', label: 'General ward', share: 0.5, seasonality: 'monsoon_vector' },
    { bedClass: 'paediatric', label: 'Paediatric', share: 0.14, seasonality: 'summer_enteric' },
    { bedClass: 'emergency', label: 'Casualty / observation', share: 0.1, seasonality: 'monsoon_envenomation' },
    { bedClass: 'isolation', label: 'Isolation', share: 0.08, seasonality: 'winter_respiratory' },
  ],
};

/**
 * Annual mean occupancy rate by tier -- the level the seasonal curve swings around.
 *
 * MODELLING ASSUMPTION. The ordering is the defensible part and it is stark:
 * district hospitals in India run hot enough to put patients on the floor while
 * PHC beds a few kilometres away sit empty, because referral behaviour bypasses
 * the primary tier. That gradient is not noise to be smoothed away -- it is the
 * single most actionable thing a bed dashboard can show a district officer.
 */
export const BASELINE_OCCUPANCY: Record<FacilityType, number> = {
  SC: 0,
  PHC: 0.32,
  CHC: 0.52,
  SDH: 0.68,
  DH: 0.79,
  DW: 0,
};

/**
 * Fraction of admission demand that moves with the season.
 *
 * Applying a seasonal index straight to occupancy would say a ward is 100%
 * seasonal, which is false: chronic care, trauma, deliveries and referrals
 * arrive all year. Splitting demand into a fixed base and a seasonal component
 * keeps the monsoon swing visible without inventing a ward that empties in
 * February.
 */
export const SEASONAL_ADMISSION_SHARE = 0.55;

/** How full a ward is, in the same four bands the stock risk engine uses. */
export type PressureLevel = 'critical' | 'high' | 'moderate' | 'low';

/**
 * Band an occupancy rate.
 *
 * Thresholds are operational, not statistical. Above 95% a ward has no bed to
 * admit the next arrival into and starts boarding patients in corridors; above
 * 85% it can absorb a normal day but not an outbreak; 70% is the level at which
 * a district should already be planning. Deliberately the same four labels as
 * `StockRisk.severity` so one chip component serves both layers.
 */
export function occupancyPressure(rate: number): PressureLevel {
  if (rate >= 0.95) return 'critical';
  if (rate >= 0.85) return 'high';
  if (rate >= 0.7) return 'moderate';
  return 'low';
}

/** Occupancy of one ward at one facility on the as-of date. */
export interface BedClassOccupancy {
  bedClass: BedClass;
  label: string;
  beds: number;
  occupied: number;
  /** Today's seasonal multiplier for this ward's calendar. */
  seasonalMultiplier: number;
}

/**
 * Bed state for one facility.
 *
 * Note the deliberate pair of series, mirroring the drug ledger's recorded /
 * true split. Occupancy returns are CENSORED BY CAPACITY in exactly the way
 * dispensing records are censored by stock-outs: a 30-bed CHC that needed to
 * admit 34 people reports 30, and the four who were referred onward or sent
 * home leave no trace in the occupancy return. A planner reading only the
 * recorded series sees a ward at 100% and concludes it is "just full", never
 * that it is 13% short of the beds its catchment presented with.
 */
export interface BedState {
  facilityId: string;
  /** ISO date the state is evaluated at. */
  asOf: string;
  sanctionedBeds: number;
  /**
   * Beds actually usable today. Sanctioned strength is a paper number: beds
   * without a mattress, a functioning oxygen point or a ward to stand in are
   * counted in the establishment and cannot take a patient.
   */
  functionalBeds: number;
  occupied: number;
  free: number;
  occupancyRate: number;
  pressure: PressureLevel;
  /** Daily occupied-bed count, capacity-capped. What an HMIS occupancy return contains. */
  occupiedSeries: number[];
  /** Daily admission demand before the capacity cap. Ground truth; unobservable in production. */
  demandSeries: number[];
  meanOccupancyRate: number;
  peakOccupancyRate: number;
  /** Days in the window where every functional bed was taken. */
  daysAtCapacity: number;
  /** Patient-days of demand that arrived and found no bed. The censored quantity. */
  unmetBedDays: number;
  /** Composite seasonal multiplier across this facility's ward mix, on the as-of date. */
  seasonalMultiplier: number;
  byClass: BedClassOccupancy[];
}

// ---------------------------------------------------------------------------
// Workforce
// ---------------------------------------------------------------------------

/**
 * Staff cadres, using the titles the Indian public health system uses. Cadre
 * identity matters because vacancy is wildly uneven across cadres -- treating
 * "staff" as one pooled number hides the fact that the empty posts are
 * concentrated in exactly the cadres that are hardest to replace.
 */
export type StaffCadre =
  | 'specialist' // surgeon, physician, obstetrician-gynaecologist, paediatrician
  | 'medical_officer' // MBBS general duty MO; the PHC in-charge
  | 'staff_nurse'
  | 'pharmacist' // keeper of the stock register at PHC and above
  | 'lab_technician'
  | 'radiographer'
  | 'cho' // Community Health Officer / mid-level provider at an HWC Sub-Centre
  | 'anm' // Auxiliary Nurse Midwife / female health worker; the Sub-Centre
  | 'mpw_male' // Multi-Purpose Worker (male); vector control and field surveillance
  | 'storekeeper';

export const CADRE_LABEL: Record<StaffCadre, string> = {
  specialist: 'Specialist',
  medical_officer: 'Medical Officer',
  staff_nurse: 'Staff Nurse',
  pharmacist: 'Pharmacist',
  lab_technician: 'Lab Technician',
  radiographer: 'Radiographer',
  cho: 'Community Health Officer',
  anm: 'ANM / Female Health Worker',
  mpw_male: 'MPW (Male)',
  storekeeper: 'Storekeeper',
};

/**
 * Sanctioned establishment by tier, per IPHS 2022. Indicative where the norm is
 * a band scaled by bed strength (SDH, DH).
 *
 *   SC-HWC : the Ayushman Bharat Health & Wellness Centre establishment --
 *            one CHO (mid-level provider), one ANM, one male MPW.
 *   PHC    : two Medical Officers (one may be AYUSH), three staff nurses, one
 *            pharmacist, one lab technician, one male MPW.
 *   CHC    : four specialists (surgeon, physician, O&G, paediatrician), two
 *            general duty MOs, ten staff nurses for 30 beds, plus diagnostics.
 *   SDH/DH : scaled from the same ratios; a 200-bed DH carries roughly one
 *            nursing post per two-and-a-bit beds across all shifts and reliefs.
 *   DW     : a stocking point. Its establishment is a store in-charge and
 *            storekeepers, and it is in this table because a warehouse with no
 *            one to sign for a consignment stalls the entire district.
 */
export const SANCTIONED_POSTS: Record<FacilityType, Partial<Record<StaffCadre, number>>> = {
  SC: { cho: 1, anm: 1, mpw_male: 1 },
  PHC: { medical_officer: 2, staff_nurse: 3, pharmacist: 1, lab_technician: 1, mpw_male: 1 },
  CHC: {
    specialist: 4,
    medical_officer: 2,
    staff_nurse: 10,
    pharmacist: 2,
    lab_technician: 1,
    radiographer: 1,
  },
  SDH: {
    specialist: 6,
    medical_officer: 4,
    staff_nurse: 25,
    pharmacist: 3,
    lab_technician: 2,
    radiographer: 1,
    storekeeper: 1,
  },
  DH: {
    specialist: 20,
    medical_officer: 12,
    staff_nurse: 90,
    pharmacist: 6,
    lab_technician: 5,
    radiographer: 3,
    storekeeper: 2,
  },
  DW: { pharmacist: 1, storekeeper: 2 },
};

/**
 * National mean vacancy rate against SANCTIONED posts, by cadre.
 *
 * MODELLING ASSUMPTION, shaped by what Rural Health Statistics reports year
 * after year. The ordering is the load-bearing part:
 *
 *   - Specialists are the catastrophic case. A CHC is defined by having a
 *     surgeon, a physician, an O&G and a paediatrician; most CHCs have one or
 *     none, which is why so many "30-bed CHCs" cannot perform a caesarean.
 *   - Male MPW posts are the quiet second disaster. They do vector control and
 *     field surveillance -- the work that detects an outbreak before it reaches
 *     a ward -- and recruitment against them stopped in many states.
 *   - Pharmacist vacancy is modest in absolute terms and disproportionate in
 *     consequence, because it is the post that keeps the stock register.
 */
export const CADRE_VACANCY_BASE: Record<StaffCadre, number> = {
  specialist: 0.62,
  medical_officer: 0.18,
  staff_nurse: 0.14,
  pharmacist: 0.22,
  lab_technician: 0.28,
  radiographer: 0.3,
  cho: 0.12,
  anm: 0.1,
  mpw_male: 0.45,
  storekeeper: 0.2,
};

/**
 * Probability an in-position member of this cadre is absent on a given day.
 *
 * MODELLING ASSUMPTION. Unannounced-visit studies of Indian primary care put
 * health worker absence in a broad 25-40% band, with doctors absent more often
 * than paramedical and field staff -- private practice, district meetings, and
 * deputation to a facility with a bigger caseload all pull the same way. The
 * numbers below sit at the conservative end of that literature and are further
 * amplified by remoteness in the simulator.
 *
 * ABSENCE IS NOT VACANCY, and keeping them separate is the entire point. A
 * filled post with a 30% absence rate delivers 0.7 of a person; a state that
 * reports "posts filled" as its workforce indicator is reporting a number that
 * is 30% wrong before it leaves the district.
 */
export const CADRE_ABSENCE_BASE: Record<StaffCadre, number> = {
  specialist: 0.26,
  medical_officer: 0.24,
  staff_nurse: 0.14,
  pharmacist: 0.16,
  lab_technician: 0.18,
  radiographer: 0.18,
  cho: 0.15,
  anm: 0.17,
  mpw_male: 0.28,
  storekeeper: 0.12,
};

/**
 * How much harder it is to keep this cadre in a remote posting, 0..1.
 *
 * A storekeeper can be recruited locally almost anywhere. A paediatrician
 * cannot: the specialist vacancy gradient between a peri-urban CHC and a CHC in
 * a tribal block is the steepest gradient in the whole workforce picture, and
 * flattening it would erase the reason redistribution and tele-consultation
 * exist at all.
 */
export const CADRE_REMOTENESS_SENSITIVITY: Record<StaffCadre, number> = {
  specialist: 1.0,
  medical_officer: 0.85,
  staff_nurse: 0.55,
  pharmacist: 0.6,
  lab_technician: 0.7,
  radiographer: 0.7,
  cho: 0.4,
  anm: 0.3,
  mpw_male: 0.5,
  storekeeper: 0.25,
};

/**
 * Who keeps the stock register at each tier, and who covers when that post is empty.
 *
 * This mapping is the hinge between the workforce layer and the medicine layer.
 * At a PHC and above the pharmacist is the custodian of record; at a Sub-Centre
 * it is the ANM, who orders, holds and dispenses her own small kit. The
 * substitute is who actually ends up filing the return when the custodian post
 * is vacant -- the return still arrives, it is simply kept by someone doing it
 * on top of a clinical job, from memory, at month end.
 */
export const STOCK_CUSTODIAN: Record<FacilityType, StaffCadre> = {
  SC: 'anm',
  PHC: 'pharmacist',
  CHC: 'pharmacist',
  SDH: 'pharmacist',
  DH: 'pharmacist',
  DW: 'pharmacist',
};

export const SUBSTITUTE_CUSTODIAN: Record<FacilityType, StaffCadre> = {
  SC: 'cho',
  PHC: 'staff_nurse',
  CHC: 'staff_nurse',
  SDH: 'storekeeper',
  DH: 'storekeeper',
  DW: 'storekeeper',
};

/**
 * Beds one present nursing post can safely cover, across all shifts and reliefs.
 *
 * Derived from the IPHS establishment itself rather than asserted separately: a
 * 30-bed CHC is sanctioned 10 staff nurses and a 6-bed PHC is sanctioned 3, so
 * the norm the standards themselves encode is about three beds per nursing
 * post. Used to compute how many of a ward's functional beds are actually
 * STAFFED today, which is usually a smaller number than either the sanctioned
 * or the functional count and is the one a bed-allocation decision should use.
 */
export const BEDS_PER_NURSE_NORM = 3;

/** Establishment, occupancy and attendance for one cadre at one facility. */
export interface CadreStaffing {
  cadre: StaffCadre;
  label: string;
  /** Posts on the sanctioned establishment, per IPHS. */
  sanctioned: number;
  /** Posts with a named person against them. Sanctioned minus vacancies. */
  inPosition: number;
  /** People who actually turned up on the as-of date. */
  presentToday: number;
  /** 1 - inPosition/sanctioned. */
  vacancyRate: number;
  /** 1 - presentToday/inPosition. Zero when nobody is in position to be absent. */
  absenteeismRate: number;
}

/**
 * Workforce state for one facility.
 *
 * THREE LEVELS, NOT ONE. Sanctioned, in-position and present-today are reported
 * separately and never collapsed, because each gap has a different owner and a
 * different remedy: sanctioned-to-in-position is a recruitment and cadre-policy
 * problem sitting with the state, in-position-to-present is a supervision and
 * incentive problem sitting with the district, and the two are routinely
 * conflated into a single "staff shortage" figure that nobody can act on.
 */
export interface StaffingState {
  facilityId: string;
  asOf: string;
  cadres: CadreStaffing[];
  sanctioned: number;
  inPosition: number;
  presentToday: number;
  vacancyRate: number;
  absenteeismRate: number;
  /** presentToday / sanctioned -- the fraction of the designed facility that exists today. */
  effectiveAvailability: number;
  /** 0..1 composite of district reliability and distance from the parent stocking point. */
  remoteness: number;
  /**
   * Plain-language gaps worth putting in front of a district officer, worst
   * first. Empty when the facility is adequately staffed, which is a real and
   * common outcome and must not be dressed up as a finding.
   */
  criticalGaps: string[];
}

// ---------------------------------------------------------------------------
// The link back to the medicine layer
// ---------------------------------------------------------------------------

/** How much of the stock report from this facility can be believed. */
export type ReportingClass =
  | 'verified' // custodian in position and present; the number was counted by the person responsible
  | 'attested' // custodian in position but absent today, or covering across facilities
  | 'unverified' // no custodian in position; the return is kept by a substitute on top of a clinical job
  | 'unattended'; // neither custodian nor substitute present -- nobody filed anything

export interface ReportingReliability {
  /** 0..1. Multiplies into how much weight the risk engine should give this facility's ledger. */
  score: number;
  class: ReportingClass;
  custodian: StaffCadre;
  custodianInPosition: boolean;
  custodianPresentToday: boolean;
  /** One sentence, safe to render verbatim next to the stock figure. */
  note: string;
}

/**
 * The two ways the resource layer changes what the medicine layer means.
 *
 * Deliberately expressed as MULTIPLIERS rather than as adjusted stock numbers.
 * Nothing here rewrites a measured on-hand figure -- doing that would be
 * fabricating inventory. They are exposed for the forecast and the UI to apply
 * openly, so that a caveat stays a caveat instead of quietly becoming a
 * correction nobody can see.
 */
export interface MedicineLinkage {
  /**
   * Multiplier on modelled drug consumption, from ward occupancy sitting above
   * or below this tier's baseline. Bounded, because inpatient dispensing is a
   * minority of a primary facility's total volume -- most of it is OPD, which
   * an empty ward does not stop.
   */
  consumptionPressure: number;
  /** Trust in the last stock report, 0..1. Same number as `reporting.score`, surfaced where it is used. */
  stockReportTrust: number;
  /**
   * Factor to widen forecast uncertainty by, given how thinly the ledger is
   * attested. A facility with no pharmacist does not have a wrong forecast; it
   * has a forecast with an honest error bar twice as wide, and a planner should
   * be shown that rather than a falsely precise number.
   */
  reportingUncertaintyFactor: number;
}

/** Everything the resource layer knows about one facility. */
export interface ResourceState {
  facilityId: string;
  facilityName: string;
  facilityType: FacilityType;
  districtCode: string;
  districtName: string;
  stateCode: string;
  stateName: string;
  lat: number;
  lon: number;
  population: number;
  asOf: string;
  beds: BedState;
  staffing: StaffingState;
  reporting: ReportingReliability;
  linkage: MedicineLinkage;
  /**
   * Functional beds that today's present nursing establishment can actually
   * cover, at `BEDS_PER_NURSE_NORM`. Capped at `functionalBeds` -- surplus
   * nurses do not create beds.
   */
  staffedBeds: number;
}

// ---------------------------------------------------------------------------
// District roll-up
// ---------------------------------------------------------------------------

/**
 * District-level resource picture.
 *
 * Every field here is an aggregate of facility states in the same district and
 * nothing is computed twice: this is the roll-up the national snapshot carries
 * per district, and the district console renders it directly.
 *
 * Deliberately carries NO district identity -- no code, no name, no state. It
 * is always embedded in a row that already says which district it belongs to,
 * and a second copy of a district name is a second thing that can be stale. The
 * roll-up answers "what is here"; the row it hangs off answers "where".
 */
export interface DistrictResourceRollup {
  // --- beds ---
  facilitiesWithBeds: number;
  sanctionedBeds: number;
  functionalBeds: number;
  staffedBeds: number;
  occupiedBeds: number;
  freeBeds: number;
  /** occupiedBeds / functionalBeds across the district. */
  bedOccupancyRate: number;
  pressure: PressureLevel;
  /** Facilities at or above 95% of their functional beds. */
  facilitiesAtCapacity: number;
  /** Patient-days over the simulated window where demand exceeded capacity. */
  unmetBedDays: number;

  // --- workforce ---
  staffSanctioned: number;
  staffInPosition: number;
  staffPresent: number;
  vacancyRate: number;
  absenteeismRate: number;
  /** staffPresent / staffSanctioned. */
  effectiveAvailability: number;
  specialistSanctioned: number;
  specialistInPosition: number;
  specialistVacancyRate: number;

  // --- the link to the medicine layer ---
  /** Facilities at PHC tier and above holding stock with no pharmacist in position. */
  facilitiesWithoutPharmacist: number;
  facilitiesWithoutMedicalOfficer: number;
  subCentresWithoutAnm: number;
  /** Facilities whose last stock report is `unverified` or `unattended`. */
  unverifiedReportingFacilities: number;
  /** Population-weighted mean of `reporting.score`, 0..1. */
  meanReportTrust: number;
  /**
   * Share of the district's catchment served by a facility whose stock figures
   * nobody is in position to verify. The headline number of this whole layer:
   * it converts a staffing vacancy into a data-quality statement about the
   * medicine dashboard sitting next to it.
   */
  populationUnderUnverifiedReporting: number;
}
