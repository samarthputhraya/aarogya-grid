/**
 * Can this machine actually run the field?
 *
 * WHY THIS IS A PROBE AND NOT A FEATURE FLAG
 * ------------------------------------------
 * The WebGL renderer is an enhancement layered over a server-rendered SVG map, and the
 * decision to swap has to be made on the visitor's machine rather than ours. The cases
 * this exists for are all real and none of them announce themselves:
 *
 *   - a conference projector driven by an old laptop with a blocklisted GPU
 *   - a corporate SOE with hardware acceleration disabled by policy
 *   - a headless or virtualised environment (some assessors screenshot in one)
 *   - Chrome having quietly dropped the GPU process after an earlier crash
 *
 * In every one of those `getContext('webgl2')` returns null rather than throwing, so the
 * only honest test is to ask for the context and see what comes back.
 *
 * The context is created on a detached canvas and explicitly released. Browsers cap the
 * number of live WebGL contexts (16 or so on most desktop Chrome builds) and evict the
 * oldest when the cap is hit -- so a probe that leaked would, on a page that later opens
 * a real context, be the thing that killed it.
 */

export interface FieldCapability {
  /** WebGL2 context creation succeeded. */
  webgl2: boolean;
  /**
   * The reader has asked for reduced motion. Carried alongside the capability rather
   * than checked separately because both decisions are made at the same moment and a
   * component that has one without the other will get the first frame wrong.
   *
   * A media query cannot reach inside a canvas, so unlike every other animation in this
   * project the opt-out has to be honoured in JavaScript.
   */
  reducedMotion: boolean;
}

/** Assume the worst until proven otherwise -- used for the server render. */
export const NO_CAPABILITY: FieldCapability = {
  webgl2: false,
  reducedMotion: false,
};

export function probeCapability(): FieldCapability {
  // Guard for the server render and for any test environment without a DOM.
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return NO_CAPABILITY;
  }

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let webgl2 = false;
  let canvas: HTMLCanvasElement | null = null;

  try {
    canvas = document.createElement('canvas');
    // 1x1: we are asking "does a context exist", not allocating a drawing surface.
    canvas.width = 1;
    canvas.height = 1;

    const gl = canvas.getContext('webgl2', {
      // Match what deck.gl will ask for. A machine that can give us a bare context but
      // not a stencil buffer would pass a laxer probe and then fail at first draw --
      // which is the one outcome worse than never enhancing at all.
      failIfMajorPerformanceCaveat: true,
      antialias: false,
      depth: true,
      stencil: true,
    });

    if (gl) {
      webgl2 = true;
      // Release immediately. See the context-cap note above.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // Some environments throw rather than returning null. Same answer either way.
    webgl2 = false;
  } finally {
    canvas = null;
  }

  return { webgl2, reducedMotion };
}
