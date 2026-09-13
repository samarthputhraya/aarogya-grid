/**
 * Reading a Kerala IDSP daily bulletin, deterministically.
 *
 * WHAT THE SOURCE IS
 * ------------------
 * The State Surveillance Unit of the Directorate of Health Services, Kerala,
 * publishes "Communicable Diseases - Daily Report" every day as a signed PDF:
 * the Integrated Disease Surveillance Programme's district-wise reporting format,
 * one row per district, with fever consultations and the notifiable diseases
 * counted as suspected, confirmed and deaths. It is the one real, public,
 * district-level, daily disease signal in India this project could find, and it
 * is what the early-warning feed's `observed` signals are built from.
 *
 * WHY NOT A LANGUAGE MODEL
 * ------------------------
 * The PDF has a real text layer. A model reading it would add a failure mode --
 * a plausible wrong number -- to a document that can be read exactly, and would
 * send a public-health document outside the region to do it. So the table is
 * rebuilt from the text layer's positioned items, and every day is checked
 * against the bulletin's own TOTAL row: a column whose districts do not sum to
 * the state total is recorded as failing that check rather than trusted.
 *
 * Pure: this file takes positioned text items and returns numbers. Loading the
 * PDF is `./pdf.ts`; fetching it is `scripts/fetch-idsp.mts`.
 */

/** A positioned run of text from the PDF's text layer. */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

/** The district-wise table's 29 data columns, in the order the format prints them. */
export const COLUMNS = [
  'feverOutpatients',
  'feverInpatients',
  'chikungunyaSuspected',
  'chikungunyaConfirmed',
  'chikungunyaDeaths',
  'dengueSuspected',
  'dengueConfirmed',
  'dengueDeaths',
  'leptospirosisSuspected',
  'leptospirosisConfirmed',
  'leptospirosisDeaths',
  'acuteDiarrhoealDisease',
  'chickenpox',
  'hepatitisA',
  'choleraSuspectedCases',
  'choleraSuspectedDeaths',
  'choleraConfirmedCases',
  'choleraConfirmedDeaths',
  'aesCases',
  'japaneseEncephalitisCases',
  'malariaVivaxImported',
  'malariaVivaxIndigenous',
  'malariaFalciparumImported',
  'malariaFalciparumIndigenous',
  'malariaMixedImported',
  'malariaMixedIndigenous',
  'malariaDeaths',
  'scrubTyphus',
  'influenza',
] as const;

export type Column = (typeof COLUMNS)[number];

/** The format's district abbreviations, north to south as printed. */
export const DISTRICT_ABBREVIATIONS = [
  'TVM', 'KLM', 'PTA', 'IDK', 'KTM', 'ALP', 'EKM', 'TSR', 'PKD', 'MPM', 'KKD', 'WYD', 'KNR', 'KSD',
] as const;

export type DistrictAbbreviation = (typeof DISTRICT_ABBREVIATIONS)[number];

export interface ParsedBulletin {
  /** ISO date the bulletin reports on, from its title. */
  date: string;
  /** Per district, 29 values in `COLUMNS` order. `null` where the cell was blank. */
  districts: Record<DistrictAbbreviation, (number | null)[]>;
  /** The bulletin's own TOTAL row, or null if it could not be read. */
  total: (number | null)[] | null;
  checks: {
    /** Districts whose row had every one of the 29 cells. */
    completeRows: number;
    /** Columns where the districts do not add up to the TOTAL row. */
    columnsFailingTotal: Column[];
    /** Blank cells set to zero because their column adds up to the printed total without them. */
    blankCellsReconciled: number;
    /** The short date printed in the table header, e.g. `11-09-26`, if it agrees with the title. */
    headerDateAgrees: boolean;
  };
}

export class BulletinFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulletinFormatError';
  }
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * The reporting date from the title, in either of the two ways it is written:
 * `Daily Report on September 11, 2026` and, in January, `Daily Report on 2nd
 * January, 2026` (with the ordinal set as a superscript on its own line).
 */
