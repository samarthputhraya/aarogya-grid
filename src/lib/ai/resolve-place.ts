import { DISTRICTS, DISTRICTS_BY_CODE, type DistrictInfo } from '@/lib/domain/geo';
import { FACILITY_LABEL } from '@/lib/format';
import { diceSimilarity, normalise } from './resolve';

/**
 * Place entity resolution -- districts and facilities.
 *
 * WHY THIS EXISTS, AND WHY IT EXISTS SEPARATELY FROM THE MODEL
 * ------------------------------------------------------------
 * `resolve.ts` argues that a language model asked for a DRUG code will produce
 * a plausible-looking code whether or not the item exists. Live testing of the
 * grid agent reproduced exactly that failure on PLACES, and faster: asked "what
 * is the weather in Lucknow?" -- a question with no answer in this system at
 * all -- the model called a tool with `districtCode: "Lucknow"`, a string that
 * is not a district code in any registry on earth. It did not decline; it
 * invented an identifier shaped like the one it had been shown.
 *
 * So the agent's tools take PLACE NAMES, never codes or facility ids, and this
 * module is the only thing permitted to turn a name into one. The model's
 * entire vocabulary of identifiers is human-readable names -- which is also why
 * no tool result in `grid-tools.ts` ever hands a code BACK to it. A model that
 * has never seen a district code in its context cannot echo one.
 *
 * The scoring functions are imported from `resolve.ts` rather than reimplemented
 * so that "how close are these two strings" has exactly one answer in this
 * codebase.
 */

/**
 * Districts Indians routinely call something other than their gazetted name.
 *
 * Renaming is recent and incomplete across India: an officer trained before
 * 2014 says Bangalore, the LGD says Bengaluru Urban, and both mean the same
 * 4.2 million people. A resolver that only knows the gazetted name fails the
 * most natural phrasing of the question. Keyed by district code, extended as a
 * data task -- the same shape as the drug alias table.
 */
const DISTRICT_ALIASES: Record<string, string[]> = {
  'DST-29-BENGALUR': ['bangalore', 'bengaluru', 'bangalore urban', 'blr'],
  'DST-29-MYSURU': ['mysore'],
  'DST-29-BELAGAVI': ['belgaum'],
  'DST-29-KALABURA': ['gulbarga', 'kalaburagi'],
  'DST-29-BALLARI': ['bellary'],
  'DST-29-VIJAYAPU': ['bijapur', 'vijayapura'],
  'DST-29-DAKSHINA': ['mangalore', 'mangaluru', 'dakshina kannada'],
  'DST-09-PRAYAGRA': ['allahabad', 'prayagraj'],
  'DST-09-VARANASI': ['banaras', 'benares', 'kashi'],
  'DST-09-KANPURNA': ['kanpur'],
  'DST-27-CHHATRAP': ['aurangabad', 'sambhajinagar'],
  'DST-18-KAMRUPME': ['guwahati', 'gauhati', 'kamrup'],
  'DST-21-KHORDHA': ['bhubaneswar', 'khurda'],
  'DST-19-PURBABAR': ['burdwan', 'bardhaman'],
  'DST-24-KACHCHH': ['kutch', 'bhuj'],
  'DST-33-THOOTHUK': ['tuticorin'],
  'DST-33-TIRUCHIR': ['trichy', 'tiruchi'],
  'DST-33-NILGIRIS': ['ooty', 'udhagamandalam'],
  'DST-32-THIRUVAN': ['trivandrum'],
  'DST-32-KOZHIKOD': ['calicut'],
  'DST-32-ERNAKULA': ['kochi', 'cochin'],
  'DST-32-THRISSUR': ['trichur'],
  'DST-28-VISAKHAP': ['vizag', 'visakhapatnam'],
  'DST-28-KAKINADA': ['east godavari'],
  'DST-20-EASTSING': ['jamshedpur', 'east singhbhum'],
  'DST-22-BASTAR': ['jagdalpur'],
  'DST-22-SURGUJA': ['ambikapur', 'sarguja'],
  'DST-23-BHOPAL': ['bhopal'],
  'DST-10-WESTCHAM': ['bettiah', 'west champaran', 'champaran'],
  'DST-19-SOUTH24P': ['south 24 parganas', 'sundarbans'],
};

