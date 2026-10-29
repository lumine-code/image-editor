const path = require("path");
const { randomUUID } = require("node:crypto");
const { encodeBlob, decodeDataUrl } = require("./snapshot");
const fs = require("fs");
const { Emitter, CompositeDisposable, watchFile } = require("lumine");
const HistoryManager = require("./history");

const documents = new Map();
const documentsById = new Map();
let serializedDocuments = new Map();
let restoredDocuments = new Map();
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

  static restoreState(state = {}) {
    serializedDocuments = new Map(Object.entries(state));
    restoredDocuments = new Map();
  }

  static restore(documentId, filePath) {
    const restored = restoredDocuments.get(documentId);
    if (restored && !restored.destroyed) return restored;
    const state = serializedDocuments.get(documentId);
    if (!state) return documentsById.get(documentId) ?? (filePath ? this.acquire(filePath) : null);
    if (!state.pixels && (!state.filePath || !fs.existsSync(state.filePath))) return null;
    const document = new ImageDocument(state.filePath, documentId);
    try {
      document._title = state.title;
      document._isTemporary = state.temporary;
      document._dataUrl = state.temporary ? state.pixels : null;
      if (state.pixels) {
        document.pixelBlob = decodeDataUrl(state.pixels);
        document.initialized = true;
        document.pixelRevision++;
      }
      if (state.history) document.historyManager.restoreSnapshot(state.history);
      document.pixelHistoryEntry = document.historyManager.getCurrentState();
      document.setFileState(state.fileState);
      if (state.filePath && state.pixels && document.diskFingerprint() !== state.diskFingerprint)
        document.setFileState(document.diskFingerprint() === null ? "removed" : "conflicted");
      restoredDocuments.set(documentId, document);
      return document;
    } catch (error) {
      document.destroy();
      throw error;
    }
  }

  setSaving(value) {
    this.isSaving = value;
    this.emitter.emit("did-change-saving", value);
  }

  async whenNotSaving() {
    if (!this.isSaving || this.destroyed) return;
    await new Promise((resolve) => {
      const subscriptions = new CompositeDisposable();
      const check = () => {
        if (this.isSaving && !this.destroyed) return;
        subscriptions.dispose();
        resolve();
      };
      subscriptions.add(
        this.emitter.on("did-change-saving", check),
        this.emitter.on("did-destroy", check),
      );
      check();
    });
  }

  snapshotToken() {
    const history = this.historyManager;
    return {
      fields: [
        this.getPath(),
        this._title,
        this._isTemporary,
        this._dataUrl,
        this.fileState,
        this.pixelRevision,
        this.canvasRevision,
        this.pendingEdit,
        this.isSaving,
        history.historyIndex,
        history.savedEntry,
        history.baselineModified,
        history.needsInitialSave,
      ],
      entries: history.history.map((entry) => [
        entry,
        entry.blob,
        entry.settled,
        entry.released,
        entry.translateX,
        entry.translateY,
        entry.zoom,
        entry.auto,
      ]),
    };
  }

  isSnapshotCurrent(token = this.preparedSnapshot?.token) {
    if (!token || this.destroyed) return false;
    const current = this.snapshotToken();
    return (
      current.fields.every((value, index) => value === token.fields[index]) &&
      current.entries.length === token.entries.length &&
      current.entries.every((row, index) =>
        row.every((value, field) => value === token.entries[index][field]),
      )
    );
  }

  async prepareSnapshot(readPixels) {
    while (!this.destroyed) {
      await this.whenNotSaving();
      this.reconcileFile();
      if (this.pendingEdit) await this.pendingEdit.promise;
      if (this.destroyed) return;
      const history = this.historyManager;
      await Promise.all(history.history.map((entry) => history.blobFor(entry)));
      if (this.isSnapshotCurrent()) return;
      const token = this.snapshotToken();
      const needsPixels =
        this._isTemporary || this.fileState !== "unmodified" || history.length > 0;
      let pixels = null;
      if (needsPixels) {
        const current = history.getCurrentState();
        const blob =
          current && current !== this.pixelHistoryEntry
            ? await history.blobFor(current)
            : this.pixelBlob;
        pixels = blob ? await encodeBlob(blob) : this._dataUrl;
        if (!pixels && this.pixelSource?.startsWith("data:")) pixels = this.pixelSource;
        if (!pixels) pixels = await encodeBlob(await readPixels?.());
        if (!pixels)
          throw new Error("The image pixels are unavailable for the workspace snapshot.");
      }
      const state = {
        filePath: this.getPath(),
        title: this._title,
        temporary: this._isTemporary,
        fileState: this.fileState,
        diskFingerprint: this.observedDiskFingerprint,
        pixels,
        history: history.length ? await history.snapshot() : null,
      };
      if (!this.isSnapshotCurrent(token)) continue;
      this.preparedSnapshot = { token, state };
      return;
    }
  }

  serializePrepared() {
    if (!this.isSnapshotCurrent()) {
      if (this.fileState === "unmodified" && this.historyManager.length === 0) {
        return {
          filePath: this.getPath(),
          fileState: this.fileState,
          temporary: false,
          title: this._title,
          pixels: null,
        };
      }
      const error = new Error("The image changed after its workspace snapshot was prepared.");
      error.code = "STATE_SNAPSHOT_CHANGED";
      throw error;
    }
    return this.preparedSnapshot.state;
  }

  constructor(filePath, id = randomUUID()) {
    this.id = id;
    documentsById.set(id, this);
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
      onModifiedStateChange: (modified) => this.updateFileStateFromHistory(modified),
      onHistoryChange: () => this.emitter.emit("did-change-history"),
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

  updateFileStateFromHistory(modified) {
    if (this.fileState !== "conflicted" && this.fileState !== "removed")
      this.setFileState(modified || this._isTemporary ? "modified" : "unmodified");
  }

  didChangeHistoryModified(modified) {
    this.updateFileStateFromHistory(modified);
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

  publishPixels({ blob = null, url = null, width, height, source, historyEntry = null }) {
    if (this.destroyed) return;
    if (Number.isFinite(width)) this.pixelWidth = width;
    if (Number.isFinite(height)) this.pixelHeight = height;
    this.pixelBlob = blob;
    this.pixelHistoryEntry = historyEntry;
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
    this.emitter.emit("did-destroy");
    if (documentsById.get(this.id) === this) documentsById.delete(this.id);
    if (restoredDocuments.get(this.id) === this) restoredDocuments.delete(this.id);
    this.preparedSnapshot = null;
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
