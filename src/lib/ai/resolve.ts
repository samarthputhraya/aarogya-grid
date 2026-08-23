import { DRUG_CATALOGUE, type CatalogueDrug } from '@/lib/domain/drugs';

/**
 * Drug entity resolution.
 *
 * WHY THIS IS NOT THE MODEL'S JOB
 * -------------------------------
 * Gemini is very good at understanding that a health worker saying "bukhar ki
 * goli pachas bachi hai" means fifty fever tablets remain. It is the wrong tool
 * for deciding WHICH catalogue item that maps to, because a language model asked
 * for an item code will produce a plausible-looking code whether or not the item
 * exists -- and writing a hallucinated drug code into a national inventory
 * ledger is not a recoverable error.
 *
 * So the pipeline is split, and the split is the whole point:
 *
 *   Gemini      -> open-vocabulary language understanding. Returns the drug as
 *                  the worker SAID it, plus a normalised English guess. Never a code.
 *   This module -> deterministic, auditable mapping from that text to a real
 *                  catalogue ID, with a confidence score and runners-up.
 *   The UI      -> confirms anything below the auto-accept threshold with a human.
 *
 * Every code that reaches the ledger came from `DRUG_CATALOGUE`. There is no
 * path by which a model can invent one.
 */

/**
 * Vernacular and colloquial aliases.
 *
 * These are terms health workers and patients actually use. The list is
 * deliberately small and high-confidence rather than exhaustive -- Gemini
 * handles the open vocabulary and normalises to a English drug name, and this
 * table only has to catch the cases where the colloquial term is the CANONICAL
 * one in the field (a health worker is far more likely to say "lal goli" than
 * "ferrous sulphate with folic acid").
 *
 * Extending this list is a data task, not a code change.
 */
const ALIASES: Record<string, string[]> = {
  'PARA-500-TAB': ['paracetamol', 'pcm', 'crocin', 'dolo', 'calpol', 'bukhar ki goli', 'fever tablet', 'bukhar tablet'],
  'ORS-SACHET': ['ors', 'ors packet', 'oral rehydration', 'rehydration salt', 'ors sachet', 'jeevan raksha'],
  'ZINC-20-DT': ['zinc', 'zinc tablet', 'zinc sulphate', 'jhink'],
  'IFA-ADULT-TAB': ['ifa', 'iron tablet', 'iron folic', 'lal goli', 'red tablet', 'iron and folic acid', 'khoon ki goli'],
  'CALCIUM-500-TAB': ['calcium', 'calcium tablet', 'safed goli', 'cal tablet'],
  'ALBENDAZOLE-400': ['albendazole', 'deworming tablet', 'pet ke keede ki dawa', 'krimi nashak', 'worm tablet'],
  'ASV-POLY-10ML': ['asv', 'anti snake venom', 'snake bite injection', 'saap kaatne ka injection', 'antisnake venom'],
  'ATROPINE-0.6-INJ': ['atropine', 'atropine injection'],
  'ADRENALINE-INJ': ['adrenaline', 'epinephrine', 'adrenalin'],
  'OXYTOCIN-5IU-INJ': ['oxytocin', 'oxy', 'labour injection', 'delivery injection'],
  'MGSO4-INJ': ['magnesium sulphate', 'mgso4', 'mag sulph', 'eclampsia injection'],
  'MISOPROSTOL-200': ['misoprostol', 'miso'],
  'METFORMIN-500': ['metformin', 'sugar ki dawa', 'sugar tablet', 'diabetes tablet', 'glycomet'],
  'AMLODIPINE-5': ['amlodipine', 'bp ki dawa', 'bp tablet', 'amlong', 'blood pressure tablet'],
  'TELMISARTAN-40': ['telmisartan', 'telma'],
  'ATORVASTATIN-10': ['atorvastatin', 'atorva', 'cholesterol tablet'],
  'ASPIRIN-75': ['aspirin', 'ecosprin'],
  'AMOXICILLIN-500': ['amoxicillin', 'amoxycillin', 'mox', 'amox'],
  'AZITHRO-500': ['azithromycin', 'azithral', 'azee', 'azithro'],
  'CEFTRIAXONE-1G': ['ceftriaxone', 'monocef', 'ceftri'],
  'CIPRO-500': ['ciprofloxacin', 'cipro', 'ciplox'],
  'METRONIDAZOLE-400': ['metronidazole', 'metrogyl', 'flagyl', 'metro'],
  'COTRIMOXAZOLE-DS': ['cotrimoxazole', 'septran', 'bactrim', 'cotrim'],
  'DOXYCYCLINE-100': ['doxycycline', 'doxy'],
  'ATT-4FDC': ['anti tb', 'tb medicine', 'hrze', 'fdc', 'tb ki dawa', 'four drug fdc'],
  'ACT-ASSP-ADULT': ['act', 'artesunate sp', 'malaria tablet', 'malaria ki dawa', 'as+sp', 'acr'],
  'ARTESUNATE-60-INJ': ['artesunate injection', 'artesunate', 'severe malaria injection'],
  'CHLOROQUINE-250': ['chloroquine', 'cq', 'malaria goli'],
  'PRIMAQUINE-7.5': ['primaquine', 'pq'],
  'RL-500ML': ['ringer lactate', 'rl', 'ringer', 'rl bottle'],
  'NS-500ML': ['normal saline', 'ns', 'saline', 'nacl', 'saline bottle'],
  'DEXTROSE-5-500ML': ['dextrose', 'ds', 'glucose bottle', 'dns'],
  'SALBUTAMOL-MDI': ['salbutamol inhaler', 'inhaler', 'asthalin inhaler', 'pump'],
  'SALBUTAMOL-NEB': ['salbutamol respule', 'nebuliser solution', 'asthalin respule', 'neb'],
  'ARV-VACCINE': ['anti rabies', 'rabies vaccine', 'arv', 'kutta katne ka injection', 'dog bite injection'],
  'TD-VACCINE': ['td', 'tetanus', 'tt', 'tetanus toxoid', 'dhanush ban ka injection'],
  'VITAMIN-A-SOLN': ['vitamin a', 'vit a', 'vitamin a solution'],
  'PANTOPRAZOLE-40': ['pantoprazole', 'pan', 'pantop', 'acidity tablet', 'gas ki goli'],
  'CETIRIZINE-10': ['cetirizine', 'cetrizine', 'alerid', 'allergy tablet'],
  'IBUPROFEN-400': ['ibuprofen', 'brufen', 'dard ki goli'],
  'DICLOFENAC-INJ': ['diclofenac', 'voveran', 'dard ka injection'],
  'HYDROCORT-100-INJ': ['hydrocortisone', 'efcorlin', 'hydrocort'],
  'DEXA-4-INJ': ['dexamethasone', 'dexona', 'dexa'],
  'PRALIDOXIME-INJ': ['pralidoxime', '2-pam', 'pam', 'pralidox'],
  'POVIDONE-IODINE': ['betadine', 'povidone', 'iodine', 'antiseptic'],
  'GLOVES-STERILE': ['gloves', 'surgical gloves', 'dastane', 'sterile gloves'],
  'ENALAPRIL-5': ['enalapril', 'envas'],
};