/** Above this a place match is used without asking. Stricter than the drug gate. */
export const PLACE_AUTO_ACCEPT = 0.8;

export interface ResolvedDistrict {
  district: DistrictInfo;
  confidence: number;
  via: 'code' | 'exact' | 'alias' | 'fuzzy';
}

export interface DistrictResolution {
  query: string;
  best: ResolvedDistrict | null;
  alternatives: ResolvedDistrict[];
  needsConfirmation: boolean;
  /**
   * Set when the query was SHAPED like a district code but matched nothing.
   *
   * This is the fabricated-identifier case, and it is worth a distinct signal
   * rather than a generic miss: the caller can tell the model to stop emitting
   * codes, which is a different correction from "did you mean Bijapur".
   */
  rejectedAsIdentifier: boolean;
}

function looksLikeCode(query: string): boolean {
  return /^\s*DST[-_ ]/i.test(query);
}

interface Surface {
  text: string;
  via: 'exact' | 'alias';
}

function surfacesFor(d: DistrictInfo): Surface[] {
  const out: Surface[] = [
    { text: normalise(d.name), via: 'exact' },
    { text: normalise(d.name + ' ' + d.stateName), via: 'exact' },
    { text: normalise(d.name + ' district'), via: 'exact' },
  ];
  for (const alias of DISTRICT_ALIASES[d.code] ?? []) {
    out.push({ text: normalise(alias), via: 'alias' });
  }
  return out;
}

const DISTRICT_INDEX: { district: DistrictInfo; surfaces: Surface[] }[] = DISTRICTS.map((d) => ({
  district: d,
  surfaces: surfacesFor(d),
}));

/**
 * Score one query against one set of surfaces.
 *
 * Whole-token containment is scored explicitly rather than left to bigram
 * similarity because district names are short and share a lot of character
 * bigrams -- "Salem" and "Malda" score 0.5 on Dice alone. Containment of a
 * distinctive token is much stronger evidence than character overlap, and it is
 * what makes "the Lucknow numbers" resolve while "the numbers" does not.
 */
function scoreSurfaces(
  query: string,
  surfaces: Surface[],
): { score: number; via: 'exact' | 'alias' | 'fuzzy' } {
  const q = normalise(query);
  const qTokens = q.split(' ').filter((t) => t.length >= 3);
  let best = 0;
  let via: 'exact' | 'alias' | 'fuzzy' = 'fuzzy';

  for (const surface of surfaces) {
    if (surface.text === q) return { score: surface.via === 'exact' ? 1 : 0.97, via: surface.via };

    let score = diceSimilarity(q, surface.text);

    const sTokens = new Set(surface.text.split(' '));
    const shared = qTokens.filter((t) => sTokens.has(t));
    if (shared.length > 0) {
      // Capped below the 0.97 an exact alias hit scores, so a partial match can
      // never outrank a literal one on a tie.
      const coverage = shared.length / Math.max(qTokens.length, sTokens.size);
      score = Math.max(score, 0.6 + 0.33 * coverage);
    }

    if (score > best) {
      best = score;
      via = 'fuzzy';
    }
  }
  return { score: best, via };
}

/**
 * Resolve free text to a district.
 *
 * A real code is accepted (it cannot have been fabricated -- it is in the
 * registry), a code-shaped string that is not in the registry is rejected
 * loudly, and everything else is matched on name.
 */
