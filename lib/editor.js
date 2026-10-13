const path = require("path");
const fs = require("fs");
const { Emitter, CompositeDisposable } = require("lumine");
const ImageEditorView = require("./view");
const paths = require("./paths");

class ImageEditor {
  static deserialize({ filePath, viewState, documentId }) {
    if (documentId) {
      const document = require("./document").restore(documentId, filePath);
      if (!document) return;
      const editor = new ImageEditor(null, document);
      editor.copyViewState = viewState;
      return editor;
    }
    let fileStats;
    try {
      fileStats = fs.statSync(filePath);
    } catch {
      // Missing file: fall through to the warning below.
    }
    if (fileStats?.isFile()) {
      const editor = new ImageEditor(filePath);
      editor.copyViewState = viewState;
      return editor;
    } else {
      console.warn(
        `Could not deserialize image editor for path '${filePath}' because that file no longer exists`,
      );
    }
  }

  /**
   * Create an ImageEditor from a data URL (no file on disk).
   * @param {string} dataUrl - The image data URL (e.g., "data:image/png;base64,...")
   * @param {string} [title="Untitled Image"] - The title for the editor tab
   * @returns {ImageEditor} A new ImageEditor instance
   */
  static fromDataUrl(dataUrl, title = "Untitled Image") {
    const editor = new ImageEditor(null);
    editor._dataUrl = dataUrl;
    editor._title = title;
    editor._isTemporary = true;
    return editor;
  }

  constructor(filePath, document = null) {
    this.subscriptions = new CompositeDisposable();
    this.emitter = new Emitter();
    this.destroyed = false;
    this.documentGeneration = 0;
    this.attachDocument(document || require("./document").acquire(filePath));
  }

  attachDocument(document) {
    const previous = this.document;
    document.retain();
    this.documentSubscriptions?.dispose();
    this.document = document;
    this.documentGeneration++;
    this.documentSubscriptions = new CompositeDisposable();
    for (const event of [
      "did-change",
      "did-change-path",
      "did-change-uri",
      "did-change-title",
      "did-change-file-state",
      "did-change-pixels",
      "did-change-history",
    ]) {
      this.documentSubscriptions.add(
        document.emitter.on(event, (value) => {
          if (event === "did-change-file-state" && value !== "unmodified")
            this.terminatePendingState();
          if (event === "did-change-path" && this.editorView?.shownFile)
            this.editorView.shownFile.path = value;
          this.emitter.emit(event, value);
        }),
      );
    }
    previous?.release();
  }

  getPaneItemRevision() {
    return this.documentGeneration;
  }
  setPath(filePath) {
    this.document.setPath(filePath);
  }
  onDidChangePath(callback) {
    return this.emitter.on("did-change-path", callback);
  }
  onDidChangeURI(callback) {
    return this.emitter.on("did-change-uri", callback);
  }
  onDidChangePixels(callback) {
    return this.emitter.on("did-change-pixels", callback);
  }
  onDidChangeHistory(callback) {
    return this.emitter.on("did-change-history", callback);
  }

  copy({ signal } = {}) {
    signal?.throwIfAborted();
    if (this.destroyed) throw new Error("Cannot copy a destroyed image editor");
    const entry = this.document.historyManager.getCurrentState();
    if (entry && !entry.settled && !entry.released) {
      return waitForCopy(entry.ready, signal).then(() => this.copy({ signal }));
    }
    const copy = new ImageEditor(null, this.document);
    copy.copyViewState = this.editorView?.capturePaneViewState();
    return copy;
  }

  get element() {
    return (this.view && this.view.element) || document.createElement("div");
  }

  get view() {
    if (!this.editorView) {
      try {
        this.editorView = new ImageEditorView(this);
      } catch {
        console.warn(
          `Could not create ImageEditorView. This can be intentional in the event of an image file being deleted by an external program.`,
        );
        return undefined;
      }
    }
    return this.editorView;
  }

  getPaneItemDocument() {
    return this.document;
  }

  serialize() {
    return {
      documentId: this.document.id,
      filePath: this.getPath(),
      deserializer: this.constructor.name,
      viewState: this.editorView?.capturePaneViewState(),
    };
  }

  terminatePendingState() {
    if (lumine.workspace.paneForItem(this)?.getPendingItem() === this) {
      this.emitter.emit("did-terminate-pending-state");
    }
  }

