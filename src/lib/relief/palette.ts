import { riskColor } from '@/lib/format';

/**
 * The console's colour ramp, in the form WebGL needs.
 *
 * WHY THIS PARSES RATHER THAN RESTATES
 * ------------------------------------
 * `riskColor()` in `@/lib/format` is the source of truth for what a risk score
 * looks like, and it is read by every table, every KPI tile and the SVG map. A
 * relief layer that carried its own `[255, 77, 94]` tuples would be a third copy
 * of the ramp -- `IndiaMap.tsx:99-107` already keeps a second one for its legend
 * and comments at length on the hazard.
 *
 * So the tuples are derived from the same hex strings at module load. The cost is
 * one pass of `parseInt` over a handful of colours; the benefit is that a change
 * to the ramp cannot leave the map disagreeing with the table beside it.
 */

export type RGBA = [number, number, number, number];

/**
 * `#rrggbb` -> `[r, g, b, a]`.
 *
 * Throws on anything it does not recognise rather than returning a default.
 * A silent fallback here would paint a district in the wrong severity, which is
 * the one class of bug this whole palette exists to prevent -- better a build
 * that fails loudly than a map that lies quietly.
 */
export function hexToRgba(hex: string, alpha = 255): RGBA {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`relief/palette: expected #rrggbb, got "${hex}"`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

/** Risk score (0..38-ish) -> fill, straight through the console's own function. */
export function riskRgba(score: number, alpha = 255): RGBA {
  return hexToRgba(riskColor(score), alpha);
}

/**
 * Severity, as literals.
 *
 * `SEVERITY_COLOR` in `@/lib/format` cannot be reused here: it holds CSS custom
 * property references (`var(--color-sev-critical)`) because its consumers are SVG
 * `fill` attributes and Tailwind classes, where a `var()` resolves. There is no
 * `var()` inside a vertex buffer, so these have to be the resolved values.
 *
 * Caught by `hexToRgba` throwing on the first run rather than by review, which is
 * the behaviour that guard exists for -- a lenient parser would have returned black
 * and painted every critical district the colour of the page ground.
 *
 * Mirrors the `--color-sev-*` tokens in globals.css. Second site for a ramp change.
 */
export const SEVERITY_RGBA = {
  critical: hexToRgba('#ff4d5e'),
  high: hexToRgba('#ff9838'),
  moderate: hexToRgba('#ffd23f'),
  low: hexToRgba('#34d399'),
} as const;

/**
 * Surface and brand tokens.
 *
 * These are the only literals in the file, and they are duplicated from the
 * `@theme` block in `globals.css` because CSS custom properties are not readable
 * from a WebGL shader or from a deck.gl accessor -- there is no `var()` inside a
 * vertex buffer. They are annotated with the token they mirror so a palette
 * change has a findable second site.
 */
export const INK_950 = hexToRgba('#010409'); // --color-ink-950, page ground
export const INK_900 = hexToRgba('#0a1019'); // --color-ink-900, panel fill
export const INK_850 = hexToRgba('#101a28'); // --color-ink-850, inset card
export const INK_800 = hexToRgba('#162131'); // --color-ink-800
export const INK_700 = hexToRgba('#212e3f'); // --color-ink-700, panel border
export const INK_600 = hexToRgba('#2e3c4e'); // --color-ink-600
export const INK_500 = hexToRgba('#3f4f66'); // --color-ink-500, strongest rule
export const MIST_500 = hexToRgba('#778ba2'); // --color-mist-500
export const MIST_300 = hexToRgba('#a2b1c2'); // --color-mist-300
export const MIST_100 = hexToRgba('#dce5ef'); // --color-mist-100
export const BRAND = hexToRgba('#2dd4bf'); // --color-brand
export const BRAND_DIM = hexToRgba('#149a8f'); // --color-brand-dim

/** Same colour, different alpha, without re-parsing. */
export function withAlpha(c: RGBA, alpha: number): RGBA {
  return [c[0], c[1], c[2], alpha];
}
