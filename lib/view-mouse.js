/**
 * Mouse event handling module
 * Manages mouse interactions for panning, selecting, moving, and resizing
 */

const selection = require("./selection");

class MouseEventHandler {
  constructor(view) {
    this.view = view;
    this.panning = false;
    this.panMoved = false;
    this.panDistance = 0;
    this.suppressNextContextMenu = false;
    this.contextMenuSuppressTimeout = null;
    this.selecting = false;
    this.selectDistance = 0;
    this.selectStarted = false;
    this.moving = false;
    this.moveStarted = false;
    this.moveDistance = 0;
    this.resizing = false;
    this.resizeHandle = null;
    this.moveStartMouse = { x: 0, y: 0 };
    this.moveStartSelection = { x1: 0, y1: 0, x2: 0, y2: 0 };
    this.clickInsideSelectionAtGestureStart = false;
  }

  /**
   * Handle double click event.
   * Double-click inside a selection zooms to that selection, double-click
   * anywhere else zooms to fit the whole image.
   * @param {MouseEvent} event
   */
  handleDoubleClick(event) {
    if (event.button !== 0) return;
    if (this.clickInsideSelectionAtGestureStart) {
      this.view.zoomToSelection();
    } else {
      this.view.zoomToFit({ smooth: true });
    }
  }

  /**
   * Handle mouse move event
   * @param {MouseEvent} event
   */
  handleMouseMove(event) {
    if (this.panning) {
      this.handlePanning(event);
    } else if (this.moving) {
      this.handleMoving(event);
    } else if (this.resizing) {
      this.handleResizing(event);
    } else if (this.selecting) {
      this.handleSelecting(event);
    }

    // Update mouse position display
    if (this.view.loaded && this.view.refs.image) {
      this.updateMousePosition(event);
    }
  }

  /**
   * Handle panning movement
   * @param {MouseEvent} event
   */
  handlePanning(event) {
    this.panDistance += Math.abs(event.movementX) + Math.abs(event.movementY);
    if (!this.panMoved && this.panDistance > 5) {
      this.panMoved = true;
      this.view.disableAutoZoom();
      this.view.refs.imageContainer.classList.add("grabbing");
      this.view.refs.imageContainer.style.cursor = "grab";
    }
    if (!this.panMoved) return;
    this.view.translateX += event.movementX;
    this.view.translateY += event.movementY;
    // updateTransform batches both transform and selection box updates in RAF
    this.view.updateTransform();
  }

  /**
   * Handle selection movement
   * @param {MouseEvent} event
   */
  handleMoving(event) {
    this.moveDistance += Math.abs(event.movementX) + Math.abs(event.movementY);
    if (!this.moveStarted && this.moveDistance > 3) {
      this.moveStarted = true;
    }
    if (!this.moveStarted) return;
    const rect = this.view.refs.imageContainer.getBoundingClientRect();
    const imgCoords = selection.viewportToImage(
      event.clientX - rect.left,
      event.clientY - rect.top,
      this.view.translateX,
      this.view.translateY,
      this.view.zoom,
    );
    const deltaX = imgCoords.x - this.moveStartMouse.x;
    const deltaY = imgCoords.y - this.moveStartMouse.y;
    this.view.selectionStartImg.x = this.moveStartSelection.x1 + deltaX;
    this.view.selectionStartImg.y = this.moveStartSelection.y1 + deltaY;
    this.view.selectionEndImg.x = this.moveStartSelection.x2 + deltaX;
    this.view.selectionEndImg.y = this.moveStartSelection.y2 + deltaY;
    this.view.updateSelectionBox();
  }

  /**
   * Handle selection resizing
   * @param {MouseEvent} event
   */
  handleResizing(event) {
    const rect = this.view.refs.imageContainer.getBoundingClientRect();
    const imgCoords = selection.viewportToImage(
      event.clientX - rect.left,
      event.clientY - rect.top,
      this.view.translateX,
      this.view.translateY,
      this.view.zoom,
    );
    const handle = this.resizeHandle;
    if (handle.includes("n")) this.view.selectionStartImg.y = imgCoords.y;
    if (handle.includes("s")) this.view.selectionEndImg.y = imgCoords.y;
    if (handle.includes("w")) this.view.selectionStartImg.x = imgCoords.x;
    if (handle.includes("e")) this.view.selectionEndImg.x = imgCoords.x;
    this.view.updateSelectionBox();
  }

