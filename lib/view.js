/**
 * ImageEditorView - Main view component for the image editor
 * Orchestrates all modules for image editing functionality
 */

const fs = require("fs");
const path = require("path");
const { Emitter, CompositeDisposable, Disposable, FileState } = require("lumine");
const etch = require("@lumine-code/etch");
const $ = etch.dom;

// Import modular components
const filters = require("./filters");
const canvasFilters = require("./canvas-filters");
const transforms = require("./transforms");
const dialogs = require("./dialogs");
const fileOps = require("./file-ops");
const HistoryManager = require("./history");
const ImageNavigator = require("./navigation");
const selection = require("./selection");
const CanvasPool = require("./canvas-pool");
const ZoomController = require("./zoom-controller");
const MouseEventHandler = require("./view-mouse");
const paths = require("./paths");

/** Only a blob: URL holds a reference that has to be handed back. */
/**
 * How long the record of what is on screen is taken at face value.
 *
 * Long enough to absorb the burst of watcher events one write raises, short
 * enough that a rewrite the timestamps cannot tell apart is picked up on the
 * next event rather than never.
 */
const SHOWN_FILE_TRUST_MS = 5000;

const isBlobUrl = (url) => typeof url === "string" && url.startsWith("blob:");

/**
 * toBlob arguments for a history frame: lossless unless it is a compact one.
 *
 * WebP rather than JPEG for the compact case, because JPEG carries no alpha
 * and composites what it cannot keep onto black — so undoing past a compressed
 * frame of an image with transparency brought back a black background. WebP is
 * lossy and keeps alpha, and compresses better besides. A platform that cannot
 * encode it hands back null, which the caller falls back from.
 */
const encodingFor = (entry) => (entry.compact ? ["image/webp", 0.92] : ["image/png"]);

