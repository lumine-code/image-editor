/**
 * Undo history.
 *
 * A frame is kept as a Blob rather than a data URL. A data URL is base64, so
 * a third larger than the bytes it carries, and it is held as a JavaScript
 * string at two bytes a character — roughly 2.7 times the encoded size, on the
 * heap, re-parsed and re-decoded on every undo. A Blob is the encoded size
 * exactly, off the heap, and can be spilled to disk under pressure.
 *
 * Encoding is asynchronous, so a frame is reserved before it is filled in.
 * beginEntry fixes the entry's place in the history synchronously and hands
 * back an empty one; settleEntry fills it in whenever the encoder is done. A
 * slow encode therefore lands in its own slot and cannot arrive out of order
 * behind a later edit, which is why nothing here has to be awaited.
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
    this.disposed = false;
  }

  // Reset history (called when loading a new image)
  reset() {
    for (const entry of this.history) this.releaseEntry(entry);
    this.history = [];
    this.historyIndex = -1;
    this.needsInitialSave = true;
    this.emitModifiedStateIfChanged();
  }

  // Release everything and refuse to record any more.
  dispose() {
    this.reset();
    this.disposed = true;
  }

  // Ensure initial state is saved before first edit
  ensureInitialSaved(saveCallback) {
    if (this.needsInitialSave) {
      this.needsInitialSave = false;
      saveCallback();
    }
  }

  /**
   * Reserve a place in the history for pixels that are still encoding.
   *
   * Synchronous on purpose: the entry's position is settled before the caller
   * returns, so however long the encode takes it fills this slot and not a
   * later one. The caller reads `compact` to decide how to encode.
   *
   * @param {{translateX: number, translateY: number, zoom: number, auto: boolean}} viewState
   * @param {{width: number, height: number}} size in pixels of the frame
   * @returns {object|null} the entry to hand back to settleEntry
   */
  beginEntry(viewState, { width, height }) {
    if (this.disposed) return null;

    // Measured in pixels, which is what decides how big a frame will be. The
    // file's size on disk says only how well it happened to compress, and no
    // edit updates it, so a crop to a thumbnail went on reporting the original.
    const compact = width * height > this.largeImagePixels;

    const entry = {
      blob: null,
      url: null,
      released: false,
      settled: false,
      compact,
      translateX: viewState.translateX,
      translateY: viewState.translateY,
      zoom: viewState.zoom,
      auto: viewState.auto,
      imageWidth: width,
      imageHeight: height,
    };
    entry.ready = new Promise((resolve) => {
      entry._markReady = resolve;
    });

    // Anything ahead of the cursor is now unreachable.
    if (this.historyIndex < this.history.length - 1) {
      for (const stale of this.history.slice(this.historyIndex + 1)) this.releaseEntry(stale);
      this.history = this.history.slice(0, this.historyIndex + 1);
    }

    this.history.push(entry);
    this.historyIndex = this.history.length - 1;

    // A while loop, not an if: compact varies per entry, so a resize can drop
    // the cap from 50 to 10 in one step and leave more than one to trim.
    const maxSize = compact ? this.compactHistorySize : this.maxHistorySize;
    while (this.history.length > maxSize) {
      this.releaseEntry(this.history.shift());
      this.historyIndex--;
    }

    this.emitModifiedStateIfChanged();
    return entry;
  }

  /**
   * Attach the encoded pixels to a reserved entry.
   *
   * A null blob marks the frame unreadable rather than dropping it, so the
   * entries around it keep their positions under a cursor that may have moved.
   * An entry whose slot was evicted or reset away in the meantime takes
   * nothing: the blob is simply let go.
   */
  settleEntry(entry, blob) {
    if (!entry || entry.released) return;
    entry.blob = blob || null;
    entry.settled = true;
    entry._markReady();
  }

  /**
   * The object URL for an entry, minted at most once.
   *
   * Cached on the entry because loadFromHistory needs the same string twice
   * and two URLs over one blob would mean one of them leaking.
   *
   * @returns {Promise<string|null>} null if the frame never encoded
   */
  async urlFor(entry) {
    if (!entry) return null;
    if (!entry.settled && !entry.released) await entry.ready;
    if (entry.released || !entry.blob) return null;
    if (!entry.url) entry.url = URL.createObjectURL(entry.blob);
    return entry.url;
  }

  // Hand back an entry's URL and blob, and unblock anyone waiting on it.
  releaseEntry(entry) {
    if (!entry || entry.released) return;
    entry.released = true;
    if (entry.url) {
      URL.revokeObjectURL(entry.url);
      entry.url = null;
    }
    entry.blob = null;
    if (entry._markReady) entry._markReady();
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

  // Get history length
  get length() {
    return this.history.length;
  }
}

module.exports = HistoryManager;
