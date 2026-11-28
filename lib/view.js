/**
 * ImageEditorView - Main view component for the image editor
 * Orchestrates all modules for image editing functionality
 */

const fs = require("fs");
const path = require("path");
const { Emitter, CompositeDisposable, Disposable } = require("lumine");
const etch = require("@lumine-code/etch");
const $ = etch.dom;

// Import modular components
const filters = require("./filters");
const canvasFilters = require("./canvas-filters");
const transforms = require("./transforms");
const dialogUtils = require("./dialogs");
const fileOps = require("./file-ops");
const ImageDocument = require("./document");
const ImageNavigator = require("./navigation");
const selection = require("./selection");
const CanvasPool = require("./canvas-pool");
const ZoomController = require("./zoom-controller");
const MouseEventHandler = require("./view-mouse");
const OperationIndicator = require("./operation-indicator");
const paths = require("./paths");

const imageControlButton = (ref, label, glyph) =>
  $.button(
    { className: "btn icon-button", type: "button", ref, "aria-label": label },
    $.span({ className: "icon-button-glyph", "aria-hidden": "true" }, glyph),
  );

/** Only a blob: URL holds a reference that has to be handed back. */
/**
 * How long the record of what is on screen is taken at face value.
 *
 * Long enough to absorb the burst of watcher events one write raises, short
 * enough that a rewrite the timestamps cannot tell apart is picked up on the
 * next event rather than never.
 */