module.exports = class ImageEditorView {
  constructor(editor) {
    this.editor = editor;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.surfaceDisposables = new CompositeDisposable();
    this.activeDialogCleanups = new Set();
    this.imageSize = editor.isTemporary() ? 0 : fs.statSync(this.editor.getPath()).size;
    this.loaded = false;
    this.selectionStartImg = { x: 0, y: 0 };
    this.selectionEndImg = { x: 0, y: 0 };
    this.selectionVisible = false;
    this.isSaving = false;
    this.lastSelfWrite = null;
    this.shownFile = null;
    this._displayUrl = null;
    this._ownedImageUrl = null;
    this._pinnedImageUrls = new Set();
    this._pendingImageUrlReleases = new Set();
    this._revokedImageUrls = new Set();
    this._destroyed = false;
    this.readOnly = editor.getPath() && path.extname(editor.getPath()).toLowerCase() === ".svg";
    this.transformRAF = null;
    this.transformRAFWindow = null;
    this.smoothTransformRAF = null;
    this.smoothTransformRAFWindow = null;
    this.deferredFilterRAF = null;
    this.deferredFilterRAFWindow = null;
    this.pendingFilterRun = null;
    this.imageLoadsSuspended = false;
    this.displayImageLoad = null;
    this.realmImageLoads = new Map();
    this.rotatePreviewGeneration = 0;
    this.navigationRequestGeneration = 0;

    // Initialize modular components
    this.zoomController = new ZoomController({
      levels: [0.05, 0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2, 3, 4, 5, 7.5, 10],
    });
    this.mouseHandler = new MouseEventHandler(this);

    // Expose zoom/translate for compatibility
    Object.defineProperty(this, "zoom", {
      get: () => this.zoomController.zoom,
      set: (value) => {
        this.zoomController.zoom = value;
      },
    });
    Object.defineProperty(this, "translateX", {
      get: () => this.zoomController.translateX,
      set: (value) => {
        this.zoomController.translateX = value;
      },
    });
    Object.defineProperty(this, "translateY", {
      get: () => this.zoomController.translateY,
      set: (value) => {
        this.zoomController.translateY = value;
      },
    });
    Object.defineProperty(this, "auto", {
      get: () => this.zoomController.auto,
      set: (value) => {
        this.zoomController.auto = value;
      },
    });
    Object.defineProperty(this, "levels", {
      get: () => this.zoomController.levels,
    });

    // Initialize history manager
    this.historyManager = new HistoryManager({
      onModifiedStateChange: (modified) => {
        this.editor.didChangeHistoryModified(modified);
      },
    });
    this._syncHistoryLimits();

    // Initialize navigator
    this.navigator = new ImageNavigator({
      extensions: paths.NAVIGABLE_EXTENSIONS,
    });

    // Performance optimizations - cache config values
    this.lastWheelTime = 0;
    this.wheelDebounceDelay = lumine.config.get("image-editor.wheelNavigationDelay") || 150;
    this.largeImageThreshold =
      (lumine.config.get("image-editor.largeImageThreshold") || 2) * 1024 * 1024;

    etch.initialize(this);
    this.canvasPool = new CanvasPool(this.element.ownerDocument, 3);
    this.dialogs = dialogs.forDocument(this.element.ownerDocument, (cleanup) =>
      this.trackDialogCleanup(cleanup),
    );

    this.defaultBackgroundColor = lumine.config.get("image-editor.defaultBackgroundColor");
    this.refs.imageContainer.setAttribute("background", this.defaultBackgroundColor);
    this.refs.image.style.display = "none";
    // The stylesheet hides the selection box, but getSelectionArea reads the
    // inline style, which starts empty and so read as "a selection is up" —
    // one of zero size, which every filter then refused as invalid. State it
    // inline so it agrees with the stylesheet and with selectionVisible.
    this.refs.selectionBox.style.display = "none";
    this.updateImageURI();

    this._setupDisposables();
    this._setupTooltips();
    this._setupEventListeners();
    this.setupResizeHandles();
  }

  getDocument() {
    return this.element.ownerDocument;
  }

  getWindow() {
    return this.getDocument().defaultView;
  }

  createRealmImage(domWindow) {
    return new domWindow.Image();
  }

  startRealmImageLoad(
    key,
    { source, onLoad, onError = null, onCancel = null, restartOnTransition = true },
  ) {
    if (this._destroyed) {
      onCancel?.("destroyed");
      return Promise.resolve({ outcome: "cancelled", reason: "destroyed" });
    }
    this.cancelRealmImageLoad(key, "superseded");
    let resolve;
    const operation = {
      key,
      source,
      onLoad,
      onError,
      onCancel,
      restartOnTransition,
      attempt: 0,
      image: null,
      window: null,
      state: "suspended",
      promise: new Promise((done) => {
        resolve = done;
      }),
      resolve,
    };
    this.realmImageLoads.set(key, operation);
    if (!this.imageLoadsSuspended) this.startRealmImageAttempt(operation);
    return operation.promise;
  }

  startRealmImageAttempt(operation) {
    if (this._destroyed || this.realmImageLoads.get(operation.key) !== operation) return;
    const domWindow = this.getWindow();
    let image;
    try {
      image = this.createRealmImage(domWindow);
    } catch (error) {
      this.finishRealmImageLoad(operation, "error", error);
      return;
    }
    const attempt = ++operation.attempt;
    operation.image = image;
    operation.window = domWindow;
    operation.state = "active";
    image.onload = () => {
      if (!this.isCurrentRealmImageAttempt(operation, image, attempt)) return;
      this.finishRealmImageLoad(operation, "load", image);
    };
    image.onerror = (error) => {
      if (!this.isCurrentRealmImageAttempt(operation, image, attempt)) return;
      this.finishRealmImageLoad(operation, "error", error);
    };
    try {
      image.src = operation.source;
    } catch (error) {
      this.finishRealmImageLoad(operation, "error", error);
    }
  }

  isCurrentRealmImageAttempt(operation, image, attempt) {
    return (
      this.realmImageLoads.get(operation.key) === operation &&
      operation.image === image &&
      operation.attempt === attempt
    );
  }

  finishRealmImageLoad(operation, outcome, value) {
    if (this.realmImageLoads.get(operation.key) !== operation) return;
    this.realmImageLoads.delete(operation.key);
    this.detachRealmImageAttempt(operation, false);
    try {
      if (outcome === "load") operation.onLoad?.(value);
      else operation.onError?.(value);
    } catch (error) {
      console.error(error);
      outcome = "error";
      value = error;
    }
    operation.state = "settled";
    operation.resolve({ outcome, value });
  }

  detachRealmImageAttempt(operation, cancelSource = true) {
    const image = operation.image;
    operation.attempt += 1;
    operation.image = null;
    operation.window = null;
    if (!image) return;
    try {
      image.onload = null;
      image.onerror = null;
      if (cancelSource) image.src = "";
    } catch {
      // Recovery can begin after the Image's native Window has closed.
    }
  }

  cancelRealmImageLoad(key, reason = "cancelled") {
    const operation = this.realmImageLoads.get(key);
    if (!operation) return false;
    this.realmImageLoads.delete(key);
    this.detachRealmImageAttempt(operation);
    operation.state = "cancelled";
    try {
      operation.onCancel?.(reason);
    } catch (error) {
      console.error(error);
    }
    operation.resolve({ outcome: "cancelled", reason });
    return true;
  }

  startDisplayImageLoad({ source, onLoad, onError, onCancel = null, purpose = "display" }) {
    if (this._destroyed) {
      onCancel?.("destroyed");
      return Promise.resolve({ outcome: "cancelled", reason: "destroyed" });
    }
    this.cancelDisplayImageLoad("superseded");
    let resolve;
    let reject;
    const operation = {
      source,
      onLoad,
      onError,
      onCancel,
      purpose,
      attempt: 0,
      document: null,
      state: "suspended",
      promise: new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      }),
      resolve,
      reject,
    };
    this.displayImageLoad = operation;
    if (!this.imageLoadsSuspended) this.startDisplayImageAttempt(operation);
    return operation.promise;
  }

  startDisplayImageAttempt(operation) {
    if (this._destroyed || this.displayImageLoad !== operation) return;
    const image = this.refs.image;
    const attempt = ++operation.attempt;
    operation.document = this.getDocument();
    operation.state = "active";
    const isCurrent = () =>
      this.displayImageLoad === operation &&
      operation.attempt === attempt &&
      operation.document === this.getDocument();
    const settle = async (callback, value) => {
      if (!isCurrent()) return;
      try {
        const result = await callback?.(image, isCurrent, value);
        if (!isCurrent()) return;
        this.finishDisplayImageLoad(operation);
        operation.resolve(result);
      } catch (error) {
        if (!isCurrent()) return;
        this.finishDisplayImageLoad(operation);
        operation.reject(error);
      }
    };
    operation.loadHandler = () => void settle(operation.onLoad);
    operation.errorHandler = (error) => void settle(operation.onError, error);
    image.onload = operation.loadHandler;
    image.onerror = operation.errorHandler;
    try {
      this.setImageSource(operation.source, { loadOperation: operation });
    } catch (error) {
      operation.errorHandler(error);
    }
  }

  finishDisplayImageLoad(operation) {
    if (this.displayImageLoad !== operation) return;
    const image = this.refs.image;
    if (image.onload === operation.loadHandler) image.onload = null;
    if (image.onerror === operation.errorHandler) image.onerror = null;
    this.displayImageLoad = null;
    operation.state = "settled";
  }

  suspendDisplayImageLoad(operation) {
    if (!operation || this.displayImageLoad !== operation) return;
    operation.attempt += 1;
    const image = this.refs.image;
    if (image.onload === operation.loadHandler) image.onload = null;
    if (image.onerror === operation.errorHandler) image.onerror = null;
    operation.document = null;
    operation.state = "suspended";
  }

  cancelDisplayImageLoad(reason = "cancelled", purpose = null) {
    const operation = this.displayImageLoad;
    if (!operation || (purpose && operation.purpose !== purpose)) return false;
    this.suspendDisplayImageLoad(operation);
    this.displayImageLoad = null;
    operation.state = "cancelled";
    try {
      operation.onCancel?.(reason);
    } catch (error) {
      console.error(error);
    }
    operation.resolve({ outcome: "cancelled", reason });
    return true;
  }

  suspendImageLoadsForTransition() {
    this.imageLoadsSuspended = true;
    this.rotatePreviewGeneration += 1;
    this.cancelDisplayImageLoad("surface-transition", "rotate-preview");
    this.suspendDisplayImageLoad(this.displayImageLoad);
    for (const operation of Array.from(this.realmImageLoads.values())) {
      if (!operation.restartOnTransition) {
        this.cancelRealmImageLoad(operation.key, "surface-transition");
      } else {
        this.detachRealmImageAttempt(operation);
        operation.state = "suspended";
      }
    }
  }

  rebindImageLoadsAfterTransition() {
    this.imageLoadsSuspended = false;
    if (this.displayImageLoad) {
      if (
        this.displayImageLoad.state === "active" &&
        this.displayImageLoad.document !== this.getDocument()
      ) {
        this.suspendDisplayImageLoad(this.displayImageLoad);
      }
      if (this.displayImageLoad.state === "suspended") {
        this.startDisplayImageAttempt(this.displayImageLoad);
      }
    }
    for (const operation of this.realmImageLoads.values()) {
      if (operation.state === "active" && operation.window !== this.getWindow()) {
        this.detachRealmImageAttempt(operation);
        operation.state = "suspended";
      }
      if (operation.state === "suspended") this.startRealmImageAttempt(operation);
    }
  }

  cancelAllImageLoads(reason = "cancelled") {
    this.imageLoadsSuspended = false;
    this.cancelDisplayImageLoad(reason);
    for (const key of Array.from(this.realmImageLoads.keys())) {
      this.cancelRealmImageLoad(key, reason);
    }
    this.hideSpinner();
  }

  trackDialogCleanup(cleanup) {
    let active = true;
    const tracked = () => {
      if (!active) return;
      active = false;
      this.activeDialogCleanups.delete(tracked);
      cleanup();
    };
    this.activeDialogCleanups.add(tracked);
    return tracked;
  }

  closeDialogs() {
    for (const cleanup of Array.from(this.activeDialogCleanups)) cleanup();
  }

  _setupDisposables() {
    // Debounced reload for external file changes (wait for file to be fully written)
    const debouncedReload = () => {
      // Internal navigation calls updateImageURI directly after replacing the editor file.
      // Skip the extra delayed reload from the editor's did-replace-file event.
      if (this._skipNextReload) {
        this._skipNextReload = false;
        return;
      }
      if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
      this.reloadTimeout = setTimeout(() => this.updateImageURI(), 500);
    };
    this.disposables.add(this.editor.onDidReplaceFile(debouncedReload));
    this.disposables.add(this.editor.onDidChange(debouncedReload));
    this.disposables.add(
      lumine.commands.add(this.element, {
        "image-editor:reload": {
          description: "Read the image from disk again, discarding edits.",
          didDispatch: () => this.updateImageURI({ force: true }),
        },
        "image-editor:zoom-in": () => this.zoomIn(),
        "image-editor:zoom-out": () => this.zoomOut(),
        "image-editor:reset-zoom": {
          description: "Put the zoom back to actual size.",
          didDispatch: () => this.resetZoom(),
        },
        "image-editor:zoom-to-fit": {
          description: "Zoom until the whole image fits the view.",
          didDispatch: () => this.zoomToFit({ smooth: true }),
        },
        "image-editor:zoom-to-selection": {
          description: "Zoom until the selected area fills the view.",
          didDispatch: () => this.zoomToSelection(),
        },
        "image-editor:center": {
          description: "Put the image back in the middle of the view.",
          didDispatch: () => this.centerImage(),
        },
        "image-editor:next-image": {
          description: "Open the next image in this folder.",
          didDispatch: () => this.nextImage(),
        },
        "image-editor:previous-image": {
          description: "Open the previous image in this folder.",
          didDispatch: () => this.previousImage(),
        },
        "image-editor:first-image": {
          description: "Open the first image in this folder.",
          didDispatch: () => this.firstImage(),
        },
        "image-editor:last-image": {
          description: "Open the last image in this folder.",
          didDispatch: () => this.lastImage(),
        },
        "core:cancel": () => this.hideSelection(),
        "core:move-up": () => this.scrollUp(),
        "core:move-down": () => this.scrollDown(),
        "core:move-left": () => this.scrollLeft(),
        "core:move-right": () => this.scrollRight(),
        "core:page-up": () => this.pageUp(),
        "core:page-down": () => this.pageDown(),
        "core:move-to-top": () => this.scrollToTop(),
        "core:move-to-bottom": () => this.scrollToBottom(),
        "image-editor:crop-to-selection": {
          description: "Throw away everything outside the selection.",
          didDispatch: () => this.cropToSelection(),
        },
        "image-editor:blur-light": {
          description: "Blur the image a little.",
          didDispatch: () => this.blurImage(6),
        },
        "image-editor:blur-medium": {
          description: "Blur the image moderately.",
          didDispatch: () => this.blurImage(12),
        },
        "image-editor:blur-strong": {
          description: "Blur the image heavily.",
          didDispatch: () => this.blurImage(20),
        },
        "image-editor:blur": {
          description: "Blur the image by an amount you choose.",
          didDispatch: () => this.showBlurDialog(),
        },
        "image-editor:rotate-90-cw": {
          description: "Turn the image a quarter turn clockwise.",
          didDispatch: () => this.rotate(90),
        },
        "image-editor:rotate-90-ccw": {
          description: "Turn the image a quarter turn anticlockwise.",
          didDispatch: () => this.rotate(-90),
        },
        "image-editor:rotate-180": {
          description: "Turn the image upside down.",
          didDispatch: () => this.rotate(180),
        },
        "image-editor:rotate-free": {
          description: "Turn the image by an angle you type.",
          didDispatch: () => this.showRotateAngleDialog(),
        },
        "image-editor:flip-horizontal": {
          description: "Mirror the image left to right.",
          didDispatch: () => this.flipHorizontal(),
        },
        "image-editor:flip-vertical": {
          description: "Mirror the image top to bottom.",
          didDispatch: () => this.flipVertical(),
        },
        "image-editor:resize": {
          description: "Scale the image to a size you type.",
          didDispatch: () => this.showResizeDialog(),
        },
        "image-editor:grayscale": {
          description: "Drop the colour, leaving the image in greys.",
          didDispatch: () => this.showGrayscaleDialog(),
        },
        "image-editor:invert-colors": {
          description: "Replace every colour with its opposite.",
          didDispatch: () => this.invertColors(),
        },
        "image-editor:sepia": {
          description: "Tint the image the brown of an old photograph.",
          didDispatch: () => this.applySepia(),
        },
        "image-editor:sharpen-light": {
          description: "Sharpen the image a little.",
          didDispatch: () => this.sharpenImage(0.5),
        },
        "image-editor:sharpen-medium": {
          description: "Sharpen the image moderately.",
          didDispatch: () => this.sharpenImage(1.0),
        },
        "image-editor:sharpen-strong": {
          description: "Sharpen the image heavily.",
          didDispatch: () => this.sharpenImage(1.5),
        },
        "image-editor:sharpen": {
          description: "Sharpen the image by an amount you choose.",
          didDispatch: () => this.showSharpenDialog(),
        },
        "image-editor:brightness-contrast": {
          description: "Adjust the image's brightness and contrast together.",
          didDispatch: () => this.showBrightnessContrastDialog(),
        },
        "image-editor:saturation": {
          description: "Adjust how strong the image's colours are.",
          didDispatch: () => this.showSaturationDialog(),
        },
        "image-editor:hue-shift": {
          description: "Rotate every colour around the hue wheel.",
          didDispatch: () => this.showHueShiftDialog(),
        },
        "image-editor:posterize": {
          description: "Reduce the image to a few flat levels per channel.",
          didDispatch: () => this.showPosterizeDialog(),
        },
        "image-editor:auto-adjust-colors": {
          description: "Stretch the levels so the image uses the full range.",
          didDispatch: () => this.autoAdjustColors(),
        },
        "image-editor:copy-selection": {
          description: "Copy the selected area of the image to the clipboard.",
          didDispatch: () => this.copySelectionToClipboard(),
        },
        "image-editor:copy-path": {
          description: "Copy this image's full path from the filesystem root.",
          didDispatch: () => this.copyPathToClipboard(),
        },
        "image-editor:copy-project-path": {
          description: "Copy this image's path relative to the project root.",
          didDispatch: () => this.copyProjectPathToClipboard(),
        },
        "image-editor:auto-select": {
          description: "Select the image's content, trimming the flat border away.",
          didDispatch: () => this.autoSelect(),
        },
        "image-editor:auto-select-with-border": {
          description: "Select the content and keep a margin of the border.",
          didDispatch: () => this.autoSelect(2),
        },
        "image-editor:select-all": {
          description: "Select the whole of the image.",
          didDispatch: () => this.selectAll(),
        },
        "image-editor:select-visible-area": {
          description: "Select just the part of the image now on screen.",
          didDispatch: () => this.selectVisibleArea(),
        },
        "image-editor:show-properties": {
          description: "Report the image's size, format and colour depth.",
          didDispatch: () => this.showPropertiesDialog(),
        },
        "image-editor:undo": () => this.undo(),
        "image-editor:redo": () => this.redo(),
        "image-editor:hide-selection": {
          description: "Clear the selection without changing the image.",
          didDispatch: () => this.hideSelection(),
        },
        "image-editor:background-native": {
          description: "Show the image over the theme's own background.",
          didDispatch: () => this.changeBackground("native"),
        },
        "image-editor:background-white": {
          description: "Show the image over white, to judge it on paper.",
          didDispatch: () => this.changeBackground("white"),
        },
        "image-editor:background-black": {
          description: "Show the image over black, to judge it on screen.",
          didDispatch: () => this.changeBackground("black"),
        },
        "image-editor:background-transparent": {
          description: "Show a chequerboard behind the transparent areas.",
          didDispatch: () => this.changeBackground("transparent"),
        },
      }),
    );

    // Config observers for cached values
    this.disposables.add(
      lumine.config.onDidChange("image-editor.wheelNavigationDelay", ({ newValue }) => {
        this.wheelDebounceDelay = newValue || 150;
      }),
      lumine.config.onDidChange("image-editor.largeImagePixelThreshold", () =>
        this._syncHistoryLimits(),
      ),
      lumine.config.onDidChange("image-editor.maxHistorySize", () => this._syncHistoryLimits()),
      lumine.config.onDidChange("image-editor.largeImageThreshold", ({ newValue }) => {
        this.largeImageThreshold = (newValue || 2) * 1024 * 1024;
      }),
    );
  }

  _setupTooltips() {
    const tooltips = [
      [
        this.refs.firstImageButton,
        {
          title: "Navigate to the first image in the current directory",
          keyBindingCommand: "image-editor:first-image",
        },
      ],
      [
        this.refs.prevImageButton,
        {
          title: "Navigate to the previous image",
          keyBindingCommand: "image-editor:previous-image",
        },
      ],
      [this.refs.undoButton, { title: "Undo last change", keyBindingCommand: "image-editor:undo" }],
      [
        this.refs.redoButton,
        { title: "Redo last undone change", keyBindingCommand: "image-editor:redo" },
      ],
      [
        this.refs.nextImageButton,
        { title: "Navigate to the next image", keyBindingCommand: "image-editor:next-image" },
      ],
      [
        this.refs.lastImageButton,
        {
          title: "Navigate to the last image in the current directory",
          keyBindingCommand: "image-editor:last-image",
        },
      ],
      [
        this.refs.zoomOutButton,
        { title: "Decrease zoom level", keyBindingCommand: "image-editor:zoom-out" },
      ],
      [
        this.refs.zoomToFitButton,
        { title: "Scale image to fit viewport", keyBindingCommand: "image-editor:zoom-to-fit" },
      ],
      [
        this.refs.zoomInButton,
        { title: "Increase zoom level", keyBindingCommand: "image-editor:zoom-in" },
      ],
    ];

    tooltips.forEach(([element, options]) => {
      this.disposables.add(lumine.tooltips.add(element, options));
    });
  }

  _setupEventListeners() {
    const buttonHandlers = [
      [this.refs.zoomInButton, "click", () => this.zoomIn()],
      [this.refs.zoomOutButton, "click", () => this.zoomOut()],
      [this.refs.zoomToFitButton, "click", () => this.zoomToFit({ smooth: true })],
      [this.refs.undoButton, "click", () => this.undo()],
      [this.refs.redoButton, "click", () => this.redo()],
      [this.refs.prevImageButton, "click", () => this.previousImage()],
      [this.refs.firstImageButton, "click", () => this.firstImage()],
      [this.refs.nextImageButton, "click", () => this.nextImage()],
      [this.refs.lastImageButton, "click", () => this.lastImage()],
    ];

    buttonHandlers.forEach(([element, event, handler]) => {
      element.addEventListener(event, handler);
      this.disposables.add(new Disposable(() => element.removeEventListener(event, handler)));
    });

    const wheelContainerHandler = (event) => {
      const mouseScrollMode = lumine.config.get("image-editor.switchZoomAndNavigation");
      const isZoomAction = mouseScrollMode ? event.ctrlKey : !event.ctrlKey;

      event.stopPropagation();

      if (isZoomAction) {
        const factor = event.wheelDeltaY > 0 ? 1.2 : 1 / 1.2;
        this.zoomToMousePosition(factor * this.zoom, event, { smooth: true });
      } else {
        const now = Date.now();
        if (this.lastWheelTime && now - this.lastWheelTime < this.wheelDebounceDelay) {
          return;
        }
        this.lastWheelTime = now;
        if (event.wheelDeltaY < 0) {
          this.nextImage();
        } else if (event.wheelDeltaY > 0) {
          this.previousImage();
        }
      }
    };
    this.refs.imageContainer.addEventListener("wheel", wheelContainerHandler, { passive: true });
    this.disposables.add(
      new Disposable(() =>
        this.refs.imageContainer.removeEventListener("wheel", wheelContainerHandler),
      ),
    );

    this._setupMouseHandlers();
    this.bindSurface();
  }

  _setupMouseHandlers() {
    this.mouseMoveHandler = (event) => this.mouseHandler.handleMouseMove(event);
    this.mouseDownHandler = (event) => this.mouseHandler.handleMouseDown(event);
    this.mouseUpHandler = () => this.mouseHandler.handleMouseUp();
    this.contextMenuHandler = (event) => this.mouseHandler.handleContextMenu(event);
    this.doubleClickHandler = (event) => this.mouseHandler.handleDoubleClick(event);

    this.refs.imageContainer.addEventListener("mousedown", this.mouseDownHandler);
    this.refs.imageContainer.addEventListener("dblclick", this.doubleClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.imageContainer.removeEventListener("mousedown", this.mouseDownHandler);
        this.refs.imageContainer.removeEventListener("dblclick", this.doubleClickHandler);
      }),
    );
  }

  bindSurface() {
    this.surfaceDisposables.dispose();
    this.surfaceDisposables = new CompositeDisposable();
    const domWindow = this.getWindow();
    const resizeObserver = new domWindow.ResizeObserver(() => {
      if (this.auto) this.zoomToFit();
    });
    resizeObserver.observe(this.refs.imageContainer);
    domWindow.addEventListener("mousemove", this.mouseMoveHandler);
    domWindow.addEventListener("mouseup", this.mouseUpHandler);
    domWindow.addEventListener("contextmenu", this.contextMenuHandler, true);
    this.resizeObserver = resizeObserver;
    this.surfaceDisposables.add(
      new Disposable(() => {
        try {
          resizeObserver.disconnect();
        } catch {
          // Recovery can begin after the owning native Window has closed.
        }
      }),
      new Disposable(() => {
        try {
          domWindow.removeEventListener("mousemove", this.mouseMoveHandler);
          domWindow.removeEventListener("mouseup", this.mouseUpHandler);
          domWindow.removeEventListener("contextmenu", this.contextMenuHandler, true);
        } catch {
          // Recovery can begin after the owning native Window has closed.
        }
      }),
    );
  }

  beginWindowSurfaceTransition() {
    this.closeDialogs();
    this.suspendImageLoadsForTransition();
    this.mouseHandler.handleMouseUp();
    this.mouseHandler.clearContextMenuSuppression();
    this.surfaceDisposables.dispose();
    this.cancelSmoothTransform();
    this.cancelTransformFrame();
    const pendingFilterRun = this.pendingFilterRun;
    this.cancelDeferredFilterFrame({ preserve: true });
    this.canvasPool.clear();
    const finish = () => {
      this.cancelSmoothTransform();
      this.cancelTransformFrame();
      this.canvasPool.setDocument(this.getDocument());
      this.dialogs = dialogs.forDocument(this.getDocument(), (cleanup) =>
        this.trackDialogCleanup(cleanup),
      );
      this.bindSurface();
      if (this.auto) this.zoomToFit();
      else this.updateTransform();
      if (pendingFilterRun && this.pendingFilterRun === pendingFilterRun) {
        this.scheduleDeferredFilterRun(pendingFilterRun);
      }
      this.rebindImageLoadsAfterTransition();
    };
    return { commit: finish, rollback: finish };
  }

  _normalizeSelection() {
    const minX = Math.min(this.selectionStartImg.x, this.selectionEndImg.x);
    const maxX = Math.max(this.selectionStartImg.x, this.selectionEndImg.x);
    const minY = Math.min(this.selectionStartImg.y, this.selectionEndImg.y);
    const maxY = Math.max(this.selectionStartImg.y, this.selectionEndImg.y);
    this.selectionStartImg = { x: minX, y: minY };
    this.selectionEndImg = { x: maxX, y: maxY };
    this.updateSelectionBox();
  }

  _checkSelectionSize() {
    const selWidth = Math.abs(this.selectionEndImg.x - this.selectionStartImg.x);
    const selHeight = Math.abs(this.selectionEndImg.y - this.selectionStartImg.y);
    const minSize = 3 / this.zoom;
    if (selWidth < minSize && selHeight < minSize) {
      this.setSelectionVisibility(false);
    }
  }

  onDidLoad(callback) {
    return this.emitter.on("did-load", callback);
  }

  onMousePosition(callback) {
    return this.emitter.on("mouse-position", callback);
  }

  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }

  update() {}

  /**
   * Point the image element at `url`, releasing the blob URL it was showing.
   *
   * The release waits for the next load or error rather than happening at
   * assignment: until the replacement is decoded the old URL is still what is
   * on screen, and revoking it there would leave a broken image behind if the
   * swap failed. A URL that is pinned, or that has come back round to being
   * the current source, is never released.
   *
   * @param {string} url
   * @param {object} [options]
   * @param {boolean} [options.own=true] false when something else owns `url`
   *   and will revoke it — history entries own theirs.
   * @returns {string} url
   */
  setImageSource(url, { own = true, loadOperation = null } = {}) {
    if (this.displayImageLoad && this.displayImageLoad !== loadOperation) {
      this.cancelDisplayImageLoad("source-replaced");
    }
    const previous = this._ownedImageUrl;
    this._displayUrl = url;
    this._ownedImageUrl = own && isBlobUrl(url) ? url : null;

    if (previous && previous !== url) {
      const image = this.refs.image;
      this._pendingImageUrlReleases.add(previous);
      const release = () => {
        image.removeEventListener("load", release);
        image.removeEventListener("error", release);
        this._pendingImageUrlReleases.delete(previous);
        this._releaseImageUrl(previous);
      };
      image.addEventListener("load", release);
      image.addEventListener("error", release);
    }

    this.refs.image.src = url;
    return url;
  }

  /**
   * Keep `url` alive across source swaps.
   *
   * The free-rotate dialog holds the pre-dialog source across a whole preview
   * session and puts it back on cancel, so it has to outlive every preview
   * frame that replaces it in the meantime.
   */
  pinImageUrl(url) {
    if (isBlobUrl(url)) this._pinnedImageUrls.add(url);
  }

  unpinImageUrl(url) {
    if (this._pinnedImageUrls.delete(url)) this._releaseImageUrl(url);
  }

  _releaseImageUrl(url) {
    if (!isBlobUrl(url)) return;
    if (url === this._displayUrl) return;
    if (this._pinnedImageUrls.has(url)) return;
    this._revokeImageUrl(url);
  }

  _revokeImageUrl(url) {
    if (!isBlobUrl(url) || this._revokedImageUrls.has(url)) return;
    this._revokedImageUrls.add(url);
    URL.revokeObjectURL(url);
  }

  destroy() {
    this._destroyed = true;
    this.navigationRequestGeneration += 1;
    this.rotatePreviewGeneration += 1;
    this.closeDialogs();
    this.loadingAbortController && (this.loadingAbortController.cancelled = true);
    this.cancelAllImageLoads("destroyed");
    if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
    if (this.boundaryOverlayTimeout) clearTimeout(this.boundaryOverlayTimeout);
    this.cancelSmoothTransform();
    this.cancelTransformFrame();
    this.cancelDeferredFilterFrame();
    this.surfaceDisposables.dispose();
    this.disposables.dispose();
    this.emitter.dispose();
    this.canvasPool.clear();
    this.historyManager.dispose();

    // Nothing is on screen any more, so the guard against revoking the current
    // source has nothing to protect.
    this._displayUrl = null;
    const imageUrls = new Set(this._pendingImageUrlReleases);
    for (const url of this._pinnedImageUrls) imageUrls.add(url);
    if (this._ownedImageUrl) imageUrls.add(this._ownedImageUrl);
    for (const url of imageUrls) this._revokeImageUrl(url);
    this._pendingImageUrlReleases.clear();
    this._pinnedImageUrls.clear();
    this._ownedImageUrl = null;

    etch.destroy(this);
  }

  showSpinner() {
    if (this.refs.loadingSpinner) {
      this.refs.loadingSpinner.classList.add("visible");
    }
  }

  hideSpinner() {
    if (this.refs.loadingSpinner) {
      this.refs.loadingSpinner.classList.remove("visible");
    }
  }

  setupResizeHandles() {
    const corners = ["nw", "ne", "se", "sw"];
    corners.forEach((handle) => {
      const refName = "handle" + handle.toUpperCase();
      const element = this.refs[refName];
      const handleMouseDown = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.mouseHandler.startResizing(handle);
      };
      element.addEventListener("mousedown", handleMouseDown);
      this.disposables.add(
        new Disposable(() => element.removeEventListener("mousedown", handleMouseDown)),
      );
    });

    const edges = ["n", "e", "s", "w"];
    edges.forEach((edge) => {
      const refName = "edge" + edge.toUpperCase();
      const element = this.refs[refName];
      const handleMouseDown = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.mouseHandler.startResizing(edge);
      };
      element.addEventListener("mousedown", handleMouseDown);
      this.disposables.add(
        new Disposable(() => element.removeEventListener("mousedown", handleMouseDown)),
      );
    });
  }

  render() {
    return $.div(
      { className: "image-editor", tabIndex: -1 },
      $.div(
        { className: "image-controls", ref: "imageControls" },
        $.span({ className: "image-controls-spacer" }),
        $.div(
          { className: "image-controls-group btn-group" },
          $.button({ className: "btn", ref: "firstImageButton" }, "<<"),
          $.button({ className: "btn", ref: "prevImageButton" }, "<"),
          $.button({ className: "btn", ref: "undoButton" }, "↶"),
          $.button({ className: "btn", ref: "zoomOutButton" }, "-"),
          $.button({ className: "btn zoom-to-fit-button", ref: "zoomToFitButton" }, ""),
          $.button({ className: "btn", ref: "zoomInButton" }, "+"),
          $.button({ className: "btn", ref: "redoButton" }, "↷"),
          $.button({ className: "btn", ref: "nextImageButton" }, ">"),
          $.button({ className: "btn", ref: "lastImageButton" }, ">>"),
        ),
        $.span({ className: "loading-spinner-right", ref: "loadingSpinner" }),
      ),
      $.div(
        { className: "image-container", ref: "imageContainer" },
        $.img({ ref: "image" }),
        $.div({ className: "boundary-overlay", ref: "boundaryOverlay" }),
        $.div(
          { className: "selection-box", ref: "selectionBox" },
          $.div({ className: "selection-edge edge-n", ref: "edgeN" }),
          $.div({ className: "selection-edge edge-e", ref: "edgeE" }),
          $.div({ className: "selection-edge edge-s", ref: "edgeS" }),
          $.div({ className: "selection-edge edge-w", ref: "edgeW" }),
          $.div({ className: "selection-handle nw", ref: "handleNW" }),
          $.div({ className: "selection-handle ne", ref: "handleNE" }),
          $.div({ className: "selection-handle se", ref: "handleSE" }),
          $.div({ className: "selection-handle sw", ref: "handleSW" }),
        ),
      ),
    );
  }

  async updateImageURI(options = {}) {
    if (this.isSaving) return;

    if (this.loadingAbortController) {
      this.loadingAbortController.cancelled = true;
    }
    this.cancelDisplayImageLoad("superseded");

    this.loadingAbortController = { cancelled: false };
    const currentLoad = this.loadingAbortController;

    this.showSpinner();

    // Handle temporary editors (data URLs) - no file stats needed
    if (this.editor.isTemporary()) {
      const imageUrl = this.editor.getDataUrl();
      try {
        await this.loadImageOptimized(imageUrl, false, currentLoad);
      } catch (error) {
        if (!currentLoad.cancelled) {
          console.error("Error loading image:", error);
          this.hideSpinner();
        }
      }
      return;
    }

    const filePath = this.editor.getPath();
    let stats = null;
    try {
      stats = await fs.promises.stat(filePath);
      if (currentLoad.cancelled || this._destroyed) return;
      this.imageSize = stats.size;
    } catch (e) {
      if (currentLoad.cancelled || this._destroyed) return;
      this.imageSize = 0;
      // File was deleted/moved/renamed while open. Skip the load so the
      // browser does not log an ERR_FILE_NOT_FOUND for the missing path.
      if (e.code === "ENOENT" && !currentLoad.cancelled) {
        this.hideSpinner();
        if (!this.loaded) {
          lumine.notifications.addError("Image file not found", {
            description: this.editor.getPath(),
            dismissable: true,
          });
        }
        return;
      }
    }

    // The file on disk is the one this view just wrote, so its pixels are already
    // on screen — reloading would only cost a decode and reset the zoom and pan.
    if (!options.force && this.isSelfWrite(filePath, stats)) {
      this.editor.didObserveUnchangedFile();
      this.hideSpinner();
      return;
    }

    // The <img> already holds this file at this mtime and size. Chromium does
    // re-fire `load` for a repeated src, so this is not about the load
    // settling — it is about what that load would do on the way through:
    // decode the image again, reset the undo history, and emit did-load, which
    // sends every navigation consumer back to the directory listing. A watcher
    // event that reports no actual change should cost none of that.
    if (!options.force && this.isAlreadyShown(filePath, stats)) {
      this.editor.didObserveUnchangedFile();
      this.hideSpinner();
      return;
    }

    if (!options.force && this.editor.getFileState() !== FileState.UNMODIFIED) {
      this.editor.confirmExternalChange();
      this.hideSpinner();
      return;
    }

    // getEncodedURI() returns a data: URL for a temporary editor, which a query
    // string would corrupt — safe only because isTemporary() returned above.
    // A forced reload means "read it from disk again", so it takes a nonce.
    const imageUrl = `${this.editor.getEncodedURI()}?v=${
      options.force ? Date.now() : paths.cacheKeyForStats(stats)
    }`;
    const isLargeImage = this.imageSize > this.largeImageThreshold;

    try {
      await this.loadImageOptimized(imageUrl, isLargeImage, currentLoad);
      // A cancelled load resolves without having shown anything, and whichever
      // load superseded it records its own file.
      if (!currentLoad.cancelled && this.loaded) {
        this.noteShownFile(filePath, stats);
        this.editor.didReloadFromDisk();
      }
      // The explicit gesture: a forced reload means "read it all again", and
      // the folder is part of what is being looked at. An ordinary load says
      // nothing about the folder and leaves the listing alone.
      if (options.force) this.navigator.invalidateCache();
    } catch (error) {
      if (!currentLoad.cancelled) {
        const isDecodeError = error.name === "DOMException" && error.message.includes("decode");
        if (!isDecodeError) {
          console.error("Error loading image:", error);
        }
        // Don't mark as unloaded or show error if we already have a loaded image
        // (external file change might be transient)
        if (!this.loaded) {
          this.hideSpinner();
          if (!isDecodeError) {
            lumine.notifications.addError("Failed to load image", {
              description: error.message,
              dismissable: true,
            });
          }
        } else {
          this.hideSpinner();
        }
      }
    }
  }

  async loadImageOptimized(imageUrl, isLargeImage, currentLoad) {
    if (this.readOnly) imageUrl = this._svgBlobUrl(imageUrl);
    return this.startDisplayImageLoad({
      source: imageUrl,
      onCancel: () => {
        currentLoad.cancelled = true;
      },
      onLoad: async (image, isCurrent) => {
        if (currentLoad.cancelled) return;

        if (isLargeImage && image.decode) {
          try {
            await image.decode();
          } catch (decodeError) {
            if (currentLoad.cancelled || !isCurrent()) return;
            console.warn(
              "Image decode failed, continuing without async decode:",
              decodeError.message,
            );
          }
        }

        if (currentLoad.cancelled || !isCurrent()) return;
        const previousWidth = this.originalWidth;
        const previousHeight = this.originalHeight;
        const wasLoaded = this.loaded;
        this.originalHeight = image.naturalHeight;
        this.originalWidth = image.naturalWidth;

        this.loaded = true;

        // Reloading the same image keeps the zoom and pan the user was on. A first
        // load, a resized image, or fit mode (where a re-fit lands where it already
        // was) still fits and centers.
        const keepViewport =
          wasLoaded &&
          !this.auto &&
          previousWidth === this.originalWidth &&
          previousHeight === this.originalHeight;

        if (keepViewport) {
          this.updateTransform();
        } else {
          this.translateX = 0;
          this.translateY = 0;
          this.zoomToFit();
          this.centerImage();
        }
        image.style.display = "";

        this.historyManager.reset();
        this.emitter.emit("did-update");
        this.emitter.emit("did-load");
        this.hideSpinner();
      },
      onError: async () => {
        this.loaded = false;
        this.hideSpinner();
        if (currentLoad.cancelled) return;
        const filePath = this.editor.getPath();
        if (!filePath) throw new Error("Failed to load image");
        try {
          await fs.promises.access(filePath, fs.constants.F_OK);
        } catch {
          // The file was deleted or renamed while its image was loading.
          return;
        }
        throw new Error("Failed to load image");
      },
    });
  }

  getPooledCanvas(width, height) {
    return this.canvasPool.getCanvas(width, height);
  }

  returnCanvasToPool(canvas) {
    this.canvasPool.returnCanvas(canvas);
  }

  updateSize(zoom, { applyTransform = true, smooth = false } = {}) {
    if (!this.loaded || this.element.offsetHeight === 0) return;
    this.disableAutoZoom();
    this.zoom = Math.min(Math.max(zoom, 0.001), 100);
    if (applyTransform) this.updateTransform({ smooth });
  }

  cancelSmoothTransform() {
    if (this.smoothTransformRAF != null) {
      try {
        this.smoothTransformRAFWindow?.cancelAnimationFrame(this.smoothTransformRAF);
      } catch {
        // A recovery transition may start after the owning Window has closed.
      }
      this.smoothTransformRAF = null;
      this.smoothTransformRAFWindow = null;
    }
  }

  cancelTransformFrame() {
    if (this.transformRAF != null) {
      try {
        this.transformRAFWindow?.cancelAnimationFrame(this.transformRAF);
      } catch {
        // A recovery transition may start after the owning Window has closed.
      }
      this.transformRAF = null;
      this.transformRAFWindow = null;
    }
  }

  updateTransform({ smooth = false } = {}) {
    if (smooth) {
      this.updateTransformSmooth();
      return;
    }

    this.cancelSmoothTransform();
    if (this.transformRAF == null) {
      this.transformRAFWindow = this.getWindow();
      this.transformRAF = this.transformRAFWindow.requestAnimationFrame(() => {
        this.transformRAF = null;
        this.transformRAFWindow = null;
        this._applyTransform();
      });
    }
  }

  updateTransformSmooth(duration = 120) {
    if (!this.loaded || this.element.offsetHeight === 0) {
      this.updateTransform();
      return;
    }

    this.cancelTransformFrame();
    this.cancelSmoothTransform();

    const target = {
      translateX: this.translateX,
      translateY: this.translateY,
      zoom: this.zoom,
    };
    const start = this.renderedTransform || target;
    const domWindow = this.getWindow();
    const startTime = domWindow.performance.now();

    const animate = (now) => {
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const translateX = start.translateX + (target.translateX - start.translateX) * eased;
      const translateY = start.translateY + (target.translateY - start.translateY) * eased;
      const zoom = start.zoom + (target.zoom - start.zoom) * eased;

      this._applyTransform({ translateX, translateY, zoom, isSmoothFrame: true });

      if (progress < 1) {
        this.smoothTransformRAFWindow = domWindow;
        this.smoothTransformRAF = domWindow.requestAnimationFrame(animate);
      } else {
        this.smoothTransformRAF = null;
        this.smoothTransformRAFWindow = null;
        this._applyTransform();
      }
    };

    this.smoothTransformRAFWindow = domWindow;
    this.smoothTransformRAF = domWindow.requestAnimationFrame(animate);
  }

  _applyTransform({
    translateX = this.translateX,
    translateY = this.translateY,
    zoom = this.zoom,
    isSmoothFrame = false,
  } = {}) {
    if (!isSmoothFrame) this.cancelSmoothTransform();

    this.refs.image.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoom})`;
    this.refs.image.style.willChange = "transform";
    this.refs.image.style.width = "";
    this.refs.image.style.height = "";
    this.renderedTransform = { translateX, translateY, zoom };

    const percent = Math.round(this.zoom * 1000) / 10;
    this.refs.zoomToFitButton.textContent = percent + "%";

    if (this.selectionVisible) {
      this.updateSelectionBox(translateX, translateY, zoom);
    }
  }

  updateSelectionBox(translateX = this.translateX, translateY = this.translateY, zoom = this.zoom) {
    if (!this.refs.selectionBox) return;
    selection.updateSelectionBoxStyle(
      this.refs.selectionBox,
      this.selectionStartImg,
      this.selectionEndImg,
      translateX,
      translateY,
      zoom,
    );
  }

  centerImage({ smooth = false } = {}) {
    if (!this.loaded || this.element.offsetHeight === 0) return;

    const containerWidth = this.refs.imageContainer.offsetWidth;
    const containerHeight = this.refs.imageContainer.offsetHeight;
    const centerX = containerWidth / 2;
    const centerY = containerHeight / 2;

    if (this.originX === 0 && this.originY === 0) {
      this.originX = centerX;
      this.originY = centerY;
    }

    const imageWidth = this.refs.image.naturalWidth * this.zoom;
    const imageHeight = this.refs.image.naturalHeight * this.zoom;

    this.translateX = centerX - imageWidth / 2;
    this.translateY = centerY - imageHeight / 2;

    this.updateTransform({ smooth });
  }

  zoomToMousePosition(newZoom, event, { smooth = false } = {}) {
    if (!this.loaded) return;

    const { left, top } = this.refs.imageContainer.getBoundingClientRect();
    const mouseX = event.clientX - left;
    const mouseY = event.clientY - top;

    const imageX = (mouseX - this.translateX) / this.zoom;
    const imageY = (mouseY - this.translateY) / this.zoom;

    this.updateSize(newZoom, { applyTransform: false });

    this.translateX = mouseX - imageX * this.zoom;
    this.translateY = mouseY - imageY * this.zoom;

    this.updateTransform({ smooth });
  }

  zoomToCenterPoint(newZoom, { smooth = false } = {}) {
    if (!this.loaded) return;

    const containerWidth = this.refs.imageContainer.offsetWidth;
    const containerHeight = this.refs.imageContainer.offsetHeight;
    const centerX = containerWidth / 2;
    const centerY = containerHeight / 2;

    const imageX = (centerX - this.translateX) / this.zoom;
    const imageY = (centerY - this.translateY) / this.zoom;

    this.updateSize(newZoom, { applyTransform: false });

    this.translateX = centerX - imageX * this.zoom;
    this.translateY = centerY - imageY * this.zoom;

    this.updateTransform({ smooth });
  }

  _zoomToFit(limit, auto, element, { smooth = false } = {}) {
    if (!this.loaded || this.element.offsetHeight === 0) return;
    let zoom = Math.min(
      this.refs.imageContainer.offsetWidth / this.refs.image.naturalWidth,
      this.refs.imageContainer.offsetHeight / this.refs.image.naturalHeight,
    );
    if (limit) zoom = Math.min(zoom, limit);
    this.updateSize(zoom, { applyTransform: false });
    this.centerImage({ smooth });
    this.auto = auto;
    element.classList.add("selected");
  }

  zoomToFit({ smooth = false } = {}) {
    const limit = lumine.config.get("image-editor.autoZoomLimit") ? 1 : null;
    this._zoomToFit(limit, true, this.refs.zoomToFitButton, { smooth });
  }

  zoomToSelection({ smooth = true } = {}) {
    if (!this.loaded || this.element.offsetHeight === 0) return;

    const area = this.getSelectionArea();
    if (!area || !area.hasSelection || area.width === 0 || area.height === 0) return;

    const containerWidth = this.refs.imageContainer.offsetWidth;
    const containerHeight = this.refs.imageContainer.offsetHeight;

    let zoom = Math.min(containerWidth / area.width, containerHeight / area.height);
    zoom = Math.min(Math.max(zoom, 0.001), 100);

    this.disableAutoZoom();
    this.zoom = zoom;

    // Center the selection within the viewport
    const selCenterX = area.left + area.width / 2;
    const selCenterY = area.top + area.height / 2;
    this.translateX = containerWidth / 2 - selCenterX * zoom;
    this.translateY = containerHeight / 2 - selCenterY * zoom;

    // Clear the selection once it has been zoomed to
    this.setSelectionVisibility(false);

    this.updateTransform({ smooth });
  }

  zoomOut() {
    for (let i = this.levels.length - 1; i >= 0; i--) {
      if (this.levels[i] < this.zoom) {
        this.zoomToCenterPoint(this.levels[i], { smooth: true });
        break;
      }
    }
  }

  zoomIn() {
    for (let i = 0; i < this.levels.length; i++) {
      if (this.levels[i] > this.zoom) {
        this.zoomToCenterPoint(this.levels[i], { smooth: true });
        break;
      }
    }
  }

  resetZoom() {
    if (!this.loaded || this.element.offsetHeight === 0) return;
    this.zoomToCenterPoint(1, { smooth: true });
  }

  hideSelection() {
    if (this.refs.selectionBox) {
      this.setSelectionVisibility(false);
    }
    this.mouseHandler.reset();
  }

  disableAutoZoom() {
    this.auto = false;
    if (this.refs.zoomToFitButton) this.refs.zoomToFitButton.classList.remove("selected");
  }

  changeBackground(color) {
    if (this.loaded && this.element.offsetHeight > 0 && color) {
      this.refs.imageContainer.setAttribute("background", color);
    }
  }

  scrollUp() {
    this.disableAutoZoom();
    this.translateY += this.refs.imageContainer.offsetHeight / 10;
    this.updateTransform({ smooth: true });
  }
  scrollDown() {
    this.disableAutoZoom();
    this.translateY -= this.refs.imageContainer.offsetHeight / 10;
    this.updateTransform({ smooth: true });
  }
  scrollLeft() {
    this.disableAutoZoom();
    this.translateX += this.refs.imageContainer.offsetWidth / 10;
    this.updateTransform({ smooth: true });
  }
  scrollRight() {
    this.disableAutoZoom();
    this.translateX -= this.refs.imageContainer.offsetWidth / 10;
    this.updateTransform({ smooth: true });
  }
  pageUp() {
    this.disableAutoZoom();
    this.translateY += this.refs.imageContainer.offsetHeight;
    this.updateTransform();
  }
  pageDown() {
    this.disableAutoZoom();
    this.translateY -= this.refs.imageContainer.offsetHeight;
    this.updateTransform();
  }
  scrollToTop() {
    this.disableAutoZoom();
    this.translateY = 0;
    this.updateTransform();
  }
  scrollToBottom() {
    this.disableAutoZoom();
    this.translateY =
      this.refs.imageContainer.offsetHeight - this.refs.image.naturalHeight * this.zoom;
    this.updateTransform();
  }

  async nextImage() {
    return this._step(1, "right");
  }

  async previousImage() {
    return this._step(-1, "left");
  }

  /**
   * Move one image along, showing the boundary overlay when the step wraps.
   *
   * Both answers come from a single listing. Taken separately they could
   * disagree: a file event can invalidate the cache between two awaits, so the
   * overlay would describe a boundary the step no longer sees.
   */
  async _step(direction, boundary) {
    const now = Date.now();
    if (this.lastNavigationTime && now - this.lastNavigationTime < 50) return;
    this.lastNavigationTime = now;

    const currentPath = this.editor.getPath();
    const fileList = await this.navigator.getFileList(currentPath);
    const cycle = lumine.config.get("image-editor.scrollCycle") !== false;

    const atBoundary =
      fileList.files.length > 0 &&
      (direction > 0
        ? fileList.currentIndex === fileList.files.length - 1
        : fileList.currentIndex === 0);
    if (cycle && atBoundary) this.showBoundaryOverlay(boundary);

    const target = this.navigator.stepFrom(fileList, direction, { cycle });
    // Folded, so a path differing only in case does not read as another file
    // and send the view reloading onto itself.
    if (target && paths.normalizePathKey(target) !== paths.normalizePathKey(currentPath)) {
      this.loadImageFromNavigation(target);
    }
  }

  showBoundaryOverlay(direction) {
    if (!this.refs.boundaryOverlay) return;
    const overlay = this.refs.boundaryOverlay;
    const iconClass = direction === "left" ? "icon-move-down" : "icon-move-up";
    overlay.className = `boundary-overlay icon ${iconClass}`;
    overlay.offsetHeight;
    overlay.classList.add("active");
    if (this.boundaryOverlayTimeout) clearTimeout(this.boundaryOverlayTimeout);
    this.boundaryOverlayTimeout = setTimeout(() => overlay.classList.remove("active"), 800);
  }

  async firstImage() {
    const firstPath = await this.navigator.getFirstImage(this.editor.getPath());
    if (firstPath && path.normalize(firstPath) !== path.normalize(this.editor.getPath())) {
      this.loadImageFromNavigation(firstPath);
    }
  }

  async lastImage() {
    const lastPath = await this.navigator.getLastImage(this.editor.getPath());
    if (lastPath && path.normalize(lastPath) !== path.normalize(this.editor.getPath())) {
      this.loadImageFromNavigation(lastPath);
    }
  }

  // Public API for external packages (e.g., navigation-panel)
  async getFileList() {
    // Copied, because the navigator returns its own cache object and now keeps
    // an index derived from that array. A consumer sorting it in place would
    // desynchronize the two and misnavigate with nothing to show for it.
    const list = await this.navigator.getFileList(this.editor.getPath());
    return {
      directory: list.directory,
      files: list.files.slice(),
      currentIndex: list.currentIndex,
    };
  }

  /**
   * Ask before moving off an image with unsaved edits.
   *
   * Reloading has always refused to overwrite unsaved work — updateImageURI
   * returns early when the image is modified — but stepping to the next image
   * went straight past that and reset the history on arrival, so an arrow key
   * discarded the edits without a word. The wording and the three buttons are
   * the editor's own, from the prompt a pane raises when an unsaved item is
   * closed.
   *
   * @returns {Promise<boolean>} false if the move should not happen
   */
  async confirmDiscardingEdits() {
    if (this.editor.getFileState() === FileState.UNMODIFIED) return true;

    const response = await lumine.window.confirm({
      message: `Save changes to ${this.editor.getTitle()}?`,
      detail: "Your changes will be lost if you move to another image without saving.",
      buttons: ["Save", "Cancel", "Don't Save"],
    });

    if (response === 1) return false;
    // A failed save keeps the user where their work is.
    if (response === 0) return (await this.save()) === true;
    return true;
  }

  async loadImageFromNavigation(imagePath) {
    if (!imagePath) return;
    const requestGeneration = ++this.navigationRequestGeneration;
    if (!(await this.confirmDiscardingEdits())) return;
    if (requestGeneration !== this.navigationRequestGeneration || this._destroyed) return;

    this.showSpinner();
    this.auto = true; // Reset to fit zoom on navigation
    this.refs.zoomToFitButton.classList.add("selected");

    // Verify the file still exists before loading. This both gives the status
    // bar an immediate size and avoids a browser ERR_FILE_NOT_FOUND when
    // navigating to an image that was deleted/moved.
    let stats;
    try {
      stats = await fs.promises.stat(imagePath);
      if (requestGeneration !== this.navigationRequestGeneration || this._destroyed) return;
      this.imageSize = stats.size;
    } catch {
      if (requestGeneration !== this.navigationRequestGeneration || this._destroyed) return;
      this.imageSize = 0;
      this.hideSpinner();
      lumine.notifications.addError("Image file not found", {
        description: imagePath,
        dismissable: true,
      });
      return;
    }

    this.readOnly = path.extname(imagePath).toLowerCase() === ".svg";

    if (this.loadingAbortController) {
      this.loadingAbortController.cancelled = true;
    }
    this.cancelDisplayImageLoad("navigation");

    let encodedPath = `${paths.encodeFileURL(imagePath)}?v=${paths.cacheKeyForStats(stats)}`;
    encodedPath = this._svgBlobUrl(encodedPath, imagePath);
    return this.startRealmImageLoad("navigation", {
      source: encodedPath,
      onLoad: (image) => {
        const imageData = this.calculateZoomForImage(image, encodedPath);
        this.applyImageWithMetadata(imagePath, imageData);
        this.noteShownFile(imagePath, stats);
        this.hideSpinner();
      },
      onError: () => {
        this.hideSpinner();
        lumine.notifications.addError("Failed to load image", {
          description: `Could not load ${imagePath}`,
        });
      },
      onCancel: (reason) => {
        if (reason === "destroyed") this.hideSpinner();
      },
    });
  }

  calculateZoomForImage(img, encodedPath) {
    const newWidth = img.naturalWidth;
    const newHeight = img.naturalHeight;
    let zoom, translateX, translateY;

    if (this.auto) {
      zoom = Math.min(
        this.refs.imageContainer.offsetWidth / newWidth,
        this.refs.imageContainer.offsetHeight / newHeight,
      );
      if (lumine.config.get("image-editor.autoZoomLimit")) zoom = Math.min(zoom, 1);
    } else {
      zoom = this.zoom;
    }

    const imageWidth = newWidth * zoom;
    const imageHeight = newHeight * zoom;
    translateX = (this.refs.imageContainer.offsetWidth - imageWidth) / 2;
    translateY = (this.refs.imageContainer.offsetHeight - imageHeight) / 2;

    return { img, encodedPath, width: newWidth, height: newHeight, zoom, translateX, translateY };
  }

  applyImageWithMetadata(imagePath, imageData) {
    this.originalWidth = imageData.width;
    this.originalHeight = imageData.height;
    this.zoom = imageData.zoom;
    this.translateX = imageData.translateX;
    this.translateY = imageData.translateY;

    this._applyTransform();
    this.setImageSource(imageData.encodedPath);
    this._skipNextReload = true;
    this.lastSelfWrite = null;
    this.editor.load(imagePath);
    this.historyManager.reset();
    this.setSelectionVisibility(false);
    this.loaded = true;
    this.refs.image.style.display = "";
    this.emitter.emit("did-update");
    this.emitter.emit("did-load");
  }

  ensureInitialHistorySaved() {
    if (this.readOnly) return false;
    this.editor.terminatePendingState();
    this.historyManager.ensureInitialSaved(() => this.saveToHistory());
    return true;
  }

  _svgBlobUrl(imageUrl, filePath) {
    filePath = filePath || this.editor.getPath();
    if (!filePath || path.extname(filePath).toLowerCase() !== ".svg") return imageUrl;
    try {
      const svgContent = fs.readFileSync(filePath, "utf8");
      const match = svgContent.match(/<svg([^>]*)>/i);
      if (!match) return imageUrl;
      const attrs = match[1];

      // Already has valid numeric width and height, no fix needed
      const wVal = attrs.match(/\bwidth=["'](\d+(?:\.\d+)?)\s*(px)?["']/);
      const hVal = attrs.match(/\bheight=["'](\d+(?:\.\d+)?)\s*(px)?["']/);
      if (wVal && hVal && parseFloat(wVal[1]) > 0 && parseFloat(hVal[1]) > 0) return imageUrl;

      // Need viewBox to determine dimensions
      const vbMatch = attrs.match(/viewBox=["']([^"']+)/i);
      if (!vbMatch) return imageUrl;
      const parts = vbMatch[1].trim().split(/[\s,]+/);
      if (parts.length !== 4) return imageUrl;
      const w = parseFloat(parts[2]);
      const h = parseFloat(parts[3]);
      if (!(w > 0 && h > 0)) return imageUrl;

      // Strip existing width/height and inject numeric values from viewBox
      // Use data URL instead of blob URL to avoid canvas taint (cross-origin)
      const cleaned = attrs
        .replace(/\bwidth=["'][^"']*["']/g, "")
        .replace(/\bheight=["'][^"']*["']/g, "");
      const fixed = svgContent.replace(
        /<svg([^>]*)>/i,
        `<svg${cleaned} width="${w}" height="${h}">`,
      );
      return `data:image/svg+xml;base64,${Buffer.from(fixed).toString("base64")}`;
    } catch {
      // Keep the original URL when the SVG cannot be normalized.
    }
    return imageUrl;
  }

  getSelectionArea() {
    const hasVisibleSelection =
      this.refs.selectionBox && this.refs.selectionBox.style.display !== "none";
    return selection.getSelectionArea(
      this.selectionStartImg,
      this.selectionEndImg,
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
      hasVisibleSelection,
    );
  }

  setSelectionVisibility(visible) {
    this.selectionVisible = visible;
    this.refs.selectionBox.style.display = visible ? "block" : "none";
    this.emitter.emit("selection-visibility-changed", visible);
  }

  cropToSelection() {
    if (!this.refs.selectionBox || this.refs.selectionBox.style.display === "none") {
      lumine.notifications.addWarning("No selection", {
        description: "Please create a selection first by dragging with the left mouse button.",
      });
      return;
    }
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    this.historyManager.updateCurrentState({
      translateX: this.translateX,
      translateY: this.translateY,
      zoom: this.zoom,
      auto: this.auto,
    });

    const area = this.getSelectionArea();
    if (!area || area.width === 0 || area.height === 0) {
      lumine.notifications.addWarning("Invalid selection", {
        description: "Selection has no area.",
      });
      return;
    }

    this.ensureInitialHistorySaved();
    this.showSpinner();

    const sourceCanvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
    const canvas = transforms.cropImage(
      sourceCanvas,
      area.left,
      area.top,
      area.width,
      area.height,
      this.canvasPool,
    );

    const cropCenterX = this.translateX + (area.left + area.width / 2) * this.zoom;
    const cropCenterY = this.translateY + (area.top + area.height / 2) * this.zoom;

    this.commitCanvas(canvas, {
      releaseCanvas: () => this.returnCanvasToPool(canvas),
      message: "Image cropped",
      description: 'Image has been cropped to selection. Use "Save" to save changes.',
      onLoad: (width, height) => {
        if (this.auto) {
          this.zoomToFit();
        } else {
          // Keep what was cropped where it was on screen.
          this.translateX = cropCenterX - (width * this.zoom) / 2;
          this.translateY = cropCenterY - (height * this.zoom) / 2;
          this.updateTransform();
        }
        this.setSelectionVisibility(false);
      },
    });
  }

  blurImage(blurLevel) {
    if (!canvasFilters.supportsCanvasFilter(this.getDocument())) {
      lumine.notifications.addError("Blur is unavailable", {
        description: "This platform does not support canvas filters.",
      });
      return;
    }
    this.runFilterOperation({
      describe: (target) => `Blur level ${blurLevel} applied to ${target}`,
      // The slider is a standard deviation, which is what blur() takes, so the
      // doubling that fed the old approximation carries over unchanged.
      apply: (ctx, area) =>
        canvasFilters.blurRegion(ctx, area, blurLevel * 2, {
          // A selection blurs from its own pixels. The old loop could not
          // reach past the buffer it was handed, and a selection that pulled
          // in its surroundings would dissolve rather than soften.
          sampleWithinArea: area.hasSelection,
        }),
      defer: true,
      progressLabel: "blur",
    });
  }

  sharpenImage(strength) {
    // The preview over-sharpens, and there is no honest fix at this scale: the
    // kernel reaches exactly one pixel whatever the image is, so on a source
    // downscaled to 768px it reaches proportionally further than it will when
    // applied. Scaling the strength is not the same thing as scaling a radius.
    this.runFilterOperation({
      describe: (target) => `Sharpen applied to ${target}`,
      apply: (ctx, area) =>
        this.applyImageDataOperation(ctx, area, (data) =>
          filters.applySharpenKernel(data, area.width, area.height, strength),
        ),
      defer: true,
      progressLabel: "sharpen",
    });
  }

  applyGrayscale(amount = 100) {
    this.runFilterOperation({
      describe: (target) => `Grayscale ${amount}% applied to ${target}`,
      apply: (ctx, area) =>
        this.applyImageDataOperation(ctx, area, (data) =>
          filters.applyGrayscaleAmount(data, amount),
        ),
    });
  }

  invertColors() {
    this.runFilterOperation({
      describe: (target) => `Colors inverted on ${target}`,
      apply: (ctx, area) => this.applyImageDataOperation(ctx, area, filters.invertColors),
    });
  }

  applySepia() {
    this.runFilterOperation({
      describe: (target) => `Sepia tone applied to ${target}`,
      apply: (ctx, area) => this.applyImageDataOperation(ctx, area, filters.applySepia),
    });
  }

  applyBrightnessContrast(brightness, contrast) {
    this.runFilterOperation({
      describe: (target) => `Brightness & contrast adjusted on ${target}`,
      apply: (ctx, area) =>
        this.applyImageDataOperation(ctx, area, (data) =>
          filters.applyBrightnessContrast(data, brightness, contrast),
        ),
    });
  }

  applySaturation(saturation) {
    this.runFilterOperation({
      describe: (target) => `Saturation adjusted on ${target}`,
      apply: (ctx, area) =>
        this.applyImageDataOperation(ctx, area, (data) =>
          filters.applySaturation(data, saturation),
        ),
    });
  }

  applyHueShift(hueShift) {
    this.runFilterOperation({
      describe: (target) => `Hue shifted by ${hueShift}° on ${target}`,
      apply: (ctx, area) =>
        this.applyImageDataOperation(ctx, area, (data) => filters.applyHueShift(data, hueShift)),
      defer: true,
      progressLabel: "hue shift",
    });
  }

  applyPosterize(levels) {
    this.runFilterOperation({
      describe: (target) => `Posterized to ${levels} levels on ${target}`,
      apply: (ctx, area) =>
        this.applyImageDataOperation(ctx, area, (data) => filters.applyPosterize(data, levels)),
    });
  }

  autoAdjustColors() {
    this.runFilterOperation({
      describe: (target) => `Auto adjusted colors on ${target}`,
      apply: (ctx, area) => this.applyImageDataOperation(ctx, area, filters.autoAdjustColors),
    });
  }

  /**
   * Run an edit over the selection, or over the whole image when there is
   * none, and publish the result.
   *
   * Ten methods used to carry their own copy of this, and they had drifted:
   * four checked that the image was loaded and four did not, one asked for a
   * readback-friendly context and nine did not, one warned before a long
   * operation and the rest froze in silence, and every one of them ran the
   * whole filter on a read-only image before finding out it could not keep the
   * result.
   *
   * @param {object} options
   * @param {(target: string) => string} options.describe
   *   Success message; `target` reads "selection" or "image".
   * @param {(ctx: CanvasRenderingContext2D, area: object) => void} options.apply
   *   Mutates `ctx`, which already holds the image at 1:1, within `area`.
   * @param {boolean} [options.defer=false]
   *   Let a frame paint before starting, so the spinner is on screen for an
   *   edit that will take a while.
   * @param {string} [options.progressLabel]
   *   Names the operation in a notice shown for a large area.
   */
  runFilterOperation({ describe, apply, defer = false, progressLabel = null }) {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    // Up front: the work is thrown away on a read-only image, so there is no
    // reason to do it first and say so afterwards.
    if (this.readOnly) {
      lumine.notifications.addWarning("This image is read-only");
      return;
    }

    let area = this.getSelectionArea();
    if (!area) {
      // A selection can be visible and still have no area — dragged flat, or
      // resized onto its own edge. Rather than refuse, drop it and treat the
      // whole image as the target, which is what auto-adjust alone used to do.
      this.setSelectionVisibility(false);
      area = this.getSelectionArea();
    }
    if (!area) {
      lumine.notifications.addWarning("Invalid selection", {
        description: "Selection has no area.",
      });
      return;
    }

    // Silently, because these are bound to bare keys: holding one repeats
    // faster than the two frames a deferred filter waits, and the point is to
    // drop the repeats, not to report each one.
    if (this.filterInProgress) return;

    this.ensureInitialHistorySaved();

    if (progressLabel && area.width * area.height > 2000000) {
      lumine.notifications.addInfo(`Processing ${progressLabel}...`, {
        description: "This may take a moment for large images.",
        dismissable: true,
      });
    }

    const run = () => {
      const canvas = this.getPooledCanvas(
        this.refs.image.naturalWidth,
        this.refs.image.naturalHeight,
      );
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(this.refs.image, 0, 0);

      apply(ctx, area);

      this.commitCanvas(canvas, {
        releaseCanvas: () => this.returnCanvasToPool(canvas),
        message: describe(area.hasSelection ? "selection" : "image"),
        onLoad: () => this.updateTransform(),
        onError: () => {
          this.filterInProgress = false;
        },
      });
      this.filterInProgress = false;
    };

    if (!defer) {
      run();
      return;
    }

    // Two frames, not one: a callback runs before the frame it was scheduled
    // for is painted, so a single one would still start the work with the
    // spinner unpainted.
    this.scheduleDeferredFilterRun(run);
  }

  scheduleDeferredFilterRun(run) {
    this.cancelDeferredFilterFrame({ preserve: true });
    this.pendingFilterRun = run;
    this.filterInProgress = true;
    this.showSpinner();
    const domWindow = this.getWindow();
    this.deferredFilterRAFWindow = domWindow;
    this.deferredFilterRAF = domWindow.requestAnimationFrame(() => {
      if (this.pendingFilterRun !== run || this.deferredFilterRAFWindow !== domWindow) return;
      this.deferredFilterRAF = domWindow.requestAnimationFrame(() => {
        if (this.pendingFilterRun !== run || this.deferredFilterRAFWindow !== domWindow) return;
        this.deferredFilterRAF = null;
        this.deferredFilterRAFWindow = null;
        this.pendingFilterRun = null;
        run();
      });
    });
  }

  cancelDeferredFilterFrame({ preserve = false } = {}) {
    if (this.deferredFilterRAF != null) {
      try {
        this.deferredFilterRAFWindow?.cancelAnimationFrame(this.deferredFilterRAF);
      } catch {
        // A recovery transition may start after the owning Window has closed.
      }
    }
    this.deferredFilterRAF = null;
    this.deferredFilterRAFWindow = null;
    if (!preserve) {
      this.pendingFilterRun = null;
      this.filterInProgress = false;
    }
  }

  /** Read `area` out of `ctx`, hand it to a filters.js function, write it back. */
  applyImageDataOperation(ctx, area, mutate) {
    const imageData = ctx.getImageData(area.left, area.top, area.width, area.height);
    mutate(imageData);
    ctx.putImageData(imageData, area.left, area.top);
  }

  /**
   * Show what a canvas holds and record it as an undo state.
   *
   * The canvas is encoded once. That encode is both what the image element
   * displays and what the history keeps, where the two used to be separate
   * passes over the same pixels — the second of them synchronous, and preceded
   * by a fresh full-size canvas and a redraw of the image into it.
   *
   * A compact frame is the one case that still encodes twice, and there the
   * second pass is the point: the displayed copy has to stay lossless, because
   * every later edit reads its pixels back out of the image element, so making
   * it lossy would compound the loss edit over edit.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {object} [options]
   * @param {Function} [options.releaseCanvas] called once every encode has read it
   * @param {boolean} [options.recordHistory=true] false for a live preview
   * @param {boolean} [options.spinner=true]
   * @param {string} [options.message] success notification, when enabled
   * @param {string} [options.description] second line of that notification
   * @param {(width: number, height: number) => void} [options.onLoad] viewport work
   * @param {Function} [options.onError]
   */
  commitCanvas(
    canvas,
    {
      releaseCanvas = null,
      recordHistory = true,
      spinner = true,
      message = null,
      description = 'Use "Save" to save changes.',
      onLoad = null,
      onError = null,
      onCancel = null,
      isCurrent = () => true,
      purpose = "canvas-commit",
    } = {},
  ) {
    // A read-only image still shows what a transform did to it — the SVG paths
    // have always rasterised and rotated on screen, and Save As is how that
    // gets kept. What it does not get is an undo state, which is the line
    // saveToHistory has always drawn. Filters refuse earlier, in
    // runFilterOperation, before any of the work is done.
    if (this.readOnly) recordHistory = false;

    if (spinner) this.showSpinner();

    // Read now: the pool resizes what it recycles, so once the canvas has been
    // handed back these no longer describe what was encoded.
    const width = canvas.width;
    const height = canvas.height;

    const entry = recordHistory
      ? this.historyManager.beginEntry(
          {
            translateX: this.translateX,
            translateY: this.translateY,
            zoom: this.zoom,
            auto: this.auto,
          },
          { width, height },
        )
      : null;

    const finish = () => {
      this.hideSpinner();
    };

    canvas.toBlob((displayBlob) => {
      if (this._destroyed || !displayBlob || !isCurrent()) {
        if (releaseCanvas) releaseCanvas();
        this.historyManager.abandonEntry(entry);
        this.hideSpinner();
        if (!isCurrent()) onCancel?.();
        else onError?.();
        return;
      }

      if (!entry) {
        if (releaseCanvas) releaseCanvas();
      } else if (!entry.compact) {
        if (releaseCanvas) releaseCanvas();
        this.historyManager.settleEntry(entry, displayBlob);
      } else {
        canvas.toBlob(
          (compactBlob) => {
            if (releaseCanvas) releaseCanvas();
            this.historyManager.settleEntry(entry, compactBlob || displayBlob);
          },
          ...encodingFor(entry),
        );
      }

      const displayUrl = URL.createObjectURL(displayBlob);
      void this.startDisplayImageLoad({
        source: displayUrl,
        purpose,
        onCancel: (reason) => {
          this._releaseImageUrl(displayUrl);
          if (reason === "destroyed") finish();
          onCancel?.(reason);
        },
        onLoad: () => {
          if (!isCurrent()) {
            finish();
            onCancel?.();
            return;
          }
          finish();
          this.originalWidth = width;
          this.originalHeight = height;
          onLoad?.(width, height);
          this.emitter.emit("did-update");

          if (message && lumine.config.get("image-editor.showSuccessMessages")) {
            lumine.notifications.addSuccess(message, { description });
          }
        },
        onError: () => {
          finish();
          onError?.();
        },
      }).catch((error) => {
        finish();
        onError?.(error);
      });
    }, "image/png");
  }

  rotate(degrees) {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    this.ensureInitialHistorySaved();
    this.showSpinner();

    const sourceCanvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
    const canvas = transforms.rotateImage(sourceCanvas, degrees, this.canvasPool);

    this.commitCanvas(canvas, {
      releaseCanvas: () => {
        this.returnCanvasToPool(sourceCanvas);
        this.returnCanvasToPool(canvas);
      },
      message: "Image rotated",
      description: `Rotated ${Math.abs(degrees)}° ${
        degrees === 180 ? "" : degrees > 0 ? "clockwise" : "counter-clockwise"
      }. Use "Save" to save changes.`,
      onLoad: (width, height) => {
        if (this.auto) {
          let zoom = Math.min(
            this.refs.imageContainer.offsetWidth / width,
            this.refs.imageContainer.offsetHeight / height,
          );
          zoom = Math.min(zoom, 1);
          this.zoom = Math.min(Math.max(zoom, 0.001), 100);
          this.translateX = (this.refs.imageContainer.offsetWidth - width * this.zoom) / 2;
          this.translateY = (this.refs.imageContainer.offsetHeight - height * this.zoom) / 2;
        }
        this._applyTransform();
        this.setSelectionVisibility(false);
      },
    });
  }

  freeRotate(degrees, trim = true) {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    this.ensureInitialHistorySaved();
    this.showSpinner();

    const sourceCanvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
    const canvas = transforms.freeRotateImage(
      sourceCanvas,
      degrees,
      { expandCanvas: true, trim },
      this.canvasPool,
    );
    this.returnCanvasToPool(sourceCanvas);

    this.commitCanvas(canvas, {
      releaseCanvas: () => this.returnCanvasToPool(canvas),
      message: "Image rotated",
      description: `Rotated ${degrees} deg${trim ? " and trimmed" : ""}. Use "Save" to save changes.`,
      onLoad: () => {
        if (this.auto) this.zoomToFit();
        else this.updateTransform();
        this.setSelectionVisibility(false);
      },
    });
  }

  flipHorizontal() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    this.ensureInitialHistorySaved();
    this.showSpinner();

    const sourceCanvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
    const canvas = transforms.flipHorizontal(sourceCanvas, this.canvasPool);

    this.commitCanvas(canvas, {
      releaseCanvas: () => {
        this.returnCanvasToPool(sourceCanvas);
        this.returnCanvasToPool(canvas);
      },
      message: "Image flipped",
      description: 'Flipped horizontally. Use "Save" to save changes.',
      onLoad: () => {
        this.updateTransform();
        this.setSelectionVisibility(false);
      },
    });
  }

  flipVertical() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    this.ensureInitialHistorySaved();
    this.showSpinner();

    const sourceCanvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
    const canvas = transforms.flipVertical(sourceCanvas, this.canvasPool);

    this.commitCanvas(canvas, {
      releaseCanvas: () => {
        this.returnCanvasToPool(sourceCanvas);
        this.returnCanvasToPool(canvas);
      },
      message: "Image flipped",
      description: 'Flipped vertically. Use "Save" to save changes.',
      onLoad: () => {
        this.updateTransform();
        this.setSelectionVisibility(false);
      },
    });
  }

  resizeImage(newWidth, newHeight) {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    if (newWidth < 1 || newHeight < 1 || newWidth > 10000 || newHeight > 10000) {
      lumine.notifications.addError("Invalid dimensions", {
        description: "Width and height must be between 1 and 10000 pixels.",
      });
      return;
    }

    this.ensureInitialHistorySaved();
    this.showSpinner();

    const oldWidth = this.refs.image.naturalWidth;
    const oldHeight = this.refs.image.naturalHeight;
    const sourceCanvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
    const canvas = transforms.resizeImage(sourceCanvas, newWidth, newHeight, this.canvasPool);

    this.commitCanvas(canvas, {
      releaseCanvas: () => {
        this.returnCanvasToPool(sourceCanvas);
        this.returnCanvasToPool(canvas);
      },
      message: "Image resized",
      description: `Resized from ${oldWidth}×${oldHeight} to ${newWidth}×${newHeight}. Use "Save" to save changes.`,
      onLoad: () => {
        if (this.auto) this.zoomToFit();
        else this.updateTransform();
        this.setSelectionVisibility(false);
      },
    });
  }

  async save() {
    if (!this.loaded) {
      lumine.notifications.addError("No image to save");
      return false;
    }
    if (this.readOnly) {
      lumine.notifications.addWarning("This image is read-only");
      return false;
    }

    const currentPath = this.editor.getPath();
    if (!currentPath) return this.saveImage();

    this.isSaving = true;
    // Resolves when the bytes are on disk, not when the request is made. The
    // encode and the write are both callbacks, so awaiting this used to mean
    // nothing, and a caller that needed the file written had to poll.
    return new Promise((resolve) => {
      try {
        fileOps.saveImage(
          this.refs.image,
          currentPath,
          (path, stats) => {
            this.historyManager.reset();
            this.noteSelfWrite(path, stats);
            // The bytes just written are the ones on screen, so this is the
            // revision being shown now. Without it the record goes on naming
            // the revision from before the edit, and a later restore of that
            // file would be waved through as already displayed.
            this.noteShownFile(path, stats);
            this.editor.didSave();
            this.isSaving = false;
            if (lumine.config.get("image-editor.showSuccessMessages")) {
              lumine.notifications.addSuccess("Image saved", { description: `Saved to ${path}` });
            }
            resolve(true);
          },
          (error) => {
            this.isSaving = false;
            lumine.notifications.addError("Failed to save image", { description: error.message });
            resolve(false);
          },
        );
      } catch (error) {
        this.isSaving = false;
        lumine.notifications.addError("Failed to save image", { description: error.message });
        resolve(false);
      }
    });
  }

  async saveImage() {
    if (!this.loaded) {
      lumine.notifications.addError("No image to save");
      return false;
    }

    return new Promise((resolve) => {
      fileOps.saveImageAs(
        this.refs.image,
        this.editor.getPath(),
        (path, stats) => {
          this.historyManager.reset();
          this.noteSelfWrite(path, stats);
          this.noteShownFile(path, stats);
          if (this.editor.getPath() !== path) {
            this._skipNextReload = true;
            this.editor.load(path);
          }
          this.editor.didSave();
          if (lumine.config.get("image-editor.showSuccessMessages")) {
            lumine.notifications.addSuccess("Image saved", { description: `Saved to ${path}` });
          }
          resolve(true);
        },
        (error) => {
          lumine.notifications.addError("Failed to save image", { description: error.message });
          resolve(false);
        },
      );
    });
  }

  // Record the file this view just wrote, so the watcher event that write raises
  // can be told apart from a genuine external change.
  noteSelfWrite(filePath, stats) {
    this.lastSelfWrite = stats
      ? { path: filePath, mtimeMs: stats.mtimeMs, size: stats.size }
      : null;
  }

  isSelfWrite(filePath, stats) {
    const write = this.lastSelfWrite;
    return Boolean(
      write &&
      stats &&
      write.path === filePath &&
      write.mtimeMs === stats.mtimeMs &&
      write.size === stats.size,
    );
  }

  // Record the revision of the file the <img> is currently showing. Kept apart
  // from lastSelfWrite, which answers a different question — that one is about
  // a write this view made, this one about what is on screen however it got
  // there.
  noteShownFile(filePath, stats) {
    this.shownFile = stats
      ? { path: filePath, mtimeMs: stats.mtimeMs, size: stats.size, at: Date.now() }
      : null;
  }

  // Compared field by field rather than against refs.image.src, which is not
  // the string we built: the URL parser moves a Windows drive letter out of the
  // host position, so `file://C:/x` comes back as `file:///C:/x`.
  isAlreadyShown(filePath, stats) {
    const shown = this.shownFile;
    // Expires, unlike lastSelfWrite. That one names a single write and costs
    // one skipped reload if it ever matched wrongly; this one is rewritten on
    // every load and cleared almost nowhere, so on a filesystem with coarse
    // timestamps a same-size rewrite inside one tick would otherwise stay
    // invisible for the life of the tab.
    return Boolean(
      shown &&
      stats &&
      shown.path === filePath &&
      shown.mtimeMs === stats.mtimeMs &&
      shown.size === stats.size &&
      Date.now() - shown.at < SHOWN_FILE_TRUST_MS,
    );
  }

  copyPathToClipboard() {
    this.copyFilePathToClipboard({
      title: "Path copied",
      getPath: (filePath) => filePath,
    });
  }

  copyProjectPathToClipboard() {
    this.copyFilePathToClipboard({
      title: "Project path copied",
      getPath: (filePath) => {
        const [_projectPath, relativePath] = lumine.project.relativizePath(filePath);
        return relativePath || filePath;
      },
    });
  }

  copyFilePathToClipboard({ title, getPath }) {
    const filePath = this.editor.getPath();
    if (!filePath) {
      lumine.notifications.addError("No file path available");
      return;
    }

    const text = getPath(filePath);
    lumine.clipboard.write(text);
    if (lumine.config.get("image-editor.showSuccessMessages")) {
      lumine.notifications.addSuccess(title, { description: text });
    }
  }

  copySelectionToClipboard() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    if (this.readOnly) return;

    let area;
    let isFullImage = false;

    if (!this.selectionVisible) {
      // No selection - copy entire image
      area = { left: 0, top: 0, width: this.originalWidth, height: this.originalHeight };
      isFullImage = true;
    } else {
      area = this.getSelectionArea();
      if (!area || area.width === 0 || area.height === 0) {
        // Fallback to entire image if selection is invalid
        area = { left: 0, top: 0, width: this.originalWidth, height: this.originalHeight };
        isFullImage = true;
      }
    }

    selection.copyToClipboard(
      this.refs.image,
      area.left,
      area.top,
      area.width,
      area.height,
      () => {
        if (lumine.config.get("image-editor.showSuccessMessages")) {
          lumine.notifications.addSuccess(isFullImage ? "Image copied" : "Selection copied", {
            description: isFullImage
              ? "Entire image copied to clipboard."
              : "Selection copied to clipboard.",
          });
        }
      },
      (error) => lumine.notifications.addError("Failed to copy", { description: error.message }),
    );
  }

  autoSelect(borderPercent = 0) {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    if (this.readOnly) return;

    const tolerance = lumine.config.get("image-editor.autoSelectTolerance") || 30;
    const result = selection.autoSelectContent(this.refs.image, tolerance, borderPercent);

    if (!result.success) {
      if (result.reason === "no-content") {
        lumine.notifications.addWarning("No content detected", {
          description:
            "Could not detect content boundaries. Try adjusting the tolerance in settings.",
        });
      } else if (result.reason === "entire-image") {
        lumine.notifications.addInfo("Entire image is content", {
          description: "No background detected. The entire image appears to be content.",
        });
      }
      return;
    }

    this.selectionStartImg = result.start;
    this.selectionEndImg = result.end;
    this.setSelectionVisibility(true);
    this.updateSelectionBox();

    if (lumine.config.get("image-editor.showSuccessMessages")) {
      const borderText = borderPercent > 0 ? ` with ${borderPercent}% border` : "";
      lumine.notifications.addSuccess(`Auto-selection complete${borderText}`, {
        description: `Selected ${result.width}x${result.height} px area.`,
      });
    }
  }

  selectAll() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    if (this.readOnly) return;

    this.selectionStartImg = { x: 0, y: 0 };
    this.selectionEndImg = {
      x: this.refs.image.naturalWidth - 1,
      y: this.refs.image.naturalHeight - 1,
    };
    this.setSelectionVisibility(true);
    this.updateSelectionBox();

    if (lumine.config.get("image-editor.showSuccessMessages")) {
      lumine.notifications.addSuccess("Selected entire image", {
        description: `Selected ${this.refs.image.naturalWidth}×${this.refs.image.naturalHeight} px.`,
      });
    }
  }

  selectVisibleArea() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    if (this.readOnly) return;

    const result = selection.getVisibleArea(
      this.refs.imageContainer.offsetWidth,
      this.refs.imageContainer.offsetHeight,
      this.translateX,
      this.translateY,
      this.zoom,
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
    );

    if (!result) {
      lumine.notifications.addWarning("No visible area", {
        description: "Image is not visible in the current viewport.",
      });
      return;
    }

    this.selectionStartImg = result.start;
    this.selectionEndImg = result.end;
    this.setSelectionVisibility(true);
    this.updateSelectionBox();

    if (lumine.config.get("image-editor.showSuccessMessages")) {
      lumine.notifications.addSuccess("Selected visible area", {
        description: `Selected ${result.width}×${result.height} px.`,
      });
    }
  }

  /**
   * Push the current settings into the history manager.
   *
   * Both limits used to be read once at construction and never again, so
   * changing either setting had no effect on an open editor for the rest of
   * the session.
   */
  _syncHistoryLimits() {
    this.historyManager.maxHistorySize = lumine.config.get("image-editor.maxHistorySize") || 50;
    this.historyManager.largeImagePixels =
      (lumine.config.get("image-editor.largeImagePixelThreshold") || 4) * 1e6;
  }

  saveToHistory() {
    if (!this.loaded || this.readOnly) return;

    const canvas = this.getPooledCanvas(
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
    );
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    // Capturing the pixels is synchronous, and so is claiming the slot below.
    // Only the encode is not, which is why no caller of this has to wait.
    ctx.drawImage(this.refs.image, 0, 0);

    const entry = this.historyManager.beginEntry(
      {
        translateX: this.translateX,
        translateY: this.translateY,
        zoom: this.zoom,
        auto: this.auto,
      },
      { width: canvas.width, height: canvas.height },
    );
    if (!entry) {
      this.returnCanvasToPool(canvas);
      return;
    }

    canvas.toBlob(
      (blob) => {
        // Returned here and not a line earlier: the pool resizes and clears
        // what it hands out, so giving it back before the encoder had read it
        // would record a blank frame.
        this.returnCanvasToPool(canvas);
        this.historyManager.settleEntry(entry, blob);
      },
      ...encodingFor(entry),
    );
  }

  isModified() {
    return this.historyManager.isModified();
  }

  async undo() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    if (!this.historyManager.canUndo()) {
      lumine.notifications.addWarning("Nothing to undo", {
        description: "Already at the oldest change.",
      });
      return;
    }

    const state = this.historyManager.undo();
    await this.loadFromHistory(state);

    if (lumine.config.get("image-editor.showSuccessMessages")) {
      const pos = this.historyManager.getPosition();
      lumine.notifications.addSuccess("Undo", {
        description: `Reverted to previous state (${pos.current}/${pos.total}).`,
      });
    }
  }

  async redo() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    if (!this.historyManager.canRedo()) {
      lumine.notifications.addWarning("Nothing to redo", {
        description: "Already at the newest change.",
      });
      return;
    }

    const state = this.historyManager.redo();
    await this.loadFromHistory(state);

    if (lumine.config.get("image-editor.showSuccessMessages")) {
      const pos = this.historyManager.getPosition();
      lumine.notifications.addSuccess("Redo", {
        description: `Restored to next state (${pos.current}/${pos.total}).`,
      });
    }
  }

  async loadFromHistory(historyEntry) {
    if (!historyEntry) return;

    this.showSpinner();

    const prevWidth = this.refs.image.naturalWidth;
    const prevHeight = this.refs.image.naturalHeight;
    const blob = await this.historyManager.blobFor(historyEntry);

    if (!blob) {
      this.hideSpinner();
      lumine.notifications.addWarning("That undo state could not be restored");
      return;
    }
    // Holding the key down can move the cursor past a frame while its encode
    // was still in flight, and the newer one is the one to show.
    if (this.historyManager.getCurrentState() !== historyEntry) {
      this.hideSpinner();
      return;
    }

    // Minted here and owned here, like every other source. The history keeps
    // the blob; a URL over it belongs to whoever is showing it.
    const source = URL.createObjectURL(blob);
    // A history frame is a re-encode, not the file. Undoing back to the first
    // one leaves isModified() false, so without this a watcher event would be
    // waved through as "already showing that file" and the re-encode would
    // stay on screen in place of the real pixels.
    this.shownFile = null;

    await this.startDisplayImageLoad({
      source,
      purpose: "history",
      onCancel: (reason) => {
        this._releaseImageUrl(source);
        if (reason === "destroyed") this.hideSpinner();
      },
      onLoad: () => {
        if (this.historyManager.getCurrentState() !== historyEntry) {
          this.hideSpinner();
          return;
        }
        // Taken from the entry rather than the decode: it is exact, it was
        // recorded when the frame was, and it needs nothing to have loaded.
        this.originalWidth = historyEntry.imageWidth;
        this.originalHeight = historyEntry.imageHeight;

        if (this.auto) {
          this.zoomToFit();
        } else {
          if (this.originalWidth !== prevWidth || this.originalHeight !== prevHeight) {
            this.zoom = historyEntry.zoom;
            this.translateX = historyEntry.translateX;
            this.translateY = historyEntry.translateY;
          }
          this._applyTransform();
        }

        this.setSelectionVisibility(false);
        this.emitter.emit("did-update");
        this.hideSpinner();
      },
      onError: () => this.hideSpinner(),
    });
  }

  showResizeDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    const currentWidth = this.refs.image.naturalWidth;
    const currentHeight = this.refs.image.naturalHeight;
    const aspectRatio = currentWidth / currentHeight;

    const backdrop = this.dialogs.createDialogBackdrop();
    const { dialogElement, cleanup: dialogCleanup } =
      this.dialogs.createDraggableDialog("Resize Image");
    dialogElement.classList.add("image-editor-preview-dialog");

    const infoElement = this.dialogs.createSelectionInfo(
      `Current size: ${currentWidth} × ${currentHeight} px`,
    );
    dialogElement.appendChild(infoElement);

    const { container: widthContainer, input: widthInput } = this.dialogs.createNumberInput({
      label: "Width (px)",
      default: currentWidth,
      min: 1,
      max: 10000,
    });
    const { container: heightContainer, input: heightInput } = this.dialogs.createNumberInput({
      label: "Height (px)",
      default: currentHeight,
      min: 1,
      max: 10000,
    });
    dialogElement.appendChild(widthContainer);
    dialogElement.appendChild(heightContainer);

    const { container: lockContainer, checkbox: lockCheckbox } = this.dialogs.createCheckbox(
      "lock-aspect-ratio",
      "Lock aspect ratio",
      true,
    );
    dialogElement.appendChild(lockContainer);

    const percentButtons = this.dialogs.createQuickButtons(
      [25, 50, 75, 100, 150, 200],
      (percent) => {
        widthInput.value = Math.round(currentWidth * (percent / 100));
        heightInput.value = Math.round(currentHeight * (percent / 100));
        scheduleResizePreview();
      },
      (v) => `${v}%`,
    );
    dialogElement.appendChild(percentButtons);

    const getResizeValues = () => [
      parseInt(widthInput.value) || currentWidth,
      parseInt(heightInput.value) || currentHeight,
    ];
    const previewPanel = this.dialogs.createPreviewPanel({
      sourceImage: this.refs.image,
      maxSourceSize: 1280,
      initialValues: getResizeValues(),
      renderPreview: (sourceCanvas, previewCanvas, values) => {
        this.renderResizePreview(sourceCanvas, previewCanvas, values[0], values[1]);
      },
      getOutputInfo: (values) => `Output: ${values[0]} x ${values[1]} px`,
    });
    dialogElement.appendChild(previewPanel.container);
    dialogElement.appendChild(previewPanel.infoElement);
    const scheduleResizePreview = () => previewPanel.schedulePreview(getResizeValues());
    const imageLoadDisposable = this.onDidLoad(() => previewPanel.refreshSource(getResizeValues()));

    let isUpdating = false;
    widthInput.addEventListener("input", () => {
      if (lockCheckbox.checked && !isUpdating) {
        isUpdating = true;
        heightInput.value = Math.round((parseInt(widthInput.value) || 1) / aspectRatio);
        isUpdating = false;
      }
      scheduleResizePreview();
    });
    heightInput.addEventListener("input", () => {
      if (lockCheckbox.checked && !isUpdating) {
        isUpdating = true;
        widthInput.value = Math.round((parseInt(heightInput.value) || 1) * aspectRatio);
        isUpdating = false;
      }
      scheduleResizePreview();
    });

    const { buttonContainer, cancelButton, applyButton } = this.dialogs.createButtonContainer(
      "Cancel",
      "Resize",
    );

    const cleanup = this.trackDialogCleanup(() => {
      previewPanel.cleanup();
      imageLoadDisposable.dispose();
      dialogCleanup();
      this.getDocument().removeEventListener("keydown", escapeHandler);
      if (this.getDocument().body.contains(backdrop)) this.getDocument().body.removeChild(backdrop);
    });

    cancelButton.addEventListener("click", cleanup);
    applyButton.addEventListener("click", () => {
      const newWidth = parseInt(widthInput.value) || currentWidth;
      const newHeight = parseInt(heightInput.value) || currentHeight;
      if (newWidth !== currentWidth || newHeight !== currentHeight) {
        this.resizeImage(newWidth, newHeight);
      }
      cleanup();
    });

    dialogElement.appendChild(buttonContainer);
    backdrop.appendChild(dialogElement);
    this.getDocument().body.appendChild(backdrop);

    const escapeHandler = (e) => {
      if (e.key === "Escape") cleanup();
    };
    this.getDocument().addEventListener("keydown", escapeHandler);

    previewPanel.renderNow(getResizeValues());
    widthInput.focus();
    widthInput.select();
  }

  showRotateAngleDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    const backdrop = this.dialogs.createDialogBackdrop();
    const { dialogElement, cleanup: dialogCleanup } =
      this.dialogs.createDraggableDialog("Rotate Image");
    dialogElement.classList.add("image-editor-rotate-dialog");

    const formatAngle = (value) => `${Number.parseFloat(value || 0).toFixed(1)} deg`;

    const {
      container: sliderContainer,
      slider: angleSlider,
      valueLabel,
    } = this.dialogs.createSliderControl({
      label: "Angle (degrees)",
      min: -180,
      max: 180,
      default: 0,
      step: 0.1,
    });
    valueLabel.textContent = formatAngle(0);
    valueLabel.classList.add("dialog-angle-value");
    valueLabel.parentElement.removeChild(valueLabel);
    dialogElement.appendChild(sliderContainer);

    const quickButtons = this.dialogs.createQuickButtons(
      [-45, -30, -15, 0, 15, 30, 45],
      (angle) => {
        angleSlider.value = angle;
        valueLabel.textContent = formatAngle(angle);
        schedulePreview();
      },
      (angle) => formatAngle(angle),
    );
    quickButtons.classList.add("dialog-quick-angle-buttons");
    quickButtons.appendChild(valueLabel);
    dialogElement.appendChild(quickButtons);

    const { container: trimContainer, checkbox: trimCheckbox } = this.dialogs.createCheckbox(
      "trim-rotated-image",
      "Trim empty corners",
      true,
    );
    trimContainer.classList.add("dialog-checkbox-row");
    trimContainer.style.gap = "3px";
    trimCheckbox.style.margin = "0";
    dialogElement.appendChild(trimContainer);

    const previewPanel = this.dialogs.createPreviewPanel({
      sourceImage: this.refs.image,
      maxSourceSize: 1280,
      initialValues: [parseFloat(angleSlider.value), trimCheckbox.checked],
      renderPreview: (sourceCanvas, previewCanvas, values) => {
        this.renderRotatePreview(sourceCanvas, previewCanvas, values[0], values[1]);
      },
      getOutputInfo: (values) => this.getRotateOutputInfo(values[0], values[1]),
    });
    dialogElement.appendChild(previewPanel.container);
    dialogElement.appendChild(previewPanel.infoElement);

    const getPreviewValues = () => [parseFloat(angleSlider.value), trimCheckbox.checked];
    const schedulePreview = () => {
      previewPanel.schedulePreview(getPreviewValues());
    };

    angleSlider.addEventListener("input", () => {
      valueLabel.textContent = formatAngle(angleSlider.value);
      schedulePreview();
    });
    trimCheckbox.addEventListener("change", schedulePreview);
    const imageLoadDisposable = this.onDidLoad(() =>
      previewPanel.refreshSource(getPreviewValues()),
    );

    const { buttonContainer, cancelButton, applyButton } = this.dialogs.createButtonContainer(
      "Cancel",
      "Rotate",
    );

    const cleanup = this.trackDialogCleanup(() => {
      previewPanel.cleanup();
      imageLoadDisposable.dispose();
      dialogCleanup();
      this.getDocument().removeEventListener("keydown", escapeHandler);
      if (this.getDocument().body.contains(backdrop)) this.getDocument().body.removeChild(backdrop);
    });

    cancelButton.addEventListener("click", cleanup);
    applyButton.addEventListener("click", () => {
      const angle = parseFloat(angleSlider.value);
      if (angle !== 0) {
        this.freeRotate(angle, trimCheckbox.checked);
      }
      cleanup();
    });

    dialogElement.appendChild(buttonContainer);
    backdrop.appendChild(dialogElement);
    this.getDocument().body.appendChild(backdrop);

    const escapeHandler = (e) => {
      if (e.key === "Escape") cleanup();
    };
    this.getDocument().addEventListener("keydown", escapeHandler);

    previewPanel.renderNow(getPreviewValues());
    angleSlider.focus();
  }

  renderRotatePreview(sourceCanvas, previewCanvas, angle, trim) {
    const rotatedCanvas = transforms.freeRotateImage(sourceCanvas, angle, {
      expandCanvas: true,
      trim,
    });
    const ctx = previewCanvas.getContext("2d");
    const scale = Math.min(
      previewCanvas.width / rotatedCanvas.width,
      previewCanvas.height / rotatedCanvas.height,
    );
    const width = Math.max(1, Math.round(rotatedCanvas.width * scale));
    const height = Math.max(1, Math.round(rotatedCanvas.height * scale));
    const left = Math.round((previewCanvas.width - width) / 2);
    const top = Math.round((previewCanvas.height - height) / 2);

    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(rotatedCanvas, left, top, width, height);
  }

  getRotateOutputInfo(angle, trim) {
    const outputSourceWidth = this.refs.image.naturalWidth;
    const outputSourceHeight = this.refs.image.naturalHeight;
    const outputSize = trim
      ? transforms.calculateTrimmedRotationSize(outputSourceWidth, outputSourceHeight, angle)
      : transforms.calculateRotatedBounds(outputSourceWidth, outputSourceHeight, angle);
    return `Output: ${outputSize.width} x ${outputSize.height} px`;
  }

  drawCanvasIntoPreview(sourceCanvas, previewCanvas) {
    const ctx = previewCanvas.getContext("2d");
    const scale = Math.min(
      previewCanvas.width / sourceCanvas.width,
      previewCanvas.height / sourceCanvas.height,
    );
    const width = Math.max(1, Math.round(sourceCanvas.width * scale));
    const height = Math.max(1, Math.round(sourceCanvas.height * scale));
    const left = Math.round((previewCanvas.width - width) / 2);
    const top = Math.round((previewCanvas.height - height) / 2);

    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(sourceCanvas, left, top, width, height);
  }

  renderResizePreview(sourceCanvas, previewCanvas, outputWidth, outputHeight) {
    const safeWidth = Math.max(1, outputWidth);
    const safeHeight = Math.max(1, outputHeight);
    const outputAspect = safeWidth / safeHeight;
    const previewAspect = previewCanvas.width / previewCanvas.height;
    let width;
    let height;

    if (outputAspect > previewAspect) {
      width = previewCanvas.width;
      height = Math.max(1, Math.round(width / outputAspect));
    } else {
      height = previewCanvas.height;
      width = Math.max(1, Math.round(height * outputAspect));
    }

    const left = Math.round((previewCanvas.width - width) / 2);
    const top = Math.round((previewCanvas.height - height) / 2);
    const ctx = previewCanvas.getContext("2d");

    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(sourceCanvas, left, top, width, height);
  }

  getScaledPreviewArea(sourceCanvas, area) {
    if (!area || !area.hasSelection) {
      return {
        hasSelection: false,
        left: 0,
        top: 0,
        width: sourceCanvas.width,
        height: sourceCanvas.height,
      };
    }

    const scaleX = sourceCanvas.width / this.refs.image.naturalWidth;
    const scaleY = sourceCanvas.height / this.refs.image.naturalHeight;
    const left = Math.max(0, Math.min(sourceCanvas.width - 1, Math.floor(area.left * scaleX)));
    const top = Math.max(0, Math.min(sourceCanvas.height - 1, Math.floor(area.top * scaleY)));

    return {
      // Carried through, because a caller may need to treat a selection's
      // neighbourhood differently from the whole image's.
      hasSelection: true,
      left,
      top,
      width: Math.max(1, Math.min(sourceCanvas.width - left, Math.round(area.width * scaleX))),
      height: Math.max(1, Math.min(sourceCanvas.height - top, Math.round(area.height * scaleY))),
    };
  }

  /**
   * Preview options for an operation that works on a context rather than on
   * ImageData.
   *
   * A sibling of createAdjustmentPreviewOptions rather than a generalisation
   * of it, so the eight ImageData dialogs are left alone.
   *
   * @param {(ctx: CanvasRenderingContext2D, area: object, values: number[], scale: number) => void} applyToContext
   */
  createCanvasPreviewOptions(applyToContext, maxSourceSize = 768) {
    // One canvas for the whole dialog. A preview re-renders on every slider
    // pause, on mouse-up, on a selection change and on a resize, and each of
    // those used to allocate a fresh one of up to a megapixel.
    let working = null;
    const reusableCanvas = (width, height) => {
      if (!working) {
        working = this.getDocument().createElement("canvas");
        // Taken at creation, because a canvas ignores these on any later ask.
        working.getContext("2d");
      }
      if (working.width !== width || working.height !== height) {
        working.width = width;
        working.height = height;
      }
      return working;
    };

    return {
      sourceImage: this.refs.image,
      maxSourceSize,
      renderPreview: (sourceCanvas, previewCanvas, values, area) => {
        const outputCanvas = reusableCanvas(sourceCanvas.width, sourceCanvas.height);
        const outputCtx = outputCanvas.getContext("2d");
        outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        outputCtx.drawImage(sourceCanvas, 0, 0);

        const scale = sourceCanvas.width / this.refs.image.naturalWidth;
        applyToContext(outputCtx, this.getScaledPreviewArea(sourceCanvas, area), values, scale);

        this.drawCanvasIntoPreview(outputCanvas, previewCanvas);
      },
      getOutputInfo: () =>
        `Output: ${this.refs.image.naturalWidth} x ${this.refs.image.naturalHeight} px`,
    };
  }

  createAdjustmentPreviewOptions(applyPreview, maxSourceSize = 1024) {
    // One canvas for the whole dialog. A preview re-renders on every slider
    // pause, on mouse-up, on a selection change and on a resize, and each of
    // those used to allocate a fresh one of up to a megapixel.
    let working = null;
    const reusableCanvas = (width, height) => {
      if (!working) {
        working = this.getDocument().createElement("canvas");
        // Taken at creation, because a canvas ignores these on any later ask.
        working.getContext("2d", { willReadFrequently: true });
      }
      if (working.width !== width || working.height !== height) {
        working.width = width;
        working.height = height;
      }
      return working;
    };

    return {
      sourceImage: this.refs.image,
      maxSourceSize,
      renderPreview: (sourceCanvas, previewCanvas, values, area) => {
        const outputCanvas = reusableCanvas(sourceCanvas.width, sourceCanvas.height);
        const outputCtx = outputCanvas.getContext("2d", { willReadFrequently: true });
        outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        outputCtx.drawImage(sourceCanvas, 0, 0);

        const previewArea = this.getScaledPreviewArea(sourceCanvas, area);
        const imageData = outputCtx.getImageData(
          previewArea.left,
          previewArea.top,
          previewArea.width,
          previewArea.height,
        );
        applyPreview(imageData, previewArea.width, previewArea.height, values);
        outputCtx.putImageData(imageData, previewArea.left, previewArea.top);

        this.drawCanvasIntoPreview(outputCanvas, previewCanvas);
      },
      getOutputInfo: () =>
        `Output: ${this.refs.image.naturalWidth} x ${this.refs.image.naturalHeight} px`,
    };
  }

  showFreeRotateDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    const originalSrc = this.refs.image.src;
    // Held across the whole preview session and put back on cancel, so it has
    // to outlive every preview frame that replaces it in the meantime.
    this.pinImageUrl(originalSrc);
    const originalWidth = this.originalWidth;
    const originalHeight = this.originalHeight;
    const originalZoom = this.zoom;
    const originalTranslateX = this.translateX;
    const originalTranslateY = this.translateY;
    const originalAuto = this.auto;

    const backdrop = this.dialogs.createDialogBackdrop();
    const { dialogElement, cleanup: dialogCleanup } =
      this.dialogs.createDraggableDialog("Free Rotate");

    const {
      container: sliderContainer,
      slider: angleSlider,
      valueLabel,
    } = this.dialogs.createSliderControl({
      label: "Angle (degrees)",
      min: -180,
      max: 180,
      default: 0,
      step: 0.5,
    });
    dialogElement.appendChild(sliderContainer);

    const quickButtons = this.dialogs.createQuickButtons(
      [-45, -30, -15, 0, 15, 30, 45],
      (angle) => {
        angleSlider.value = angle;
        valueLabel.textContent = `${angle}°`;
        schedulePreview();
      },
      (v) => `${v}°`,
    );
    dialogElement.appendChild(quickButtons);

    const { container: expandContainer, checkbox: expandCheckbox } = this.dialogs.createCheckbox(
      "expand-canvas",
      "Expand canvas to fit rotated image",
      true,
    );
    dialogElement.appendChild(expandContainer);

    const { container: autoPreviewContainer, checkbox: autoPreviewCheckbox } =
      this.dialogs.createCheckbox("auto-preview", "Auto preview", false);
    dialogElement.appendChild(autoPreviewContainer);

    let previewTimeout = null;
    let keepResult = false;
    const cancelPreview = () => {
      if (previewTimeout) clearTimeout(previewTimeout);
      previewTimeout = null;
      this.rotatePreviewGeneration += 1;
      this.cancelRealmImageLoad("rotate-preview", "dialog-closed");
      this.cancelDisplayImageLoad("dialog-closed", "rotate-preview");
    };
    const schedulePreview = () => {
      if (!autoPreviewCheckbox.checked) return;
      if (previewTimeout) clearTimeout(previewTimeout);
      previewTimeout = setTimeout(
        () =>
          this.applyRotatePreview(
            originalSrc,
            originalWidth,
            originalHeight,
            parseFloat(angleSlider.value),
            expandCheckbox.checked,
          ),
        150,
      );
    };
    expandCheckbox.addEventListener("change", schedulePreview);

    angleSlider.addEventListener("input", () => {
      valueLabel.textContent = `${angleSlider.value}°`;
      schedulePreview();
    });

    autoPreviewCheckbox.addEventListener("change", () => {
      if (autoPreviewCheckbox.checked) {
        schedulePreview();
      } else {
        restoreOriginal();
      }
    });

    const restoreOriginal = () => {
      cancelPreview();
      this.restoreOriginalImage(
        originalSrc,
        originalWidth,
        originalHeight,
        originalZoom,
        originalTranslateX,
        originalTranslateY,
        originalAuto,
      );
    };

    const { buttonContainer, cancelButton, applyButton } = this.dialogs.createButtonContainer(
      "Cancel",
      "Rotate",
    );

    const cleanup = this.trackDialogCleanup(() => {
      cancelPreview();
      if (!keepResult && !this._destroyed) {
        this.restoreOriginalImage(
          originalSrc,
          originalWidth,
          originalHeight,
          originalZoom,
          originalTranslateX,
          originalTranslateY,
          originalAuto,
        );
      }
      dialogCleanup();
      this.getDocument().removeEventListener("keydown", escapeHandler);
      if (this.getDocument().body.contains(backdrop)) this.getDocument().body.removeChild(backdrop);
      // A no-op while it is still what the image is showing, which is exactly
      // the case after a cancel.
      this.unpinImageUrl(originalSrc);
    });

    cancelButton.addEventListener("click", cleanup);
    applyButton.addEventListener("click", () => {
      const angle = parseFloat(angleSlider.value);
      if (angle === 0) {
        cleanup();
        return;
      }
      restoreOriginal();
      keepResult = true;
      this.freeRotate(angle, expandCheckbox.checked);
      cleanup();
    });

    dialogElement.appendChild(buttonContainer);
    backdrop.appendChild(dialogElement);
    this.getDocument().body.appendChild(backdrop);

    const escapeHandler = (e) => {
      if (e.key === "Escape") cleanup();
    };
    this.getDocument().addEventListener("keydown", escapeHandler);

    angleSlider.focus();
  }

  applyRotatePreview(originalSrc, originalWidth, originalHeight, angle, expand) {
    const generation = ++this.rotatePreviewGeneration;
    this.cancelDisplayImageLoad("superseded", "rotate-preview");
    return this.startRealmImageLoad("rotate-preview", {
      source: originalSrc,
      restartOnTransition: false,
      onLoad: (image) => {
        if (generation !== this.rotatePreviewGeneration || this._destroyed) return;
        const sourceCanvas = transforms.imageToCanvas(image, this.canvasPool);
        const canvas = transforms.freeRotateImage(sourceCanvas, angle, expand, this.canvasPool);
        // A preview frame, not an edit: it is replaced by the next tick of the
        // slider and undoing to it would mean nothing. Said outright here rather
        // than left implicit in what this happens not to call.
        this.commitCanvas(canvas, {
          recordHistory: false,
          spinner: false,
          purpose: "rotate-preview",
          isCurrent: () => generation === this.rotatePreviewGeneration && !this._destroyed,
          releaseCanvas: () => {
            this.returnCanvasToPool(sourceCanvas);
            this.returnCanvasToPool(canvas);
          },
          onLoad: () => {
            if (this.auto) this.zoomToFit();
            else this.updateTransform();
          },
        });
      },
    });
  }

  restoreOriginalImage(
    originalSrc,
    originalWidth,
    originalHeight,
    originalZoom,
    originalTranslateX,
    originalTranslateY,
    originalAuto,
  ) {
    this.setImageSource(originalSrc);
    this.originalWidth = originalWidth;
    this.originalHeight = originalHeight;
    this.zoom = originalZoom;
    this.translateX = originalTranslateX;
    this.translateY = originalTranslateY;
    this.auto = originalAuto;
    if (this.auto) this.zoomToFit();
    else this._applyTransform();
    this.emitter.emit("did-update");
  }

  showBrightnessContrastDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    this.dialogs.showAdjustmentDialog(
      "Brightness & Contrast",
      [
        { label: "Brightness", min: -100, max: 100, default: 0, step: 1 },
        { label: "Contrast", min: -100, max: 100, default: 0, step: 1 },
      ],
      () => this.getSelectionArea(),
      (values) => this.applyBrightnessContrast(values[0], values[1]),
      this.emitter,
      this.createAdjustmentPreviewOptions((imageData, _width, _height, values) =>
        filters.applyBrightnessContrast(imageData, values[0], values[1]),
      ),
    );
  }

  showSaturationDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    this.dialogs.showAdjustmentDialog(
      "Saturation",
      [{ label: "Saturation", min: -100, max: 100, default: 0, step: 1 }],
      () => this.getSelectionArea(),
      (values) => this.applySaturation(values[0]),
      this.emitter,
      this.createAdjustmentPreviewOptions((imageData, _width, _height, values) =>
        filters.applySaturation(imageData, values[0]),
      ),
    );
  }

  showHueShiftDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    this.dialogs.showAdjustmentDialog(
      "Hue Shift",
      [{ label: "Hue", min: 0, max: 360, default: 0, step: 1 }],
      () => this.getSelectionArea(),
      (values) => this.applyHueShift(values[0]),
      this.emitter,
      this.createAdjustmentPreviewOptions((imageData, _width, _height, values) =>
        filters.applyHueShift(imageData, values[0]),
      ),
    );
  }

  showPosterizeDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    this.dialogs.showAdjustmentDialog(
      "Posterize",
      [{ label: "Levels", min: 2, max: 32, default: 8, step: 1 }],
      () => this.getSelectionArea(),
      (values) => this.applyPosterize(values[0]),
      this.emitter,
      this.createAdjustmentPreviewOptions((imageData, _width, _height, values) =>
        filters.applyPosterize(imageData, values[0]),
      ),
    );
  }

  showGrayscaleDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    this.dialogs.showAdjustmentDialog(
      "Grayscale",
      [{ label: "Amount", min: 0, max: 100, default: 100, step: 1 }],
      () => this.getSelectionArea(),
      (values) => this.applyGrayscale(values[0]),
      this.emitter,
      this.createAdjustmentPreviewOptions((imageData, _width, _height, values) =>
        filters.applyGrayscaleAmount(imageData, values[0]),
      ),
    );
  }

  showBlurDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    this.dialogs.showAdjustmentDialog(
      "Blur",
      [{ label: "Radius", min: 1, max: 50, default: 12, step: 1 }],
      () => this.getSelectionArea(),
      (values) => this.blurImage(values[0]),
      this.emitter,
      this.createCanvasPreviewOptions((ctx, area, values, scale) =>
        // Scaled by the same factor as the source it is being shown on, or the
        // preview would blur a 768px copy by a radius meant for the full image.
        canvasFilters.blurRegion(ctx, area, values[0] * 2 * scale, {
          sampleWithinArea: area.hasSelection,
        }),
      ),
    );
  }

  showSharpenDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    this.dialogs.showAdjustmentDialog(
      "Sharpen",
      [{ label: "Strength", min: 0.1, max: 3.0, default: 1.0, step: 0.1 }],
      () => this.getSelectionArea(),
      (values) => this.sharpenImage(values[0]),
      this.emitter,
      this.createAdjustmentPreviewOptions(
        (imageData, width, height, values) =>
          filters.applySharpenKernel(imageData, width, height, values[0]),
        768,
      ),
    );
  }

  async showPropertiesDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    if (!this.editor.getPath()) {
      lumine.notifications.addError("No file path available");
      return;
    }

    if (!fileOps.getFileStats(this.editor.getPath())) {
      lumine.notifications.addError("Cannot read file stats");
      return;
    }

    const backdrop = this.dialogs.createDialogBackdrop();
    const dialogElement = this.getDocument().createElement("div");
    dialogElement.className = "image-editor-properties-dialog";

    const titleElement = this.getDocument().createElement("h3");
    titleElement.className = "dialog-title";
    titleElement.textContent = "Image Properties";
    dialogElement.appendChild(titleElement);

    const table = this.getDocument().createElement("table");
    table.className = "properties-table";

    const addRow = (label, value) => {
      const row = this.getDocument().createElement("tr");
      const labelCell = this.getDocument().createElement("td");
      labelCell.className = "property-label";
      labelCell.textContent = label + ":";
      const valueCell = this.getDocument().createElement("td");
      valueCell.className = "property-value";
      valueCell.textContent = value;
      row.appendChild(labelCell);
      row.appendChild(valueCell);
      table.appendChild(row);
    };

    const currentPath = this.editor.getPath();
    const stats = fileOps.getFileStats(currentPath);
    const width = this.refs.image.naturalWidth;
    const height = this.refs.image.naturalHeight;
    const ext = path.extname(currentPath).toLowerCase();
    const formatMap = {
      ".png": "PNG",
      ".jpg": "JPEG",
      ".jpeg": "JPEG",
      ".gif": "GIF",
      ".bmp": "BMP",
      ".webp": "WebP",
      ".svg": "SVG",
    };

    addRow("File name", path.basename(currentPath));
    addRow("Folder", path.dirname(currentPath));
    addRow("Format", formatMap[ext] || ext.toUpperCase());
    addRow(
      "Dimensions",
      `${width} × ${height} pixels (${((width * height) / 1000000).toFixed(2)} MP)`,
    );
    addRow("Disk size", fileOps.formatBytes(stats.size));
    addRow("Memory size", fileOps.formatBytes(width * height * 4));
    addRow("Modified", fileOps.formatDate(stats.mtime));
    addRow("Created", fileOps.formatDate(stats.birthtime));

    const posInfo = await this.navigator.getPositionInfo(currentPath);
    if (posInfo) addRow("Position in folder", posInfo);

    if (this.historyManager.length > 0) {
      const pos = this.historyManager.getPosition();
      addRow("History", `${pos.current} / ${pos.total} states`);
    }

    dialogElement.appendChild(table);
    let refreshToken = 0;
    const refreshProperties = async () => {
      const token = ++refreshToken;
      const activePath = this.editor.getPath();
      table.innerHTML = "";

      if (!activePath) {
        addRow("Status", "No file path available");
        return;
      }

      const activeStats = fileOps.getFileStats(activePath);
      if (!activeStats) {
        addRow("Status", "Cannot read file stats");
        return;
      }

      const activeWidth = this.refs.image.naturalWidth;
      const activeHeight = this.refs.image.naturalHeight;
      const activeExt = path.extname(activePath).toLowerCase();

      addRow("File name", path.basename(activePath));
      addRow("Folder", path.dirname(activePath));
      addRow("Format", formatMap[activeExt] || activeExt.toUpperCase());
      addRow(
        "Dimensions",
        `${activeWidth} x ${activeHeight} pixels (${((activeWidth * activeHeight) / 1000000).toFixed(2)} MP)`,
      );
      addRow("Disk size", fileOps.formatBytes(activeStats.size));
      addRow("Memory size", fileOps.formatBytes(activeWidth * activeHeight * 4));
      addRow("Modified", fileOps.formatDate(activeStats.mtime));
      addRow("Created", fileOps.formatDate(activeStats.birthtime));

      const activePosInfo = await this.navigator.getPositionInfo(activePath);
      if (token !== refreshToken) return;
      if (activePosInfo) addRow("Position in folder", activePosInfo);

      if (this.historyManager.length > 0) {
        const pos = this.historyManager.getPosition();
        addRow("History", `${pos.current} / ${pos.total} states`);
      }
    };

    const { buttonContainer, applyButton } = this.dialogs.createButtonContainer("", "Close");
    applyButton.className = "btn btn-primary";
    buttonContainer.innerHTML = "";
    buttonContainer.appendChild(applyButton);
    buttonContainer.style.marginTop = "15px";

    const cleanup = this.trackDialogCleanup(() => {
      imageLoadDisposable.dispose();
      imageUpdateDisposable.dispose();
      this.getDocument().removeEventListener("keydown", escapeHandler);
      if (this.getDocument().body.contains(backdrop)) this.getDocument().body.removeChild(backdrop);
    });

    applyButton.addEventListener("click", cleanup);
    dialogElement.appendChild(buttonContainer);
    backdrop.appendChild(dialogElement);
    this.getDocument().body.appendChild(backdrop);

    const escapeHandler = (e) => {
      if (e.key === "Escape") cleanup();
    };
    this.getDocument().addEventListener("keydown", escapeHandler);
    const imageLoadDisposable = this.onDidLoad(refreshProperties);
    const imageUpdateDisposable = this.onDidUpdate(refreshProperties);

    await refreshProperties();
    applyButton.focus();
  }
};