  onDidTerminatePendingState(callback) {
    return this.emitter.on("did-terminate-pending-state", callback);
  }

  // Register a callback for when the image file changes
  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  // Register a callback for when the image's title changes
  onDidChangeTitle(callback) {
    return this.emitter.on("did-change-title", callback);
  }

  onDidChangeFileState(callback) {
    return this.emitter.on("did-change-file-state", callback);
  }

  onDidReplaceFile(callback) {
    return this.emitter.on("did-replace-file", callback);
  }

  getFileState() {
    return this.fileState;
  }

  shouldPromptToSave({ lastView = true } = {}) {
    return (
      lastView &&
      this.fileState !== "unmodified" &&
      lumine.config.get("core.promptOnCloseDirtyBuffer")
    );
  }

  setFileState(state) {
    return this.document.setFileState(state);
  }
  noteExternalChange() {
    this.document.noteExternalChange();
  }
  confirmExternalChange() {
    this.document.confirmExternalChange();
  }
  didChangeHistoryModified(modified) {
    this.document.didChangeHistoryModified(modified);
  }
  didReloadFromDisk() {
    this.document.didReloadFromDisk();
  }
  didObserveUnchangedFile() {
    this.document.didObserveUnchangedFile();
  }
  didSave() {
    this.document.didSave();
  }
  reconcileFile(force) {
    this.document.reconcileFile(force);
  }
  diskFingerprint() {
    return this.document.diskFingerprint();
  }

  load(filePath, updateDocument) {
    const oldURI = this.getURI();
    if (filePath !== oldURI) this.attachDocument(require("./document").acquire(filePath));
    updateDocument?.();
    this.emitter.emit("did-replace-file");
    if (oldURI !== this.getURI()) {
      this.emitter.emit("did-change-path", filePath);
      this.emitter.emit("did-change-uri", { oldURI, newURI: this.getURI() });
    }
    this.emitter.emit("did-change-title");
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.subscriptions.dispose();
    this.documentSubscriptions.dispose();
    this.editorView?.destroy();
    this.document.release();
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }

  getAllowedLocations() {
    return ["center"];
  }

  // Retrieves the filename of the open file.
  //
  // This is `'untitled'` if the file is new and not saved to the disk.
  //
  // Returns a {String}.
  getTitle() {
    if (this._title) {
      return this._title;
    }
    const filePath = this.getPath();
    if (filePath) {
      return path.basename(filePath);
    } else {
      return "untitled";
    }
  }

  // Returns true if this is a temporary editor (from data URL, not file).
  isTemporary() {
    return this._isTemporary;
  }

  // Returns the data URL if this is a temporary editor.
  getDataUrl() {
    return this._dataUrl;
  }

  // Retrieves the absolute path to the image.
  //
  // Returns a {String} path or null for temporary editors.
  getPath() {
    return this.file ? this.file.path : null;
  }

  // Retrieves the URI of the image.
  //
  // Returns a {String}.
  getURI() {
    return this.getPath();
  }

  // Retrieves the encoded URI of the image.
  //
  // Returns a {String}.
  getEncodedURI() {
    if (this._dataUrl) {
      return this._dataUrl;
    }
    const filePath = this.getPath();
    if (!filePath) return null;
    return paths.encodeFileURL(filePath);
  }

  // Compares two {ImageEditor}s to determine equality.
  //
  // Equality is based on the condition that the two URIs are the same.
  //
  // Returns a {Boolean}.
  isEqual(other) {
    return other instanceof ImageEditor && this.getURI() === other.getURI();
  }

  // Essential: Invoke the given callback when the editor is destroyed.
  //
  // * `callback` {Function} to be called when the editor is destroyed.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  // Save the current image to its file path.
  // This method enables the core:save command.
  async save() {
    if (this.view) {
      return this.view.save();
    }
  }

  // Save the current image to a new file path.
  // This method enables the core:save-as command.
  async saveAs() {
    if (this.view) {
      return this.view.saveImage();
    }
  }
}

for (const property of [
  "file",
  "fileSubscriptions",
  "fileState",
  "fileOperationDepth",
  "externalChangePending",
  "observedDiskFingerprint",
  "_isTemporary",
  "_dataUrl",
  "_title",
]) {
  Object.defineProperty(ImageEditor.prototype, property, {
    get() {
      return this.document[property];
    },
    set(value) {
      this.document[property] = value;
    },
  });
}

function waitForCopy(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

module.exports = ImageEditor;