const SHOWN_FILE_TRUST_MS = 5000;
const MAX_ORIENTATION_IMAGE_DIMENSION = 4096;
const MIN_ORIENTATION_CONFIDENCE = 15;

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
  get document() {
    return this.element?.ownerDocument ?? globalThis.document;
  }
  get window() {
    return this.document.defaultView;
  }

  get dialogs() {
    return dialogUtils.forDocument(this.document);
  }

  didAttachToWindow() {
    this._bindWindowEvents();
    this._bindResizeObserver();
    if (this.deferredFilterRun) this.scheduleDeferredFilter();
  }

  didChangeWindow() {
    if (this.auto) this.applyAutoZoom({ immediate: true });
    else if (this.loaded) this.updateTransform({ immediate: true });
  }

  _bindResizeObserver() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new this.window.ResizeObserver(() => {
      // ResizeObserver runs before paint, after this frame's animation callbacks.
      // Deferring the transform again would paint the old viewport for one frame.
      if (this.auto) this.applyAutoZoom({ immediate: true });
    });
    this.resizeObserver.observe(this.refs.imageContainer);
  }

  prepareWindowChange() {
    for (const cancel of [...(this.activeDialogs ?? [])]) cancel();
    this.clearBoundaryOverlay();
    this.fileListView?.destroy();
    this.fileListView = null;
    this.cancelSmoothTransform();
    if (this.transformRAF) this.window.cancelAnimationFrame(this.transformRAF);
    this.transformRAF = null;
    this.cancelDeferredFilterFrame();
  }

  cancelWindowChange() {
    if (this.deferredFilterRun) this.scheduleDeferredFilter();
  }

  registerDialog(cancel) {
    this.activeDialogs ??= new Set();
    this.activeDialogs.add(cancel);
    return new Disposable(() => this.activeDialogs.delete(cancel));
  }

  showAdjustmentDialog(title, sliders, getSelectionArea, apply, emitter, previewOptions = null) {
    return this.dialogs.showAdjustmentDialog(
      title,
      sliders,
      getSelectionArea,
      apply,
      emitter,
      previewOptions,
      (cancel) => this.registerDialog(cancel),
    );
  }

  cancelDeferredFilterFrame() {
    this.deferredFilterGeneration = (this.deferredFilterGeneration ?? 0) + 1;
    if (this.deferredFilterFrame != null) this.deferredFilterCancel(this.deferredFilterFrame);
    this.deferredFilterCancel = null;
    this.deferredFilterFrame = this.deferredFilterFrameWindow = null;
  }

  scheduleDeferredFilter() {
    this.cancelDeferredFilterFrame();
    const generation = this.deferredFilterGeneration;
    this.deferredFilterFrameWindow = this.window;
    this.deferredFilterCancel = this.window.cancelAnimationFrame.bind(this.window);
    this.deferredFilterFrame = this.window.requestAnimationFrame(() => {
      if (generation !== this.deferredFilterGeneration || !this.deferredFilterRun) return;
      this.deferredFilterFrame = this.deferredFilterFrameWindow = null;
      this.deferredFilterCancel = null;
      if (--this.deferredFilterFramesLeft > 0) return this.scheduleDeferredFilter();
      const run = this.deferredFilterRun;
      this.deferredFilterRun = null;
      run();
    });
  }

  constructor(editor) {
    this.editor = editor;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.imageSize =
      editor.isTemporary() || editor.document.initialized
        ? 0
        : fs.statSync(this.editor.getPath()).size;
    this.loaded = false;
    this.navigationConfirmationPending = false;
    this.selectionStartImg = { x: 0, y: 0 };
    this.selectionEndImg = { x: 0, y: 0 };
    this.selectionVisible = false;
    Object.defineProperty(this, "isSaving", {
      get: () => this.editor.document.isSaving,
      set: (value) => {
        this.editor.document.setSaving(value);
      },
    });
    Object.defineProperty(this, "lastSelfWrite", {
      get: () => this.editor.document.lastSelfWrite,
      set: (value) => {
        this.editor.document.lastSelfWrite = value;
      },
    });
    this.shownFile = null;
    this._displayUrl = null;
    this._ownedImageUrl = null;
    this._pinnedImageUrls = new Set();
    this._destroyed = false;
    this.documentGeneration = 0;
    this.readOnly = editor.getPath() && path.extname(editor.getPath()).toLowerCase() === ".svg";
    this.smoothTransformRAF = null;

    // Initialize modular components
    this.canvasPool = new CanvasPool(3);
    this.zoomController = new ZoomController();
    this.zoomMode = "auto";
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
        if (!value) this.zoomMode = null;
        else if (!this.zoomMode) this.zoomMode = "auto";
        this.updateZoomButtonState();
      },
    });
    Object.defineProperty(this, "levels", {
      get: () => this.zoomController.levels,
    });

    // Initialize history manager
    Object.defineProperty(this, "historyManager", {
      get: () => this.editor.document.historyManager,
    });
    this._syncHistoryLimits();

    // Initialize navigator
    this.navigator = new ImageNavigator({
      extensions: paths.NAVIGABLE_EXTENSIONS,
      listDirectoryFiles: (directory) => require("./main").listDirectoryFiles(directory),
      watchDirectory: (directory, callback) =>
        require("./main").watchDirectory(directory, callback),
    });

    // Performance optimizations - cache config values
    this.lastWheelTime = 0;
    this.wheelDebounceDelay = lumine.config.get("image-editor.wheelNavigationDelay") || 150;
    this.largeImageThreshold =
      (lumine.config.get("image-editor.largeImageThreshold") || 2) * 1024 * 1024;

    etch.initialize(this);
    this.disposables.add(require("./main").registerView(this));
    this.operationIndicator = new OperationIndicator({
      element: this.refs.loadingSpinner,
      button: this.refs.operationCancelButton,
      badge: this.refs.operationQueueBadge,
      tooltips: lumine.tooltips,
      focusTarget: this.element,
      cancel: () => this.editor.document.operationQueue.cancel(),
    });
    this.disposables.add(this.operationIndicator);
    this.updateOperationIndicator();

    this.refs.image.style.display = "none";
    // The stylesheet hides the selection box, but getSelectionArea reads the
    // inline style, which starts empty and so read as "a selection is up" —
    // one of zero size, which every filter then refused as invalid. State it
    // inline so it agrees with the stylesheet and with selectionVisible.
    this.refs.selectionBox.style.display = "none";
    this.updateHistoryButtonState();
    this.updateImageURI();

    this._setupDisposables();
    this._setupTooltips();
    this._setupEventListeners();
    this._setupZoomControl();
    this._setupImagePosition();
    this.setupResizeHandles();
    this.disposables.add(lumine.views.addWindowParticipant(this.element, this));
    this.disposables.add(new Disposable(() => this.windowEvents?.dispose()));
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
    this.disposables.add(
      this.editor.onDidReplaceFile(() => {
        this.updateOperationIndicator();
        debouncedReload();
      }),
    );
    this.disposables.add(this.editor.onDidChange(debouncedReload));
    this.disposables.add(
      this.editor.onDidChangePixels((state) => {
        if (state.source !== this.editor) this.trackPixelSync(this.applySharedPixels(state));
      }),
    );
    this.disposables.add(this.editor.onDidChangeHistory(() => this.emitter.emit("did-update")));
    this.disposables.add(this.editor.onDidChangeOperations(() => this.updateOperationIndicator()));
    this.disposables.add(
      lumine.commands.add(
        this.element,
        require("./command-availability")(this, {
          "image-editor:reload": {
            description: "Read the image from disk again, discarding edits.",
            didDispatch: () => this.updateImageURI({ force: true }),
          },
          "image-editor:zoom-in": () => this.zoomIn(),
          "image-editor:zoom-out": () => this.zoomOut(),
          "image-editor:zoom-100": {
            isAvailable: () => this.canSetZoomPreset({ scale: 1 }),
            didDispatch: () => this.resetZoom(),
          },
          "image-editor:automatic-zoom": {
            description: "Fit the image automatically, respecting the auto zoom limit.",
            isAvailable: () => this.canSetZoomPreset({ mode: "auto" }),
            didDispatch: () => this.setZoomPreset({ mode: "auto" }),
          },
          "image-editor:zoom-to-selection": {
            description: "Zoom until the selected area fills the view.",
            didDispatch: () => this.zoomToSelection(),
          },
          "image-editor:center": {
            description: "Put the image back in the middle of the view.",
            didDispatch: () => this.centerImage(),
          },
          "image-editor:list": {
            description: "Search image filenames in this folder and open one.",
            didDispatch: () => this.showFileList(),
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
          "image-editor:resize-canvas-to-selection": {
            description: "Make the selection the canvas, adding transparent space where needed.",
            didDispatch: () => this.resizeCanvasToSelection(),
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
            didDispatch: () => this.runImageOperation("Blur", () => this.showBlurDialog()),
          },
          "image-editor:auto-rotate": {
            description: "Turn the image so its text reads upright.",
            didDispatch: () => this.autoRotate(),
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
            didDispatch: () =>
              this.runImageOperation("Rotate Image", () => this.showRotateAngleDialog()),
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
            didDispatch: () =>
              this.runImageOperation("Resize Image", () => this.showResizeDialog()),
          },
          "image-editor:grayscale": {
            description: "Drop the colour, leaving the image in greys.",
            didDispatch: () =>
              this.runImageOperation("Grayscale", () => this.showGrayscaleDialog()),
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
            didDispatch: () => this.runImageOperation("Sharpen", () => this.showSharpenDialog()),
          },
          "image-editor:brightness-contrast": {
            description: "Adjust the image's brightness and contrast together.",
            didDispatch: () =>
              this.runImageOperation("Brightness / Contrast", () =>
                this.showBrightnessContrastDialog(),
              ),
          },
          "image-editor:saturation": {
            description: "Adjust how strong the image's colours are.",
            didDispatch: () =>
              this.runImageOperation("Saturation", () => this.showSaturationDialog()),
          },
          "image-editor:hue-shift": {
            description: "Rotate every colour around the hue wheel.",
            didDispatch: () => this.runImageOperation("Hue Shift", () => this.showHueShiftDialog()),
          },
          "image-editor:posterize": {
            description: "Reduce the image to a few flat levels per channel.",
            didDispatch: () =>
              this.runImageOperation("Posterize", () => this.showPosterizeDialog()),
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
          "image-editor:undo": () => this.undo(),
          "image-editor:redo": () => this.redo(),
          "image-editor:hide-selection": {
            description: "Clear the selection without changing the image.",
            didDispatch: () =>
              this.runImageOperation("Clear Selection", () => this.hideSelection()),
          },
        }),
      ),
    );

    this.disposables.add(
      this.onDidUpdate(() => {
        this.updateHistoryButtonState();
        lumine.commands.invalidateAvailability();
      }),
      this.emitter.on("selection-visibility-changed", () =>
        lumine.commands.invalidateAvailability(),
      ),
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
        {
          title:
            "Edit zoom percentage. Middle-click for Automatic Zoom. Right-click for zoom levels.",
          keyBindingCommand: "image-editor:automatic-zoom",
        },
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
      [this.refs.undoButton, "click", () => this.undo()],
      [this.refs.redoButton, "click", () => this.redo()],
      [this.refs.prevImageButton, "click", () => this.previousImage()],
      [this.refs.firstImageButton, "click", () => this.firstImage()],
      [this.refs.nextImageButton, "click", () => this.nextImage()],
      [this.refs.lastImageButton, "click", () => this.lastImage()],
    ];

    buttonHandlers.forEach(([element, event, handler]) => {
      const handleMouseDown = (event) => event.preventDefault();
      const handleClick = (event) => {
        const keyboardActivation = event.detail === 0 && this.document.activeElement === element;
        handler(event);
        if (!keyboardActivation) this.element.focus();
      };
      element.addEventListener("mousedown", handleMouseDown);
      element.addEventListener(event, handleClick);
      this.disposables.add(
        new Disposable(() => {
          element.removeEventListener("mousedown", handleMouseDown);
          element.removeEventListener(event, handleClick);
        }),
      );
    });

    const controlsContextMenuHandler = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    this.refs.imageControls.addEventListener("contextmenu", controlsContextMenuHandler);
    this.disposables.add(
      new Disposable(() =>
        this.refs.imageControls.removeEventListener("contextmenu", controlsContextMenuHandler),
      ),
    );

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

    this._bindResizeObserver();

    this._setupMouseHandlers();
  }

  _setupZoomControl() {
    const { zoomToFitButton: field, zoomInput: input } = this.refs;
    input.disabled = !this.loaded;
    input.inputMode = "decimal";
    input.setAttribute("aria-label", "Zoom percentage");
    input.setAttribute("aria-haspopup", "menu");
    input.setAttribute("aria-expanded", "false");
    const focusImage = () => this.element.focus({ preventScroll: true });
    const reset = (event) => {
      if (event.button !== 1 || input.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      focusImage();
      lumine.commands.dispatch(this.element, "image-editor:automatic-zoom");
    };
    const menu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.showZoomMenu(event);
    };
    const keydown = (event) => {
      if (event.isComposing) return;
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        menu(event);
        return;
      }
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      const value = input.value;
      focusImage();
      if (event.key !== "Enter" || !this.loaded) return;
      if (value === this.zoomEditStart) return this.disableAutoZoom();
      const match = /^\s*(\d+(?:[.,]\d*)?|[.,]\d+)\s*%?\s*$/.exec(value);
      if (match) {
        const scale = Number(match[1].replace(",", ".")) / 100;
        lumine.commands.dispatch(this.element, "image-editor:set-zoom", { scale });
      }
    };
    const mousedown = (event) => {
      // Select the whole value on entry, then allow normal caret placement.
      if (event.button === 1 || (event.button === 0 && this.document.activeElement !== input))
        event.preventDefault();
    };
    const click = (event) => {
      if (event.button === 0 && !input.disabled && this.document.activeElement !== input) {
        event.preventDefault();
        input.focus({ preventScroll: true });
      } else reset(event);
    };
    const wheel = (event) => {
      if (this._destroyed || !this.loaded || event.defaultPrevented) return;
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? this.refs.imageContainer.clientHeight
            : 1;
      const delta = event.deltaY * unit;
      if (!Number.isFinite(delta) || delta === 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.zoomToCenterPoint(this.zoom * Math.exp(-delta * 0.002), { smooth: true });
    };
    const focus = () => {
      this.zoomEditStart = input.value;
      input.select();
    };
    const blur = () => (input.value = this.zoomController.getZoomPercentage());
    const listeners = [
      [field, "mousedown", mousedown],
      [field, "click", click],
      [field, "auxclick", reset],
      [field, "contextmenu", menu],
      [field, "wheel", wheel, { passive: false }],
      [input, "focus", focus],
      [input, "blur", blur],
      [input, "keydown", keydown],
    ];
    for (const [element, name, handler, options] of listeners)
      element.addEventListener(name, handler, options);
    this.disposables.add(
      this.onDidLoad(() => (input.disabled = false)),
      new Disposable(() => {
        for (const [element, name, handler] of listeners)
          element.removeEventListener(name, handler);
        this.zoomMenu?.close({ cancelled: true, restoreFocus: false });
      }),
    );
  }

  _setupMouseHandlers() {
    this.mouseMoveHandler = (event) => this.mouseHandler.handleMouseMove(event);
    this.mouseDownHandler = (event) => this.mouseHandler.handleMouseDown(event);
    this.mouseUpHandler = () => this.mouseHandler.handleMouseUp();
    this.contextMenuHandler = (event) => this.mouseHandler.handleContextMenu(event);
    this.doubleClickHandler = (event) => this.mouseHandler.handleDoubleClick(event);

    this.refs.imageContainer.addEventListener("mousedown", this.mouseDownHandler);
    this.refs.imageContainer.addEventListener("dblclick", this.doubleClickHandler);
    this._bindWindowEvents();
    this.disposables.add(
      new Disposable(() => {
        this.refs.imageContainer.removeEventListener("mousedown", this.mouseDownHandler);
        this.refs.imageContainer.removeEventListener("dblclick", this.doubleClickHandler);
      }),
    );
  }

  _bindWindowEvents() {
    this.windowEvents?.dispose();
    const window = this.window;
    window.addEventListener("mousemove", this.mouseMoveHandler);
    window.addEventListener("mouseup", this.mouseUpHandler);
    window.addEventListener("contextmenu", this.contextMenuHandler, true);
    this.windowEvents = new Disposable(() => {
      window.removeEventListener("mousemove", this.mouseMoveHandler);
      window.removeEventListener("mouseup", this.mouseUpHandler);
      window.removeEventListener("contextmenu", this.contextMenuHandler, true);
    });
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
  setImageSource(url, { own = true } = {}) {
    const previous = this._ownedImageUrl;
    this._displayUrl = url;
    this._ownedImageUrl = own && isBlobUrl(url) ? url : null;

    if (previous && previous !== url) {
      const image = this.refs.image;
      const release = () => {
        image.removeEventListener("load", release);
        image.removeEventListener("error", release);
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
    URL.revokeObjectURL(url);
  }

  destroy() {
    this.navigator.destroy();
    this._destroyed = true;
    this.editor.document.operationQueue.discardInvalid();
    this.updateHistoryButtonState();
    this.fileListView?.destroy();
    this._invalidateDocumentWork();
    if (this.loadingAbortController) {
      this.loadingAbortController.cancel();
      this.loadingAbortController = null;
    }
    if (this.refs.image) {
      this.refs.image.onload = null;
      this.refs.image.onerror = null;
      this.refs.image.removeAttribute("src");
    }
    if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
    this.clearBoundaryOverlay();
    this.cancelSmoothTransform();
    if (this.transformRAF) {
      this.window.cancelAnimationFrame(this.transformRAF);
      this.transformRAF = null;
    }
    this.disposables.dispose();
    this.emitter.dispose();
    this.resizeObserver.disconnect();
    this.canvasPool.clear();

    // Nothing is on screen any more, so the guard against revoking the current
    // source has nothing to protect.
    this._displayUrl = null;
    for (const url of this._pinnedImageUrls) URL.revokeObjectURL(url);
    this._pinnedImageUrls.clear();
    if (this._ownedImageUrl) URL.revokeObjectURL(this._ownedImageUrl);
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
          imageControlButton("firstImageButton", "First image", "<<"),
          imageControlButton("prevImageButton", "Previous image", "<"),
          imageControlButton("undoButton", "Undo", "↶"),
          imageControlButton("zoomOutButton", "Zoom out", "-"),
          $.label(
            { className: "btn image-position-field", ref: "imagePosition" },
            $.input({
              className: "image-position-input native-key-bindings",
              ref: "imagePositionInput",
              type: "number",
              min: "1",
              step: "1",
              inputmode: "numeric",
              "aria-label": "Image number",
              disabled: true,
            }),
            $.span({ className: "image-position-count", ref: "imagePositionCount" }, "/ –"),
          ),
          $.label(
            { className: "btn zoom-to-fit-button", ref: "zoomToFitButton" },
            $.input({
              className: "image-zoom-input native-key-bindings",
              ref: "zoomInput",
              type: "text",
            }),
          ),
          imageControlButton("zoomInButton", "Zoom in", "+"),
          imageControlButton("redoButton", "Redo", "↷"),
          imageControlButton("nextImageButton", "Next image", ">"),
          imageControlButton("lastImageButton", "Last image", ">>"),
        ),
        OperationIndicator.render($),
      ),
      $.div(
        { className: "image-container", ref: "imageContainer" },
        $.img({ ref: "image" }),
        $.div({ className: "image-frame", "aria-hidden": "true" }),
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

  _beginImageLoad(signal) {
    this.loadingAbortController?.cancel();
    if (this.reloadTimeout) {
      clearTimeout(this.reloadTimeout);
      this.reloadTimeout = null;
    }
    const controller = new AbortController();
    const load = {
      cancelled: false,
      signal: controller.signal,
      cancel() {
        this.cancelled = true;
        controller.abort();
      },
    };
    const abort = () => {
      load.cancel();
      if (!this._destroyed && load === this.loadingAbortController) this.hideSpinner();
    };
    signal?.addEventListener("abort", abort, { once: true });
    load.dispose = () => signal?.removeEventListener("abort", abort);
    this.loadingAbortController = load;
    if (signal?.aborted || this._destroyed) load.cancel();
    else this.showSpinner();
    return load;
  }

  _assertCurrentLoad(load) {
    if (this._destroyed || load.cancelled || load !== this.loadingAbortController) {
      throw new DOMException("Image load was cancelled", "AbortError");
    }
  }

  _finishImageLoad(load) {
    load.dispose();
    if (!this._destroyed && load === this.loadingAbortController) this.hideSpinner();
  }

  async updateImageURI(options = {}) {
    if (this._destroyed) return;
    const navigation = this.loadingAbortController;
    if (!options.force && navigation?.navigation && !navigation.cancelled) {
      // A watcher still belongs to the document being left. Let the explicit
      // replacement finish, and reread only if that document remains current.
      navigation.deferredReloadFile = this.editor.file;
      return;
    }
    if ((options.force || this.loaded) && !options.operation) {
      return this.runImageOperation("Reload Image", (operation) =>
        this.updateImageURI({ ...options, operation }),
      );
    }
    if (this.isSaving) return;
    const currentLoad = this._beginImageLoad(options.operation?.signal);
    currentLoad.operation = options.operation;
    try {
      if (!options.force && !this.loaded && this.editor.document.pixelBlob) {
        const sync = this.applySharedPixels({ blob: this.editor.document.pixelBlob }, currentLoad);
        this.trackPixelSync(sync);
        await sync;
        return;
      }
      const snapshot = this.editor._initialImageSnapshot;
      if (snapshot) {
        await this.loadImageOptimized(snapshot.dataUrl, false, currentLoad, true);
        this._assertCurrentLoad(currentLoad);
        this.historyManager.baselineModified = snapshot.modified;
        this.historyManager.emitModifiedStateIfChanged();
        if (this.editor._initialImageSnapshot === snapshot)
          delete this.editor._initialImageSnapshot;
        return;
      }
      if (this.editor.isTemporary()) {
        await this.loadImageOptimized(this.editor.getDataUrl(), false, currentLoad);
        return;
      }

      const filePath = this.editor.getPath();
      const previousFile = this.editor.file;
      const previousHistoryEntry = this.historyManager.getCurrentState();
      const stats = await fs.promises.stat(filePath);
      this._assertCurrentLoad(currentLoad);
      if (
        this.editor.file !== previousFile ||
        this.historyManager.getCurrentState() !== previousHistoryEntry
      ) {
        throw new DOMException("Image changed while reloading", "AbortError");
      }

      // The view already holds this revision, either from disk or from its own
      // write. Re-reading it would unnecessarily reset the history and viewport.
      if (
        !options.force &&
        (this.isSelfWrite(filePath, stats) || this.isAlreadyShown(filePath, stats))
      ) {
        this.editor.didObserveUnchangedFile();
        return;
      }
      if (!options.force && this.editor.getFileState() !== "unmodified") {
        this.editor.confirmExternalChange();
        return;
      }

      const imageUrl = `${this.editor.getEncodedURI()}?v=${
        options.force ? Date.now() : paths.cacheKeyForStats(stats)
      }`;
      await this.loadImageOptimized(imageUrl, stats.size > this.largeImageThreshold, currentLoad);
      this._assertCurrentLoad(currentLoad);
      this.imageSize = stats.size;
      this.noteShownFile(filePath, stats);
      this.editor.didReloadFromDisk();
      if (options.force) this.navigator.invalidateCache();
      // imageSize becomes known only once this revision has successfully loaded.
      this.emitter.emit("did-update");
    } catch (error) {
      if (!currentLoad.cancelled && !this._destroyed && error.name !== "AbortError") {
        if (!this.loaded) {
          lumine.notifications.addError(
            error.code === "ENOENT" ? "Image file not found" : "Failed to load image",
            {
              detail: `Path: ${this.editor.getPath()}\n\n${error.message}`,
              dismissable: true,
            },
          );
        }
      }
    } finally {
      this._finishImageLoad(currentLoad);
    }
  }

  // Decode off-screen so a failed or superseded request never replaces the
  // usable document. All requests, including watcher reloads, share one token.
  _decodeImage(imageUrl, isLargeImage, currentLoad) {
    this._assertCurrentLoad(currentLoad);
    return new Promise((resolve, reject) => {
      const image = new Image();
      const cleanup = () => {
        image.onload = null;
        image.onerror = null;
        currentLoad.signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        image.removeAttribute("src");
        reject(new DOMException("Image load was cancelled", "AbortError"));
      };
      currentLoad.signal.addEventListener("abort", abort, { once: true });
      image.onload = async () => {
        try {
          if (isLargeImage && image.decode) await image.decode();
          this._assertCurrentLoad(currentLoad);
          cleanup();
          resolve(image);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      image.onerror = () => {
        cleanup();
        reject(new Error("Failed to load image"));
      };
      image.src = imageUrl;
    });
  }

  async loadImageOptimized(imageUrl, isLargeImage, currentLoad, snapshot = false) {
    if (this.readOnly && !snapshot) imageUrl = this._svgBlobUrl(imageUrl);
    const previousFile = this.editor.file;
    const previousHistoryEntry = this.historyManager.getCurrentState();
    const image = await this._decodeImage(imageUrl, isLargeImage, currentLoad);
    this._assertCurrentLoad(currentLoad);
    if (
      this.isSaving ||
      this.editor.file !== previousFile ||
      this.historyManager.getCurrentState() !== previousHistoryEntry
    ) {
      throw new DOMException("Image changed while reloading", "AbortError");
    }
    const keepViewport =
      this.loaded &&
      !this.auto &&
      this.originalWidth === image.naturalWidth &&
      this.originalHeight === image.naturalHeight;
    const imageData = this.calculateZoomForImage(image, imageUrl, { fit: !keepViewport });
    if (keepViewport) {
      imageData.translateX = this.translateX;
      imageData.translateY = this.translateY;
    }
    const replacing = this.loaded;
    currentLoad.operation?.commit();
    this._applyLoadedImage(imageData);
    const presented = this.finishImagePresentation(currentLoad, () => this.restoreCopyViewState());
    if (!this.editor.document.initialized || replacing) {
      this.historyManager.reset();
      let sharedUrl = imageUrl;
      if (isBlobUrl(imageUrl)) {
        const canvas = this.getPooledCanvas(image.naturalWidth, image.naturalHeight);
        canvas.getContext("2d").drawImage(image, 0, 0);
        sharedUrl = canvas.toDataURL("image/png");
        this.returnCanvasToPool(canvas);
      }
      this.editor.document.publishPixels({
        url: sharedUrl,
        width: image.naturalWidth,
        height: image.naturalHeight,
        source: this.editor,
      });
    }
    await presented;
  }

  finishImagePresentation(load, restoreView) {
    const presented = this.refs.image
      .decode()
      .finally(() => this._assertCurrentLoad(load))
      .then(() => {
        this.loaded = true;
        restoreView?.();
        this.emitter.emit("did-update");
        this.emitter.emit("did-load");
      });
    this.trackPixelSync(presented);
    return presented;
  }

  getPooledCanvas(width, height) {
    return this.canvasPool.getCanvas(width, height);
  }

  captureSnapshotPixels(maxDimension = Infinity) {
    const image = this.refs.image;
    if (!this.loaded || !image.naturalWidth || !image.naturalHeight) return null;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = this.getPooledCanvas(width, height);
    return new Promise((resolve, reject) => {
      try {
        canvas.getContext("2d").drawImage(image, 0, 0, width, height);
        canvas.toBlob((blob) => {
          this.returnCanvasToPool(canvas);
          resolve(blob);
        });
      } catch (error) {
        this.returnCanvasToPool(canvas);
        reject(error);
      }
    });
  }

  capturePaneViewState() {
    return {
      zoom: this.zoom,
      auto: this.auto,
      zoomMode: this.zoomMode,
      translateX: this.translateX,
      translateY: this.translateY,
      selectionVisible: this.selectionVisible,
      selectionStartImg: { ...this.selectionStartImg },
      selectionEndImg: { ...this.selectionEndImg },
    };
  }

  restoreCopyViewState() {
    const state = this.editor.copyViewState;
    if (!state) return;
    this.editor.copyViewState = null;
    Object.assign(this, state);
    this._applyTransform();
    this.setSelectionVisibility(state.selectionVisible);
    this.updateSelectionBox();
  }

  async applySharedPixels(state, load = this._beginImageLoad()) {
    const url = state.blob ? URL.createObjectURL(state.blob) : state.url;
    if (!url) return;
    try {
      const image = await this._decodeImage(url, false, load);
      this._assertCurrentLoad(load);
      const data = this.calculateZoomForImage(image, url, { fit: !this.loaded || this.auto });
      if (this.loaded && !this.auto) {
        data.translateX = this.translateX;
        data.translateY = this.translateY;
      }
      this._applyLoadedImage(data);
      if (this.refs.image.decode) await this.refs.image.decode();
      this._assertCurrentLoad(load);
      this.loaded = true;
      this.shownFile = null;
      this.restoreCopyViewState();
      this.emitter.emit("did-update");
      this.emitter.emit("did-load");
    } catch (error) {
      if (state.blob) URL.revokeObjectURL(url);
      if (error.name !== "AbortError" && !this._destroyed) console.error(error);
    } finally {
      this._finishImageLoad(load);
    }
  }

  returnCanvasToPool(canvas) {
    if (this._destroyed) canvas.width = canvas.height = 0;
    else this.canvasPool.returnCanvas(canvas);
  }

  updateOperationIndicator() {
    const { running, waiting } = this.editor.document.operationQueue;
    this.operationIndicator.update({
      active:
        running && !running.signal.aborted
          ? { label: running.label, cancellable: running.canCancel }
          : null,
      waiting,
    });
    this.updateHistoryButtonState();
    lumine.commands.invalidateAvailability({ target: this.element });
  }

  trackPixelSync(promise) {
    this.pixelSyncPromise = promise;
    const clear = () => {
      if (this.pixelSyncPromise === promise) this.pixelSyncPromise = null;
    };
    void promise.then(clear, clear);
  }

  runImageEdit(label, run) {
    return this.runImageOperation(label, run, { affectsFile: !this.readOnly });
  }

  runImageOperation(label, run, { affectsFile = false, reportErrors = true } = {}) {
    const document = this.editor.document;
    const revision = this.editor.getPaneItemRevision();
    const isValid = () =>
      !this._destroyed &&
      this.editor.document === document &&
      this.editor.getPaneItemRevision() === revision;
    const result = document.operationQueue.enqueue({
      label,
      isValid,
      affectsFile,
      run: (operation) => {
        const execute = () => {
          operation.signal.throwIfAborted();
          if (isValid()) return run(operation);
        };
        return this.pixelSyncPromise ? this.pixelSyncPromise.then(execute) : execute();
      },
    });
    if (!reportErrors) return result;
    return result.catch((error) => {
      if (isValid()) {
        lumine.notifications.addError(`Failed to complete ${label}`, {
          window: lumine.workspace.getWindowForElement(this.element),
          detail: error.message,
        });
      }
    });
  }

  updateSize(zoom, { applyTransform = true, smooth = false } = {}) {
    if (!this.loaded || this.element.offsetHeight === 0) return;
    this.disableAutoZoom();
    this.zoom = Math.min(Math.max(zoom, 0.001), 100);
    if (applyTransform) this.updateTransform({ smooth });
  }

  cancelSmoothTransform() {
    if (this.smoothTransformRAF) {
      this.window.cancelAnimationFrame(this.smoothTransformRAF);
      this.smoothTransformRAF = null;
    }
  }

  updateTransform({ smooth = false, immediate = false } = {}) {
    if (immediate) {
      if (this.transformRAF) this.window.cancelAnimationFrame(this.transformRAF);
      this.transformRAF = null;
      this._applyTransform();
      return;
    }
    if (smooth) {
      this.updateTransformSmooth();
      return;
    }

    this.cancelSmoothTransform();
    if (!this.transformRAF) {
      this.transformRAF = this.window.requestAnimationFrame(() => {
        this.transformRAF = null;
        this._applyTransform();
      });
    }
  }

  updateTransformSmooth(duration = 120) {
    if (!this.loaded || this.element.offsetHeight === 0) {
      this.updateTransform();
      return;
    }

    if (this.transformRAF) {
      this.window.cancelAnimationFrame(this.transformRAF);
      this.transformRAF = null;
    }
    this.cancelSmoothTransform();

    const target = {
      translateX: this.translateX,
      translateY: this.translateY,
      zoom: this.zoom,
    };
    const start = this.renderedTransform || target;
    const startTime = this.window.performance.now();

    const animate = (now) => {
      const progress = Math.max(0, Math.min((now - startTime) / duration, 1));
      const eased = 1 - Math.pow(1 - progress, 3);
      const translateX = start.translateX + (target.translateX - start.translateX) * eased;
      const translateY = start.translateY + (target.translateY - start.translateY) * eased;
      const zoom = start.zoom + (target.zoom - start.zoom) * eased;

      this._applyTransform({ translateX, translateY, zoom, isSmoothFrame: true });

      if (progress < 1) {
        this.smoothTransformRAF = this.window.requestAnimationFrame(animate);
      } else {
        this.smoothTransformRAF = null;
        this._applyTransform();
      }
    };

    this.smoothTransformRAF = this.window.requestAnimationFrame(animate);
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

    const input = this.refs.zoomInput;
    const percent = this.zoomController.getZoomPercentage();
    const editing = this.document.activeElement === input;
    if (input.value !== percent && (!editing || input.value === this.zoomEditStart)) {
      input.value = percent;
      if (editing) {
        this.zoomEditStart = percent;
        input.select();
      }
    }
    this.updateZoomButtonState();

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

  centerImage({ smooth = false, immediate = false } = {}) {
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

    this.updateTransform({ smooth, immediate });
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

  zoomForMode(width, height, mode = this.zoomMode || "auto") {
    const widthScale = this.refs.imageContainer.offsetWidth / width;
    let zoom =
      mode === "fit-width"
        ? widthScale
        : Math.min(widthScale, this.refs.imageContainer.offsetHeight / height);
    if (mode === "auto" && lumine.config.get("image-editor.autoZoomLimit"))
      zoom = Math.min(zoom, 1);
    return Math.min(Math.max(zoom, 0.001), 100);
  }

  updateZoomButtonState() {
    const button = this.refs?.zoomToFitButton;
    if (!button) return;
    const mode = this.auto ? this.zoomMode || "auto" : null;
    button.classList.toggle("selected", mode === "auto");
    if (mode) button.dataset.zoomMode = mode;
    else delete button.dataset.zoomMode;
  }

  applyAutoZoom({ smooth = false, immediate = false } = {}) {
    if (!this.loaded || this.element.offsetHeight === 0) return;
    const mode = this.zoomMode || "auto";
    const zoom = this.zoomForMode(
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
      mode,
    );
    this.updateSize(zoom, { applyTransform: false });
    this.zoomMode = mode;
    this.auto = true;
    this.centerImage({ smooth, immediate });
  }

  zoomToFit({ smooth = false, immediate = false } = {}) {
    this.zoomMode = "auto";
    this.applyAutoZoom({ smooth, immediate });
  }

  canSetZoomPreset(detail) {
    return Boolean(
      this.loaded &&
      !this._destroyed &&
      (["auto", "fit-image", "fit-width"].includes(detail?.mode) ||
        (Number.isFinite(detail?.scale) && detail.scale >= 0.001 && detail.scale <= 100)),
    );
  }

  setZoomPreset(detail) {
    if (!this.canSetZoomPreset(detail)) return;
    if (this.auto && this.zoomMode === detail.mode) return;
    switch (detail.mode) {
      case "auto":
        this.zoomToFit({ smooth: true });
        break;
      case "fit-image":
      case "fit-width":
        this.zoomMode = detail.mode;
        this.applyAutoZoom({ smooth: true });
        break;
      default:
        this.zoomToCenterPoint(detail.scale, { smooth: true });
    }
  }

  showZoomMenu(event) {
    if (!this.loaded || this._destroyed) return;
    const { zoomInput } = this.refs;
    const keyboardActivation = event.button !== 2 && this.document.activeElement === zoomInput;
    if (!keyboardActivation) this.element.focus({ preventScroll: true });
    this.zoomMenu?.close({ cancelled: true, restoreFocus: false });
    const modes = [
      ["Automatic Zoom", "auto", "automatic-zoom"],
      ["Fit to View", "fit-image", "fit-to-view"],
      ["Fit Width", "fit-width", "fit-width"],
    ];
    const mode = this.auto ? this.zoomMode || "auto" : null;
    const menu = lumine.menu.showPopup({
      target: this.element,
      anchor: this.refs.zoomToFitButton,
      placement: "below",
      alignment: "left",
      restoreFocusTarget: keyboardActivation ? zoomInput : this.element,
      autoSelectFirstItem: true,
      className: "image-editor-zoom-menu",
      template: [
        ...modes.map(([label, presetMode, command]) => ({
          label,
          type: "radio",
          checked: mode === presetMode,
          command: `image-editor:${command}`,
        })),
        { type: "separator" },
        ...this.levels.map((scale) => ({
          label: `${Math.round(scale * 100)}%`,
          type: "radio",
          checked: !mode && Math.abs(this.zoom - scale) < 0.0005,
          command: scale === 1 ? "image-editor:zoom-100" : "image-editor:set-zoom",
          ...(scale === 1 ? { keyBindingLabel: "0" } : { commandDetail: { scale } }),
        })),
      ],
    });
    this.zoomMenu = menu;
    zoomInput.setAttribute("aria-expanded", "true");
    menu.onDidClose(() => {
      if (this.zoomMenu !== menu) return;
      this.zoomMenu = null;
      zoomInput.setAttribute("aria-expanded", "false");
    });
  }

  zoomToSelection({ smooth = true } = {}) {
    return this.runImageOperation("Zoom to Selection", () => {
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
    });
  }

  zoomOut() {
    this.zoomToCenterPoint(this.zoom / 1.1, { smooth: true });
  }

  zoomIn() {
    this.zoomToCenterPoint(this.zoom * 1.1, { smooth: true });
  }

  zoomPreviousLevel() {
    const zoom = this.zoomController.getPreviousZoomLevel();
    if (zoom !== null) this.zoomToCenterPoint(zoom, { smooth: true });
  }

  zoomNextLevel() {
    const zoom = this.zoomController.getNextZoomLevel();
    if (zoom !== null) this.zoomToCenterPoint(zoom, { smooth: true });
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

    const currentLoad = this.loadingAbortController;
    const currentFile = this.editor.file;
    const currentPath = this.editor.getPath();
    const fileList = await this.navigator.getFileList(currentPath);
    if (
      this._destroyed ||
      currentFile !== this.editor.file ||
      currentLoad !== this.loadingAbortController
    ) {
      return;
    }
    const cycle = lumine.config.get("image-editor.scrollCycle") !== false;

    const atBoundary =
      fileList.files.length > 0 &&
      (direction > 0
        ? fileList.currentIndex === fileList.files.length - 1
        : fileList.currentIndex === 0);
    if (cycle && atBoundary) this.showBoundaryOverlay(boundary);

    const target = this.navigator.stepFrom(fileList, direction, { cycle });
    // The listing resolved any native alias, so compare its current entry.
    const listedCurrentPath = fileList.files[fileList.currentIndex] ?? currentPath;
    if (target && paths.normalizePathKey(target) !== paths.normalizePathKey(listedCurrentPath)) {
      return this.loadImageFromNavigation(target);
    }
  }

  showBoundaryOverlay(direction) {
    if (!this.refs.boundaryOverlay) return;
    this.clearBoundaryOverlay();
    const overlay = this.refs.boundaryOverlay;
    const iconClass = direction === "left" ? "icon-move-down" : "icon-move-up";
    overlay.className = `boundary-overlay icon ${iconClass}`;
    overlay.offsetHeight;
    overlay.classList.add("active");
    const window = this.window;
    this.boundaryOverlayWindow = window;
    const timer = window.setTimeout(() => {
      if (this.boundaryOverlayWindow !== window || this.boundaryOverlayTimeout !== timer) return;
      this.boundaryOverlayTimeout = null;
      this.boundaryOverlayWindow = null;
      overlay.classList.remove("active");
    }, 800);
    this.boundaryOverlayTimeout = timer;
  }

  clearBoundaryOverlay() {
    if (this.boundaryOverlayTimeout != null)
      this.boundaryOverlayWindow?.clearTimeout(this.boundaryOverlayTimeout);
    this.boundaryOverlayTimeout = null;
    this.boundaryOverlayWindow = null;
    this.refs?.boundaryOverlay?.classList.remove("active");
  }

  async firstImage() {
    const currentLoad = this.loadingAbortController;
    const currentFile = this.editor.file;
    const firstPath = await this.navigator.getFirstImage(this.editor.getPath());
    if (
      this._destroyed ||
      currentFile !== this.editor.file ||
      currentLoad !== this.loadingAbortController
    ) {
      return;
    }
    if (firstPath && path.normalize(firstPath) !== path.normalize(this.editor.getPath())) {
      return this.loadImageFromNavigation(firstPath);
    }
  }

  async lastImage() {
    const currentLoad = this.loadingAbortController;
    const currentFile = this.editor.file;
    const lastPath = await this.navigator.getLastImage(this.editor.getPath());
    if (
      this._destroyed ||
      currentFile !== this.editor.file ||
      currentLoad !== this.loadingAbortController
    ) {
      return;
    }
    if (lastPath && path.normalize(lastPath) !== path.normalize(this.editor.getPath())) {
      return this.loadImageFromNavigation(lastPath);
    }
  }

  // Public API for external packages (e.g., navigation-panel)
  getFileList() {
    return this.navigator.getFileList(this.editor.getPath());
  }

  _setupImagePosition() {
    const refresh = () => this.refreshImagePosition();
    const field = this.refs.imagePosition;
    const input = this.refs.imagePositionInput;
    const select = () => input.select();
    const change = () => this.commitImagePosition(false);
    const keydown = (event) => {
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter") this.commitImagePosition(true);
      else {
        input.value = String((this.imagePositionListing?.currentIndex ?? -1) + 1 || "");
        this.element.focus();
      }
    };
    const wheel = async (event) => {
      if (
        this._destroyed ||
        !this.loaded ||
        event.defaultPrevented ||
        !Number.isFinite(event.deltaY) ||
        event.deltaY === 0
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      try {
        await (event.deltaY > 0 ? this.nextImage() : this.previousImage());
      } catch (error) {
        if (!this._destroyed && error.name !== "AbortError")
          lumine.notifications.addError("Failed to navigate images", {
            detail: error.message,
          });
      }
      if (!this._destroyed && this.imagePositionListing)
        input.value = String(this.imagePositionListing.currentIndex + 1);
    };
    input.addEventListener("focus", select);
    input.addEventListener("change", change);
    input.addEventListener("keydown", keydown);
    field.addEventListener("wheel", wheel, { passive: false });
    this.disposables.add(
      this.navigator.onDidInvalidate(refresh),
      this.editor.onDidChangePath(refresh),
      lumine.config.onDidChange("image-editor.scrollCycle", () =>
        this.updateImagePosition(this.imagePositionListing),
      ),
      new Disposable(() => {
        input.removeEventListener("focus", select);
        input.removeEventListener("change", change);
        input.removeEventListener("keydown", keydown);
        field.removeEventListener("wheel", wheel);
      }),
    );
    refresh();
  }

  async refreshImagePosition() {
    const generation = (this.imagePositionGeneration = (this.imagePositionGeneration ?? 0) + 1);
    const currentPath = this.editor.getPath();
    this.updateImagePosition(null);
    if (!currentPath || this._destroyed) return;
    const listing = await this.getFileList();
    if (
      this._destroyed ||
      generation !== this.imagePositionGeneration ||
      currentPath !== this.editor.getPath()
    )
      return;
    this.updateImagePosition(listing);
  }

  updateImagePosition(listing) {
    const ready = listing?.currentIndex >= 0 && listing.currentIndex < listing.files.length;
    this.imagePositionListing = ready ? listing : null;
    let availabilityChanged = false;
    for (const [button, action] of [
      [this.refs.firstImageButton, "firstImage"],
      [this.refs.prevImageButton, "previousImage"],
      [this.refs.nextImageButton, "nextImage"],
      [this.refs.lastImageButton, "lastImage"],
    ]) {
      const disabled = !this.canNavigateImage(action);
      availabilityChanged ||= button.disabled !== disabled;
      button.disabled = disabled;
    }
    const input = this.refs.imagePositionInput;
    const wasDisabled = input.disabled;
    input.disabled = !ready;
    input.max = String(ready ? listing.files.length : 1);
    input.style.width = `${Math.max(2, String(ready ? listing.files.length : 1).length) + 1}ch`;
    if (wasDisabled || this.document.activeElement !== input || !ready)
      input.value = ready ? String(listing.currentIndex + 1) : "";
    this.refs.imagePositionCount.textContent = `/ ${ready ? listing.files.length : "–"}`;
    if (availabilityChanged) lumine.commands.invalidateAvailability();
  }

  canNavigateImage(action) {
    const listing = this.imagePositionListing;
    if (this._destroyed || !listing) return false;
    switch (action) {
      case "firstImage":
        return listing.currentIndex > 0;
      case "previousImage":
        return this.canStepImage(-1);
      case "nextImage":
        return this.canStepImage(1);
      case "lastImage":
        return listing.currentIndex < listing.files.length - 1;
      default:
        return false;
    }
  }

  canStepImage(direction) {
    const listing = this.imagePositionListing;
    if (this._destroyed || !listing || listing.files.length < 2) return false;
    const index = listing.currentIndex + direction;
    return (
      lumine.config.get("image-editor.scrollCycle") !== false ||
      (index >= 0 && index < listing.files.length)
    );
  }

  async commitImagePosition(focus) {
    const input = this.refs.imagePositionInput;
    const entered = Number(input.value);
    if (focus) this.element.focus();
    if (this.imagePositionCommit) return this.imagePositionCommit;
    const currentPath = this.editor.getPath();
    const currentLoad = this.loadingAbortController;
    const generation = this.imagePositionGeneration;
    const navigate = async () => {
      const listing = await this.getFileList();
      if (
        this._destroyed ||
        currentPath !== this.editor.getPath() ||
        currentLoad !== this.loadingAbortController ||
        generation !== this.imagePositionGeneration ||
        listing.currentIndex < 0
      )
        return;
      const index =
        Number.isInteger(entered) && entered >= 1
          ? Math.min(entered, listing.files.length) - 1
          : listing.currentIndex;
      input.value = String(index + 1);
      if (index !== listing.currentIndex) await this.loadImageFromNavigation(listing.files[index]);
      if (!this._destroyed) await this.refreshImagePosition();
    };
    const pending = (this.imagePositionCommit = navigate());
    try {
      await pending;
    } finally {
      if (this.imagePositionCommit === pending) this.imagePositionCommit = null;
    }
  }

  showFileList() {
    if (this._destroyed) return;
    if (!this.editor.getPath()) {
      lumine.notifications.addWarning("Save this image before browsing its folder.");
      return;
    }
    this.fileListView ||= new (require("./file-list"))(this);
    return this.fileListView.show();
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
    if (this.editor.getFileState() === "unmodified") return true;

    this.navigationConfirmationPending = true;
    try {
      const window = lumine.workspace.getWindowForElement(this.element);
      const response = await window.confirm({
        message: `Save changes to ${this.editor.getTitle()}?`,
        detail: "Your changes will be lost if you move to another image without saving.",
        buttons: ["Save", "Cancel", "Don't Save"],
      });

      if (response === 1) return false;
      // A failed save keeps the user where their work is.
      if (response === 0) return (await this.save()) === true;
      return true;
    } finally {
      this.navigationConfirmationPending = false;
    }
  }

  async loadImageFromNavigation(imagePath, { signal, pending = false } = {}) {
    // Keep the original navigation alive while its save question is awaiting an answer.
    if (!imagePath || this._destroyed || this.isSaving || this.navigationConfirmationPending)
      return false;
    const source = this.editor.document;
    if (source.operationQueue.running) {
      await source.operationQueue.whenIdle();
      if (this._destroyed || this.editor.document !== source || signal?.aborted || this.isSaving)
        return false;
    }
    const currentLoad = this._beginImageLoad(signal);
    currentLoad.navigation = true;
    let encodedPath;
    try {
      this._assertCurrentLoad(currentLoad);
      if (pending) {
        if (this.editor.getFileState() !== "unmodified" || this.editor.isTemporary()) return false;
      } else if (!(await this.confirmDiscardingEdits())) {
        return false;
      }
      this._assertCurrentLoad(currentLoad);
      const previousFile = this.editor.file;
      const previousHistoryEntry = this.historyManager.getCurrentState();
      const stats = await fs.promises.stat(imagePath);
      this._assertCurrentLoad(currentLoad);
      if (!stats.isFile()) throw new Error("Image path is not a file");

      const destination = ImageDocument.find(imagePath);
      const destinationRevision = destination?.pixelRevision;
      const destinationEntry = destination?.historyManager.getCurrentState();
      const destinationState = destination?.fileState;
      const destinationIsDirty = destination && destinationState !== "unmodified";
      // Clean documents use the current file on disk. Edited documents can only
      // be joined once they have published the pixels at their history cursor.
      const sharedPixels =
        destinationIsDirty &&
        (!destinationEntry || destination.pixelHistoryEntry === destinationEntry)
          ? destination.pixelBlob
          : null;
      if (
        destination?.isSaving ||
        destination?.operationQueue.running ||
        (destinationIsDirty && (pending || !sharedPixels))
      ) {
        if (!pending)
          lumine.notifications.addWarning("Cannot switch to the destination image yet", {
            detail: `Finish editing or saving ${path.basename(imagePath)} and try again.`,
          });
        return false;
      }
      encodedPath = sharedPixels
        ? URL.createObjectURL(sharedPixels)
        : this._svgBlobUrl(
            `${paths.encodeFileURL(imagePath)}?v=${paths.cacheKeyForStats(stats)}`,
            imagePath,
          );
      const image = await this._decodeImage(
        encodedPath,
        stats.size > this.largeImageThreshold,
        currentLoad,
      );
      this._assertCurrentLoad(currentLoad);
      // A save, relocation or edit during decoding belongs to the existing
      // document. Never discard it on behalf of an earlier navigation request.
      if (
        this.isSaving ||
        source.operationQueue.running ||
        this.editor.file !== previousFile ||
        this.historyManager.getCurrentState() !== previousHistoryEntry ||
        (pending && this.editor.getFileState() !== "unmodified")
      ) {
        return false;
      }
      // Another view can change the destination while its pixels decode.
      if (
        ImageDocument.find(imagePath) !== destination ||
        destination?.isSaving ||
        destination?.operationQueue.running ||
        destination?.pixelRevision !== destinationRevision ||
        destination?.historyManager.getCurrentState() !== destinationEntry ||
        destination?.fileState !== destinationState
      ) {
        return false;
      }

      const imageData = this.calculateZoomForImage(image, encodedPath, {
        fit: true,
        mode: "auto",
      });
      await this.applyImageWithMetadata(
        imagePath,
        imageData,
        stats,
        Boolean(sharedPixels),
        currentLoad,
      );
      return true;
    } catch (error) {
      if (pending) throw error;
      if (!currentLoad.cancelled && !this._destroyed && error.name !== "AbortError") {
        lumine.notifications.addError(
          error.code === "ENOENT" ? "Image file not found" : "Failed to load image",
          { detail: `Path: ${imagePath}\n\n${error.message}`, dismissable: true },
        );
      }
      return false;
    } finally {
      this._releaseImageUrl(encodedPath);
      currentLoad.navigation = false;
      this._finishImageLoad(currentLoad);
      if (
        !this._destroyed &&
        currentLoad === this.loadingAbortController &&
        currentLoad.deferredReloadFile &&
        currentLoad.deferredReloadFile === this.editor.file
      ) {
        await this.updateImageURI();
      }
    }
  }

  calculateZoomForImage(
    img,
    encodedPath,
    { fit = this.auto, mode = this.zoomMode || "auto" } = {},
  ) {
    const newWidth = img.naturalWidth;
    const newHeight = img.naturalHeight;
    let zoom, translateX, translateY;

    if (fit) {
      zoom = this.zoomForMode(newWidth, newHeight, mode);
    } else {
      zoom = this.zoom;
    }

    const imageWidth = newWidth * zoom;
    const imageHeight = newHeight * zoom;
    translateX = (this.refs.imageContainer.offsetWidth - imageWidth) / 2;
    translateY = (this.refs.imageContainer.offsetHeight - imageHeight) / 2;

    return { img, encodedPath, width: newWidth, height: newHeight, zoom, translateX, translateY };
  }

  _applyLoadedImage(imageData) {
    this._invalidateDocumentWork();
    this.originalWidth = imageData.width;
    this.originalHeight = imageData.height;
    this.zoom = imageData.zoom;
    this.translateX = imageData.translateX;
    this.translateY = imageData.translateY;
    this.updateZoomButtonState();

    this._applyTransform();
    this.setImageSource(imageData.encodedPath);
    this.refs.image.style.display = "";
  }

  _invalidateDocumentWork() {
    this.documentGeneration++;
    if (this.autoRotateController) {
      this.autoRotateController.abort();
      this.autoRotateController = null;
      if (!this._destroyed) lumine.commands.invalidateAvailability();
    }
    this.cancelDeferredFilter?.();
    this.previewRevision = (this.previewRevision ?? 0) + 1;
    this.refs.image.onload = null;
    this.refs.image.onerror = null;
    this.emitter.emit("will-replace-document");
  }

  applyImageWithMetadata(imagePath, imageData, stats, fromSharedPixels, currentLoad) {
    let presented;
    this.editor.load(imagePath, () => {
      this.readOnly = path.extname(imagePath).toLowerCase() === ".svg";
      this.imageSize = stats.size;
      this.noteShownFile(imagePath, fromSharedPixels ? null : stats);
      this.zoomMode = "auto";
      this.auto = true;
      this._applyLoadedImage(imageData);
      presented = this.finishImagePresentation(currentLoad);
      this._skipNextReload = true;
      this.setSelectionVisibility(false);
      this.selectionStartImg = { x: 0, y: 0 };
      this.selectionEndImg = { x: 0, y: 0 };
      this.mouseHandler.reset();
    });
    this.emitter.emit("mouse-position", { imgX: null, imgY: null });
    return presented;
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
    if (this.readOnly) return;
    return this.runImageEdit("Crop to Selection", (operation) => {
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

      const area = this.getSelectionArea();
      if (!area || area.width === 0 || area.height === 0) {
        lumine.notifications.addWarning("Invalid selection", {
          description: "Selection has no area.",
        });
        return;
      }

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

      return this.applyCanvas(canvas, {
        operation,
        releaseCanvas: () => {
          this.returnCanvasToPool(sourceCanvas);
          this.returnCanvasToPool(canvas);
        },
        onLoad: (width, height) => {
          if (this.auto) {
            this.applyAutoZoom();
          } else {
            // Keep what was cropped where it was on screen.
            this.translateX = cropCenterX - (width * this.zoom) / 2;
            this.translateY = cropCenterY - (height * this.zoom) / 2;
            this.updateTransform();
          }
          this.setSelectionVisibility(false);
        },
      });
    });
  }

  resizeCanvasToSelection() {
    if (this.readOnly) return;
    return this.runImageEdit("Resize Canvas to Selection", (operation) => {
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

      const area = selection.getSelectionBounds(this.selectionStartImg, this.selectionEndImg);
      if (!area) {
        lumine.notifications.addWarning("Invalid selection", {
          description: "Selection has no area.",
        });
        return;
      }
      if (area.width > 10000 || area.height > 10000) {
        lumine.notifications.addError("Invalid dimensions", {
          description: "The selected canvas must be no larger than 10000×10000 pixels.",
        });
        return;
      }

      const sourceCanvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
      const canvas = transforms.resizeCanvasToArea(
        sourceCanvas,
        area.left,
        area.top,
        area.width,
        area.height,
        this.canvasPool,
      );
      const selectionCenterX = this.translateX + (area.left + area.width / 2) * this.zoom;
      const selectionCenterY = this.translateY + (area.top + area.height / 2) * this.zoom;

      return this.applyCanvas(canvas, {
        operation,
        releaseCanvas: () => {
          this.returnCanvasToPool(sourceCanvas);
          this.returnCanvasToPool(canvas);
        },
        onLoad: (width, height) => {
          if (this.auto) {
            this.applyAutoZoom();
          } else {
            this.translateX = selectionCenterX - (width * this.zoom) / 2;
            this.translateY = selectionCenterY - (height * this.zoom) / 2;
            this.updateTransform();
          }
          this.setSelectionVisibility(false);
        },
      });
    });
  }

  blurImage(blurLevel) {
    if (!canvasFilters.supportsCanvasFilter()) {
      lumine.notifications.addError("Blur is unavailable", {
        description: "This platform does not support canvas filters.",
      });
      return;
    }
    return this.runFilterOperation({
      label: "Blur",
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
    });
  }

  sharpenImage(strength) {
    return this.runFilterOperation({
      label: "Sharpen",
      filter: "applySharpenKernel",
      args: (area) => [area.width, area.height, strength],
      defer: true,
    });
  }

  applyGrayscale(amount = 100) {
    return this.runFilterOperation({
      label: "Grayscale",
      filter: "applyGrayscaleAmount",
      args: [amount],
    });
  }

  invertColors() {
    return this.runFilterOperation({ label: "Invert Colors", filter: "invertColors" });
  }

  applySepia() {
    return this.runFilterOperation({ label: "Sepia", filter: "applySepia" });
  }

  applyBrightnessContrast(brightness, contrast) {
    return this.runFilterOperation({
      label: "Brightness / Contrast",
      filter: "applyBrightnessContrast",
      args: [brightness, contrast],
    });
  }

  applySaturation(saturation) {
    return this.runFilterOperation({
      label: "Saturation",
      filter: "applySaturation",
      args: [saturation],
    });
  }

  applyHueShift(hueShift) {
    return this.runFilterOperation({
      label: "Hue Shift",
      filter: "applyHueShift",
      args: [hueShift],
      defer: true,
    });
  }

  applyPosterize(levels) {
    return this.runFilterOperation({
      label: "Posterize",
      filter: "applyPosterize",
      args: [levels],
    });
  }

  autoAdjustColors() {
    return this.runFilterOperation({ label: "Auto Adjust Colors", filter: "autoAdjustColors" });
  }

  runFilterOperation({ label = "Filter Image", apply, filter, args = [], defer = false }) {
    return this.runImageEdit(label, (operation) => {
      if (!this.loaded || this.readOnly) return;
      if (defer) this.editor.terminatePendingState();
      let area = this.getSelectionArea();
      if (!area) {
        const { naturalWidth: width, naturalHeight: height } = this.refs.image;
        area = { left: 0, top: 0, width, height, hasSelection: false };
      }

      const run = async () => {
        const canvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
        const ctx = canvas.getContext("2d");
        let edit;
        try {
          edit = this.prepareCanvasEdit(true);
          if (filter) {
            const data = ctx.getImageData(area.left, area.top, area.width, area.height);
            const parameters = typeof args === "function" ? args(area) : args;
            if (area.width * area.height >= 1_000_000) {
              const { applyFilter } = require("./async-filter");
              const pixels = await applyFilter(data, filter, parameters, operation.signal);
              operation.signal.throwIfAborted();
              ctx.putImageData(
                new ImageData(pixels, area.width, area.height, { colorSpace: data.colorSpace }),
                area.left,
                area.top,
              );
            } else {
              filters[filter](data, ...parameters);
              ctx.putImageData(data, area.left, area.top);
            }
          } else {
            apply(ctx, area);
          }
          operation.signal.throwIfAborted();
        } catch (error) {
          this.returnCanvasToPool(canvas);
          throw error;
        }
        return this.applyCanvas(canvas, {
          edit,
          operation,
          releaseCanvas: () => this.returnCanvasToPool(canvas),
          onLoad: () => this.updateTransform(),
        });
      };
      if (!defer) return run();
      return this.runAfterSpinnerPaint(run, operation.signal);
    });
  }

  runAfterSpinnerPaint(run, signal) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", cancel);
        this.cancelDeferredFilter = this.deferredFilterRun = null;
        this.filterInProgress = false;
      };
      const cancel = () => {
        this.cancelDeferredFilterFrame();
        cleanup();
        resolve();
      };
      this.cancelDeferredFilter = cancel;
      signal.addEventListener("abort", cancel, { once: true });
      this.filterInProgress = true;
      this.deferredFilterRun = () => {
        cleanup();
        run().then(resolve, reject);
      };
      // Animation frame callbacks run before paint. Give the spinner a frame
      // on screen before entering synchronous canvas operations.
      this.deferredFilterFramesLeft = 2;
      this.scheduleDeferredFilter();
    });
  }

  commitCanvas(canvas, options = {}) {
    if (options.operation || options.recordHistory === false) {
      return this.applyCanvas(canvas, options);
    }
    let started = false;
    return this.runImageEdit("Edit Image", (operation) => {
      started = true;
      return this.applyCanvas(canvas, { ...options, operation });
    }).finally(() => {
      if (!started) options.releaseCanvas?.();
    });
  }

  prepareCanvasEdit(recordHistory) {
    const document = this.editor.document;
    const history = document.historyManager;
    const shared = recordHistory && !this.readOnly;
    if (shared) this.editor.terminatePendingState();
    // Stage the undo baseline without updating history before the commit.
    const initial = shared && history.needsInitialSave ? this.captureHistoryFrame() : null;
    return {
      document,
      generation: this.documentGeneration,
      initial,
      shared,
      viewport: this.historyViewport(),
    };
  }

  async applyCanvas(canvas, { operation, recordHistory = true, releaseCanvas, onLoad, edit } = {}) {
    let releaseAfterEncode = releaseCanvas;
    try {
      const { document, generation, initial, shared, viewport } =
        edit ?? this.prepareCanvasEdit(recordHistory);
      const history = document.historyManager;
      const previewRevision = shared
        ? null
        : (this.previewRevision = (this.previewRevision ?? 0) + 1);
      const viewIsCurrent = () =>
        !this._destroyed &&
        this.editor.document === document &&
        generation === this.documentGeneration &&
        (shared || this.previewRevision === previewRevision);
      const { width, height } = canvas;
      const blob = await transforms.canvasToBlob(canvas);
      operation?.signal.throwIfAborted();
      if (!blob) throw new Error("Could not encode the image");
      if (document.destroyed || (!shared && !viewIsCurrent())) return;

      operation?.commit();
      if (shared) {
        history.ensureInitialSaved(() => this.recordHistoryFrame(history, initial));
        history.updateCurrentState(viewport);
        const entry = history.beginEntry(viewport, { width, height });
        if (entry?.compact) {
          releaseAfterEncode = null;
          void transforms
            .canvasToBlob(canvas, ...encodingFor(entry))
            .then(
              (compactBlob) => history.settleEntry(entry, compactBlob || blob),
              () => history.settleEntry(entry, blob),
            )
            .finally(() => releaseCanvas?.());
        } else {
          history.settleEntry(entry, blob);
        }
        document.publishPixels({ blob, width, height, source: this.editor, historyEntry: entry });
      }
      if (viewIsCurrent()) {
        await this.displayOperationImage(blob, viewIsCurrent, () => {
          this.originalWidth = width;
          this.originalHeight = height;
          onLoad?.(width, height);
        });
      }
    } finally {
      releaseAfterEncode?.();
    }
  }

  async displayOperationImage(blob, isCurrent, updateView) {
    const image = this.refs.image;
    this.setImageSource(URL.createObjectURL(blob));
    try {
      await image.decode();
    } catch (error) {
      if (isCurrent()) throw error;
      return;
    }
    if (!isCurrent()) return;
    updateView();
    this.emitter.emit("did-update");
  }

  autoRotate() {
    if (this.autoRotateController) return;
    return this.runImageEdit("Auto Rotate", (operation) => this.detectAndRotate(operation));
  }

  async detectAndRotate(operation) {
    if (this._destroyed || !this.loaded || this.readOnly) return;

    const documentModel = this.editor.document;
    const load = this.loadingAbortController;

    const generation = this.documentGeneration;
    const displayUrl = this._displayUrl;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, operation.signal]);
    const isCurrent = () =>
      !signal.aborted &&
      this.editor.document === documentModel &&
      this.documentGeneration === generation &&
      this.loadingAbortController === load &&
      this._displayUrl === displayUrl;

    this.autoRotateController = controller;
    lumine.commands.invalidateAvailability();
    const window = lumine.workspace.getWindowForElement(this.element);
    try {
      await this.refs.image.decode();
      if (!isCurrent()) return;
      const blob = await this.captureSnapshotPixels(MAX_ORIENTATION_IMAGE_DIMENSION);
      if (!isCurrent()) return;
      if (!blob) throw new Error("Could not read image pixels");

      const { detectOrientation } = require("./auto-orientation");
      const image = Buffer.from(await blob.arrayBuffer());
      if (!isCurrent()) return;
      const { degrees, confidence } = await detectOrientation(image, { signal });
      if (!isCurrent()) return;

      if (degrees == null || !(confidence >= MIN_ORIENTATION_CONFIDENCE)) {
        lumine.notifications.addWarning("Could not determine image orientation", { window });
      } else if (degrees === 0) {
        lumine.notifications.addInfo("No rotation needed", { window });
      } else {
        await this.rotateInOperation(degrees, operation);
      }
    } catch (error) {
      if (isCurrent()) {
        lumine.notifications.addError("Failed to detect image orientation", {
          window,
          detail: error.message,
        });
      }
    } finally {
      if (this.autoRotateController === controller) {
        this.autoRotateController = null;
        if (!this._destroyed) lumine.commands.invalidateAvailability();
      }
    }
  }

  rotate(degrees) {
    return this.runImageEdit("Rotate Image", (operation) =>
      this.rotateInOperation(degrees, operation),
    );
  }

  rotateInOperation(degrees, operation) {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    const sourceCanvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
    const canvas = transforms.rotateImage(sourceCanvas, degrees, this.canvasPool);

    return this.applyCanvas(canvas, {
      operation,
      releaseCanvas: () => {
        this.returnCanvasToPool(sourceCanvas);
        this.returnCanvasToPool(canvas);
      },
      onLoad: () => {
        if (this.auto) {
          this.applyAutoZoom({ immediate: true });
        } else this._applyTransform();
        this.setSelectionVisibility(false);
      },
    });
  }

  freeRotate(degrees, trim = true) {
    return this.runImageEdit("Rotate Image", (operation) => {
      if (!this.loaded) {
        lumine.notifications.addError("Image not loaded");
        return;
      }

      const sourceCanvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
      const canvas = transforms.freeRotateImage(
        sourceCanvas,
        degrees,
        { expandCanvas: true, trim },
        this.canvasPool,
      );
      this.returnCanvasToPool(sourceCanvas);

      return this.applyCanvas(canvas, {
        operation,
        releaseCanvas: () => this.returnCanvasToPool(canvas),
        onLoad: () => {
          if (this.auto) this.applyAutoZoom();
          else this.updateTransform();
          this.setSelectionVisibility(false);
        },
      });
    });
  }

  flipHorizontal() {
    return this.runImageEdit("Flip Horizontally", (operation) => {
      if (!this.loaded) {
        lumine.notifications.addError("Image not loaded");
        return;
      }

      const sourceCanvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
      const canvas = transforms.flipHorizontal(sourceCanvas, this.canvasPool);

      return this.applyCanvas(canvas, {
        operation,
        releaseCanvas: () => {
          this.returnCanvasToPool(sourceCanvas);
          this.returnCanvasToPool(canvas);
        },
        onLoad: () => {
          this.updateTransform();
          this.setSelectionVisibility(false);
        },
      });
    });
  }

  flipVertical() {
    return this.runImageEdit("Flip Vertically", (operation) => {
      if (!this.loaded) {
        lumine.notifications.addError("Image not loaded");
        return;
      }

      const sourceCanvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
      const canvas = transforms.flipVertical(sourceCanvas, this.canvasPool);

      return this.applyCanvas(canvas, {
        operation,
        releaseCanvas: () => {
          this.returnCanvasToPool(sourceCanvas);
          this.returnCanvasToPool(canvas);
        },
        onLoad: () => {
          this.updateTransform();
          this.setSelectionVisibility(false);
        },
      });
    });
  }

  resizeImage(newWidth, newHeight) {
    return this.runImageEdit("Resize Image", (operation) => {
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

      const sourceCanvas = transforms.imageToCanvas(this.refs.image, this.canvasPool);
      const canvas = transforms.resizeImage(sourceCanvas, newWidth, newHeight, this.canvasPool);

      return this.applyCanvas(canvas, {
        operation,
        releaseCanvas: () => {
          this.returnCanvasToPool(sourceCanvas);
          this.returnCanvasToPool(canvas);
        },
        onLoad: () => {
          if (this.auto) this.applyAutoZoom();
          else this.updateTransform();
          this.setSelectionVisibility(false);
        },
      });
    });
  }

  async save() {
    if (!this.editor.getPath()) return this.saveImage();
    return (
      (await this.runImageOperation("Save Image", (operation) =>
        this.saveToPath(this.editor.getPath(), operation),
      )) ?? false
    );
  }

  async saveWithPreflight(beforeSave, { onlyIfModified = false } = {}) {
    return (
      (await this.runImageOperation(
        "Save Image",
        (operation) => {
          const document = this.editor.document;
          const filePath = document.getPath();
          if (!filePath || !this.loaded) return false;
          if (onlyIfModified && document.fileState === "unmodified") return true;
          const revision = this.editor.getPaneItemRevision();
          const isCurrent = () =>
            !this._destroyed &&
            this.editor.document === document &&
            this.editor.getPaneItemRevision() === revision &&
            document.getPath() === filePath;
          return this.saveToPath(filePath, operation, {
            beforeWrite: async () => {
              if (!isCurrent()) return false;
              document.reconcileFile();
              if (document.externalChangePending) document.confirmExternalChange();
              await beforeSave();
              return isCurrent();
            },
          });
        },
        { reportErrors: false },
      )) ?? false
    );
  }

  async saveImage(destination) {
    const document = this.editor.document;
    const useDialog = destination == null;
    if (this._destroyed || !this.loaded || (useDialog && document.saveDialogPending)) return false;
    this.editor.terminatePendingState();
    const revision = this.editor.getPaneItemRevision();
    const currentPath = this.editor.getPath();
    if (useDialog) document.setSaveDialogPending(true);
    try {
      const filePath = destination ?? (await fileOps.chooseSavePath(this.refs.image, currentPath));
      if (
        !filePath ||
        this._destroyed ||
        this.editor.document !== document ||
        this.editor.getPaneItemRevision() !== revision ||
        document.getPath() !== currentPath
      )
        return false;
      return (
        (await this.runImageOperation(
          "Save Image As",
          (operation) => this.saveToPath(filePath, operation, { saveAs: true }),
          { reportErrors: useDialog },
        )) ?? false
      );
    } catch (error) {
      if (!useDialog) throw error;
      if (!this._destroyed)
        lumine.notifications.addError("Failed to save image", { detail: error.message });
      return false;
    } finally {
      if (useDialog) document.setSaveDialogPending(false);
    }
  }

  async saveToPath(filePath, operation, { saveAs = false, beforeWrite } = {}) {
    if (!this.loaded || !filePath) return false;
    if (this.readOnly && !saveAs) {
      lumine.notifications.addWarning("This image is read-only");
      return false;
    }
    this.editor.terminatePendingState();
    const document = this.editor.document;
    const originalPath = document.getPath();
    document.setSaving(true);
    try {
      const result = await fileOps.saveImage(this.refs.image, filePath, operation, beforeWrite);
      if (!result) return false;
      if (document.destroyed || document.getPath() !== originalPath) return true;
      const { stats } = result;
      document.historyManager.reset();
      document.lastSelfWrite = stats
        ? { path: filePath, mtimeMs: stats.mtimeMs, size: stats.size }
        : null;
      if (!this._destroyed && this.editor.document === document) {
        this.noteShownFile(filePath, stats);
        if (originalPath !== filePath) this._skipNextReload = true;
      }
      if (originalPath !== filePath) document.setPath(filePath);
      document.didSave();
      return true;
    } finally {
      document.setSaving(false);
    }
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
      getPath: (filePath) => filePath,
    });
  }

  copyProjectPathToClipboard() {
    this.copyFilePathToClipboard({
      getPath: (filePath) => {
        const [_projectPath, relativePath] = lumine.project.relativizePath(filePath);
        return relativePath || filePath;
      },
    });
  }

  copyFilePathToClipboard({ getPath }) {
    const filePath = this.editor.getPath();
    if (!filePath) {
      lumine.notifications.addError("No file path available");
      return;
    }

    const text = getPath(filePath);
    lumine.clipboard.write(text);
  }

  copySelectionToClipboard() {
    return this.runImageOperation("Copy Selection", (operation) => {
      if (!this.loaded) {
        lumine.notifications.addError("Image not loaded");
        return;
      }
      if (this.readOnly) return;

      let area;

      if (!this.selectionVisible) {
        // No selection - copy entire image
        area = { left: 0, top: 0, width: this.originalWidth, height: this.originalHeight };
      } else {
        area = this.getSelectionArea();
        if (!area || area.width === 0 || area.height === 0) {
          // Fallback to entire image if selection is invalid
          area = { left: 0, top: 0, width: this.originalWidth, height: this.originalHeight };
        }
      }

      return selection.copyToClipboard(
        this.refs.image,
        area.left,
        area.top,
        area.width,
        area.height,
        operation,
      );
    });
  }

  autoSelect(borderPercent = 0) {
    return this.runImageOperation(borderPercent ? "Auto Select With Border" : "Auto Select", () => {
      if (!this.loaded) {
        lumine.notifications.addError("Image not loaded");
        return;
      }
      if (this.readOnly) return;

      const tolerance = lumine.config.get("image-editor.autoSelectTolerance") ?? 30;
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
    });
  }

  selectAll() {
    return this.runImageOperation("Select All", () => {
      if (!this.loaded) {
        lumine.notifications.addError("Image not loaded");
        return;
      }
      if (this.readOnly) return;

      this.selectionStartImg = { x: 0, y: 0 };
      this.selectionEndImg = {
        x: this.refs.image.naturalWidth,
        y: this.refs.image.naturalHeight,
      };
      this.setSelectionVisibility(true);
      this.updateSelectionBox();
    });
  }

  selectVisibleArea() {
    return this.runImageOperation("Select Visible Area", () => {
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
    });
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

  historyViewport() {
    return {
      translateX: this.translateX,
      translateY: this.translateY,
      zoom: this.zoom,
      auto: this.auto,
    };
  }

  captureHistoryFrame() {
    const { naturalWidth: width, naturalHeight: height } = this.refs.image;
    const canvas = this.getPooledCanvas(width, height);
    canvas.getContext("2d").drawImage(this.refs.image, 0, 0);
    const compact = width * height > this.historyManager.largeImagePixels;
    const pixels = transforms
      .canvasToBlob(canvas, ...encodingFor({ compact }))
      .then((blob) => blob || (compact ? transforms.canvasToBlob(canvas) : null))
      .catch(() => null)
      .finally(() => this.returnCanvasToPool(canvas));
    return { width, height, viewport: this.historyViewport(), pixels };
  }

  recordHistoryFrame(history, frame) {
    if (!frame) return;
    const entry = history.beginEntry(frame.viewport, frame);
    void frame.pixels.then((blob) => history.settleEntry(entry, blob));
  }

  saveToHistory() {
    if (!this.loaded || this.readOnly) return;
    this.recordHistoryFrame(this.historyManager, this.captureHistoryFrame());
  }

  isModified() {
    return this.historyManager.isModified();
  }

  updateHistoryButtonState() {
    const enabled = this.loaded && !this._destroyed && !this.readOnly;
    const busy = Boolean(this.editor.document.operationQueue.running);
    this.refs.undoButton.disabled = !enabled || !(busy || this.historyManager.canUndo());
    this.refs.redoButton.disabled = !enabled || !(busy || this.historyManager.canRedo());
  }

  undo() {
    return this.runImageEdit("Undo", (operation) => this.moveHistory(-1, operation));
  }

  redo() {
    return this.runImageEdit("Redo", (operation) => this.moveHistory(1, operation));
  }

  async moveHistory(direction, operation) {
    if (!this.loaded || this.readOnly) return;
    const document = this.editor.document;
    const generation = this.documentGeneration;
    const history = document.historyManager;
    const entry = history.history[history.historyIndex + direction];
    if (!entry) return;
    const blob = await history.blobFor(entry);
    operation.signal.throwIfAborted();
    if (!blob) throw new Error("That undo state could not be restored");
    if (document.destroyed) return;

    operation.commit();
    if (direction < 0) history.undo();
    else history.redo();
    document.publishPixels({
      blob,
      width: entry.imageWidth,
      height: entry.imageHeight,
      source: this.editor,
      historyEntry: entry,
    });

    const isCurrent = () =>
      !this._destroyed &&
      this.editor.document === document &&
      this.documentGeneration === generation;
    if (!isCurrent()) return;
    const previousWidth = this.originalWidth;
    const previousHeight = this.originalHeight;
    this.shownFile = null;
    await this.displayOperationImage(blob, isCurrent, () => {
      this.originalWidth = entry.imageWidth;
      this.originalHeight = entry.imageHeight;
      if (this.auto) this.applyAutoZoom();
      else {
        if (this.originalWidth !== previousWidth || this.originalHeight !== previousHeight) {
          this.zoom = entry.zoom;
          this.translateX = entry.translateX;
          this.translateY = entry.translateY;
        }
        this._applyTransform();
      }
      this.setSelectionVisibility(false);
    });
  }

  showResizeDialog() {
    const presentationDocument = this.document;
    const presentationWindow = presentationDocument.defaultView;
    const dialogs = dialogUtils.forDocument(presentationDocument);
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    const currentWidth = this.refs.image.naturalWidth;
    const currentHeight = this.refs.image.naturalHeight;
    const aspectRatio = currentWidth / currentHeight;

    const backdrop = dialogs.createDialogBackdrop();
    const {
      dialogElement,
      bodyElement,
      cleanup: dialogCleanup,
    } = dialogs.createDraggableDialog("Resize Image");
    dialogElement.classList.add("image-editor-preview-dialog");

    const infoElement = dialogs.createSelectionInfo(
      `Current size: ${currentWidth} × ${currentHeight} px`,
    );
    bodyElement.appendChild(infoElement);

    const { container: widthContainer, input: widthInput } = dialogs.createNumberInput({
      label: "Width (px)",
      default: currentWidth,
      min: 1,
      max: 10000,
    });
    const { container: heightContainer, input: heightInput } = dialogs.createNumberInput({
      label: "Height (px)",
      default: currentHeight,
      min: 1,
      max: 10000,
    });
    bodyElement.appendChild(widthContainer);
    bodyElement.appendChild(heightContainer);

    const { container: lockContainer, checkbox: lockCheckbox } = dialogs.createCheckbox(
      "lock-aspect-ratio",
      "Lock aspect ratio",
      true,
    );
    bodyElement.appendChild(lockContainer);

    const percentButtons = dialogs.createQuickButtons(
      [25, 50, 75, 100, 150, 200],
      (percent) => {
        widthInput.value = Math.round(currentWidth * (percent / 100));
        heightInput.value = Math.round(currentHeight * (percent / 100));
        scheduleResizePreview();
      },
      (v) => `${v}%`,
    );
    bodyElement.appendChild(percentButtons);

    const getResizeValues = () => [
      parseInt(widthInput.value) || currentWidth,
      parseInt(heightInput.value) || currentHeight,
    ];
    const previewPanel = dialogs.createPreviewPanel({
      sourceImage: this.refs.image,
      maxSourceSize: 1280,
      initialValues: getResizeValues(),
      renderPreview: (sourceCanvas, previewCanvas, values) => {
        this.renderResizePreview(sourceCanvas, previewCanvas, values[0], values[1]);
      },
      getOutputInfo: (values) => `Output: ${values[0]} x ${values[1]} px`,
    });
    bodyElement.appendChild(previewPanel.container);
    bodyElement.appendChild(previewPanel.infoElement);
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

    const { buttonContainer, cancelButton, applyButton } = dialogs.createButtonContainer(
      "Cancel",
      "Resize",
    );

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      dialogRegistration.dispose();
      replacementDisposable.dispose();
      previewPanel.cleanup();
      imageLoadDisposable.dispose();
      dialogCleanup();
      presentationDocument.removeEventListener("keydown", escapeHandler);
      presentationWindow.removeEventListener("unload", onPresentationClosed);
      if (presentationDocument.body.contains(backdrop))
        presentationDocument.body.removeChild(backdrop);
    };
    const replacementDisposable = this.emitter.on("will-replace-document", cleanup);
    const dialogRegistration = this.registerDialog(cleanup);

    cancelButton.addEventListener("click", cleanup);
    applyButton.addEventListener("click", () => {
      if (closed) return;
      const newWidth = parseInt(widthInput.value) || currentWidth;
      const newHeight = parseInt(heightInput.value) || currentHeight;
      if (newWidth !== currentWidth || newHeight !== currentHeight) {
        this.resizeImage(newWidth, newHeight);
      }
      cleanup();
    });

    dialogElement.appendChild(buttonContainer);
    backdrop.appendChild(dialogElement);
    presentationDocument.body.appendChild(backdrop);

    const escapeHandler = (e) => {
      if (e.key === "Escape") cleanup();
    };
    presentationDocument.addEventListener("keydown", escapeHandler);
    const onPresentationClosed = cleanup;
    presentationWindow.addEventListener("unload", onPresentationClosed, { once: true });

    previewPanel.renderNow(getResizeValues());
    widthInput.focus();
    widthInput.select();
  }

  showRotateAngleDialog() {
    const presentationDocument = this.document;
    const presentationWindow = presentationDocument.defaultView;
    const dialogs = dialogUtils.forDocument(presentationDocument);
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    const backdrop = dialogs.createDialogBackdrop();
    const {
      dialogElement,
      bodyElement,
      cleanup: dialogCleanup,
    } = dialogs.createDraggableDialog("Rotate Image");
    dialogElement.classList.add("image-editor-rotate-dialog");

    const formatAngle = (value) => `${Number.parseFloat(value || 0).toFixed(1)} deg`;

    const {
      container: sliderContainer,
      slider: angleSlider,
      valueLabel,
    } = dialogs.createSliderControl({
      label: "Angle (degrees)",
      min: -180,
      max: 180,
      default: 0,
      step: 0.1,
    });
    valueLabel.textContent = formatAngle(0);
    valueLabel.classList.add("dialog-angle-value");
    valueLabel.parentElement.removeChild(valueLabel);
    bodyElement.appendChild(sliderContainer);

    const quickButtons = dialogs.createQuickButtons(
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
    bodyElement.appendChild(quickButtons);

    const { container: trimContainer, checkbox: trimCheckbox } = dialogs.createCheckbox(
      "trim-rotated-image",
      "Trim empty corners",
      true,
    );
    trimContainer.classList.add("dialog-checkbox-row");
    trimContainer.style.gap = "3px";
    trimCheckbox.style.margin = "0";
    bodyElement.appendChild(trimContainer);

    const previewPanel = dialogs.createPreviewPanel({
      sourceImage: this.refs.image,
      maxSourceSize: 1280,
      initialValues: [parseFloat(angleSlider.value), trimCheckbox.checked],
      renderPreview: (sourceCanvas, previewCanvas, values) => {
        this.renderRotatePreview(sourceCanvas, previewCanvas, values[0], values[1]);
      },
      getOutputInfo: (values) => this.getRotateOutputInfo(values[0], values[1]),
    });
    bodyElement.appendChild(previewPanel.container);
    bodyElement.appendChild(previewPanel.infoElement);

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

    const { buttonContainer, cancelButton, applyButton } = dialogs.createButtonContainer(
      "Cancel",
      "Rotate",
    );

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      dialogRegistration.dispose();
      replacementDisposable.dispose();
      previewPanel.cleanup();
      imageLoadDisposable.dispose();
      dialogCleanup();
      presentationDocument.removeEventListener("keydown", escapeHandler);
      presentationWindow.removeEventListener("unload", onPresentationClosed);
      if (presentationDocument.body.contains(backdrop))
        presentationDocument.body.removeChild(backdrop);
    };
    const replacementDisposable = this.emitter.on("will-replace-document", cleanup);
    const dialogRegistration = this.registerDialog(cleanup);

    cancelButton.addEventListener("click", cleanup);
    applyButton.addEventListener("click", () => {
      if (closed) return;
      const angle = parseFloat(angleSlider.value);
      if (angle !== 0) {
        this.freeRotate(angle, trimCheckbox.checked);
      }
      cleanup();
    });

    dialogElement.appendChild(buttonContainer);
    backdrop.appendChild(dialogElement);
    presentationDocument.body.appendChild(backdrop);

    const escapeHandler = (e) => {
      if (e.key === "Escape") cleanup();
    };
    presentationDocument.addEventListener("keydown", escapeHandler);
    const onPresentationClosed = cleanup;
    presentationWindow.addEventListener("unload", onPresentationClosed, { once: true });

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
        working = this.document.createElement("canvas");
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
        working = this.document.createElement("canvas");
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
    const presentationDocument = this.document;
    const presentationWindow = presentationDocument.defaultView;
    const dialogs = dialogUtils.forDocument(presentationDocument);
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    const documentGeneration = this.documentGeneration;
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
    const originalZoomMode = this.zoomMode;

    const backdrop = dialogs.createDialogBackdrop();
    const {
      dialogElement,
      bodyElement,
      cleanup: dialogCleanup,
    } = dialogs.createDraggableDialog("Free Rotate");

    const {
      container: sliderContainer,
      slider: angleSlider,
      valueLabel,
    } = dialogs.createSliderControl({
      label: "Angle (degrees)",
      min: -180,
      max: 180,
      default: 0,
      step: 0.5,
    });
    bodyElement.appendChild(sliderContainer);

    const quickButtons = dialogs.createQuickButtons(
      [-45, -30, -15, 0, 15, 30, 45],
      (angle) => {
        angleSlider.value = angle;
        valueLabel.textContent = `${angle}°`;
        schedulePreview();
      },
      (v) => `${v}°`,
    );
    bodyElement.appendChild(quickButtons);

    const { container: expandContainer, checkbox: expandCheckbox } = dialogs.createCheckbox(
      "expand-canvas",
      "Expand canvas to fit rotated image",
      true,
    );
    bodyElement.appendChild(expandContainer);

    const { container: autoPreviewContainer, checkbox: autoPreviewCheckbox } =
      dialogs.createCheckbox("auto-preview", "Auto preview", false);
    bodyElement.appendChild(autoPreviewContainer);

    let previewTimeout = null;
    let previewDecode = null;
    const schedulePreview = () => {
      if (closed || documentGeneration !== this.documentGeneration) return;
      if (!autoPreviewCheckbox.checked) return;
      if (previewTimeout != null) presentationWindow.clearTimeout(previewTimeout);
      previewTimeout = null;
      const timer = presentationWindow.setTimeout(() => {
        if (closed || documentGeneration !== this.documentGeneration || previewTimeout !== timer)
          return;
        previewTimeout = null;
        previewDecode?.dispose();
        previewDecode = this.applyRotatePreview(
          originalSrc,
          originalWidth,
          originalHeight,
          parseFloat(angleSlider.value),
          expandCheckbox.checked,
          () => !closed && this.document === presentationDocument,
        );
      }, 150);
      previewTimeout = timer;
    };
    expandCheckbox.addEventListener("change", schedulePreview);

    angleSlider.addEventListener("input", () => {
      valueLabel.textContent = `${angleSlider.value}°`;
      schedulePreview();
    });

    autoPreviewCheckbox.addEventListener("change", () => {
      if (closed || documentGeneration !== this.documentGeneration) return;
      if (autoPreviewCheckbox.checked) {
        schedulePreview();
      } else {
        if (previewTimeout != null) presentationWindow.clearTimeout(previewTimeout);
        previewTimeout = null;
        this.restoreOriginalImage(
          originalSrc,
          originalWidth,
          originalHeight,
          originalZoom,
          originalTranslateX,
          originalTranslateY,
          originalAuto,
          originalZoomMode,
        );
      }
    });

    const restoreOriginal = () => {
      if (previewTimeout != null) presentationWindow.clearTimeout(previewTimeout);
      previewTimeout = null;
      if (closed || documentGeneration !== this.documentGeneration) return;
      this.restoreOriginalImage(
        originalSrc,
        originalWidth,
        originalHeight,
        originalZoom,
        originalTranslateX,
        originalTranslateY,
        originalAuto,
        originalZoomMode,
      );
    };

    const { buttonContainer, cancelButton, applyButton } = dialogs.createButtonContainer(
      "Cancel",
      "Rotate",
    );

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      dialogRegistration.dispose();
      this.previewRevision = (this.previewRevision || 0) + 1;
      previewDecode?.dispose();
      previewDecode = null;
      if (previewTimeout != null) presentationWindow.clearTimeout(previewTimeout);
      previewTimeout = null;
      replacementDisposable.dispose();
      dialogCleanup();
      presentationDocument.removeEventListener("keydown", escapeHandler);
      presentationWindow.removeEventListener("unload", onPresentationClosed);
      if (presentationDocument.body.contains(backdrop))
        presentationDocument.body.removeChild(backdrop);
      // A no-op while it is still what the image is showing, which is exactly
      // the case after a cancel.
      this.unpinImageUrl(originalSrc);
    };
    const replacementDisposable = this.emitter.on("will-replace-document", cleanup);
    const cancel = () => {
      if (closed) return;
      restoreOriginal();
      cleanup();
    };
    const dialogRegistration = this.registerDialog(cancel);

    cancelButton.addEventListener("click", cancel);
    applyButton.addEventListener("click", () => {
      if (closed || documentGeneration !== this.documentGeneration) return;
      const angle = parseFloat(angleSlider.value);
      if (angle === 0) {
        restoreOriginal();
        cleanup();
        return;
      }
      restoreOriginal();
      this.trackPixelSync(this.refs.image.decode());
      this.freeRotate(angle, expandCheckbox.checked);
      cleanup();
    });

    dialogElement.appendChild(buttonContainer);
    backdrop.appendChild(dialogElement);
    presentationDocument.body.appendChild(backdrop);

    const escapeHandler = (e) => {
      if (e.key === "Escape") cancel();
    };
    presentationDocument.addEventListener("keydown", escapeHandler);
    const onPresentationClosed = cancel;
    presentationWindow.addEventListener("unload", onPresentationClosed, { once: true });

    angleSlider.focus();
  }

  applyRotatePreview(
    originalSrc,
    originalWidth,
    originalHeight,
    angle,
    expand,
    isCurrent = () => true,
  ) {
    const documentGeneration = this.documentGeneration;
    const tempImg = new Image();
    const replacementDisposable = this.emitter.on("will-replace-document", () => {
      tempImg.onload = null;
      tempImg.onerror = null;
      tempImg.removeAttribute("src");
      replacementDisposable.dispose();
    });
    tempImg.onload = () => {
      replacementDisposable.dispose();
      tempImg.onload = null;
      tempImg.onerror = null;
      if (this._destroyed || documentGeneration !== this.documentGeneration || !isCurrent()) return;
      const sourceCanvas = transforms.imageToCanvas(tempImg, this.canvasPool);
      const canvas = transforms.freeRotateImage(sourceCanvas, angle, expand, this.canvasPool);
      // A preview frame, not an edit: it is replaced by the next tick of the
      // slider and undoing to it would mean nothing. Said outright here rather
      // than left implicit in what this happens not to call.
      this.commitCanvas(canvas, {
        recordHistory: false,
        spinner: false,
        releaseCanvas: () => {
          this.returnCanvasToPool(sourceCanvas);
          this.returnCanvasToPool(canvas);
        },
        onLoad: () => {
          if (this.auto) this.applyAutoZoom();
          else this.updateTransform();
        },
      });
    };
    tempImg.onerror = () => {
      replacementDisposable.dispose();
      tempImg.onload = null;
      tempImg.onerror = null;
    };
    tempImg.src = originalSrc;
    return new Disposable(() => {
      tempImg.onload = null;
      tempImg.onerror = null;
      tempImg.removeAttribute("src");
      replacementDisposable.dispose();
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
    originalZoomMode,
  ) {
    this.setImageSource(originalSrc);
    this.originalWidth = originalWidth;
    this.originalHeight = originalHeight;
    this.zoom = originalZoom;
    this.translateX = originalTranslateX;
    this.translateY = originalTranslateY;
    this.zoomMode = originalZoomMode;
    this.auto = originalAuto;
    if (this.auto) {
      // The restored source has not decoded yet; fit its saved dimensions.
      this.zoom = this.zoomForMode(originalWidth, originalHeight);
      this.translateX = (this.refs.imageContainer.offsetWidth - originalWidth * this.zoom) / 2;
      this.translateY = (this.refs.imageContainer.offsetHeight - originalHeight * this.zoom) / 2;
    }
    this._applyTransform();
    this.emitter.emit("did-update");
  }

  showBrightnessContrastDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    this.showAdjustmentDialog(
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
    this.showAdjustmentDialog(
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
    this.showAdjustmentDialog(
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
    this.showAdjustmentDialog(
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
    this.showAdjustmentDialog(
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
    this.showAdjustmentDialog(
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
    this.showAdjustmentDialog(
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
};
