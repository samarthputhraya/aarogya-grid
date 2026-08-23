import type { Drug } from './types';

/**
 * PHC essential-medicines catalogue.
 *
 * PROVENANCE
 * ----------
 * Drug names, forms, strengths and therapeutic groups are real items carried at
 * Indian primary care facilities, drawn from the National List of Essential
 * Medicines and typical state Essential Drug Lists. The VED classification
 * reflects standard clinical criticality: Vital items are the ones where a
 * stock-out is an emergency rather than an inconvenience.
 *
 * The two NUMERIC fields are modelling assumptions and are labelled as such
 * everywhere they surface in the UI:
 *
 *   - `unitCostInr` is an order-of-magnitude procurement cost, used only to
 *     price transport trade-offs in the redistribution optimiser. It is not a
 *     quotable tender rate.
 *   - `baselinePer1000PerDay` is the mean dispensing rate per 1,000 catchment
 *     population per day, used to seed the simulator. It is the parameter that
 *     gets replaced first when real DVDMS / e-Aushadhi consumption history is
 *     connected.
 *
 * Nothing here should be presented as a measured statistic.
 */
export interface CatalogueDrug extends Drug {
  /** Mean units dispensed per 1,000 catchment population per day. Modelling assumption. */
  baselinePer1000PerDay: number;
  /**
   * Negative-binomial dispersion. Lower = burstier demand.
   * Chronic-care drugs are steady (high dispersion); emergency items arrive in
   * clusters (low dispersion).
   */
  dispersion: number;
}