export interface ResolvedDrug {
  drug: CatalogueDrug;
  /** 0..1. Above `AUTO_ACCEPT` we write without asking; below, a human confirms. */
  confidence: number;
  /** How the match was made -- shown in the audit trail. */
  via: 'exact' | 'alias' | 'fuzzy';
}

export interface ResolutionResult {
  query: string;
  best: ResolvedDrug | null;
  /** Runners-up, so the UI can offer a pick-list instead of a free-text retry. */
  alternatives: ResolvedDrug[];
  /** True when the caller should require human confirmation before committing. */
  needsConfirmation: boolean;
}

/** Above this we auto-accept; below it a human confirms. Deliberately strict. */
export const AUTO_ACCEPT = 0.82;

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Character-bigram Dice coefficient -- robust to the spelling variation in transcribed speech. */
function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };

  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  for (const [g, countA] of A) {
    const countB = B.get(g);
    if (countB) overlap += Math.min(countA, countB);
  }
  const total = [...A.values()].reduce((x, y) => x + y, 0) + [...B.values()].reduce((x, y) => x + y, 0);
  return total > 0 ? (2 * overlap) / total : 0;
}

/** Build the searchable surface for one drug: name, aliases, and name+strength. */
function surfacesFor(drug: CatalogueDrug): { text: string; via: 'exact' | 'alias' }[] {
  const out: { text: string; via: 'exact' | 'alias' }[] = [
    { text: normalise(drug.name), via: 'exact' },
    { text: normalise(drug.name + ' ' + drug.strength), via: 'exact' },
  ];
  // The parenthetical in names like "Anti-Snake Venom (polyvalent)" is noise for matching.
  const bare = drug.name.replace(/\(.*?\)/g, '').trim();
  if (bare && bare !== drug.name) out.push({ text: normalise(bare), via: 'exact' });

  for (const alias of ALIASES[drug.id] ?? []) {
    out.push({ text: normalise(alias), via: 'alias' });
  }
  return out;
}

/** Precomputed index -- built once at module load, not per call. */
const INDEX: { drug: CatalogueDrug; surfaces: { text: string; via: 'exact' | 'alias' }[] }[] =
  DRUG_CATALOGUE.map((drug) => ({ drug, surfaces: surfacesFor(drug) }));

/**
 * Inverse document frequency over catalogue tokens.
 *
 * WHY THIS EXISTS -- a real safety bug it fixes
 * ---------------------------------------------
 * Weighting every shared token equally means the word "injection" counts as
 * much as the word "ceftriaxone". The query "ceftriaxone injection" then
 * matches Anti-Snake Venom (whose alias "snake bite injection" shares the token
 * "injection") exactly as strongly as it matches Ceftriaxone -- and the tie
 * broke toward the antivenom. Confidently mapping an antibiotic to an antivenom
 * is precisely the class of error this module exists to prevent.
 *
 * IDF fixes it from first principles: a token appearing across many drugs
 * carries almost no identifying information, while one appearing in a single
 * drug carries nearly all of it. "injection" is worth little, "ceftriaxone" is
 * worth almost everything, and no hand-maintained stopword list is needed.
 */
