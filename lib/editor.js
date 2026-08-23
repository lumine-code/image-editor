const path = require("path");
const fs = require("fs");
const { Emitter, CompositeDisposable, Disposable, watchFile } = require("lumine");
const ImageEditorView = require("./view");
const paths = require("./paths");

module.exports = class ImageEditor {
  static deserialize({ filePath }, treeView) {
    let fileStats;
    try {
      fileStats = fs.statSync(filePath);
    } catch {
      // Missing file: fall through to the warning below.
    }
    if (fileStats?.isFile()) {
      return new ImageEditor(filePath, treeView);
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
    const editor = new ImageEditor(null, null);
    editor._dataUrl = dataUrl;
    editor._title = title;
    editor._isTemporary = true;
    return editor;
  }

  constructor(filePath, treeView) {
    this.subscriptions = new CompositeDisposable();
    this.fileSubscriptions = new CompositeDisposable();
    this.emitter = new Emitter();
    this._isTemporary = false;
    this._dataUrl = null;
    this._title = null;

    if (filePath) {
      this.file = watchFile(filePath);
      this.treeView = treeView;
      this.handleFileEvents();
    } else {
      this.file = null;
      this.treeView = null;
    }
  }

  handleFileEvents() {
    // `watchFile` owns a native watcher that must be disposed explicitly —
    // the event subscriptions alone do not stop it.
    const file = this.file;
    this.fileSubscriptions.add(new Disposable(() => file.dispose()));
    this.fileSubscriptions.add(
      this.file.onDidDelete(() => {
        const currentPath = this.getPath();
        const pane = lumine.workspace.paneForURI(currentPath);
        try {
          pane.destroyItem(pane.itemForURI(currentPath));
        } catch (e) {
          console.warn(`Could not destroy pane after external file was deleted: ${e}`);
        }
        this.destroy();
      }),
    );

    this.fileSubscriptions.add(
      this.file.onDidRename(() => {
        this.emitter.emit("did-change-title");
      }),
    );

    this.fileSubscriptions.add(
      this.file.onDidChange(() => {
        this.emitter.emit("did-change");
      }),
    );
  }

  copy() {
    return new ImageEditor(this.getPath(), this.treeView);
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

  serialize() {
    // Don't serialize temporary editors (they can't be restored)
    if (this._isTemporary) {
      return null;
    }
    return { filePath: this.getPath(), deserializer: this.constructor.name };
  }

  terminatePendingState() {
    if (this.isEqual(lumine.workspace.getCenter().getActivePane().getPendingItem())) {
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

  // Register a callback for when the modification state changes
  onDidChangeModified(callback) {
    return this.emitter.on("did-change-modified", callback);
  }

  onDidReplaceFile(callback) {
    return this.emitter.on("did-replace-file", callback);
  }

  // Returns true if the image has been modified (history has edits)
  isModified() {
    // Temporary editors are always "modified" until saved
    if (this._isTemporary) {
      return true;
    }
    return this.view ? this.view.isModified() : false;
  }

  load(filePath) {
    // A CompositeDisposable stays disposed once disposed, so replace it with a
    // fresh instance for the new watch (disposing also stops the old watcher).
    this.fileSubscriptions.dispose();
    this.fileSubscriptions = new CompositeDisposable();
    this.file = watchFile(filePath);
    this.handleFileEvents();
    this.emitter.emit("did-replace-file");
    this.emitter.emit("did-change-title");
  }

  destroy() {
    this.subscriptions.dispose();
    this.fileSubscriptions.dispose();
    if (this.view) {
      this.view.destroy();
    }
    this.emitter.emit("did-destroy");
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
    return this.file ? this.file.getPath() : null;
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
};
