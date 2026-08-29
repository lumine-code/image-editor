/**
 * Filters expressed as canvas drawing operations rather than pixel loops.
 *
 * `ctx.filter` hands the work to the same rasteriser that draws everything
 * else, which for a blur is the difference between seconds and milliseconds.
 * What it does not do is match the old loop's edges: canvas filters treat
 * everything outside the source as transparent black, where the loop clamped
 * to the nearest edge pixel. So the source is copied into a padded scratch
 * with its boundary replicated outward, and the blur reads that.
 */

/** 3σ covers 99.7% of a Gaussian, past the support of any box approximation. */
const SUPPORT_SIGMAS = 3;

const filterSupport = new WeakMap();

/**
 * Whether this platform parses `ctx.filter`.
 *
 * Worth asking, because an unparsed value leaves the property at "none" and
 * the draw then succeeds unblurred — the user would be told the blur was
 * applied and see nothing happen.
 */
function supportsCanvasFilter(document) {
  if (!filterSupport.has(document)) {
    const probe = document.createElement("canvas").getContext("2d");
    probe.filter = "blur(2px)";
    filterSupport.set(document, probe.filter !== "none");
  }
  return filterSupport.get(document);
}

/** How far beyond a region a blur of this radius can still reach. */
function marginForSigma(sigma) {
  return Math.max(1, Math.ceil(SUPPORT_SIGMAS * sigma) + 2);
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Copy the neighbourhood a blur of `area` needs into a scratch canvas.
 *
 * The result is `area` grown by `margin` on every side: real pixels wherever
 * the source has them, and the boundary row or column stretched outward
 * wherever it does not. Stretching a one pixel strip with smoothing off
 * replicates it exactly, which is clamp-to-edge by another name.
 *
 * `bounds` limits what may be sampled. Without it the blur reads the whole
 * image, which is right for a whole-image blur; with it set to the selection,
 * a selection blurs from its own pixels the way the old loop did, rather than
 * dragging its surroundings in over its edges.
 *
 * A region whose window lies entirely within bounds needs only the first draw.
 *
 * @param {CanvasImageSource} source
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {{left: number, top: number, width: number, height: number}} area
 * @param {number} margin
 * @param {object} [bounds] rectangle the blur may sample, defaulting to the source
 * @returns {HTMLCanvasElement}
 */
function createBlurSource(source, sourceWidth, sourceHeight, area, margin, bounds) {
  const width = area.width + 2 * margin;
  const height = area.height + 2 * margin;
  const originX = area.left - margin;
  const originY = area.top - margin;

  // The part of the window the blur is allowed to read. Everything beyond it
  // is replicated rather than sampled, which is what keeps a selection's blur
  // made of its own pixels.
  const minX = bounds ? bounds.left : 0;
  const minY = bounds ? bounds.top : 0;
  const maxX = bounds ? bounds.left + bounds.width : sourceWidth;
  const maxY = bounds ? bounds.top + bounds.height : sourceHeight;

  const sx = clamp(originX, minX, maxX);
  const sy = clamp(originY, minY, maxY);
  const sw = clamp(originX + width, minX, maxX) - sx;
  const sh = clamp(originY + height, minY, maxY) - sy;

  // How much of the window falls outside it, on each side.
  const dx = sx - originX;
  const dy = sy - originY;
  const rx = width - (dx + sw);
  const ry = height - (dy + sh);

  const scratch = source.ownerDocument.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const ctx = scratch.getContext("2d");
  if (sw <= 0 || sh <= 0) return scratch;

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, sw, sh);

  if (dy > 0) ctx.drawImage(source, sx, sy, sw, 1, dx, 0, sw, dy);
  if (ry > 0) ctx.drawImage(source, sx, sy + sh - 1, sw, 1, dx, dy + sh, sw, ry);
  if (dx > 0) ctx.drawImage(source, sx, sy, 1, sh, 0, dy, dx, sh);
  if (rx > 0) ctx.drawImage(source, sx + sw - 1, sy, 1, sh, dx + sw, dy, rx, sh);

  if (dx > 0 && dy > 0) ctx.drawImage(source, sx, sy, 1, 1, 0, 0, dx, dy);
  if (rx > 0 && dy > 0) ctx.drawImage(source, sx + sw - 1, sy, 1, 1, dx + sw, 0, rx, dy);
  if (dx > 0 && ry > 0) ctx.drawImage(source, sx, sy + sh - 1, 1, 1, 0, dy + sh, dx, ry);
  if (rx > 0 && ry > 0) {
    ctx.drawImage(source, sx + sw - 1, sy + sh - 1, 1, 1, dx + sw, dy + sh, rx, ry);
  }

  return scratch;
}

/**
 * Blur a region of `ctx` in place, sampling from beyond it.
 *
 * The whole scratch canvas is the filter's source. Passing a sub-rectangle of
 * it instead would make that crop the source, and the region's own edge would
 * fade to transparent again — which is the exact bug the scratch exists to
 * avoid, so do not "simplify" it that way.
 *
 * @param {CanvasRenderingContext2D} ctx holding the image at 1:1
 * @param {{left: number, top: number, width: number, height: number}} area
 * @param {number} sigma standard deviation, in pixels
 * @param {object} [options]
 * @param {boolean} [options.sampleWithinArea=false] keep the blur made of the
 *   region's own pixels, which is what a selection wants; the whole-image case
 *   samples the whole image and only replicates past its borders.
 * @returns {boolean} false if the platform would not apply the filter
 */
function blurRegion(ctx, area, sigma, { sampleWithinArea = false } = {}) {
  if (!supportsCanvasFilter(ctx.canvas.ownerDocument)) return false;
  if (sigma <= 0 || area.width <= 0 || area.height <= 0) return true;

  const margin = marginForSigma(sigma);
  const scratch = createBlurSource(
    ctx.canvas,
    ctx.canvas.width,
    ctx.canvas.height,
    area,
    margin,
    sampleWithinArea ? area : null,
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.left, area.top, area.width, area.height);
  ctx.clip();
  // Cleared first so the blurred copy replaces the region rather than
  // compositing over it, which is what putImageData used to do.
  ctx.clearRect(area.left, area.top, area.width, area.height);
  ctx.filter = `blur(${sigma}px)`;
  ctx.drawImage(scratch, area.left - margin, area.top - margin);
  ctx.filter = "none";
  ctx.restore();

  scratch.width = scratch.height = 0;
  return true;
}

module.exports = { supportsCanvasFilter, marginForSigma, createBlurSource, blurRegion };