export const DRUG_CATALOGUE: CatalogueDrug[] = [
  // --- Antidotes & emergency ------------------------------------------------
  {
    id: 'ASV-POLY-10ML', name: 'Anti-Snake Venom (polyvalent)', form: 'Injection', strength: '10 mL vial',
    therapeuticGroup: 'Antidotes', nlem: true, ved: 'V', unit: 'vial', shelfLifeMonths: 24,
    seasonality: 'monsoon_envenomation', unitCostInr: 620, coldChain: true,
    baselinePer1000PerDay: 0.00046, dispersion: 0.4,
  },
  {
    id: 'ATROPINE-0.6-INJ', name: 'Atropine Sulphate', form: 'Injection', strength: '0.6 mg/mL',
    therapeuticGroup: 'Antidotes', nlem: true, ved: 'V', unit: 'ampoule', shelfLifeMonths: 24,
    seasonality: 'monsoon_envenomation', unitCostInr: 9, coldChain: false,
    baselinePer1000PerDay: 0.0032, dispersion: 0.3,
  },
  {
    id: 'PRALIDOXIME-INJ', name: 'Pralidoxime (2-PAM)', form: 'Injection', strength: '500 mg',
    therapeuticGroup: 'Antidotes', nlem: true, ved: 'V', unit: 'vial', shelfLifeMonths: 24,
    seasonality: 'monsoon_envenomation', unitCostInr: 180, coldChain: false,
    baselinePer1000PerDay: 0.0009, dispersion: 0.3,
  },
  {
    id: 'ADRENALINE-INJ', name: 'Adrenaline (Epinephrine)', form: 'Injection', strength: '1 mg/mL',
    therapeuticGroup: 'Emergency / Resuscitation', nlem: true, ved: 'V', unit: 'ampoule', shelfLifeMonths: 18,
    seasonality: 'flat', unitCostInr: 12, coldChain: false,
    baselinePer1000PerDay: 0.0025, dispersion: 0.4,
  },
  {
    id: 'HYDROCORT-100-INJ', name: 'Hydrocortisone Sodium Succinate', form: 'Injection', strength: '100 mg',
    therapeuticGroup: 'Emergency / Resuscitation', nlem: true, ved: 'V', unit: 'vial', shelfLifeMonths: 24,
    seasonality: 'winter_respiratory', unitCostInr: 28, coldChain: false,
    baselinePer1000PerDay: 0.006, dispersion: 0.6,
  },
  {
    id: 'DEXA-4-INJ', name: 'Dexamethasone', form: 'Injection', strength: '4 mg/mL',
    therapeuticGroup: 'Emergency / Resuscitation', nlem: true, ved: 'E', unit: 'ampoule', shelfLifeMonths: 24,
    seasonality: 'winter_respiratory', unitCostInr: 7, coldChain: false,
    baselinePer1000PerDay: 0.012, dispersion: 0.8,
  },

  // --- Obstetric ------------------------------------------------------------
  {
    id: 'OXYTOCIN-5IU-INJ', name: 'Oxytocin', form: 'Injection', strength: '5 IU/mL',
    therapeuticGroup: 'Obstetric', nlem: true, ved: 'V', unit: 'ampoule', shelfLifeMonths: 18,
    seasonality: 'obstetric', unitCostInr: 14, coldChain: true,
    baselinePer1000PerDay: 0.055, dispersion: 2.0,
  },
  {
    id: 'MISOPROSTOL-200', name: 'Misoprostol', form: 'Tablet', strength: '200 mcg',
    therapeuticGroup: 'Obstetric', nlem: true, ved: 'V', unit: 'tablet', shelfLifeMonths: 24,
    seasonality: 'obstetric', unitCostInr: 11, coldChain: false,
    baselinePer1000PerDay: 0.048, dispersion: 1.5,
  },
  {
    id: 'MGSO4-INJ', name: 'Magnesium Sulphate', form: 'Injection', strength: '50% w/v, 2 mL',
    therapeuticGroup: 'Obstetric', nlem: true, ved: 'V', unit: 'ampoule', shelfLifeMonths: 24,
    seasonality: 'obstetric', unitCostInr: 18, coldChain: false,
    baselinePer1000PerDay: 0.008, dispersion: 0.4,
  },
  {
    id: 'IFA-ADULT-TAB', name: 'Iron + Folic Acid', form: 'Tablet', strength: '60 mg + 500 mcg',
    therapeuticGroup: 'Nutrition / Anaemia', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'flat', unitCostInr: 0.35, coldChain: false,
    baselinePer1000PerDay: 3.4, dispersion: 8,
  },
  {
    id: 'CALCIUM-500-TAB', name: 'Calcium Carbonate + Vitamin D3', form: 'Tablet', strength: '500 mg',
    therapeuticGroup: 'Nutrition / Anaemia', nlem: true, ved: 'D', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'flat', unitCostInr: 0.9, coldChain: false,
    baselinePer1000PerDay: 1.8, dispersion: 8,
  },

  // --- Antimalarials --------------------------------------------------------
  {
    id: 'ACT-ASSP-ADULT', name: 'Artesunate + Sulfadoxine-Pyrimethamine (ACT)', form: 'Tablet (blister)', strength: 'Adult co-pack',
    therapeuticGroup: 'Antimalarial', nlem: true, ved: 'V', unit: 'co-pack', shelfLifeMonths: 24,
    seasonality: 'monsoon_vector', unitCostInr: 42, coldChain: false,
    baselinePer1000PerDay: 0.021, dispersion: 0.5,
  },
  {
    id: 'ARTESUNATE-60-INJ', name: 'Artesunate', form: 'Injection', strength: '60 mg',
    therapeuticGroup: 'Antimalarial', nlem: true, ved: 'V', unit: 'vial', shelfLifeMonths: 24,
    seasonality: 'monsoon_vector', unitCostInr: 135, coldChain: false,
    baselinePer1000PerDay: 0.0035, dispersion: 0.35,
  },
  {
    id: 'CHLOROQUINE-250', name: 'Chloroquine Phosphate', form: 'Tablet', strength: '250 mg',
    therapeuticGroup: 'Antimalarial', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'monsoon_vector', unitCostInr: 1.1, coldChain: false,
    baselinePer1000PerDay: 0.18, dispersion: 1.2,
  },
  {
    id: 'PRIMAQUINE-7.5', name: 'Primaquine', form: 'Tablet', strength: '7.5 mg',
    therapeuticGroup: 'Antimalarial', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'monsoon_vector', unitCostInr: 0.8, coldChain: false,
    baselinePer1000PerDay: 0.14, dispersion: 1.2,
  },

  // --- Antibiotics ----------------------------------------------------------
  {
    id: 'AMOXICILLIN-500', name: 'Amoxicillin', form: 'Capsule', strength: '500 mg',
    therapeuticGroup: 'Antibiotic', nlem: true, ved: 'E', unit: 'capsule', shelfLifeMonths: 24,
    seasonality: 'winter_respiratory', unitCostInr: 2.4, coldChain: false,
    baselinePer1000PerDay: 1.35, dispersion: 5,
  },
  {
    id: 'AZITHRO-500', name: 'Azithromycin', form: 'Tablet', strength: '500 mg',
    therapeuticGroup: 'Antibiotic', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 24,
    seasonality: 'winter_respiratory', unitCostInr: 8.5, coldChain: false,
    baselinePer1000PerDay: 0.42, dispersion: 4,
  },
  {
    id: 'CEFTRIAXONE-1G', name: 'Ceftriaxone', form: 'Injection', strength: '1 g',
    therapeuticGroup: 'Antibiotic', nlem: true, ved: 'V', unit: 'vial', shelfLifeMonths: 24,
    seasonality: 'monsoon_vector', unitCostInr: 24, coldChain: false,
    baselinePer1000PerDay: 0.085, dispersion: 1.0,
  },
  {
    id: 'CIPRO-500', name: 'Ciprofloxacin', form: 'Tablet', strength: '500 mg',
    therapeuticGroup: 'Antibiotic', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 24,
    seasonality: 'summer_enteric', unitCostInr: 1.9, coldChain: false,
    baselinePer1000PerDay: 0.62, dispersion: 4,
  },
  {
    id: 'METRONIDAZOLE-400', name: 'Metronidazole', form: 'Tablet', strength: '400 mg',
    therapeuticGroup: 'Antibiotic', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'summer_enteric', unitCostInr: 0.7, coldChain: false,
    baselinePer1000PerDay: 0.88, dispersion: 4,
  },
  {
    id: 'COTRIMOXAZOLE-DS', name: 'Cotrimoxazole (Sulfamethoxazole + Trimethoprim)', form: 'Tablet', strength: '800 + 160 mg',
    therapeuticGroup: 'Antibiotic', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'summer_enteric', unitCostInr: 1.3, coldChain: false,
    baselinePer1000PerDay: 0.5, dispersion: 4,
  },
  {
    id: 'DOXYCYCLINE-100', name: 'Doxycycline', form: 'Capsule', strength: '100 mg',
    therapeuticGroup: 'Antibiotic', nlem: true, ved: 'E', unit: 'capsule', shelfLifeMonths: 24,
    seasonality: 'monsoon_vector', unitCostInr: 1.6, coldChain: false,
    baselinePer1000PerDay: 0.34, dispersion: 2.5,
  },

  // --- Anti-tuberculosis ----------------------------------------------------
  {
    id: 'ATT-4FDC', name: 'Anti-TB 4-drug FDC (HRZE)', form: 'Tablet', strength: 'Adult FDC',
    therapeuticGroup: 'Anti-tuberculosis', nlem: true, ved: 'V', unit: 'tablet', shelfLifeMonths: 24,
    seasonality: 'flat', unitCostInr: 5.5, coldChain: false,
    baselinePer1000PerDay: 0.62, dispersion: 6,
  },

  // --- Diarrhoeal / enteric -------------------------------------------------
  {
    id: 'ORS-SACHET', name: 'Oral Rehydration Salts (WHO formula)', form: 'Sachet', strength: '20.5 g / 1 L',
    therapeuticGroup: 'Diarrhoeal disease', nlem: true, ved: 'V', unit: 'sachet', shelfLifeMonths: 36,
    seasonality: 'summer_enteric', unitCostInr: 4.2, coldChain: false,
    baselinePer1000PerDay: 0.95, dispersion: 3,
  },
  {
    id: 'ZINC-20-DT', name: 'Zinc Sulphate (dispersible)', form: 'Tablet', strength: '20 mg',
    therapeuticGroup: 'Diarrhoeal disease', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 24,
    seasonality: 'summer_enteric', unitCostInr: 1.1, coldChain: false,
    baselinePer1000PerDay: 1.1, dispersion: 3,
  },

  // --- IV fluids ------------------------------------------------------------
  {
    id: 'RL-500ML', name: 'Ringer Lactate', form: 'IV Fluid', strength: '500 mL',
    therapeuticGroup: 'IV Fluids', nlem: true, ved: 'V', unit: 'bottle', shelfLifeMonths: 24,
    seasonality: 'summer_heat', unitCostInr: 34, coldChain: false,
    baselinePer1000PerDay: 0.075, dispersion: 1.5,
  },
  {
    id: 'NS-500ML', name: 'Sodium Chloride 0.9% (Normal Saline)', form: 'IV Fluid', strength: '500 mL',
    therapeuticGroup: 'IV Fluids', nlem: true, ved: 'V', unit: 'bottle', shelfLifeMonths: 24,
    seasonality: 'summer_heat', unitCostInr: 30, coldChain: false,
    baselinePer1000PerDay: 0.11, dispersion: 1.5,
  },
  {
    id: 'DEXTROSE-5-500ML', name: 'Dextrose 5%', form: 'IV Fluid', strength: '500 mL',
    therapeuticGroup: 'IV Fluids', nlem: true, ved: 'E', unit: 'bottle', shelfLifeMonths: 24,
    seasonality: 'summer_heat', unitCostInr: 31, coldChain: false,
    baselinePer1000PerDay: 0.06, dispersion: 1.5,
  },

  // --- Analgesics / antipyretics -------------------------------------------
  {
    id: 'PARA-500-TAB', name: 'Paracetamol', form: 'Tablet', strength: '500 mg',
    therapeuticGroup: 'Analgesic / Antipyretic', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'monsoon_vector', unitCostInr: 0.55, coldChain: false,
    baselinePer1000PerDay: 2.4, dispersion: 10,
  },
  {
    id: 'IBUPROFEN-400', name: 'Ibuprofen', form: 'Tablet', strength: '400 mg',
    therapeuticGroup: 'Analgesic / Antipyretic', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'flat', unitCostInr: 0.8, coldChain: false,
    baselinePer1000PerDay: 1.1, dispersion: 8,
  },
  {
    id: 'DICLOFENAC-INJ', name: 'Diclofenac Sodium', form: 'Injection', strength: '75 mg/3 mL',
    therapeuticGroup: 'Analgesic / Antipyretic', nlem: true, ved: 'E', unit: 'ampoule', shelfLifeMonths: 24,
    seasonality: 'flat', unitCostInr: 6, coldChain: false,
    baselinePer1000PerDay: 0.24, dispersion: 3,
  },

  // --- Respiratory ----------------------------------------------------------
  {
    id: 'SALBUTAMOL-MDI', name: 'Salbutamol', form: 'Inhaler (MDI)', strength: '100 mcg/dose',
    therapeuticGroup: 'Respiratory', nlem: true, ved: 'E', unit: 'inhaler', shelfLifeMonths: 24,
    seasonality: 'winter_respiratory', unitCostInr: 128, coldChain: false,
    baselinePer1000PerDay: 0.035, dispersion: 2,
  },
  {
    id: 'SALBUTAMOL-NEB', name: 'Salbutamol Respirator Solution', form: 'Nebuliser solution', strength: '5 mg/mL',
    therapeuticGroup: 'Respiratory', nlem: true, ved: 'E', unit: 'respule', shelfLifeMonths: 24,
    seasonality: 'winter_respiratory', unitCostInr: 9, coldChain: false,
    baselinePer1000PerDay: 0.09, dispersion: 1.5,
  },

  // --- Non-communicable disease (chronic, steady demand) --------------------
  {
    id: 'AMLODIPINE-5', name: 'Amlodipine', form: 'Tablet', strength: '5 mg',
    therapeuticGroup: 'Cardiovascular / NCD', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'flat', unitCostInr: 0.4, coldChain: false,
    baselinePer1000PerDay: 1.9, dispersion: 12,
  },
  {
    id: 'TELMISARTAN-40', name: 'Telmisartan', form: 'Tablet', strength: '40 mg',
    therapeuticGroup: 'Cardiovascular / NCD', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'flat', unitCostInr: 1.4, coldChain: false,
    baselinePer1000PerDay: 1.2, dispersion: 12,
  },
  {
    id: 'ENALAPRIL-5', name: 'Enalapril', form: 'Tablet', strength: '5 mg',
    therapeuticGroup: 'Cardiovascular / NCD', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'flat', unitCostInr: 0.7, coldChain: false,
    baselinePer1000PerDay: 0.55, dispersion: 12,
  },
  {
    id: 'METFORMIN-500', name: 'Metformin', form: 'Tablet', strength: '500 mg',
    therapeuticGroup: 'Cardiovascular / NCD', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'flat', unitCostInr: 0.5, coldChain: false,
    baselinePer1000PerDay: 2.2, dispersion: 12,
  },
  {
    id: 'ATORVASTATIN-10', name: 'Atorvastatin', form: 'Tablet', strength: '10 mg',
    therapeuticGroup: 'Cardiovascular / NCD', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'flat', unitCostInr: 1.1, coldChain: false,
    baselinePer1000PerDay: 1.0, dispersion: 12,
  },
  {
    id: 'ASPIRIN-75', name: 'Aspirin', form: 'Tablet', strength: '75 mg',
    therapeuticGroup: 'Cardiovascular / NCD', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'flat', unitCostInr: 0.25, coldChain: false,
    baselinePer1000PerDay: 1.3, dispersion: 12,
  },

  // --- Vaccines & biologicals (cold chain) ---------------------------------
  {
    id: 'ARV-VACCINE', name: 'Anti-Rabies Vaccine (cell culture)', form: 'Injection', strength: '2.5 IU',
    therapeuticGroup: 'Vaccines', nlem: true, ved: 'V', unit: 'vial', shelfLifeMonths: 24,
    seasonality: 'flat', unitCostInr: 310, coldChain: true,
    baselinePer1000PerDay: 0.055, dispersion: 1.5,
  },
  {
    id: 'TD-VACCINE', name: 'Td Vaccine (Tetanus + Diphtheria)', form: 'Injection', strength: '0.5 mL dose',
    therapeuticGroup: 'Vaccines', nlem: true, ved: 'V', unit: 'dose', shelfLifeMonths: 24,
    seasonality: 'flat', unitCostInr: 16, coldChain: true,
    baselinePer1000PerDay: 0.14, dispersion: 3,
  },

  // --- Other ----------------------------------------------------------------
  {
    id: 'ALBENDAZOLE-400', name: 'Albendazole', form: 'Tablet', strength: '400 mg',
    therapeuticGroup: 'Anthelmintic', nlem: true, ved: 'E', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'flat', unitCostInr: 1.5, coldChain: false,
    baselinePer1000PerDay: 0.4, dispersion: 2,
  },
  {
    id: 'VITAMIN-A-SOLN', name: 'Vitamin A Concentrate', form: 'Oral solution', strength: '100,000 IU/mL',
    therapeuticGroup: 'Nutrition / Anaemia', nlem: true, ved: 'E', unit: 'mL', shelfLifeMonths: 24,
    seasonality: 'flat', unitCostInr: 3.2, coldChain: false,
    baselinePer1000PerDay: 0.3, dispersion: 2,
  },
  {
    id: 'PANTOPRAZOLE-40', name: 'Pantoprazole', form: 'Tablet', strength: '40 mg',
    therapeuticGroup: 'Gastrointestinal', nlem: true, ved: 'D', unit: 'tablet', shelfLifeMonths: 24,
    seasonality: 'flat', unitCostInr: 1.6, coldChain: false,
    baselinePer1000PerDay: 1.4, dispersion: 10,
  },
  {
    id: 'CETIRIZINE-10', name: 'Cetirizine', form: 'Tablet', strength: '10 mg',
    therapeuticGroup: 'Antihistamine', nlem: true, ved: 'D', unit: 'tablet', shelfLifeMonths: 36,
    seasonality: 'winter_respiratory', unitCostInr: 0.3, coldChain: false,
    baselinePer1000PerDay: 0.85, dispersion: 8,
  },
  {
    id: 'POVIDONE-IODINE', name: 'Povidone Iodine solution', form: 'Topical solution', strength: '5% w/v, 100 mL',
    therapeuticGroup: 'Antiseptic / Consumable', nlem: true, ved: 'E', unit: 'bottle', shelfLifeMonths: 36,
    seasonality: 'flat', unitCostInr: 42, coldChain: false,
    baselinePer1000PerDay: 0.02, dispersion: 3,
  },
  {
    id: 'GLOVES-STERILE', name: 'Surgical Gloves (sterile)', form: 'Consumable', strength: 'Pair, size 7',
    therapeuticGroup: 'Antiseptic / Consumable', nlem: false, ved: 'E', unit: 'pair', shelfLifeMonths: 36,
    seasonality: 'flat', unitCostInr: 11, coldChain: false,
    baselinePer1000PerDay: 0.55, dispersion: 6,
  },
];

