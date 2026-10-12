const path = require("path");
const fs = require("fs");
const { Emitter, CompositeDisposable, watchFile } = require("lumine");
const HistoryManager = require("./history");

const documents = new Map();
const keyFor = (filePath) => {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

class ImageDocument {
  static acquire(filePath) {
    const key = filePath ? keyFor(filePath) : null;
    let document = key && documents.get(key);
    if (!document || document.destroyed) document = new ImageDocument(filePath);
    return document;
  }

  constructor(filePath) {
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.fileSubscriptions = new CompositeDisposable();
    this.references = 0;
    this.destroyed = false;
    this.fileOperationDepth = 0;
    this.fileState = filePath ? "unmodified" : "modified";
    this.externalChangePending = false;
    this._isTemporary = !filePath;
    this._dataUrl = null;
    this._title = null;
    this.pixelBlob = null;
    this.pixelSource = null;
    this.pixelRevision = 0;
    this.canvasRevision = 0;
    this.initialized = false;
    this.isSaving = false;
    this.lastSelfWrite = null;
    this.historyManager = new HistoryManager({
      onModifiedStateChange: (modified) => this.didChangeHistoryModified(modified),
    });
    this.file = null;
    this.subscriptions.add(
      lumine.workspace.registerFileDocument({
        owner: this,
        getPath: () => this.getPath(),
        setPath: (nextPath) => this.setPath(nextPath),
        beginFileOperation: () => {
          this.fileOperationDepth++;
        },
        endFileOperation: () => {
          this.fileOperationDepth--;
          this.reconcileFile();
        },
      }),
    );
    try {
      if (filePath) this.installFile(filePath);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  retain() {
    if (this.destroyed) throw new Error("Cannot retain a destroyed image document");
    this.references++;
  }

  release() {
    if (this.destroyed) return;
    if (--this.references === 0) this.destroy();
  }

  getPath() {
    return this.file?.path || null;
  }

  installFile(filePath) {
    const file = watchFile(filePath);
    this.fileSubscriptions.dispose();
    this.fileSubscriptions = new CompositeDisposable();
    this.file = file;
    documents.set(keyFor(filePath), this);
    this.observedDiskFingerprint = this.diskFingerprint();
    const reconcile = (force = false) => {
      if (this.file === file) this.reconcileFile(force);
    };
    this.fileSubscriptions.add(
      file,
      file.onDidChange(() => reconcile(true)),
      file.onDidInvalidate(() => reconcile()),
      file.onDidError((error) => console.error("Unable to watch image", error)),
    );
    file.ready.then(
      () => reconcile(),
      () => {},
    );
  }

  diskFingerprint() {
    try {
      const stat = fs.statSync(this.getPath());
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  reconcileFile(force = false) {
    if (this.destroyed || this.fileOperationDepth || !this.file) return;
    const fingerprint = this.diskFingerprint();
    if (!force && fingerprint === this.observedDiskFingerprint) return;
    this.observedDiskFingerprint = fingerprint;
    if (fingerprint === null) {
      this.externalChangePending = false;
      this.setFileState("removed");
      return;
    }
    this.noteExternalChange();
    this.emitter.emit("did-change");
  }

  setPath(filePath) {
    const oldURI = this.getPath();
    if (filePath === oldURI) return;
    if (oldURI && documents.get(keyFor(oldURI)) === this) documents.delete(keyFor(oldURI));
    this.installFile(filePath);
    this._title = null;
    this._isTemporary = false;
    this._dataUrl = null;
    if (this.lastSelfWrite) this.lastSelfWrite.path = filePath;
    this.emitter.emit("did-change-path", filePath);
    this.emitter.emit("did-change-uri", { oldURI, newURI: this.getPath() });
    this.emitter.emit("did-change-title");
  }

  setFileState(fileState) {
    if (fileState === this.fileState) return false;
    this.fileState = fileState;
    this.emitter.emit("did-change-file-state", fileState);
    return true;
  }

  noteExternalChange() {
    if (this.fileState === "removed" && !this.historyManager.isModified())
      this.setFileState("unmodified");
    this.externalChangePending = true;
  }

  confirmExternalChange() {
    if (this.historyManager.isModified() || this.fileState !== "unmodified")
      this.setFileState("conflicted");
  }

  didChangeHistoryModified(modified) {
    if (this.fileState !== "conflicted" && this.fileState !== "removed")
      this.setFileState(modified || this._isTemporary ? "modified" : "unmodified");
    this.emitter.emit("did-change-history");
  }

  didReloadFromDisk() {
    this.externalChangePending = false;
    this.setFileState("unmodified");
  }

  didObserveUnchangedFile() {
    this.externalChangePending = false;
    if (this.fileState === "conflicted")
      this.setFileState(this.historyManager.isModified() ? "modified" : "unmodified");
  }

  didSave() {
    this.externalChangePending = false;
    this.setFileState("unmodified");
    this.emitter.emit("did-change-history");
  }

  publishPixels({ blob = null, url = null, width, height, source }) {
    if (this.destroyed) return;
    this.pixelBlob = blob;
    this.pixelSource = url;
    this.initialized = true;
    this.pixelRevision++;
    this.emitter.emit("did-change-pixels", {
      blob,
      url,
      width,
      height,
      source,
      revision: this.pixelRevision,
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pendingEdit?.resolve();
    this.pendingEdit = null;
    const filePath = this.getPath();
    if (filePath && documents.get(keyFor(filePath)) === this) documents.delete(keyFor(filePath));
    this.subscriptions.dispose();
    this.fileSubscriptions.dispose();
    this.historyManager.dispose();
    this.pixelBlob = null;
    this.pixelSource = null;
    this.emitter.dispose();
  }
}

module.exports = ImageDocument;
