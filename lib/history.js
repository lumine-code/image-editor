/**
 * History management module
 * Contains undo/redo functionality and state management
 */

// How deep the history is allowed to go once frames are being compressed.
const COMPACT_HISTORY_SIZE = 10;

class HistoryManager {
  constructor(options = {}) {
    this.history = [];
    this.historyIndex = -1;
    this.maxHistorySize = options.maxHistorySize || 50;
    this.compactHistorySize = options.compactHistorySize || COMPACT_HISTORY_SIZE;
    this.largeImagePixels = options.largeImagePixels || 4e6;
    this.needsInitialSave = true;
    this.lastModifiedState = false;
    this.onModifiedStateChange = options.onModifiedStateChange || null;
  }

  // Reset history (called when loading a new image)
  reset() {
    this.history = [];
    this.historyIndex = -1;
    this.needsInitialSave = true;
    this.emitModifiedStateIfChanged();
  }

  // Ensure initial state is saved before first edit
  ensureInitialSaved(saveCallback) {
    if (this.needsInitialSave) {
      this.needsInitialSave = false;
      saveCallback();
    }
  }

  // Save state using a pooled canvas (for optimization)
  saveStateWithCanvas(canvas, viewState) {
    // Measured in pixels, which is what decides how big a frame will be. The
    // file's size on disk says only how well it happened to compress, and it
    // is not updated by an edit anyway, so a crop to a thumbnail went on
    // reporting the size of the original.
    const compact = canvas.width * canvas.height > this.largeImagePixels;
    const dataUrl = compact ? canvas.toDataURL("image/jpeg", 0.95) : canvas.toDataURL("image/png");

    // Store both image state and viewport state
    const historyEntry = {
      imageData: dataUrl,
      compact,
      translateX: viewState.translateX,
      translateY: viewState.translateY,
      zoom: viewState.zoom,
      auto: viewState.auto,
      imageWidth: canvas.width,
      imageHeight: canvas.height,
    };

    // If we're not at the end of history, remove forward history
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }

    this.history.push(historyEntry);
    this.historyIndex = this.history.length - 1;

    // A while loop, not an if: compact varies per entry, so a resize can drop
    // the cap from 50 to 10 in one step and leave more than one to trim.
    const maxSize = compact ? this.compactHistorySize : this.maxHistorySize;
    while (this.history.length > maxSize) {
      this.history.shift();
      this.historyIndex--;
    }

    this.emitModifiedStateIfChanged();
  }

  // Update current history entry with current view state
  updateCurrentState(viewState) {
    if (this.historyIndex < 0 || this.historyIndex >= this.history.length) return;

    const entry = this.history[this.historyIndex];
    entry.translateX = viewState.translateX;
    entry.translateY = viewState.translateY;
    entry.zoom = viewState.zoom;
    entry.auto = viewState.auto;
  }

  // Check if can undo
  canUndo() {
    return this.historyIndex > 0;
  }

  // Check if can redo
  canRedo() {
    return this.historyIndex < this.history.length - 1;
  }

  // Move to previous state (undo)
  undo() {
    if (!this.canUndo()) return null;
    this.historyIndex--;
    this.emitModifiedStateIfChanged();
    return this.getCurrentState();
  }

  // Move to next state (redo)
  redo() {
    if (!this.canRedo()) return null;
    this.historyIndex++;
    this.emitModifiedStateIfChanged();
    return this.getCurrentState();
  }

  // Get current history state
  getCurrentState() {
    if (this.historyIndex < 0 || this.historyIndex >= this.history.length) {
      return null;
    }
    return this.history[this.historyIndex];
  }

  // Get history position info
  getPosition() {
    return {
      current: this.historyIndex + 1,
      total: this.history.length,
    };
  }

  // Check if image has been modified
  isModified() {
    return this.history.length > 1 && this.historyIndex > 0;
  }

  // Emit modified state change if changed
  emitModifiedStateIfChanged() {
    const currentModified = this.isModified();
    if (this.lastModifiedState !== currentModified) {
      this.lastModifiedState = currentModified;
      if (this.onModifiedStateChange) {
        this.onModifiedStateChange(currentModified);
      }
    }
  }

  // Get history entry data URL
  getDataUrl(historyEntry) {
    return historyEntry.imageData;
  }

  // Get history length
  get length() {
    return this.history.length;
  }
}

module.exports = HistoryManager;
