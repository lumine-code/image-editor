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

// Opened by default, and opened only on request. Both live in paths.js so the
// navigator works from the same answer.
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

  treeView: null,

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

  /**
   * Opens a file in the image editor regardless of its extension.
   * Used by the "Open in Image Editor" command for optional formats like SVG.
   * @param {string} filePath - Absolute path to the file
   */
  async openInImageEditor(filePath) {
    if (!filePath) return;
    const imageEditor = new (getImageEditor())(filePath, this.treeView);
    return await lumine.workspace.open(imageEditor);
  },

  /**
   * Activates the package and registers the image file opener.
   */
  activate() {
    this.imageEditorStatusView = null;
    this.disposables = new CompositeDisposable();
    this.disposables.add(
      lumine.workspace.addOpener(
        (uri) => {
          if (imageExtensions.includes(path.extname(uri).toLowerCase())) {
            return new (getImageEditor())(uri, this.treeView);
          }
        },
        {
          canReusePendingItem: (item, uri) =>
            ImageEditor != null &&
            item instanceof ImageEditor &&
            !item.destroyed &&
            !item.isTemporary() &&
            item.getFileState() === "unmodified" &&
            !item.editorView?.isSaving &&
            imageExtensions.includes(path.extname(uri).toLowerCase()),
          reusePendingItem: (item, uri, _options, { signal }) =>
            item.view?.loadImageFromNavigation(uri, { signal, pending: true }) ?? false,
        },
      ),
      lumine.commands.add(".tree-view", {
        "image-editor:open-in-new-tab": {
          description: "Open this image in a tab of its own.",
          didDispatch: () => {
            const paths = this.treeView ? this.treeView.selectedPaths() : [];
            this.openInImageEditor(paths[0]);
          },
        },
      }),
      lumine.commands.add("lumine-text-editor", {
        "image-editor:open-in-new-tab": {
          description: "Open this image in a tab of its own.",
          didDispatch: (event) => {
            const editor = event.currentTarget.getModel();
            this.openInImageEditor(editor.getPath());
          },
        },
      }),
      lumine.commands.add(".image-editor", {
        "image-editor:open-in-new-tab": {
          description: "Open this image in a tab of its own.",
          didDispatch: () => {
            const activeItem = lumine.workspace.getActivePaneItem();
            if (activeItem && typeof activeItem.getPath === "function") {
              this.openInImageEditor(activeItem.getPath());
            }
          },
        },
      }),
      lumine.workspace
        .getCenter()
        .onDidChangeActivePaneItem(() => this.attachImageEditorStatusView()),
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
    if (this.imageEditorStatusView) {
      this.imageEditorStatusView.destroy();
    }
    this.imageEditorStatusView = null;
    this.statusBar = null;
    this.treeView = null;
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
  consumeStatusBar(statusBar) {
    this.statusBar = statusBar;
    this.attachImageEditorStatusView();
    return new Disposable(() => {
      if (this.statusBar !== statusBar) return;
      this.imageEditorStatusView?.destroy();
      this.imageEditorStatusView = null;
      this.statusBar = null;
    });
  },

  /**
   * Consumes the tree-view service.
   * @param {Object} treeView - The tree-view service object
   * @returns {Disposable} The tree-view service edge cleanup
   */
  consumeTreeViewSelection(treeView) {
    this.treeView = treeView;
    return new Disposable(() => {
      if (this.treeView === treeView) this.treeView = null;
    });
  },

  /**
   * Attaches the image editor status view to the status bar.
   */
  attachImageEditorStatusView() {
    // `this.statusBar` stays undefined until the status-bar service is
    // consumed, so guard with a loose null check.
    if (this.imageEditorStatusView || this.statusBar == null) {
      return;
    }

    if (
      ImageEditor == null ||
      !(lumine.workspace.getCenter().getActivePaneItem() instanceof ImageEditor)
    ) {
      return;
    }

    const ImageEditorStatusView = require("./status");
    this.imageEditorStatusView = new ImageEditorStatusView(this.statusBar);
    this.imageEditorStatusView.attach();
  },

  /**
   * Deserializes an ImageEditor from saved state.
   * @param {Object} state - The serialized state
   * @returns {ImageEditor} The restored image editor
   */
  deserialize(state) {
    return getImageEditor().deserialize(state, this.treeView);
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