  /**
   * Handle selection creation
   * @param {MouseEvent} event
   */
  handleSelecting(event) {
    this.selectDistance += Math.abs(event.movementX) + Math.abs(event.movementY);
    if (!this.selectStarted && this.selectDistance > 3) {
      this.selectStarted = true;
      this.view.setSelectionVisibility(true);
    }
    if (!this.selectStarted) return;
    const rect = this.view.refs.imageContainer.getBoundingClientRect();
    this.view.selectionEndImg = selection.viewportToImage(
      event.clientX - rect.left,
      event.clientY - rect.top,
      this.view.translateX,
      this.view.translateY,
      this.view.zoom,
    );
    this.view.updateSelectionBox();
  }

  /**
   * Update mouse position display
   * @param {MouseEvent} event
   */
  updateMousePosition(event) {
    const rect = this.view.refs.imageContainer.getBoundingClientRect();
    const imgCoords = selection.viewportToImage(
      event.clientX - rect.left,
      event.clientY - rect.top,
      this.view.translateX,
      this.view.translateY,
      this.view.zoom,
    );
    const imgX = Math.round(imgCoords.x);
    const imgY = Math.round(imgCoords.y);
    if (
      imgX >= 0 &&
      imgX < this.view.refs.image.naturalWidth &&
      imgY >= 0 &&
      imgY < this.view.refs.image.naturalHeight
    ) {
      this.view.emitter.emit("mouse-position", { imgX, imgY });
    } else {
      this.view.emitter.emit("mouse-position", { imgX: null, imgY: null });
    }
  }

  /**
   * Handle mouse down event
   * @param {MouseEvent} event
   */
  handleMouseDown(event) {
    if (event.button === 2) {
      this.startPanning();
    } else if (event.button === 0) {
      if (event.target.classList.contains("selection-handle")) return;

      const hasSelection = this.view.refs.selectionBox.style.display === "block";

      // Remember whether the start of a (potential) double-click gesture
      // landed inside a selection, so handleDoubleClick can choose between
      // zoom-to-selection and automatic-zoom.
      if (event.detail <= 1) {
        this.clickInsideSelectionAtGestureStart =
          hasSelection && this.isClickInsideSelection(event);
      }

      if (hasSelection && this.isClickInsideSelection(event)) {
        this.startMoving(event);
        return;
      }

      if (hasSelection) {
        this.view.setSelectionVisibility(false);
      }

      this.startSelecting(event);
    }
  }

  /**
   * Check if click is inside selection
   * @param {MouseEvent} event
   * @returns {boolean}
   */
  isClickInsideSelection(event) {
    const rect = this.view.refs.imageContainer.getBoundingClientRect();
    const imgCoords = selection.viewportToImage(
      event.clientX - rect.left,
      event.clientY - rect.top,
      this.view.translateX,
      this.view.translateY,
      this.view.zoom,
    );
    const minX = Math.min(this.view.selectionStartImg.x, this.view.selectionEndImg.x);
    const maxX = Math.max(this.view.selectionStartImg.x, this.view.selectionEndImg.x);
    const minY = Math.min(this.view.selectionStartImg.y, this.view.selectionEndImg.y);
    const maxY = Math.max(this.view.selectionStartImg.y, this.view.selectionEndImg.y);

    return imgCoords.x >= minX && imgCoords.x <= maxX && imgCoords.y >= minY && imgCoords.y <= maxY;
  }

  /**
   * Start panning
   */
  startPanning() {
    this.panning = true;
    this.panMoved = false;
    this.panDistance = 0;
  }