const TOKEN_IDF: Map<string, number> = (() => {
  const df = new Map<string, number>();
  for (const entry of INDEX) {
    const seen = new Set<string>();
    for (const s of entry.surfaces) {
      for (const t of s.text.split(' ')) {
        if (t.length >= 2) seen.add(t);
      }
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = INDEX.length;
  const idf = new Map<string, number>();
  for (const [t, count] of df) idf.set(t, Math.log(N / (1 + count)) + 1);
  return idf;
})();

/** IDF of a token; unknown tokens are treated as maximally informative. */
function idfOf(token: string): number {
  return TOKEN_IDF.get(token) ?? Math.log(INDEX.length) + 1;
}

/**
 * Resolve free text to a catalogue drug.
 *
 * Scoring is deliberately transparent: exact and alias hits win outright, and
 * everything else falls back to bigram similarity with a bonus for whole-token
 * containment (so "ceftriaxone" beats "cetirizine" for the query "ceftriaxone
 * inj" even though the two names are close in edit distance -- a confusion that
 * would matter clinically).
 */
export function resolveDrug(query: string, opts: { strengthHint?: string } = {}): ResolutionResult {
  const q = normalise(query + (opts.strengthHint ? ' ' + opts.strengthHint : ''));
  const qBare = normalise(query);

  if (!qBare) {
    return { query, best: null, alternatives: [], needsConfirmation: true };
  }

  // Length >= 2, not > 2. Two-character tokens carry real signal in this domain
  // -- "bp", "tt", "ns", "rl", "cq", "td" are all drug abbreviations a health
  // worker uses. Dropping them made "bp ki dawa" match on "dawa" alone, which
  // resolved a blood-pressure drug to an antimalarial.
  const qTokens = new Set(qBare.split(' ').filter((t) => t.length >= 2));
  const scored: ResolvedDrug[] = [];

  for (const entry of INDEX) {
    let best = 0;
    let via: ResolvedDrug['via'] = 'fuzzy';

    for (const surface of entry.surfaces) {
      if (surface.text === qBare || surface.text === q) {
        best = surface.via === 'exact' ? 1.0 : 0.97;
        via = surface.via;
        break;
      }

      let score = Math.max(diceSimilarity(qBare, surface.text), diceSimilarity(q, surface.text));

      // Token containment, weighted by how much each token actually identifies
      // a drug. Matching "ceftriaxone" is near-conclusive; matching "injection"
      // is nearly worthless.
      const sTokens = new Set(surface.text.split(' ').filter((t) => t.length >= 2));
      let sharedWeight = 0;
      let totalWeight = 0;
      for (const t of qTokens) {
        const w = idfOf(t);
        totalWeight += w;
        if (sTokens.has(t)) sharedWeight += w;
      }
      // Capped at 0.93, strictly below the 0.97 an exact alias hit scores, so a
      // partial token match can never outrank a literal alias match on a tie.
      if (sharedWeight > 0 && totalWeight > 0) {
        score = Math.max(score, 0.55 + 0.38 * (sharedWeight / totalWeight));
      }

      if (score > best) {
        best = score;
        via = 'fuzzy';
      }
    }

    if (best > 0.35) scored.push({ drug: entry.drug, confidence: +best.toFixed(3), via });
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  const best = scored[0] ?? null;
  const alternatives = scored.slice(1, 4);

  // An ambiguous top-2 needs a human even if the top score is high -- this is
  // the case that matters clinically (cetirizine vs ceftriaxone).
  const ambiguous =
    best !== null && alternatives.length > 0 && best.confidence - alternatives[0].confidence < 0.08;

  return {
    query,
    best,
    alternatives,
    needsConfirmation: !best || best.confidence < AUTO_ACCEPT || ambiguous,
  };
}

/** Restrict resolution to what a facility tier actually stocks. */
export function resolveWithinFormulary(
  query: string,
  formulary: CatalogueDrug[],
): ResolutionResult {
  const allowed = new Set(formulary.map((d) => d.id));
  const full = resolveDrug(query);
  const filter = (r: ResolvedDrug) => allowed.has(r.drug.id);

  const candidates = [full.best, ...full.alternatives].filter(
    (r): r is ResolvedDrug => r !== null && filter(r),
  );

  const best = candidates[0] ?? null;
  const alternatives = candidates.slice(1);
  const ambiguous =
    best !== null && alternatives.length > 0 && best.confidence - alternatives[0].confidence < 0.08;

  return {
    query,
    best,
    alternatives,
    needsConfirmation: !best || best.confidence < AUTO_ACCEPT || ambiguous,
  };
}