export function resolveDistrict(query: string): DistrictResolution {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      query,
      best: null,
      alternatives: [],
      needsConfirmation: true,
      rejectedAsIdentifier: false,
    };
  }

  const asCode = DISTRICTS_BY_CODE[trimmed.toUpperCase()];
  if (asCode) {
    return {
      query,
      best: { district: asCode, confidence: 1, via: 'code' },
      alternatives: [],
      needsConfirmation: false,
      rejectedAsIdentifier: false,
    };
  }
  if (looksLikeCode(trimmed)) {
    return {
      query,
      best: null,
      alternatives: [],
      needsConfirmation: true,
      rejectedAsIdentifier: true,
    };
  }

  const scored: ResolvedDistrict[] = [];
  for (const entry of DISTRICT_INDEX) {
    const { score, via } = scoreSurfaces(trimmed, entry.surfaces);
    if (score > 0.4) {
      scored.push({ district: entry.district, confidence: +score.toFixed(3), via });
    }
  }
  scored.sort((a, b) => b.confidence - a.confidence || a.district.name.localeCompare(b.district.name));

  const best = scored[0] ?? null;
  const alternatives = scored.slice(1, 4);
  // Two districts scoring within a hair of each other is the Bijapur/Vijayapura
  // case: a high top score that still needs a human.
  const ambiguous =
    best !== null && alternatives.length > 0 && best.confidence - alternatives[0].confidence < 0.06;

  return {
    query,
    best,
    alternatives,
    needsConfirmation: !best || best.confidence < PLACE_AUTO_ACCEPT || ambiguous,
    rejectedAsIdentifier: false,
  };
}

/** The minimum a caller must know about a facility for it to be resolvable. */
export interface FacilityCandidate {
  id: string;
  name: string;
  type: string;
}

export interface ResolvedFacility<T extends FacilityCandidate> {
  facility: T;
  confidence: number;
  via: 'id' | 'exact' | 'alias' | 'fuzzy';
}

export interface FacilityResolution<T extends FacilityCandidate> {
  query: string;
  best: ResolvedFacility<T> | null;
  alternatives: ResolvedFacility<T>[];
  needsConfirmation: boolean;
  rejectedAsIdentifier: boolean;
}

function looksLikeFacilityId(query: string): boolean {
  return /^\s*DST[-_ ]?\d/i.test(query);
}

/**
 * Resolve free text to one facility within an already-loaded roster.
 *
 * Scoped to a district's own roster rather than the national network on
 * purpose: "SC-04" is ambiguous across 128 districts and unambiguous within
 * one, and the officer asking the question is looking at one district. The
 * facility TIER is folded into the searchable surface ("sub centre 4",
 * "district hospital") because that is how the tier is spoken, while the id
 * itself is only accepted if it is real.
 */
export function resolveFacility<T extends FacilityCandidate>(
  query: string,
  roster: T[],
): FacilityResolution<T> {
  const trimmed = query.trim();
  if (!trimmed || roster.length === 0) {
    return {
      query,
      best: null,
      alternatives: [],
      needsConfirmation: true,
      rejectedAsIdentifier: false,
    };
  }

  const byId = roster.find((f) => f.id.toUpperCase() === trimmed.toUpperCase());
  if (byId) {
    return {
      query,
      best: { facility: byId, confidence: 1, via: 'id' },
      alternatives: [],
      needsConfirmation: false,
      rejectedAsIdentifier: false,
    };
  }
  if (looksLikeFacilityId(trimmed)) {
    return {
      query,
      best: null,
      alternatives: [],
      needsConfirmation: true,
      rejectedAsIdentifier: true,
    };
  }

  const scored: ResolvedFacility<T>[] = [];
  for (const facility of roster) {
    const surfaces: Surface[] = [
      { text: normalise(facility.name), via: 'exact' },
      { text: normalise((FACILITY_LABEL[facility.type] ?? facility.type) + ' ' + facility.name), via: 'exact' },
      // "SC Lucknow-11" normalises to "sc lucknow 11"; a person asking for it
      // says "sub centre 11", so the bare tier-plus-index surface matters.
      { text: normalise(facility.type + ' ' + facility.name.replace(/^[A-Z]+\s+/, '')), via: 'exact' },
    ];
    const { score, via } = scoreSurfaces(trimmed, surfaces);
    if (score > 0.45) scored.push({ facility, confidence: +score.toFixed(3), via });
  }
  scored.sort((a, b) => b.confidence - a.confidence || a.facility.name.localeCompare(b.facility.name));

  const best = scored[0] ?? null;
  const alternatives = scored.slice(1, 4);
  const ambiguous =
    best !== null && alternatives.length > 0 && best.confidence - alternatives[0].confidence < 0.06;

  return {
    query,
    best,
    alternatives,
    needsConfirmation: !best || best.confidence < PLACE_AUTO_ACCEPT || ambiguous,
    rejectedAsIdentifier: false,
  };
}
