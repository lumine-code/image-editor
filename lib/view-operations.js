/**
 * Image operations module
 * Contains helper functions for applying image operations in the view
 */

const transforms = require("./transforms");

module.exports = {
  /**
   * Apply filter to image with selection support
   * @param {ImageEditorView} view - View instance
   * @param {string} filterType - Filter type (blur, sharpen)
   * @param {number} strength - Filter strength
   * @param {Function} filterFn - Filter function to apply
   */
  applyFilter(view, filterType, strength, filterFn) {
    if (!view.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    const area = view.getSelectionArea();
    if (!area) {
      lumine.notifications.addWarning("Invalid selection", {
        description: "Selection has no area.",
      });
      return;
    }

    view.ensureInitialHistorySaved();

    const { left, top, width, height, hasSelection } = area;
    const isLargeArea = width * height > 2000000;

    if (isLargeArea) {
      const filterName = filterType === "blur" ? "blur" : "sharpen";
      lumine.notifications.addInfo(`Processing ${filterName}...`, {
        description: "This may take a moment for large images.",
        dismissable: true,
      });
    }

    setTimeout(() => {
      const canvas = document.createElement("canvas");
      canvas.width = view.refs.image.naturalWidth;
      canvas.height = view.refs.image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(view.refs.image, 0, 0);

      const imageData = ctx.getImageData(left, top, width, height);
      filterFn(imageData, width, height, strength);
      ctx.putImageData(imageData, left, top);

      const areaText = hasSelection ? "selection" : "image";
      let message =
        filterType === "blur"
          ? `Blur level ${strength} applied to ${areaText}`
          : `Sharpen applied to ${areaText}`;

      view.updateImageFromCanvasWithoutHistory(canvas, message);
    }, 10);
  },

  /**
   * Apply color adjustment to image
   * @param {ImageEditorView} view - View instance
   * @param {string} adjustmentType - Adjustment type name
   * @param {Function} adjustmentFn - Adjustment function
   * @param {string} successMessage - Success message
   */
  applyColorAdjustment(view, adjustmentType, adjustmentFn, successMessage) {
    if (!view.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    const area = view.getSelectionArea();
    if (!area) {
      lumine.notifications.addWarning("Invalid selection");
      return;
    }

    view.ensureInitialHistorySaved();

    const canvas = document.createElement("canvas");
    canvas.width = view.refs.image.naturalWidth;
    canvas.height = view.refs.image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(view.refs.image, 0, 0);

    const imageData = ctx.getImageData(area.left, area.top, area.width, area.height);
    adjustmentFn(imageData);
    ctx.putImageData(imageData, area.left, area.top);

    const message = `${successMessage} ${area.hasSelection ? "selection" : "image"}`;
    view.updateImageFromCanvasWithoutHistory(canvas, message);
  },

  /**
   * Apply transform to entire image
   * @param {ImageEditorView} view - View instance
   * @param {string} transformType - Transform type (rotate, flip)
   * @param {Function} transformFn - Transform function
   * @param {string} successMessage - Success message
   * @param {boolean} maintainAspect - Whether transform maintains aspect ratio
   */
  applyTransform(view, transformType, transformFn, successMessage, maintainAspect = true) {
    if (!view.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    view.ensureInitialHistorySaved();
    view.showSpinner();

    const canvas = transformFn(transforms.imageToCanvas(view.refs.image));

    transforms.canvasToBlob(canvas).then((blob) => {
      const url = URL.createObjectURL(blob);
      view.refs.image.src = url;
      view.refs.image.onload = () => {
        view.refs.image.onload = null;
        view.originalHeight = view.refs.image.naturalHeight;
        view.originalWidth = view.refs.image.naturalWidth;

        if (view.auto) {
          view.zoomToFit();
        } else if (maintainAspect) {
          view.updateTransform();
        }

        view.refs.selectionBox.style.display = "none";
        view.emitter.emit("did-update");
        view.saveToHistory();
        view.hideSpinner();

        if (lumine.config.get("image-editor.showSuccessMessages")) {
          lumine.notifications.addSuccess(transformType, {
            description: `${successMessage}. Use "Save" to save changes.`,
          });
        }
      };
      view.refs.image.onerror = () => view.hideSpinner();
    });
  },

  /**
   * Calculate crop center for viewport adjustment
   * @param {object} area - Selection area
   * @param {number} translateX - Current X translation
   * @param {number} translateY - Current Y translation
   * @param {number} zoom - Current zoom level
   * @returns {{x: number, y: number}}
   */
  calculateCropCenter(area, translateX, translateY, zoom) {
    return {
      x: translateX + (area.left + area.width / 2) * zoom,
      y: translateY + (area.top + area.height / 2) * zoom,
    };
  },

  /**
   * Update viewport after crop
   * @param {ImageEditorView} view - View instance
   * @param {object} cropCenter - Center point before crop
   */
  updateViewportAfterCrop(view, cropCenter) {
    if (view.auto) {
      view.zoomToFit();
    } else {
      const newImageWidth = view.originalWidth * view.zoom;
      const newImageHeight = view.originalHeight * view.zoom;
      view.translateX = cropCenter.x - newImageWidth / 2;
      view.translateY = cropCenter.y - newImageHeight / 2;
      view.updateTransform();
    }
  },
};
