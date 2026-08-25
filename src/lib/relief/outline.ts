import type { Feature, MultiPolygon, Position } from 'geojson';
import outlineRaw from '@/data/india-outline.json';

/**
 * THE national outline, and the one boundary claim this project makes.
 *
 * ============================================================================
 * READ THIS BEFORE CHANGING THE GEOMETRY. IT IS NOT A RENDERING DETAIL.
 * ============================================================================
 *
 * Sourced from datameet/maps `Country/india-composite.geojson` -- a COMPOSITE,
 * meaning the full territory India claims -- and simplified by
 * `scripts/simplify-outline.mts` from 10.3 MB to 34 KB.
 *
 * In India the depiction of national boundaries is governed rather than a matter
 * of preference, and the ordinary international files (Natural Earth, GADM) and
 * every hosted basemap (Mapbox, MapLibre, OSM tiles) terminate Jammu and Kashmir
 * at the Line of Control. Verified on the source before adopting it:
 *
 *     north  37.096 N   Gilgit-Baltistan and Aksai Chin
 *                       (an LoC-terminated file stops near 35.5 N -- that is the
 *                        failure signature to test for)
 *     east   97.395 E   the whole of Arunachal Pradesh
 *     south   6.753 N   the Nicobar Islands
 *
 * Only the national outline ships. No internal state boundaries are drawn -- they
 * would introduce a second class of boundary claim for no analytical gain, since
 * districts are plotted from their own coordinates and labelled by state. A
 * previous state-polygon layer was removed for being pre-2011 vintage (no
 * Telangana; states still labelled "Orissa" and "Uttaranchal"), and a wrong
 * boundary is worse than no boundary in any government-facing context.
 *
 * Deliberately NOT permitted, in 2D or in 3D:
 *   - a hosted basemap of any kind, for the LoC reason above
 *   - a convex hull or density field over the district points: it produces a
 *     shape close enough to India to be read as India, and it is the wrong one --
 *     it swallows parts of neighbouring countries and lops off the north-east
 *   - re-simplifying for tessellation convenience, or clipping to a bounding box
 *
 * WHY THIS FILE EXISTS AT ALL: the outline is now drawn by two renderers -- the
 * server-rendered SVG and the WebGL relief. Two import sites means two chances for
 * someone to "fix" one of them in isolation. Everything goes through here, and
 * `scripts/verify-outline.mts` asserts the extents above on every `npm test`, so a
 * regression fails CI instead of a demo.
 */
export const INDIA_OUTLINE = outlineRaw as unknown as Feature<MultiPolygon>;

/** Bounding box of the claimed territory, `[west, south, east, north]`. */
export const INDIA_BOUNDS: [number, number, number, number] = [
  68.172, 6.753, 97.395, 37.096,
];

/**
 * The outline as deck.gl wants it: one entry per polygon part, each a flat ring
 * of `[lon, lat]` pairs.
 *
 * The file is 8 polygon parts (mainland plus seven island groups) and every part
 * is single-ring -- there are no holes anywhere in it, which is why this takes
 * `part[0]` and does not carry the hole-array form through. If a future outline
 * ever gains an interior ring this must become `polygon: part` instead, and
 * `SolidPolygonLayer` will handle it; the assertion in `verify-outline.mts`
 * catches the change.
 */
export const INDIA_POLYGONS: { polygon: Position[] }[] =
  INDIA_OUTLINE.geometry.coordinates.map((part) => ({ polygon: part[0] }));