export const DRUGS_BY_ID: Record<string, CatalogueDrug> = Object.fromEntries(
  DRUG_CATALOGUE.map((d) => [d.id, d]),
);

export function getDrug(id: string): CatalogueDrug {
  const d = DRUGS_BY_ID[id];
  if (!d) throw new Error('Unknown drug id: ' + id);
  return d;
}

/** Distinct therapeutic groups, in catalogue order. */
export const THERAPEUTIC_GROUPS: string[] = [
  ...new Set(DRUG_CATALOGUE.map((d) => d.therapeuticGroup)),
];

/**
 * Drugs a facility of a given tier actually carries.
 *
 * A sub-centre does not stock Ceftriaxone or run IV lines; a district hospital
 * carries everything. Modelling this matters for the optimiser -- it must never
 * recommend transferring an item to a facility that has no business holding it.
 */
export function formularyFor(tier: 'SC' | 'PHC' | 'CHC' | 'SDH' | 'DH' | 'DW'): CatalogueDrug[] {
  if (tier === 'DW' || tier === 'DH' || tier === 'SDH') return DRUG_CATALOGUE;
  if (tier === 'CHC') return DRUG_CATALOGUE;
  if (tier === 'PHC') {
    // PHCs skip the items that need an operating theatre or specialist cover.
    const excluded = new Set(['PRALIDOXIME-INJ']);
    return DRUG_CATALOGUE.filter((d) => !excluded.has(d.id));
  }
  // Sub-centre: ANM-level formulary only.
  const scAllowed = new Set([
    'ORS-SACHET', 'ZINC-20-DT', 'IFA-ADULT-TAB', 'CALCIUM-500-TAB', 'PARA-500-TAB',
    'ALBENDAZOLE-400', 'VITAMIN-A-SOLN', 'OXYTOCIN-5IU-INJ', 'MISOPROSTOL-200',
    'TD-VACCINE', 'COTRIMOXAZOLE-DS', 'CHLOROQUINE-250', 'POVIDONE-IODINE', 'GLOVES-STERILE',
  ]);
  return DRUG_CATALOGUE.filter((d) => scAllowed.has(d.id));
}
