const path = require("path");
const paths = require("./paths");
const { CompositeDisposable, Disposable } = require("lumine");

let ImageEditor = null;

function getImageEditor() {
  if (ImageEditor == null) {
    const etch = require("@lumine-code/etch");
    // Etch holds its scheduler per copy of the library. Install Lumine's
    // scheduler before requiring the first view, but keep the whole view graph
    // out of startup until an image is actually opened.
    etch.setScheduler(lumine.views);
    ImageEditor = require("./editor");
  }
  return ImageEditor;
}

// Default and optional formats share their definitions with the navigator.
const imageExtensions = paths.IMAGE_EXTENSIONS;
const optionalImageExtensions = paths.OPTIONAL_IMAGE_EXTENSIONS;

/**
 * Image Editor Package
 * Provides an image viewer for common image formats.
 * Supports zooming and panning.
 */
module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "image-editor",
      tips: [
        "In the image editor you can crop the picture to the current selection with {{ 'image-editor:crop-to-selection' | keystroke }}",
        "You can search image filenames in the current folder with {{ 'image-editor:list' | keystroke }}",
      ],
    };
  },

  /**
   * Opens an image from a data URL in a new image editor tab.
   * This allows other packages to display images without saving to disk.
   * @param {string} dataUrl - The image data URL (e.g., "data:image/png;base64,...")
   * @param {string} [title="Untitled Image"] - The title for the editor tab
   * @returns {Promise<ImageEditor>} The created image editor instance
   */
  async openFromDataUrl(dataUrl, title = "Untitled Image") {
    const imageEditor = getImageEditor().fromDataUrl(dataUrl, title);
    return await lumine.workspace.open(imageEditor);
  },

  provideNavigationAdapter() {
    return {
      handlesItem: (item) => ImageEditor != null && item instanceof ImageEditor,
      observeHeaders: (item, callback) => {
        item._navigationHeaders = null;
        let disposed = false;
        let refreshGeneration = 0;
        const stop = () => {
          disposed = true;
          refreshGeneration++;
        };
        const refresh = async () => {
          if (disposed || item.destroyed) return;
          const generation = ++refreshGeneration;
          const uri = item.getURI();
          const view = item.view;
          if (!view) return;
          const fileList = await view.getFileList();
          if (
            disposed ||
            item.destroyed ||
            generation !== refreshGeneration ||
            item.getURI() !== uri ||
            item.editorView !== view
          ) {
            return;
          }
          if (!fileList?.files?.length) {
            item._navigationHeaders = [];
            callback(item._navigationHeaders, { instant: true });
            return;
          }
          item._navigationHeaders = fileList.files.map((filePath, index) => ({
            text: path.basename(filePath),
            filePath,
            classList: [],
            currentCount: fileList.currentIndex === index ? 1 : 0,
            stackCount: fileList.currentIndex === index ? 1 : 0,
            level: 1,
            children: [],
            startPoint: { row: index, column: 0 },
            endPoint: { row: index, column: 0 },
          }));
          callback(item._navigationHeaders, { instant: true });
        };
        const subscriptions = new CompositeDisposable(
          new Disposable(stop),
          item.onDidChange(refresh),
          // Resource replacement and relocation both publish a path change.
          item.onDidChangePath(refresh),
          item.onDidDestroy(stop),
        );
        refresh();
        return subscriptions;
      },
      navigateTo: async (item, header) => {
        const element = lumine.views.getView(item);
        const opened = await lumine.workspace.open(item, { searchAllPanes: true });
        if (!opened) return;
        const navigation = item.view?.loadImageFromNavigation(header.filePath);
        element.focus();
        return navigation;
      },
    };
  },

  /**
   * Provides the image-editor service for other packages.
   * @returns {Object} Service object with openFromDataUrl method
   */
  provideImageEditor() {
    return {
      openFromDataUrl: this.openFromDataUrl.bind(this),
    };
  },

  initialize(state = {}) {
    require("./document").restoreState(state.documents);
  },

  restoreState(state = {}) {
    require("./document").restoreState(state.documents);
  },

  openDocuments() {
    const Document = require("./document");
    const documents = new Map();
    for (const item of lumine.workspace.getPaneItems()) {
      const document = item.getPaneItemDocument?.();
      if (!(document instanceof Document) || item.destroyed) continue;
      const existing = documents.get(document);
      if (!existing || (!existing.editorView?.loaded && item.editorView?.loaded))
        documents.set(document, item);
    }
    return documents;
  },

  async prepareToSerialize() {
    while (true) {
      const documents = this.openDocuments();
      await Promise.all(
        [...documents].map(([document, item]) =>
          document.prepareSnapshot(() => item.editorView?.captureSnapshotPixels()),
        ),
      );
      const current = this.openDocuments();
      if (
        current.size === documents.size &&
        [...current.keys()].every(
          (document) => documents.has(document) && document.isSnapshotCurrent(),
        )
      )
        return;
    }
  },

  serialize() {
    return {
      documents: Object.fromEntries(
        [...this.openDocuments().keys()].map((document) => [
          document.id,
          document.serializePrepared(),
        ]),
      ),
    };
  },

  /**
   * Activates the package and registers the image file opener.
   */
  activate() {
    this.imageEditorStatusView = null;
    this.statusViews = new Map();
    this.disposables = new CompositeDisposable();
    this.disposables.add(
      lumine.workspace.addPathOpener({
        id: "image-editor",
        label: "Image Editor",
        canOpen: (uri) => paths.NAVIGABLE_EXTENSIONS.includes(path.extname(uri).toLowerCase()),
        isDefaultEligible: (uri) => {
          const extension = path.extname(uri).toLowerCase().slice(1);
          return lumine.config
            .get("image-editor.defaultExtensions")
            .some((entry) => entry.trim().toLowerCase().replace(/^\./, "") === extension);
        },
        open: (uri) => new (getImageEditor())(uri),
        handlesItem: (item) => ImageEditor != null && item instanceof ImageEditor,
        canReusePendingItem: (item, uri) =>
          ImageEditor != null &&
          item instanceof ImageEditor &&
          !item.destroyed &&
          !item.isTemporary() &&
          item.getFileState() === "unmodified" &&
          !item.editorView?.isSaving &&
          paths.NAVIGABLE_EXTENSIONS.includes(path.extname(uri).toLowerCase()),
        reusePendingItem: (item, uri, _options, { signal }) =>
          item.view?.loadImageFromNavigation(uri, { signal, pending: true }) ?? false,
      }),
      // Watch for file changes in project directories
      lumine.project.onDidChangeFiles((events) => {
        this.handleFileSystemChanges(events);
      }),
      lumine.project.onDidInvalidateFiles(() => {
        if (ImageEditor == null) return;
        for (const item of lumine.workspace.getPaneItems()) {
          if (item instanceof ImageEditor) item.editorView?.navigator?.invalidateCache();
        }
      }),
    );
  },

  /**
   * Deactivates the package and disposes resources.
   */
  async deactivate() {
    for (const state of this.statusViews.values()) {
      state.subscription.dispose();
      state.view?.destroy();
    }
    this.statusViews.clear();
    this.imageEditorStatusView = null;
    this.statusBar = null;
    this.disposables?.dispose();
    this.disposables = null;

    if (ImageEditor != null) {
      const closures = [];
      for (const item of lumine.workspace.getPaneItems()) {
        if (!(item instanceof ImageEditor)) continue;
        const pane = lumine.workspace.paneForItem(item);
        if (pane) closures.push(pane.destroyItem(item, true));
        else item.destroy();
      }
      await Promise.all(closures);
    }
  },

  /**
   * Consumes the status bar service for image dimension display.
   * @param {Object} statusBar - The status bar service object
   * @returns {Disposable} The status-bar service edge cleanup
   */
  consumeStatusBar(service) {
    return service.observeWindows(
      (scopedStatusBar, context) => this.consumeWindowStatusBar(scopedStatusBar, context),
      { windows: "all" },
    );
  },

  consumeWindowStatusBar(statusBar, context) {
    const views = this.statusViews;
    let state = views.get(statusBar);
    if (!state) {
      state = { leases: 0, view: null, subscription: null };
      views.set(statusBar, state);
      const mount = () => {
        if (
          state.view ||
          ImageEditor == null ||
          !(context.editorContainer.getActivePaneItem() instanceof ImageEditor)
        )
          return;
        const StatusView = require("./status");
        state.view = new StatusView(statusBar, context);
        state.view.attach();
        if (context.window.isMain()) this.imageEditorStatusView = state.view;
      };
      state.subscription = context.editorContainer.onDidChangeActivePaneItem(mount);
      mount();
    }
    state.leases++;
    return new Disposable(() => {
      if (--state.leases > 0 || views.get(statusBar) !== state) return;
      views.delete(statusBar);
      state.subscription.dispose();
      state.view?.destroy();
      if (this.imageEditorStatusView === state.view)
        this.imageEditorStatusView = [...views.values()].at(-1)?.view ?? null;
    });
  },

  /**
   * Deserializes an ImageEditor from saved state.
   * @param {Object} state - The serialized state
   * @returns {ImageEditor} The restored image editor
   */
  deserialize(state) {
    return getImageEditor().deserialize(state);
  },

  /**
   * Handles file system changes and invalidates file list caches in active image editors.
   * @param {Array} events - Array of file system change events
   */
  handleFileSystemChanges(events) {
    if (ImageEditor == null) return;
    // Collect affected directories from image file events
    const affectedDirs = new Set();

    for (const event of events) {
      const ext = path.extname(event.path).toLowerCase();

      // Check if this is an image file (including optional extensions like SVG)
      if (imageExtensions.includes(ext) || optionalImageExtensions.includes(ext)) {
        affectedDirs.add(paths.normalizePathKey(path.dirname(event.path)));
      }

      // For rename events, also check oldPath
      if (event.action === "renamed" && event.oldPath) {
        const oldExt = path.extname(event.oldPath).toLowerCase();
        if (imageExtensions.includes(oldExt) || optionalImageExtensions.includes(oldExt)) {
          affectedDirs.add(paths.normalizePathKey(path.dirname(event.oldPath)));
        }
      }
    }

    // If no image file directories were affected, nothing to do
    if (affectedDirs.size === 0) {
      return;
    }

    // Get all active pane items
    const paneItems = lumine.workspace.getPaneItems();

    // Find all ImageEditor instances and invalidate their caches if their directory is affected
    paneItems.forEach((item) => {
      // editorView, never the view getter: that one builds a whole view, which
      // runs statSync and starts a load, so any image file event in the project
      // would materialize a view for every image tab that never had one.
      if (item instanceof ImageEditor && item.editorView && item.editorView.navigator) {
        const navigator = item.editorView.navigator;
        const cache = navigator.fileListCache;

        // Both sides folded, or a watcher event reporting C:\Data\Photos would
        // never match a cache filled from C:\data\photos and the listing would
        // go stale for the rest of the session.
        if (cache.directoryKey && affectedDirs.has(cache.directoryKey)) {
          navigator.invalidateCache();
        }
      }
    });
  },
};
