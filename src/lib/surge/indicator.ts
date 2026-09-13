import { z } from 'zod';

/**
 * The early-warning indicator payload: what leaves the country.
 *
 * WHY THIS SHAPE AND NOT OUR OWN
 * ------------------------------
 * BRICS agreed in 2024-25 to build an Integrated Early Warning System for
 * outbreaks with pandemic potential, and the hard part of any such system is
 * never the modelling -- it is that each member's surveillance stack speaks its
 * own dialect. A signal that can only be read by something that understands
 * Indian district codes, the IPHS facility tiers and a drug catalogue keyed to
 * a state EDL is a signal that stops at the border.
 *
 * So the payload deliberately carries NO Indian vocabulary in its required
 * fields. An area has a code, a name and a population; a signal has a hazard
 * class from a fixed list, an observed value, an expected range and a
 * confidence. Anything country-specific -- the district code, the drug ids, the
 * facility tiers -- travels in an optional `local` block that a foreign
 * consumer can ignore without losing the meaning.
 *
 * WHAT IT DOES NOT CONTAIN, ON PURPOSE
 * ------------------------------------
 * No facility identifiers, no patient counts below district level, no stock
 * quantities, no batch numbers. An early-warning exchange needs to know that a
 * district of 2.9 million is seeing three times the expected enteric caseload;
 * it does not need to know which sub-centre, and a payload that carried it
 * would be a payload no health ministry would sign off on sharing.
 *
 * THE SCHEMA IS THE CONTRACT
 * --------------------------
 * `IndicatorPayload` below is a Zod schema, and `npm run export:indicators`
 * emits it as a standard JSON Schema next to the data. A consumer validates
 * against that file rather than against a paragraph of prose, and the build
 * fails if what we publish does not satisfy what we documented.
 */

/**
 * Hazard classes.
 *
 * A small fixed list rather than free text, because the entire point is that
 * somebody else's system can route on it. The names are syndromic -- what was
 * seen -- rather than aetiological, because a surveillance signal knows the
 * presentation days before it knows the pathogen.
 */
export const HAZARD_CLASSES = [
  'vector_borne',
  'enteric',
  'acute_respiratory',
  'envenomation',
  'heat_related',
  'unspecified',
] as const;

/** Confidence in the signal itself, not in what caused it. */
export const SIGNAL_CONFIDENCE = ['low', 'moderate', 'high'] as const;

export const AreaSchema = z.object({
  /** Stable identifier within `codeSystem`. */
  code: z.string().min(1).max(64),
  /** What the code belongs to. `local` means "ours, undocumented elsewhere". */
  codeSystem: z.string().min(1).max(64),
  name: z.string().min(1).max(160),
  /** ISO 3166-1 alpha-3. */
  country: z.string().length(3),
  /** First-level administrative division, where one applies. */
  region: z.string().max(160).optional(),
  population: z.number().int().nonnegative(),
});

export const SignalSchema = z.object({
  /** Unique within this payload. */
  id: z.string().min(1).max(120),
  hazardClass: z.enum(HAZARD_CLASSES),
  /** Free-text label for a human reading the feed. Never routed on. */
  hazardLabel: z.string().max(160),
  area: AreaSchema,
  /** First and last day of the run that triggered this signal. */
  observedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  observedTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** What the indicator counts. */
  metric: z.enum(['outpatient_consultations', 'medicine_consumption_units']),
  observedValue: z.number().nonnegative(),
  /** Upper bound of the model's expected range over the same days. */
  expectedUpperBound: z.number().nonnegative(),
  /**
   * `observedValue / max(1, expectedUpperBound)`.
   *
   * The floor is one unit of the metric: a bound below one consultation or one
   * dispensing unit is the model saying "about nothing", and a ratio against 0.2
   * vials would print an exceedance of 5x for two vials. So below one unit the
   * ratio reads as the observed count itself -- stated here, because it used to
   * be documented as the plain quotient while twelve signals were not.
   */
  exceedanceRatio: z.number().nonnegative(),
  confidence: z.enum(SIGNAL_CONFIDENCE),
  /**
   * Everything country-specific. A consumer that does not understand it can
   * drop this block and still route the signal.
   */
  local: z
    .object({
      districtCode: z.string().optional(),
      drugId: z.string().optional(),
      drugName: z.string().optional(),
      seasonalityProfile: z.string().optional(),
    })
    .optional(),
});

export const IndicatorPayloadSchema = z.object({
  /** Schema version. Consumers branch on the major. */
  schemaVersion: z.literal('1.0'),
  /** Who produced it. */
  source: z.object({
    system: z.string().min(1).max(120),
    country: z.string().length(3),
    contact: z.string().max(200).optional(),
  }),
  /** When the feed was generated, and the last day of data behind it. */
  generatedAt: z.string(),
  dataThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * How a signal is decided, in machine-readable form.
   *
   * Published WITH the signals rather than in a document, because a consumer
   * pooling feeds from several countries has to know whether two signals mean
   * the same thing. A feed whose threshold is a footnote is a feed nobody can
   * combine.
   */
  method: z.object({
    detector: z.string().min(1).max(160),
    anomalyProbabilityThreshold: z.number().min(0).max(1),
    consecutiveDays: z.number().int().positive(),
    excessAboveUpperBound: z.number().nonnegative(),
    /** Measured on injected surges. The honest half of the contract. */
    validation: z.object({
      detectionRateAt2x: z.number().min(0).max(1),
      medianLeadDays: z.number().nullable(),
      falseAlarmsPerAreaWeek: z.number().nonnegative(),
      precision: z.number().min(0).max(1),
      basis: z.string().max(400),
    }),
  }),
  /**
   * What this feed is NOT. Required, not optional.
   *
   * A surveillance exchange that does not state its provenance invites a
   * consumer to treat a simulation as a case count, and there is no way to
   * discover the mistake downstream.
   */
  disclosure: z.object({
    dataProvenance: z.enum(['observed', 'simulated', 'mixed']),
    note: z.string().max(600),
  }),
  signals: z.array(SignalSchema),
});

export type IndicatorPayload = z.infer<typeof IndicatorPayloadSchema>;
export type Signal = z.infer<typeof SignalSchema>;

/** Seasonal archetype -> the hazard class a foreign consumer can route on. */
export const HAZARD_FOR_PATTERN: Record<string, (typeof HAZARD_CLASSES)[number]> = {
  monsoon_vector: 'vector_borne',
  summer_enteric: 'enteric',
  winter_respiratory: 'acute_respiratory',
  monsoon_envenomation: 'envenomation',
  summer_heat: 'heat_related',
  obstetric: 'unspecified',
  flat: 'unspecified',
};

/**
 * Confidence from the evidence, not from a feeling.
 *
 * Three inputs, all of them things the detector actually reported: how far
 * above the expected range the run sat, how long it lasted, and how certain the
 * model was on its strongest day. Nothing here is tunable prose.
 */
export function confidenceFor(
  ratio: number,
  runDays: number,
  peakProbability: number,
): (typeof SIGNAL_CONFIDENCE)[number] {
  if (ratio >= 1.5 && runDays >= 3 && peakProbability >= 0.99) return 'high';
  if (ratio >= 1.2 && runDays >= 2) return 'moderate';
  return 'low';
}
