/**
 * Shared helpers for the Node-only unit tests.
 */

/**
 * Wrap raw bytes as the duck type every filters.js function accepts.
 *
 * None of them reads `width` or `height` off the object — dimensions always
 * arrive as explicit arguments — so a real ImageData is never needed.
 *
 * @param {number[]|Uint8ClampedArray} bytes RGBA, four per pixel
 */
function img(bytes) {
  return { data: Uint8ClampedArray.from(bytes) };
}

/**
 * A seeded generator, so a failure reproduces instead of appearing once in CI.
 *
 * @param {number} seed
 * @returns {() => number} successive values in [0, 256)
 */
function seededBytes(seed = 1) {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG; only the high bits are used, the low ones are poor.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
}

/**
 * Fill an RGBA buffer of `width * height` pixels with reproducible noise.
 */
function noise(width, height, seed = 1) {
  const next = seededBytes(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = next();
  return { data };
}

/**
 * Store `value` the way the filters do, so the comparison sees the same
 * half-to-even rounding a Uint8ClampedArray applies on assignment.
 */
function clamped(value) {
  const one = new Uint8ClampedArray(1);
  one[0] = value;
  return one[0];
}

/**
 * Report the largest per-byte difference between two buffers.
 */
function maxAbsDiff(a, b) {
  if (a.length !== b.length) throw new Error(`length ${a.length} vs ${b.length}`);
  let worst = 0;
  let at = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  return { worst, at };
}

module.exports = { img, seededBytes, noise, clamped, maxAbsDiff };
