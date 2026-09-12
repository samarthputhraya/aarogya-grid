import type { Facility, FacilityType } from '@/lib/domain/types';
import { DISTRICTS_BY_CODE } from '@/lib/domain/geo';

/**
 * Whether a transfer is administratively possible, not just physically.
 *
 * WHY A PLANNER NEEDS THIS
 * ------------------------
 * The optimiser is very good at finding the cheapest vial of anti-snake venom
 * within 150 km. It has no idea that the vial belongs to a different state
 * government, was bought on a different budget head, is accounted for in a
 * different store ledger, and cannot be signed out by the district officer
 * looking at the screen. A plan full of orders nobody has the authority to
 * issue is not an ambitious plan; it is a plan that gets ignored, and the
 * ignoring is rational.
 *
 * This build previously planned 739 sub-centre-to-sub-centre and PHC-to-PHC
 * movements across state lines, and presented them next to same-block transfers
 * as though they were the same kind of thing. They are not. A sub-centre ANM
 * cannot requisition stock from another state's sub-centre under any procedure
 * that exists.
 *
 * THE LADDER
 * ----------
 *   same district                     permitted            — a district officer signs it
 *   same state, across a district     district countersign — two districts, one CMHO/DHS chain
 *   across a state line, CHC+         inter-state agreement — a real instrument, rarely quick
 *   across a state line, below CHC    refused              — no procedure exists
 *
 * The tier rule is the part worth defending. Cross-state movement between
 * district warehouses and CHC-and-above facilities is the one case with a
 * recognisable path: those facilities hold institutional stores, have
 * storekeepers, and sit inside an accounting structure that can raise and
 * receive an inter-state indent. Below that tier the stock is a working kit
 * held by one or two people, and the "transfer" would be an ANM handing
 * medicine to another state's ANM with no paperwork either of them can file.
 *
 * NOT A HARD-CODED POLICY -- A DEFAULT
 * ------------------------------------
 * Every level here is a parameter a health department can change, and the
 * refusal is the only one that removes orders from the plan. `planRedistribution`
 * takes this as a predicate so a deployment with a standing inter-state
 * arrangement can supply its own and the planner does not need to know.
 */

export type AdmissibilityStatus =
  /** Inside one district: an ordinary intra-district movement. */
  | 'permitted'
  /** Two districts in one state: needs both district officers. */
  | 'requires_district_countersign'
  /** Two states: needs an inter-state supply agreement to exist first. */
  | 'requires_inter_state_agreement'
  /** No procedure exists. The order is removed from the plan. */
  | 'refused';

export interface Admissibility {
  status: AdmissibilityStatus;
  /** True when a district officer can sign this alone. */
  approvableByDistrict: boolean;
  /** Who has to countersign before the order can be approved, if anyone. */
  escalateTo: 'district' | 'state' | null;
  /** One line, written to appear on the order card and the dispatch note. */
  note: string;
}

/** Tiers that hold an institutional store and can raise an inter-state indent. */
const INSTITUTIONAL_TIERS: ReadonlySet<FacilityType> = new Set<FacilityType>([
  'CHC',
  'SDH',
  'DH',
  'DW',
]);

type Endpoint = Pick<Facility, 'type' | 'districtCode' | 'stateCode'>;

/**
 * Classify one facility-to-facility movement.
 *
 * Deliberately depends on nothing but the two endpoints, so it can be called
 * from the planner, from the ticket service and from a test without any of them
 * needing the rest of the world.
 */
export function administrativeAdmissibility(from: Endpoint, to: Endpoint): Admissibility {
  if (from.districtCode === to.districtCode) {
    return {
      status: 'permitted',
      approvableByDistrict: true,
      escalateTo: null,
      note: 'Within one district — the district officer can issue this.',
    };
  }

  if (from.stateCode === to.stateCode) {
    return {
      status: 'requires_district_countersign',
      approvableByDistrict: false,
      escalateTo: 'district',
      note: 'Crosses a district boundary — needs the donor district to countersign before it can be approved.',
    };
  }

  if (INSTITUTIONAL_TIERS.has(from.type) && INSTITUTIONAL_TIERS.has(to.type)) {
    return {
      status: 'requires_inter_state_agreement',
      approvableByDistrict: false,
      escalateTo: 'state',
      note: 'Crosses a state line between institutional stores — needs an inter-state supply agreement, not a district signature.',
    };
  }

  return {
    status: 'refused',
    approvableByDistrict: false,
    escalateTo: null,
    note: 'Crosses a state line below CHC tier — no requisition procedure exists between two states at this tier.',
  };
}

/** Short label for a badge. */
export const ADMISSIBILITY_LABEL: Record<AdmissibilityStatus, string> = {
  permitted: 'In district',
  requires_district_countersign: 'District countersign',
  requires_inter_state_agreement: 'Inter-state agreement',
  refused: 'Not permitted',
};

/**
 * The same verdict, from a dispatch ticket's endpoints.
 *
 * A ticket carries a facility type and a district code, not a state code, and
 * it is rebuilt from an append-only log whose oldest rows predate this rule.
 * Re-deriving from the district catalogue rather than storing the verdict on
 * every row means a ticket written before WS6C existed is classified the same
 * way as one written after it -- and there is one function deciding, so the
 * planner's recorded verdict and the ticket's cannot drift.
 * `scripts/verify-guardrails.mts` checks that they agree.
 */
export function admissibilityForEndpoints(
  from: { facilityType: string; districtCode: string },
  to: { facilityType: string; districtCode: string },
): Admissibility {
  const stateOf = (districtCode: string) => DISTRICTS_BY_CODE[districtCode]?.stateCode ?? districtCode;
  return administrativeAdmissibility(
    {
      type: from.facilityType as FacilityType,
      districtCode: from.districtCode,
      stateCode: stateOf(from.districtCode),
    },
    {
      type: to.facilityType as FacilityType,
      districtCode: to.districtCode,
      stateCode: stateOf(to.districtCode),
    },
  );
}
