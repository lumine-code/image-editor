/**
 * Canvas pooling module
 * Manages a pool of canvas elements for reuse to improve performance
 */

class CanvasPool {
  constructor(maxSize = 3) {
    this.pool = [];
    this.maxSize = maxSize;
  }

  /**
   * Get a canvas from the pool or create a new one
   * @param {number} width - Canvas width
   * @param {number} height - Canvas height
   * @returns {HTMLCanvasElement}
   */
  getCanvas(width, height) {
    // Try to find a suitable canvas in the pool
    const canvasIndex = this.pool.findIndex(
      (c) =>
        c.width >= width && c.height >= height && c.width < width * 1.5 && c.height < height * 1.5,
    );

    if (canvasIndex !== -1) {
      const canvas = this.pool.splice(canvasIndex, 1)[0];
      // Reassigning either dimension reinitialises the bitmap, so a recycled
      // canvas arrives blank without anything having to clear it.
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }

    // Create a new canvas if none suitable in pool
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    // Taken here, once, because a canvas keeps whatever attributes its first
    // context was created with: ask again later with different ones and they
    // are quietly ignored. Everything drawn into a pooled canvas is read back
    // out of it — through getImageData or toBlob — so they all want this, and
    // stating it at the single point of creation is what makes that reliable
    // rather than a matter of which call site happened to come first.
    canvas.getContext("2d", { willReadFrequently: true });
    return canvas;
  }

  /**
   * Return a canvas to the pool for reuse
   * @param {HTMLCanvasElement} canvas - Canvas to return
   */
  returnCanvas(canvas) {
    if (this.pool.length < this.maxSize) {
      this.pool.push(canvas);
    } else {
      // Release memory if pool is full
      canvas.width = canvas.height = 0;
    }
  }

  /**
   * Clear all canvases in the pool
   */
  clear() {
    this.pool.forEach((canvas) => (canvas.width = canvas.height = 0));
    this.pool = [];
  }

  /**
   * Get current pool size
   * @returns {number}
   */
  get size() {
    return this.pool.length;
  }
}

module.exports = CanvasPool;
