const path = require("path");
const { CompositeDisposable, Disposable } = require("lumine");
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
    this.window =
      lumine.workspace.getWindowForElement(view.element) ?? lumine.workspace.getMainWindow();
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
        renderItem: (row, { highlight }) => ({
          primary: highlight(row.name),
          didRender: (element) => this.bindFileGestures(element, row),
        }),
        commands: {
          "image-editor:open-selected-file": {
            description: "Open the selected file with its default opener.",
            didDispatch: ({ detail }) => this.openFile(detail.item, detail.signal, true),
          },
          "image-editor:open-selected-with": {
            description: "Choose an opener for the selected file.",
            didDispatch: ({ detail }) => this.performFileAction(detail.item, "with", detail.signal),
          },
          "image-editor:open-selected-pending": {
            description: "Open the selected file as a pending text editor.",
            didDispatch: ({ detail }) =>
              this.performFileAction(detail.item, "pending", detail.signal),
          },
          "image-editor:open-selected-external": {
            description: "Open the selected file in its external application.",
            didDispatch: ({ detail }) =>
              this.performFileAction(detail.item, "external", detail.signal),
          },
          "image-editor:show-selected-in-folder": {
            description: "Reveal the selected file in the system file manager.",
            didDispatch: ({ detail }) => this.performFileAction(detail.item, "show", detail.signal),
          },
        },
        actions: [
          {
            command: "image-editor:open-selected-file",
            context: "item",
            primary: true,
            disposition: "close",
            dispatch: "local",
          },
          ...[
            "image-editor:open-selected-with",
            "image-editor:open-selected-pending",
            "image-editor:open-selected-external",
            "image-editor:show-selected-in-folder",
          ].map((command) => ({ command, context: "item", group: "File", disposition: "close" })),
        ],
      },
      {
        window: this.window,
        className: "image-editor-list",
        crumb: "Folder Images",
      },
    );
    this.selectList = this.selectListHost.getModel();
    this.disposables = new CompositeDisposable(
      this.selectListHost.onDidHide(() => this.navigationAbortController?.abort()),
      view.editor.onDidChangePath((filePath) => {
        if (!this.openingPath || !samePath(filePath, this.openingPath))
          this.selectListHost.cancel("source-changed");
      }),
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

  bindFileGestures(element, row) {
    const didClick = (event) => {
      if (event.button !== 0 || event.metaKey) return;
      const command = event.altKey
        ? event.ctrlKey
          ? "image-editor:open-selected-external"
          : "image-editor:open-selected-with"
        : event.shiftKey
          ? event.ctrlKey
            ? "image-editor:show-selected-in-folder"
            : "image-editor:open-selected-pending"
          : event.ctrlKey
            ? null
            : "image-editor:open-selected-file";
      if (!command) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.selectList.selectItemById(row.id);
      void this.selectList.runAction(command, { source: "click" }).catch(() => {});
    };
    element.addEventListener("click", didClick, true);
    return new Disposable(() => element.removeEventListener("click", didClick, true));
  }

  async performFileAction(row, mode, signal) {
    if (!this.rows.includes(row) || !this.isCurrentSource(this.source) || this.window.isDestroyed())
      return;
    if (mode === "with") {
      const opening = lumine.commands.dispatch(this.window.getElement(), "open-with:toggle", {
        path: row.filePath,
        pane: this.pane,
      });
      if (!opening) throw new Error("The Open With package is not available.");
      return opening;
    }
    return this.openFile(row, signal, false, {
      opener:
        mode === "pending"
          ? "text-editor"
          : mode === "external"
            ? "open-external"
            : "open-external:show",
      ...(mode === "pending" ? { pending: true, forcePending: true } : {}),
    });
  }

  async openFile(row, signal, click = false, options = {}) {
    if (!this.rows.includes(row) || !this.isCurrentSource(this.source)) return;
    const controller = new AbortController();
    this.navigationAbortController = controller;
    this.openingPath = row.filePath;
    try {
      const navigationSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const item = await lumine.workspace.open(row.filePath, {
        signal: navigationSignal,
        pane: this.pane,
        pending: click && lumine.config.get("core.allowPendingPaneItems"),
        ...options,
      });
      if (!item && options.opener !== "open-external" && options.opener !== "open-external:show") {
        const error = new Error("Opening the selected file was cancelled.");
        error.name = "AbortError";
        throw error;
      }
      return item;
    } finally {
      if (this.navigationAbortController === controller) this.navigationAbortController = null;
      if (this.openingPath === row.filePath) this.openingPath = null;
    }
  }

  show() {
    if (this.destroyed || this.view._destroyed) return;
    const filePath = this.view.editor.getPath();
    this.pane =
      lumine.workspace.paneForItem(this.view.editor) ??
      this.window.getEditorContainer().getActivePane();
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
    // A successful open can replace the pending image that owns this picker.
    // Finish that committed action before retiring its dialog and signal.
    if (
      this.openingPath &&
      this.selectList.isActionPending() &&
      this.pane
        ?.getItems()
        .some(
          (item) =>
            item !== this.view.editor &&
            item.getPath?.() &&
            samePath(item.getPath(), this.openingPath),
        )
    ) {
      this.retiringSubscription ??= this.selectList.onDidFinishAction(() => {
        this.retiringSubscription.dispose();
        this.retiringSubscription = null;
        this.destroy();
      });
      return;
    }
    this.destroyed = true;
    this.retiringSubscription?.dispose();
    this.navigationAbortController?.abort();
    this.disposables.dispose();
    this.rows = [];
    this.selectListHost.destroy();
  }
};