  /**
   * Start moving selection
   * @param {MouseEvent} event
   */
  startMoving(event) {
    const rect = this.view.refs.imageContainer.getBoundingClientRect();
    const imgCoords = selection.viewportToImage(
      event.clientX - rect.left,
      event.clientY - rect.top,
      this.view.translateX,
      this.view.translateY,
      this.view.zoom,
    );
    this.moving = true;
    this.moveStarted = false;
    this.moveDistance = 0;
    this.moveStartMouse = { x: imgCoords.x, y: imgCoords.y };
    this.moveStartSelection = {
      x1: this.view.selectionStartImg.x,
      y1: this.view.selectionStartImg.y,
      x2: this.view.selectionEndImg.x,
      y2: this.view.selectionEndImg.y,
    };
  }

  /**
   * Start selecting
   * @param {MouseEvent} event
   */
  startSelecting(event) {
    if (this.view.readOnly) return;
    const rect = this.view.refs.imageContainer.getBoundingClientRect();
    this.selecting = true;
    this.selectDistance = 0;
    this.selectStarted = false;
    this.view.selectionStartImg = selection.viewportToImage(
      event.clientX - rect.left,
      event.clientY - rect.top,
      this.view.translateX,
      this.view.translateY,
      this.view.zoom,
    );
    this.view.selectionEndImg = { ...this.view.selectionStartImg };
  }

  /**
   * Start resizing
   * @param {string} handle - Resize handle (nw, ne, se, sw, n, e, s, w)
   */
  startResizing(handle) {
    this.resizing = true;
    this.resizeHandle = handle;
  }

  /**
   * Handle mouse up event
   */
  handleMouseUp() {
    if (this.panning) {
      this.stopPanning();
    } else if (this.moving) {
      this.stopMoving();
    } else if (this.resizing) {
      this.stopResizing();
    } else if (this.selecting) {
      this.stopSelecting();
    }
  }

  /**
   * Stop panning
   */
  stopPanning() {
    this.panning = false;
    if (this.panMoved) {
      this.view.refs.imageContainer.classList.remove("grabbing");
      this.view.refs.imageContainer.style.cursor = "default";
      this.suppressUpcomingContextMenu();
    }
  }

  /**
   * Stop moving
   */
  stopMoving() {
    this.moving = false;
    this.view._normalizeSelection();
  }

  /**
   * Stop resizing
   */
  stopResizing() {
    this.resizing = false;
    this.resizeHandle = null;
    this.view._normalizeSelection();
    this.view._checkSelectionSize();
  }

  /**
   * Stop selecting
   */
  stopSelecting() {
    this.selecting = false;
    if (this.selectStarted) {
      this.view._checkSelectionSize();
    }
  }

  /**
   * Handle context menu event
   * @param {MouseEvent} event
   */
  handleContextMenu(event) {
    if ((this.panning && this.panMoved) || this.suppressNextContextMenu) {
      event.preventDefault();
      event.stopPropagation();
      this.clearContextMenuSuppression();
    }
  }

  /**
   * Suppress the context menu produced by finishing a right-click drag.
   */
  suppressUpcomingContextMenu() {
    this.suppressNextContextMenu = true;
    if (this.contextMenuSuppressTimeout) {
      clearTimeout(this.contextMenuSuppressTimeout);
    }
    this.contextMenuSuppressTimeout = setTimeout(() => {
      this.suppressNextContextMenu = false;
      this.contextMenuSuppressTimeout = null;
    }, 1000);
  }

  /**
   * Clear pending context menu suppression.
   */
  clearContextMenuSuppression() {
    this.suppressNextContextMenu = false;
    if (this.contextMenuSuppressTimeout) {
      clearTimeout(this.contextMenuSuppressTimeout);
      this.contextMenuSuppressTimeout = null;
    }
  }

  /**
   * Reset all mouse states
   */
  reset() {
    this.panning = false;
    this.panMoved = false;
    this.panDistance = 0;
    this.clearContextMenuSuppression();
    this.selecting = false;
    this.selectDistance = 0;
    this.selectStarted = false;
    this.moving = false;
    this.moveStarted = false;
    this.moveDistance = 0;
    this.resizing = false;
    this.resizeHandle = null;
  }
}

module.exports = MouseEventHandler;
