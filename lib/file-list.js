const path = require("path");
const { CompositeDisposable } = require("lumine");
const paths = require("./paths");

const samePath = (left, right) =>
  left === right ||
  (process.platform === "win32" && paths.normalizePathKey(left) === paths.normalizePathKey(right));

module.exports = class FileList {
  constructor(view) {
    this.view = view;
    this.rows = [];
    this.session = 0;
    this.destroyed = false;
    this.selectListHost = lumine.workspace.addSelectList(
      {
        items: [],
        emptyMessage: "No images found",
        source: {
          mode: "snapshot",
          loadingMessage: "Loading images…",
          load: (request) => this.loadFiles(request),
        },
        getItemId: (row) => row.id,
        search: { getFilterText: (row) => row.name, ignoreDiacritics: true },
        renderItem: (row, { highlight }) => ({ primary: highlight(row.name) }),
        commands: {
          "image-editor:open-image": {
            description: "Open the selected file in this image editor.",
            didDispatch: (event) => this.goToFile(event.detail.item, event.detail.signal),
          },
        },
        actions: [
          {
            command: "image-editor:open-image",
            context: "item",
            primary: true,
            disposition: "stay",
            dispatch: "local",
          },
        ],
      },
      { className: "image-editor-list", crumb: "Folder Images" },
    );
    this.selectList = this.selectListHost.getModel();
    this.disposables = new CompositeDisposable(
      this.selectListHost.onDidHide(() => this.navigationAbortController?.abort()),
      view.editor.onDidChangePath(() => this.selectListHost.cancel("source-changed")),
      this.selectList.onDidConfirmEmptySelection(() =>
        this.selectListHost.cancel("empty-selection"),
      ),
    );
  }

  isCurrentSource(source) {
    return (
      !this.destroyed &&
      !this.view._destroyed &&
      !this.view.editor.destroyed &&
      source === this.source &&
      source.file === this.view.editor.file &&
      source.filePath === this.view.editor.getPath()
    );
  }

  async loadFiles({ signal }) {
    const source = this.source;
    const documentGeneration = this.view.documentGeneration;
    const load = this.view.loadingAbortController;
    const listing = await this.view.getFileList();
    if (signal.aborted || this.destroyed) return;
    if (
      !this.isCurrentSource(source) ||
      documentGeneration !== this.view.documentGeneration ||
      load !== this.view.loadingAbortController
    ) {
      this.selectListHost.cancel("source-changed");
      return;
    }
    this.rows = listing.files.map((filePath) => ({
      id: `${source.session}:${filePath}`,
      filePath,
      name: path.basename(filePath),
    }));
    const current =
      this.rows.find((row) => row.filePath === source.filePath) ??
      this.rows.find((row) => samePath(row.filePath, source.filePath));
    return {
      items: this.rows,
      itemUpdateOptions: {
        selection: current && !this.selectList.getQuery() ? { id: current.id } : { mode: "first" },
      },
    };
  }

  async goToFile(row, signal) {
    if (!this.rows.includes(row) || !this.isCurrentSource(this.source)) return;
    if (samePath(row.filePath, this.source.filePath)) {
      this.selectListHost.hide();
      return;
    }
    const controller = new AbortController();
    this.navigationAbortController = controller;
    try {
      const navigationSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const loaded = await this.view.loadImageFromNavigation(row.filePath, {
        signal: navigationSignal,
      });
      if (loaded && !this.destroyed) this.selectListHost.hide();
    } finally {
      if (this.navigationAbortController === controller) this.navigationAbortController = null;
    }
  }

  show() {
    if (this.destroyed || this.view._destroyed) return;
    const filePath = this.view.editor.getPath();
    this.source = {
      session: ++this.session,
      filePath,
      file: this.view.editor.file,
    };
    this.view.navigator.invalidateCache();
    this.rows = [];
    this.selectList.setItems([]);
    return this.selectListHost.show();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.navigationAbortController?.abort();
    this.disposables.dispose();
    this.rows = [];
    this.selectListHost.destroy();
  }
};