export function titleDate(text: string): string | null {
  const iso = (y: string, monthName: string, d: string) => {
    const month = MONTHS.indexOf(monthName.toLowerCase());
    return month < 0 ? null : y + '-' + String(month + 1).padStart(2, '0') + '-' + d.padStart(2, '0');
  };
  const monthFirst = /Daily Report on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(text);
  if (monthFirst) return iso(monthFirst[3], monthFirst[1], monthFirst[2]);
  const dayFirst = /Daily Report on\s+(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s*(\d{4})/.exec(text);
  if (dayFirst) return iso(dayFirst[3], dayFirst[2], dayFirst[1]);
  // And, on some January days, as digits: `Daily Report on 10.01.2026`.
  const numeric = /Daily Report on\s+(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(text);
  if (numeric) return numeric[3] + '-' + numeric[2].padStart(2, '0') + '-' + numeric[1].padStart(2, '0');
  return null;
}

interface Row {
  y: number;
  items: TextItem[];
}

/** Items grouped into printed lines, top of the page first. */
function rows(items: TextItem[]): Row[] {
  const out: Row[] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y)) {
    if (!it.str.trim()) continue;
    const row = out.find((r) => Math.abs(r.y - it.y) <= 3);
    if (row) row.items.push(it);
    else out.push({ y: it.y, items: [it] });
  }
  for (const r of out) r.items.sort((a, b) => a.x - b.x);
  return out;
}

const center = (it: TextItem) => it.x + it.width / 2;

function cellValue(s: string): number {
  // A stray comma typed into a cell (", 0" on 17 May 2026) is not a value of its
  // own. Tolerated here only because every column is then checked against the
  // printed total, which is what would catch a misread.
  const t = s.trim().replace(/^[,\s]+/, '');
  if (/^-+$/.test(t)) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  throw new BulletinFormatError('unreadable cell "' + s + '"');
}

/**
 * Parse the district-wise table.
 *
 * `pages` is every page's text items; the table is found by its heading rather
 * than assumed to be on page two, and the date is read from the title.
 */
export function parseBulletin(pages: TextItem[][]): ParsedBulletin {
  // Some days' bulletins are scanned images with no text layer at all. Those
  // are not read -- by this parser or by a model -- and are recorded as such.
  if (pages.every((p) => p.every((i) => !i.str.trim()))) {
    throw new BulletinFormatError('scanned image with no text layer');
  }
  // Joined by printed line, not by stream order: a superscript ordinal is a
  // separate item that the stream can place anywhere.
  const allText = pages.map((p) => rows(p).map((r) => r.items.map((i) => i.str).join(' ')).join('\n')).join('\n');
  const date = titleDate(allText);
  if (!date) throw new BulletinFormatError('no "Daily Report on <date>" title');

  const tablePage = pages.find((p) => p.some((i) => /DISTRICT WISE DAILY REPORTING FORMAT/i.test(i.str)));
  if (!tablePage) throw new BulletinFormatError('no district-wise reporting table');
  const lines = rows(tablePage);

  // Printed as dd-mm-yy on some days and dd-mm-yyyy on others.
  const headerDate = tablePage
    .find((i) => /^\d{2}[-.]\d{2}[-.](\d{2}|\d{4})$/.test(i.str.trim()))
    ?.str.trim();
  const headerIso = headerDate
    ? (headerDate.length === 8 ? '20' + headerDate.slice(6, 8) : headerDate.slice(6, 10)) + '-' +
      headerDate.slice(3, 5) + '-' + headerDate.slice(0, 2)
    : null;

  // Each district's line: the abbreviation, then the cells to its right.
  const districtLines = new Map<DistrictAbbreviation, TextItem[]>();
  let totalLine: TextItem[] | null = null;
  for (const line of lines) {
    const label = line.items.find((i) => (DISTRICT_ABBREVIATIONS as readonly string[]).includes(i.str.trim()) || i.str.trim() === 'TOT');
    if (!label) continue;
    // The table's cells start right of the label; the dengue section further
    // down the page repeats abbreviations with a colon and prose, not cells.
    const cells = line.items.filter((i) => i.x > label.x + label.width - 1 && i.x < 800);
    if (cells.length < 20 || cells.some((c) => /[A-Za-z:]/.test(c.str))) continue;
    const key = label.str.trim();
    if (key === 'TOT') totalLine = cells;
    else if (!districtLines.has(key as DistrictAbbreviation)) districtLines.set(key as DistrictAbbreviation, cells);
  }
  const missing = DISTRICT_ABBREVIATIONS.filter((d) => !districtLines.has(d));
  if (missing.length > 0) throw new BulletinFormatError('rows missing for ' + missing.join(', '));

  // Column centres from the rows that printed every cell: a blank cell is
  // simply absent from the text layer, so position is the only way to know
  // which column a value belongs to in a row that has one.
  const complete = [...districtLines.values()].filter((c) => c.length === COLUMNS.length);
  const reference = complete.length >= 3 ? complete : totalLine && totalLine.length === COLUMNS.length ? [totalLine] : [];
  if (reference.length === 0) throw new BulletinFormatError('no complete row to locate the columns from');
  const centres = COLUMNS.map((_, k) => {
    const xs = reference.map((cells) => center(cells[k])).sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)];
  });
  const gap = Math.min(...centres.slice(1).map((c, i) => c - centres[i]));

  const place = (cells: TextItem[]): (number | null)[] => {
    const values: (number | null)[] = COLUMNS.map(() => null);
    for (const cell of cells) {
      let best = 0;
      for (let k = 1; k < centres.length; k++) {
        if (Math.abs(center(cell) - centres[k]) < Math.abs(center(cell) - centres[best])) best = k;
      }
      if (Math.abs(center(cell) - centres[best]) > gap / 2 + 2) {
        throw new BulletinFormatError('cell "' + cell.str + '" at x=' + cell.x + ' is between columns');
      }
      if (values[best] !== null) throw new BulletinFormatError('two cells in column ' + COLUMNS[best]);
      values[best] = cellValue(cell.str);
    }
    return values;
  };

  const districts = Object.fromEntries(
    DISTRICT_ABBREVIATIONS.map((d) => [d, place(districtLines.get(d)!)]),
  ) as Record<DistrictAbbreviation, (number | null)[]>;
  const total = totalLine ? place(totalLine) : null;

  const columnsFailingTotal: Column[] = [];
  let blankCellsReconciled = 0;
  if (total) {
    COLUMNS.forEach((col, k) => {
      if (total[k] === null) return;
      const sum = DISTRICT_ABBREVIATIONS.reduce((a, d) => a + (districts[d][k] ?? 0), 0);
      if (sum !== total[k]) {
        columnsFailingTotal.push(col);
        return;
      }
      // A blank cell in a column that adds up to the printed total WAS zero:
      // the bulletin's own arithmetic says so. In a column that does not add
      // up, a blank stays unknown.
      for (const d of DISTRICT_ABBREVIATIONS) {
        if (districts[d][k] === null) {
          districts[d][k] = 0;
          blankCellsReconciled++;
        }
      }
    });
  }

  return {
    date,
    districts,
    total,
    checks: {
      completeRows: complete.length,
      columnsFailingTotal,
      blankCellsReconciled,
      headerDateAgrees: headerIso === date,
    },
  };
}

