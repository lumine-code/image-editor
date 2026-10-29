/**
 * Zoom controller module
 * Manages zoom state and operations for image viewing
 */

const ZOOM_EPSILON = 1e-8;

class ZoomController {
  static ZOOM_LEVELS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);

  constructor(options = {}) {
    this.zoom = 1.0;
    this.translateX = 0;
    this.translateY = 0;
    this.originX = 0;
    this.originY = 0;
    this.auto = true;
    this.levels = options.levels || ZoomController.ZOOM_LEVELS;
    this.minZoom = options.minZoom || 0.001;
    this.maxZoom = options.maxZoom || 100;
  }

  /**
   * Get current zoom level
   * @returns {number}
   */
  getZoom() {
    return this.zoom;
  }

  /**
   * Set zoom level with constraints
   * @param {number} zoom - New zoom level
   */
  setZoom(zoom) {
    this.zoom = Math.min(Math.max(zoom, this.minZoom), this.maxZoom);
  }

  /**
   * Get current translation
   * @returns {{x: number, y: number}}
   */
  getTranslation() {
    return { x: this.translateX, y: this.translateY };
  }

  /**
   * Set translation
   * @param {number} x - X translation
   * @param {number} y - Y translation
   */
  setTranslation(x, y) {
    this.translateX = x;
    this.translateY = y;
  }

  /**
   * Get next higher zoom level
   * @returns {number|null}
   */
  getNextZoomLevel() {
    for (let i = 0; i < this.levels.length; i++) {
      if (this.levels[i] > this.zoom + ZOOM_EPSILON) {
        return this.levels[i];
      }
    }
    return null;
  }

  /**
   * Get next lower zoom level
   * @returns {number|null}
   */
  getPreviousZoomLevel() {
    for (let i = this.levels.length - 1; i >= 0; i--) {
      if (this.levels[i] < this.zoom - ZOOM_EPSILON) {
        return this.levels[i];
      }
    }
    return null;
  }

  /**
   * Calculate zoom to fit dimensions
   * @param {number} imageWidth - Image width
   * @param {number} imageHeight - Image height
   * @param {number} containerWidth - Container width
   * @param {number} containerHeight - Container height
   * @param {number} [limit] - Optional zoom limit
   * @returns {number}
   */
  calculateZoomToFit(imageWidth, imageHeight, containerWidth, containerHeight, limit = null) {
    let zoom = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
    if (limit) {
      zoom = Math.min(zoom, limit);
    }
    return zoom;
  }

  /**
   * Calculate centered translation
   * @param {number} imageWidth - Image width
   * @param {number} imageHeight - Image height
   * @param {number} containerWidth - Container width
   * @param {number} containerHeight - Container height
   * @param {number} zoom - Zoom level
   * @returns {{x: number, y: number}}
   */
  calculateCenteredTranslation(imageWidth, imageHeight, containerWidth, containerHeight, zoom) {
    const scaledWidth = imageWidth * zoom;
    const scaledHeight = imageHeight * zoom;
    return {
      x: (containerWidth - scaledWidth) / 2,
      y: (containerHeight - scaledHeight) / 2,
    };
  }

  /**
   * Calculate zoom around a point
   * @param {number} newZoom - New zoom level
   * @param {number} pointX - Point X in container coordinates
   * @param {number} pointY - Point Y in container coordinates
   * @returns {{zoom: number, translateX: number, translateY: number}}
   */
  calculateZoomToPoint(newZoom, pointX, pointY) {
    const imageX = (pointX - this.translateX) / this.zoom;
    const imageY = (pointY - this.translateY) / this.zoom;

    const constrainedZoom = Math.min(Math.max(newZoom, this.minZoom), this.maxZoom);

    return {
      zoom: constrainedZoom,
      translateX: pointX - imageX * constrainedZoom,
      translateY: pointY - imageY * constrainedZoom,
    };
  }

  /**
   * Disable auto zoom mode
   */
  disableAuto() {
    this.auto = false;
  }

  /**
   * Enable auto zoom mode
   * @param {boolean|number} mode - Auto zoom mode (true for fit, 1 for 100%)
   */
  enableAuto(mode) {
    this.auto = mode;
  }

  /**
   * Check if auto zoom is enabled
   * @returns {boolean|number}
   */
  isAuto() {
    return this.auto;
  }

  /**
   * Reset zoom state
   */
  reset() {
    this.zoom = 1.0;
    this.translateX = 0;
    this.translateY = 0;
    this.auto = false;
  }

  /**
   * Get zoom percentage string
   * @returns {string}
   */
  getZoomPercentage() {
    return Math.round(this.zoom * 100) + "%";
  }
}

module.exports = ZoomController;
