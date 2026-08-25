/**
 * Should this visitor get the WebGL relief, or the SVG that is already painted?
 *
 * The relief is an enhancement layered over a server-rendered map, and the decision
 * has to be made on the visitor's machine. The cases this exists for are all real
 * and none of them announce themselves:
 *
 *   - a conference projector driven by an old laptop with a blocklisted GPU
 *   - a corporate build with hardware acceleration disabled by policy
 *   - a headless or virtualised browser (assessors do screenshot in one)
 *   - Chrome having quietly dropped the GPU process after an earlier crash
 *   - a phone on conference wifi that CAN run it and shouldn't
 *
 * In most of those `getContext('webgl2')` returns null rather than throwing, so
 * asking for the context is the only honest test. But a context is not the same as
 * a machine that can hold 60 fps, which is why the cheap device gates run first: a
 * relief at 8 fps is worse than the SVG, and the visitor cannot tell us that.
 *
 * Pure and framework-free on purpose -- no React import -- so `scripts/` can test
 * it under tsx and both routes can share one copy.
 */

export type ReliefDenial =
  | 'ssr' // no window yet; the server always renders the SVG
  | 'killed' // explicit opt-out, see KILL_PARAM
  | 'save-data' // the visitor asked the browser to conserve
  | 'low-memory'
  | 'low-cores'
  | 'viewport' // too small to be worth the bundle
  | 'no-webgl2'
  | 'perf-caveat'; // context exists but is software-rendered

export type ReliefCapability =
  | { mode: 'svg'; reason: ReliefDenial }
  | { mode: 'gl'; motion: 'cinematic' | 'static' };

/** `?relief=off`, and the localStorage key it writes. */
export const KILL_PARAM = 'relief';
export const KILL_KEY = 'ag:relief';

export interface ProbeOptions {
  /** Minimum viewport width. The console earns it sooner than the landing page. */
  minWidth?: number;
}

export function probeRelief(opts: ProbeOptions = {}): ReliefCapability {
  const { minWidth = 1024 } = opts;

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { mode: 'svg', reason: 'ssr' };
  }

  // 1. Kill switch. Needed to recover a demo in front of an assessor, and to let
  //    someone see the fallback deliberately. Checked first so it can override
  //    every other gate including a machine that would pass them all.
  try {
    if (new URLSearchParams(window.location.search).get(KILL_PARAM) === 'off') {
      return { mode: 'svg', reason: 'killed' };
    }
    if (window.localStorage?.getItem(KILL_KEY) === 'off') {
      return { mode: 'svg', reason: 'killed' };
    }
  } catch {
    // Private mode can throw on localStorage. Not a reason to deny the relief.
  }

  // 2. Device class. These are the machines that will create a context and then
  //    run badly -- the outcome the probe exists to avoid, and the one a bare
  //    `getContext` check sails straight past.
  const nav = window.navigator as Navigator & {
    connection?: { saveData?: boolean };
    deviceMemory?: number;
  };
  if (nav.connection?.saveData === true) return { mode: 'svg', reason: 'save-data' };
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 4) {
    return { mode: 'svg', reason: 'low-memory' };
  }
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency < 4) {
    return { mode: 'svg', reason: 'low-cores' };
  }

  // 3. Viewport. A four-beat cinematic on a phone, over a cold-started container on
  //    conference wifi, is the highest-risk lowest-reward configuration available.
  if (window.innerWidth < minWidth) return { mode: 'svg', reason: 'viewport' };

  // 4. The actual context. `failIfMajorPerformanceCaveat` is precisely the
  //    GPU-blocklist / software-rasteriser signal -- without it, SwiftShader happily
  //    returns a context and then renders at single-digit frame rates.
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2', {
      failIfMajorPerformanceCaveat: true,
      powerPreference: 'low-power',
      antialias: false,
      depth: true,
      stencil: true,
    });
    if (!gl) return { mode: 'svg', reason: 'perf-caveat' };

    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    // Release before returning either way. Browsers cap live contexts around 16 and
    // evict the oldest; a probe that leaked would be the thing that later killed the
    // real one.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (maxTexture < 4096) return { mode: 'svg', reason: 'no-webgl2' };
  } catch {
    return { mode: 'svg', reason: 'no-webgl2' };
  } finally {
    canvas = null;
  }

  // 5. Motion does NOT deny the relief -- it changes what the relief does. A reader
  //    who asked for reduced motion still gets the map, just without the camera
  //    moving under them. A media query cannot reach inside a canvas, so unlike
  //    every other animation in this project the opt-out is honoured in JS.
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return { mode: 'gl', motion: reduce ? 'static' : 'cinematic' };
}