/**
 * The syndromes the early-warning feed watches, and the columns each one sums.
 *
 * Cases, not deaths: a death column is a lagging count of the same outbreak.
 * Suspected and confirmed together, because in a daily bulletin a case is
 * "suspected" for days before a laboratory confirms it -- a detector that waited
 * for confirmation would be as late as the laboratory.
 */
export const SYNDROMES = {
  dengue: { hazardClass: 'vector_borne', label: 'Dengue (suspected and confirmed)', columns: ['dengueSuspected', 'dengueConfirmed'] },
  malaria: {
    hazardClass: 'vector_borne',
    label: 'Malaria (all species)',
    columns: ['malariaVivaxImported', 'malariaVivaxIndigenous', 'malariaFalciparumImported', 'malariaFalciparumIndigenous', 'malariaMixedImported', 'malariaMixedIndigenous'],
  },
  chikungunya: { hazardClass: 'vector_borne', label: 'Chikungunya (suspected and confirmed)', columns: ['chikungunyaSuspected', 'chikungunyaConfirmed'] },
  scrubTyphus: { hazardClass: 'vector_borne', label: 'Scrub typhus', columns: ['scrubTyphus'] },
  diarrhoea: { hazardClass: 'enteric', label: 'Acute diarrhoeal disease', columns: ['acuteDiarrhoealDisease'] },
  hepatitisA: { hazardClass: 'enteric', label: 'Hepatitis A', columns: ['hepatitisA'] },
  leptospirosis: { hazardClass: 'zoonotic', label: 'Leptospirosis (suspected and confirmed)', columns: ['leptospirosisSuspected', 'leptospirosisConfirmed'] },
  influenza: { hazardClass: 'acute_respiratory', label: 'Influenza', columns: ['influenza'] },
  fever: { hazardClass: 'acute_febrile_illness', label: 'Fever, outpatient consultations', columns: ['feverOutpatients'] },
} as const satisfies Record<string, { hazardClass: string; label: string; columns: readonly Column[] }>;

export type Syndrome = keyof typeof SYNDROMES;

/** A syndrome's count for one district on one day, or null if any column it needs was blank. */
export function syndromeCount(row: (number | null)[], syndrome: Syndrome): number | null {
  let sum = 0;
  for (const col of SYNDROMES[syndrome].columns) {
    const v = row[COLUMNS.indexOf(col)];
    if (v === null) return null;
    sum += v;
  }
  return sum;
}
