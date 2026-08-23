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

module.exports = class ImageEditorView {
  constructor(editor) {
    this.editor = editor;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.imageSize = editor.isTemporary() ? 0 : fs.statSync(this.editor.getPath()).size;
    this.loaded = false;
    this.selectionStartImg = { x: 0, y: 0 };
    this.selectionEndImg = { x: 0, y: 0 };
    this.selectionVisible = false;
    this.isSaving = false;
    this.lastSelfWrite = null;
    this.readOnly = editor.getPath() && path.extname(editor.getPath()).toLowerCase() === ".svg";
    this.smoothTransformRAF = null;

    // Initialize modular components
    this.canvasPool = new CanvasPool(3);
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
      maxHistorySize: lumine.config.get("image-editor.maxHistorySize") || 50,
      largeImageThreshold:
        (lumine.config.get("image-editor.largeImageThreshold") || 2) * 1024 * 1024,
      onModifiedStateChange: (modified) => {
        this.editor.emitter.emit("did-change-modified", modified);
      },
    });

    // Initialize navigator
    this.navigator = new ImageNavigator({
      extensions: [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg"],
      treeView: this.editor.treeView,
    });

    // Performance optimizations - cache config values
    this.lastWheelTime = 0;
    this.wheelDebounceDelay = lumine.config.get("image-editor.wheelNavigationDelay") || 150;
    this.largeImageThreshold =
      (lumine.config.get("image-editor.largeImageThreshold") || 2) * 1024 * 1024;

    etch.initialize(this);

    this.defaultBackgroundColor = lumine.config.get("image-editor.defaultBackgroundColor");
    this.refs.imageContainer.setAttribute("background", this.defaultBackgroundColor);
    this.refs.image.style.display = "none";
    this.updateImageURI();

    this._setupDisposables();
    this._setupTooltips();
    this._setupEventListeners();
    this.setupResizeHandles();
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

    this.resizeObserver = new ResizeObserver(() => {
      if (this.auto) {
        this.zoomToFit();
      }
    });
    this.resizeObserver.observe(this.refs.imageContainer);

    this._setupMouseHandlers();
  }

  _setupMouseHandlers() {
    this.mouseMoveHandler = (event) => this.mouseHandler.handleMouseMove(event);
    this.mouseDownHandler = (event) => this.mouseHandler.handleMouseDown(event);
    this.mouseUpHandler = () => this.mouseHandler.handleMouseUp();
    this.contextMenuHandler = (event) => this.mouseHandler.handleContextMenu(event);
    this.doubleClickHandler = (event) => this.mouseHandler.handleDoubleClick(event);

    this.refs.imageContainer.addEventListener("mousedown", this.mouseDownHandler);
    this.refs.imageContainer.addEventListener("dblclick", this.doubleClickHandler);
    window.addEventListener("mousemove", this.mouseMoveHandler);
    window.addEventListener("mouseup", this.mouseUpHandler);
    window.addEventListener("contextmenu", this.contextMenuHandler, true);

    this.disposables.add(
      new Disposable(() => {
        this.refs.imageContainer.removeEventListener("mousedown", this.mouseDownHandler);
        this.refs.imageContainer.removeEventListener("dblclick", this.doubleClickHandler);
        window.removeEventListener("mousemove", this.mouseMoveHandler);
        window.removeEventListener("mouseup", this.mouseUpHandler);
        window.removeEventListener("contextmenu", this.contextMenuHandler, true);
      }),
    );
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
      this.selectionVisible = false;
      this.refs.selectionBox.style.display = "none";
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

  destroy() {
    if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
    this.disposables.dispose();
    this.emitter.dispose();
    this.resizeObserver.disconnect();
    this.canvasPool.clear();
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

    // Skip reload if image has unsaved modifications (unless forced)
    if (!options.force && this.isModified()) return;

    if (this.loadingAbortController) {
      this.loadingAbortController.cancelled = true;
    }

    this.loadingAbortController = { cancelled: false };
    const currentLoad = this.loadingAbortController;

    this.showSpinner();

    // Handle temporary editors (data URLs) - no file stats needed
    if (this.editor.isTemporary()) {
      const imageUrl = this.editor.getDataUrl();
      try {
        await this.loadImageOptimized(imageUrl, false, Date.now(), currentLoad);
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
      this.imageSize = stats.size;
    } catch (e) {
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
      this.hideSpinner();
      return;
    }

    const loadStartTime = Date.now();
    const imageUrl = `${this.editor.getEncodedURI()}?time=${Date.now()}`;
    const isLargeImage = this.imageSize > this.largeImageThreshold;

    try {
      await this.loadImageOptimized(imageUrl, isLargeImage, loadStartTime, currentLoad);
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

  async loadImageOptimized(imageUrl, isLargeImage, loadStartTime, currentLoad) {
    return new Promise((resolve, reject) => {
      if (this.readOnly) imageUrl = this._svgBlobUrl(imageUrl);
      this.refs.image.src = imageUrl;

      this.refs.image.onload = async () => {
        try {
          if (currentLoad.cancelled) {
            resolve();
            return;
          }

          if (isLargeImage && this.refs.image.decode) {
            try {
              await this.refs.image.decode();
            } catch (decodeError) {
              if (currentLoad.cancelled) {
                resolve();
                return;
              }
              console.warn(
                "Image decode failed, continuing without async decode:",
                decodeError.message,
              );
            }
          }

          if (currentLoad.cancelled) {
            resolve();
            return;
          }

          this.refs.image.onload = null;
          const previousWidth = this.originalWidth;
          const previousHeight = this.originalHeight;
          const wasLoaded = this.loaded;
          this.originalHeight = this.refs.image.naturalHeight;
          this.originalWidth = this.refs.image.naturalWidth;

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
          this.refs.image.style.display = "";

          this.historyManager.reset();
          this.emitter.emit("did-update");
          this.emitter.emit("did-load");
          this.hideSpinner();

          this.navigator.invalidateCache();

          resolve();
        } catch (error) {
          reject(error);
        }
      };

      this.refs.image.onerror = () => {
        this.refs.image.onerror = null;
        this.loaded = false;
        this.hideSpinner();
        if (currentLoad.cancelled) {
          resolve();
        } else {
          // Check if file still exists before showing error
          const filePath = this.editor.getPath();
          if (filePath) {
            fs.promises
              .access(filePath, fs.constants.F_OK)
              .then(() => {
                // File exists but failed to load - genuine error
                reject(new Error("Failed to load image"));
              })
              .catch(() => {
                // File was deleted/renamed - resolve silently
                resolve();
              });
          } else {
            reject(new Error("Failed to load image"));
          }
        }
      };
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
    if (this.smoothTransformRAF) {
      cancelAnimationFrame(this.smoothTransformRAF);
      this.smoothTransformRAF = null;
    }
  }

  updateTransform({ smooth = false } = {}) {
    if (smooth) {
      this.updateTransformSmooth();
      return;
    }

    this.cancelSmoothTransform();
    if (!this.transformRAF) {
      this.transformRAF = requestAnimationFrame(() => {
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
      cancelAnimationFrame(this.transformRAF);
      this.transformRAF = null;
    }
    this.cancelSmoothTransform();

    const target = {
      translateX: this.translateX,
      translateY: this.translateY,
      zoom: this.zoom,
    };
    const start = this.renderedTransform || target;
    const startTime = performance.now();

    const animate = (now) => {
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const translateX = start.translateX + (target.translateX - start.translateX) * eased;
      const translateY = start.translateY + (target.translateY - start.translateY) * eased;
      const zoom = start.zoom + (target.zoom - start.zoom) * eased;

      this._applyTransform({ translateX, translateY, zoom, isSmoothFrame: true });

      if (progress < 1) {
        this.smoothTransformRAF = requestAnimationFrame(animate);
      } else {
        this.smoothTransformRAF = null;
        this._applyTransform();
      }
    };

    this.smoothTransformRAF = requestAnimationFrame(animate);
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
    this.selectionVisible = false;
    this.refs.selectionBox.style.display = "none";

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
      this.selectionVisible = false;
      this.refs.selectionBox.style.display = "none";
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
    const now = Date.now();
    if (this.lastNavigationTime && now - this.lastNavigationTime < 50) return;
    this.lastNavigationTime = now;

    if (
      lumine.config.get("image-editor.scrollCycle") &&
      (await this.navigator.isAtEnd(this.editor.getPath()))
    ) {
      this.showBoundaryOverlay("right");
    }

    const nextPath = await this.navigator.getNextImage(this.editor.getPath());
    if (nextPath && path.normalize(nextPath) !== path.normalize(this.editor.getPath())) {
      this.loadImageFromNavigation(nextPath);
    }
  }

  async previousImage() {
    const now = Date.now();
    if (this.lastNavigationTime && now - this.lastNavigationTime < 50) return;
    this.lastNavigationTime = now;

    if (
      lumine.config.get("image-editor.scrollCycle") &&
      (await this.navigator.isAtStart(this.editor.getPath()))
    ) {
      this.showBoundaryOverlay("left");
    }

    const prevPath = await this.navigator.getPreviousImage(this.editor.getPath());
    if (prevPath && path.normalize(prevPath) !== path.normalize(this.editor.getPath())) {
      this.loadImageFromNavigation(prevPath);
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
    return this.navigator.getFileList(this.editor.getPath());
  }

  async loadImageFromNavigation(imagePath) {
    if (!imagePath) return;

    this.showSpinner();
    this.auto = true; // Reset to fit zoom on navigation
    this.refs.zoomToFitButton.classList.add("selected");

    // Verify the file still exists before loading. This both gives the status
    // bar an immediate size and avoids a browser ERR_FILE_NOT_FOUND when
    // navigating to an image that was deleted/moved.
    try {
      const stats = await fs.promises.stat(imagePath);
      this.imageSize = stats.size;
    } catch {
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

    const navigationLoadId = (this.navigationLoadId || 0) + 1;
    this.navigationLoadId = navigationLoadId;
    let encodedPath = `${paths.encodeFileURL(imagePath)}?time=${Date.now()}`;
    encodedPath = this._svgBlobUrl(encodedPath, imagePath);
    const tempImg = new Image();
    tempImg.onload = () => {
      if (navigationLoadId !== this.navigationLoadId) return;
      const imageData = this.calculateZoomForImage(tempImg, encodedPath);
      this.applyImageWithMetadata(imagePath, imageData);
      this.hideSpinner();
    };
    tempImg.onerror = () => {
      if (navigationLoadId !== this.navigationLoadId) return;
      this.hideSpinner();
      lumine.notifications.addError("Failed to load image", {
        description: `Could not load ${imagePath}`,
      });
    };
    tempImg.src = encodedPath;
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
    this.refs.image.src = imageData.encodedPath;
    this._skipNextReload = true;
    this.lastSelfWrite = null;
    this.editor.load(imagePath);
    this.historyManager.reset();
    this.selectionVisible = false;
    this.refs.selectionBox.style.display = "none";
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

    transforms.canvasToBlob(canvas).then((blob) => {
      const url = URL.createObjectURL(blob);
      const tempImg = new Image();
      tempImg.onload = () => {
        this.refs.image.src = url;
        this.originalHeight = tempImg.naturalHeight;
        this.originalWidth = tempImg.naturalWidth;

        if (this.auto) {
          this.zoomToFit();
        } else {
          const newImageWidth = this.originalWidth * this.zoom;
          const newImageHeight = this.originalHeight * this.zoom;
          this.translateX = cropCenterX - newImageWidth / 2;
          this.translateY = cropCenterY - newImageHeight / 2;
          this.updateTransform();
        }

        this.setSelectionVisibility(false);
        this.emitter.emit("did-update");
        this.saveToHistory();
        this.hideSpinner();

        if (lumine.config.get("image-editor.showSuccessMessages")) {
          lumine.notifications.addSuccess("Image cropped", {
            description: 'Image has been cropped to selection. Use "Save" to save changes.',
          });
        }
      };
      tempImg.onerror = () => this.hideSpinner();
      tempImg.src = url;
    });
  }

  blurImage(blurLevel) {
    this.applyImageFilter("blur", blurLevel);
  }

  sharpenImage(strength) {
    this.applyImageFilter("sharpen", strength);
  }

  applyImageFilter(filterType, strength) {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    const area = this.getSelectionArea();
    if (!area) {
      lumine.notifications.addWarning("Invalid selection", {
        description: "Selection has no area.",
      });
      return;
    }

    this.ensureInitialHistorySaved();

    const { left, top, width, height, hasSelection } = area;
    const isLargeArea = width * height > 2000000;
    if (isLargeArea) {
      const filterName = filterType === "blur" ? "blur" : "sharpen";
      lumine.notifications.addInfo(`Processing ${filterName}...`, {
        description: "This may take a moment for large images.",
        dismissable: true,
      });
    }

    setTimeout(() => {
      const canvas = this.getPooledCanvas(
        this.refs.image.naturalWidth,
        this.refs.image.naturalHeight,
      );
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(this.refs.image, 0, 0);

      const imageData = ctx.getImageData(left, top, width, height);

      if (filterType === "blur") {
        filters.fastGaussianBlur(imageData, width, height, strength * 2);
      } else if (filterType === "sharpen") {
        filters.applySharpenKernel(imageData, width, height, strength);
      }

      ctx.putImageData(imageData, left, top);

      const areaText = hasSelection ? "selection" : "image";
      let message =
        filterType === "blur"
          ? `Blur level ${strength} applied to ${areaText}`
          : `Sharpen applied to ${areaText}`;

      this.updateImageFromCanvasWithoutHistory(canvas, message, () =>
        this.returnCanvasToPool(canvas),
      );
    }, 10);
  }

  applyGrayscale(amount = 100) {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    const area = this.getSelectionArea();
    if (!area) {
      lumine.notifications.addWarning("Invalid selection");
      return;
    }

    this.ensureInitialHistorySaved();

    const canvas = this.getPooledCanvas(
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
    );
    const ctx = canvas.getContext("2d");
    ctx.drawImage(this.refs.image, 0, 0);

    const imageData = ctx.getImageData(area.left, area.top, area.width, area.height);
    filters.applyGrayscaleAmount(imageData, amount);
    ctx.putImageData(imageData, area.left, area.top);

    this.updateImageFromCanvasWithoutHistory(
      canvas,
      `Grayscale ${amount}% applied to ${area.hasSelection ? "selection" : "image"}`,
      () => this.returnCanvasToPool(canvas),
    );
  }

  invertColors() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    const area = this.getSelectionArea();
    if (!area) {
      lumine.notifications.addWarning("Invalid selection");
      return;
    }

    this.ensureInitialHistorySaved();

    const canvas = this.getPooledCanvas(
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
    );
    const ctx = canvas.getContext("2d");
    ctx.drawImage(this.refs.image, 0, 0);

    const imageData = ctx.getImageData(area.left, area.top, area.width, area.height);
    filters.invertColors(imageData);
    ctx.putImageData(imageData, area.left, area.top);

    this.updateImageFromCanvasWithoutHistory(
      canvas,
      `Colors inverted on ${area.hasSelection ? "selection" : "image"}`,
      () => this.returnCanvasToPool(canvas),
    );
  }

  applySepia() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    const area = this.getSelectionArea();
    if (!area) {
      lumine.notifications.addWarning("Invalid selection");
      return;
    }

    this.ensureInitialHistorySaved();

    const canvas = this.getPooledCanvas(
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
    );
    const ctx = canvas.getContext("2d");
    ctx.drawImage(this.refs.image, 0, 0);

    const imageData = ctx.getImageData(area.left, area.top, area.width, area.height);
    filters.applySepia(imageData);
    ctx.putImageData(imageData, area.left, area.top);

    this.updateImageFromCanvasWithoutHistory(
      canvas,
      `Sepia tone applied to ${area.hasSelection ? "selection" : "image"}`,
      () => this.returnCanvasToPool(canvas),
    );
  }

  applyBrightnessContrast(brightness, contrast) {
    const area = this.getSelectionArea();
    if (!area) {
      lumine.notifications.addWarning("Invalid selection");
      return;
    }

    this.ensureInitialHistorySaved();

    const canvas = this.getPooledCanvas(
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
    );
    const ctx = canvas.getContext("2d");
    ctx.drawImage(this.refs.image, 0, 0);

    const imageData = ctx.getImageData(area.left, area.top, area.width, area.height);
    filters.applyBrightnessContrast(imageData, brightness, contrast);
    ctx.putImageData(imageData, area.left, area.top);

    this.updateImageFromCanvasWithoutHistory(
      canvas,
      `Brightness & contrast adjusted on ${area.hasSelection ? "selection" : "image"}`,
      () => this.returnCanvasToPool(canvas),
    );
  }

  applySaturation(saturation) {
    const area = this.getSelectionArea();
    if (!area) {
      lumine.notifications.addWarning("Invalid selection");
      return;
    }

    this.ensureInitialHistorySaved();

    const canvas = this.getPooledCanvas(
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
    );
    const ctx = canvas.getContext("2d");
    ctx.drawImage(this.refs.image, 0, 0);

    const imageData = ctx.getImageData(area.left, area.top, area.width, area.height);
    filters.applySaturation(imageData, saturation);
    ctx.putImageData(imageData, area.left, area.top);

    this.updateImageFromCanvasWithoutHistory(
      canvas,
      `Saturation adjusted on ${area.hasSelection ? "selection" : "image"}`,
      () => this.returnCanvasToPool(canvas),
    );
  }

  applyHueShift(hueShift) {
    const area = this.getSelectionArea();
    if (!area) {
      lumine.notifications.addWarning("Invalid selection");
      return;
    }

    this.ensureInitialHistorySaved();

    const canvas = this.getPooledCanvas(
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
    );
    const ctx = canvas.getContext("2d");
    ctx.drawImage(this.refs.image, 0, 0);

    const imageData = ctx.getImageData(area.left, area.top, area.width, area.height);
    filters.applyHueShift(imageData, hueShift);
    ctx.putImageData(imageData, area.left, area.top);

    this.updateImageFromCanvasWithoutHistory(
      canvas,
      `Hue shifted on ${area.hasSelection ? "selection" : "image"}`,
      () => this.returnCanvasToPool(canvas),
    );
  }

  applyPosterize(levels) {
    const area = this.getSelectionArea();
    if (!area) {
      lumine.notifications.addWarning("Invalid selection");
      return;
    }

    this.ensureInitialHistorySaved();

    const canvas = this.getPooledCanvas(
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
    );
    const ctx = canvas.getContext("2d");
    ctx.drawImage(this.refs.image, 0, 0);

    const imageData = ctx.getImageData(area.left, area.top, area.width, area.height);
    filters.applyPosterize(imageData, levels);
    ctx.putImageData(imageData, area.left, area.top);

    this.updateImageFromCanvasWithoutHistory(
      canvas,
      `Posterized to ${levels} levels on ${area.hasSelection ? "selection" : "image"}`,
      () => this.returnCanvasToPool(canvas),
    );
  }

  autoAdjustColors() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    let area = this.getSelectionArea();
    if (!area) {
      this.hideSelection();
      area = this.getSelectionArea();
      if (!area) {
        lumine.notifications.addError("Unable to get image area");
        return;
      }
    }

    this.ensureInitialHistorySaved();

    const canvas = this.getPooledCanvas(
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
    );
    const ctx = canvas.getContext("2d");
    ctx.drawImage(this.refs.image, 0, 0);

    const imageData = ctx.getImageData(area.left, area.top, area.width, area.height);
    filters.autoAdjustColors(imageData);
    ctx.putImageData(imageData, area.left, area.top);

    this.updateImageFromCanvasWithoutHistory(
      canvas,
      `Auto adjusted colors on ${area.hasSelection ? "selection" : "image"}`,
      () => this.returnCanvasToPool(canvas),
    );
  }

  updateImageFromCanvasWithoutHistory(canvas, successMessage, onComplete = null) {
    if (this.readOnly) {
      if (onComplete) onComplete();
      lumine.notifications.addWarning("This image is read-only");
      return;
    }
    this.showSpinner();

    canvas.toBlob((blob) => {
      // Return canvas to pool after blob is created
      if (onComplete) onComplete();

      const url = URL.createObjectURL(blob);
      this.refs.image.src = url;
      this.refs.image.onload = () => {
        this.refs.image.onload = null;
        this.updateTransform();
        this.emitter.emit("did-update");
        this.saveToHistory();
        this.hideSpinner();

        if (lumine.config.get("image-editor.showSuccessMessages")) {
          lumine.notifications.addSuccess(successMessage, {
            description: 'Use "Save" to save changes.',
          });
        }
      };
      this.refs.image.onerror = () => this.hideSpinner();
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

    transforms.canvasToBlob(canvas).then((blob) => {
      const url = URL.createObjectURL(blob);

      // Preload into temp image first so blob is cached
      const tempImg = new Image();
      tempImg.onload = () => {
        // Now apply to actual image - loads instantly from cache
        this.refs.image.src = url;
        this.originalWidth = canvas.width;
        this.originalHeight = canvas.height;
        if (this.auto) {
          let zoom = Math.min(
            this.refs.imageContainer.offsetWidth / canvas.width,
            this.refs.imageContainer.offsetHeight / canvas.height,
          );
          zoom = Math.min(zoom, 1);
          this.zoom = Math.min(Math.max(zoom, 0.001), 100);
          this.translateX = (this.refs.imageContainer.offsetWidth - canvas.width * this.zoom) / 2;
          this.translateY = (this.refs.imageContainer.offsetHeight - canvas.height * this.zoom) / 2;
        }
        this._applyTransform();

        this.refs.selectionBox.style.display = "none";
        this.emitter.emit("did-update");
        this.saveToHistory();
        this.hideSpinner();

        if (lumine.config.get("image-editor.showSuccessMessages")) {
          const direction = degrees > 0 ? "clockwise" : "counter-clockwise";
          lumine.notifications.addSuccess("Image rotated", {
            description: `Rotated ${Math.abs(degrees)}° ${degrees === 180 ? "" : direction}. Use "Save" to save changes.`,
          });
        }
      };
      tempImg.onerror = () => this.hideSpinner();
      tempImg.src = url;
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

    transforms.canvasToBlob(canvas).then((blob) => {
      this.returnCanvasToPool(canvas);
      const url = URL.createObjectURL(blob);
      this.refs.image.src = url;
      this.refs.image.onload = () => {
        this.refs.image.onload = null;
        this.originalWidth = this.refs.image.naturalWidth;
        this.originalHeight = this.refs.image.naturalHeight;

        if (this.auto) this.zoomToFit();
        else this.updateTransform();

        this.refs.selectionBox.style.display = "none";
        this.emitter.emit("did-update");
        this.saveToHistory();
        this.hideSpinner();

        if (lumine.config.get("image-editor.showSuccessMessages")) {
          lumine.notifications.addSuccess("Image rotated", {
            description: `Rotated ${degrees} deg${trim ? " and trimmed" : ""}. Use "Save" to save changes.`,
          });
        }
      };
      this.refs.image.onerror = () => this.hideSpinner();
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

    transforms.canvasToBlob(canvas).then((blob) => {
      const url = URL.createObjectURL(blob);
      this.refs.image.src = url;
      this.refs.image.onload = () => {
        this.refs.image.onload = null;
        this.updateTransform();
        this.refs.selectionBox.style.display = "none";
        this.emitter.emit("did-update");
        this.saveToHistory();
        this.hideSpinner();

        if (lumine.config.get("image-editor.showSuccessMessages")) {
          lumine.notifications.addSuccess("Image flipped", {
            description: 'Flipped horizontally. Use "Save" to save changes.',
          });
        }
      };
      this.refs.image.onerror = () => this.hideSpinner();
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

    transforms.canvasToBlob(canvas).then((blob) => {
      const url = URL.createObjectURL(blob);
      this.refs.image.src = url;
      this.refs.image.onload = () => {
        this.refs.image.onload = null;
        this.updateTransform();
        this.refs.selectionBox.style.display = "none";
        this.emitter.emit("did-update");
        this.saveToHistory();
        this.hideSpinner();

        if (lumine.config.get("image-editor.showSuccessMessages")) {
          lumine.notifications.addSuccess("Image flipped", {
            description: 'Flipped vertically. Use "Save" to save changes.',
          });
        }
      };
      this.refs.image.onerror = () => this.hideSpinner();
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

    transforms.canvasToBlob(canvas).then((blob) => {
      const url = URL.createObjectURL(blob);
      this.refs.image.src = url;
      this.refs.image.onload = () => {
        this.refs.image.onload = null;
        this.originalWidth = this.refs.image.naturalWidth;
        this.originalHeight = this.refs.image.naturalHeight;

        if (this.auto) this.zoomToFit();
        else this.updateTransform();

        this.refs.selectionBox.style.display = "none";
        this.emitter.emit("did-update");
        this.saveToHistory();
        this.hideSpinner();

        if (lumine.config.get("image-editor.showSuccessMessages")) {
          lumine.notifications.addSuccess("Image resized", {
            description: `Resized from ${oldWidth}×${oldHeight} to ${newWidth}×${newHeight}. Use "Save" to save changes.`,
          });
        }
      };
      this.refs.image.onerror = () => this.hideSpinner();
    });
  }

  async save() {
    if (!this.loaded) {
      lumine.notifications.addError("No image to save");
      return;
    }
    if (this.readOnly) {
      lumine.notifications.addWarning("This image is read-only");
      return;
    }

    const currentPath = this.editor.getPath();
    if (!currentPath) return this.saveImage();

    try {
      this.isSaving = true;
      fileOps.saveImage(
        this.refs.image,
        currentPath,
        (path, stats) => {
          this.historyManager.reset();
          this.noteSelfWrite(path, stats);
          this.isSaving = false;
          if (lumine.config.get("image-editor.showSuccessMessages")) {
            lumine.notifications.addSuccess("Image saved", { description: `Saved to ${path}` });
          }
        },
        (error) => {
          this.isSaving = false;
          lumine.notifications.addError("Failed to save image", { description: error.message });
        },
      );
    } catch (error) {
      this.isSaving = false;
      lumine.notifications.addError("Failed to save image", { description: error.message });
    }
  }

  async saveImage() {
    if (!this.loaded) {
      lumine.notifications.addError("No image to save");
      return;
    }

    fileOps.saveImageAs(
      this.refs.image,
      this.editor.getPath(),
      (path, stats) => {
        this.noteSelfWrite(path, stats);
        if (lumine.config.get("image-editor.showSuccessMessages")) {
          lumine.notifications.addSuccess("Image saved", { description: `Saved to ${path}` });
        }
      },
      (error) => {
        lumine.notifications.addError("Failed to save image", { description: error.message });
      },
    );
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

  saveToHistory() {
    if (!this.loaded || this.readOnly) return;

    const canvas = this.getPooledCanvas(
      this.refs.image.naturalWidth,
      this.refs.image.naturalHeight,
    );
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(this.refs.image, 0, 0);

    this.historyManager.saveStateWithCanvas(
      canvas,
      {
        translateX: this.translateX,
        translateY: this.translateY,
        zoom: this.zoom,
        auto: this.auto,
      },
      this.imageSize,
    );

    this.returnCanvasToPool(canvas);
  }

  isModified() {
    return this.historyManager.isModified();
  }

  undo() {
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
    this.loadFromHistory(state);

    if (lumine.config.get("image-editor.showSuccessMessages")) {
      const pos = this.historyManager.getPosition();
      lumine.notifications.addSuccess("Undo", {
        description: `Reverted to previous state (${pos.current}/${pos.total}).`,
      });
    }
  }

  redo() {
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
    this.loadFromHistory(state);

    if (lumine.config.get("image-editor.showSuccessMessages")) {
      const pos = this.historyManager.getPosition();
      lumine.notifications.addSuccess("Redo", {
        description: `Restored to next state (${pos.current}/${pos.total}).`,
      });
    }
  }

  loadFromHistory(historyEntry) {
    if (!historyEntry) return;

    this.showSpinner();

    const prevWidth = this.refs.image.naturalWidth;
    const prevHeight = this.refs.image.naturalHeight;
    const dataUrl = this.historyManager.getDataUrl(historyEntry);

    const img = new Image();
    img.onload = () => {
      this.refs.image.src = dataUrl;
      this.originalHeight = img.naturalHeight;
      this.originalWidth = img.naturalWidth;

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
    };
    img.onerror = () => this.hideSpinner();
    img.src = dataUrl;
  }

  showResizeDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    const currentWidth = this.refs.image.naturalWidth;
    const currentHeight = this.refs.image.naturalHeight;
    const aspectRatio = currentWidth / currentHeight;

    const backdrop = dialogs.createDialogBackdrop();
    const { dialogElement, cleanup: dialogCleanup } = dialogs.createDraggableDialog("Resize Image");
    dialogElement.classList.add("image-editor-preview-dialog");

    const infoElement = dialogs.createSelectionInfo(
      `Current size: ${currentWidth} × ${currentHeight} px`,
    );
    dialogElement.appendChild(infoElement);

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
    dialogElement.appendChild(widthContainer);
    dialogElement.appendChild(heightContainer);

    const { container: lockContainer, checkbox: lockCheckbox } = dialogs.createCheckbox(
      "lock-aspect-ratio",
      "Lock aspect ratio",
      true,
    );
    dialogElement.appendChild(lockContainer);

    const percentButtons = dialogs.createQuickButtons(
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
    const previewPanel = dialogs.createPreviewPanel({
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

    const { buttonContainer, cancelButton, applyButton } = dialogs.createButtonContainer(
      "Cancel",
      "Resize",
    );

    const cleanup = () => {
      previewPanel.cleanup();
      imageLoadDisposable.dispose();
      dialogCleanup();
      document.removeEventListener("keydown", escapeHandler);
      if (document.body.contains(backdrop)) document.body.removeChild(backdrop);
    };

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
    document.body.appendChild(backdrop);

    const escapeHandler = (e) => {
      if (e.key === "Escape") cleanup();
    };
    document.addEventListener("keydown", escapeHandler);

    previewPanel.renderNow(getResizeValues());
    widthInput.focus();
    widthInput.select();
  }

  showRotateAngleDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }

    const backdrop = dialogs.createDialogBackdrop();
    const { dialogElement, cleanup: dialogCleanup } = dialogs.createDraggableDialog("Rotate Image");
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
    dialogElement.appendChild(sliderContainer);

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
    dialogElement.appendChild(quickButtons);

    const { container: trimContainer, checkbox: trimCheckbox } = dialogs.createCheckbox(
      "trim-rotated-image",
      "Trim empty corners",
      true,
    );
    trimContainer.classList.add("dialog-checkbox-row");
    trimContainer.style.gap = "3px";
    trimCheckbox.style.margin = "0";
    dialogElement.appendChild(trimContainer);

    const previewPanel = dialogs.createPreviewPanel({
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

    const { buttonContainer, cancelButton, applyButton } = dialogs.createButtonContainer(
      "Cancel",
      "Rotate",
    );

    const cleanup = () => {
      previewPanel.cleanup();
      imageLoadDisposable.dispose();
      dialogCleanup();
      document.removeEventListener("keydown", escapeHandler);
      if (document.body.contains(backdrop)) document.body.removeChild(backdrop);
    };

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
    document.body.appendChild(backdrop);

    const escapeHandler = (e) => {
      if (e.key === "Escape") cleanup();
    };
    document.addEventListener("keydown", escapeHandler);

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
      return { left: 0, top: 0, width: sourceCanvas.width, height: sourceCanvas.height };
    }

    const scaleX = sourceCanvas.width / this.refs.image.naturalWidth;
    const scaleY = sourceCanvas.height / this.refs.image.naturalHeight;
    const left = Math.max(0, Math.min(sourceCanvas.width - 1, Math.floor(area.left * scaleX)));
    const top = Math.max(0, Math.min(sourceCanvas.height - 1, Math.floor(area.top * scaleY)));

    return {
      left,
      top,
      width: Math.max(1, Math.min(sourceCanvas.width - left, Math.round(area.width * scaleX))),
      height: Math.max(1, Math.min(sourceCanvas.height - top, Math.round(area.height * scaleY))),
    };
  }

  createAdjustmentPreviewOptions(applyPreview, maxSourceSize = 1024) {
    return {
      sourceImage: this.refs.image,
      maxSourceSize,
      renderPreview: (sourceCanvas, previewCanvas, values, area) => {
        const outputCanvas = document.createElement("canvas");
        outputCanvas.width = sourceCanvas.width;
        outputCanvas.height = sourceCanvas.height;
        const outputCtx = outputCanvas.getContext("2d", { willReadFrequently: true });
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
    const originalWidth = this.originalWidth;
    const originalHeight = this.originalHeight;
    const originalZoom = this.zoom;
    const originalTranslateX = this.translateX;
    const originalTranslateY = this.translateY;
    const originalAuto = this.auto;

    const backdrop = dialogs.createDialogBackdrop();
    const { dialogElement, cleanup: dialogCleanup } = dialogs.createDraggableDialog("Free Rotate");

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
    dialogElement.appendChild(sliderContainer);

    const quickButtons = dialogs.createQuickButtons(
      [-45, -30, -15, 0, 15, 30, 45],
      (angle) => {
        angleSlider.value = angle;
        valueLabel.textContent = `${angle}°`;
        schedulePreview();
      },
      (v) => `${v}°`,
    );
    dialogElement.appendChild(quickButtons);

    const { container: expandContainer, checkbox: expandCheckbox } = dialogs.createCheckbox(
      "expand-canvas",
      "Expand canvas to fit rotated image",
      true,
    );
    expandCheckbox.addEventListener("change", schedulePreview);
    dialogElement.appendChild(expandContainer);

    const { container: autoPreviewContainer, checkbox: autoPreviewCheckbox } =
      dialogs.createCheckbox("auto-preview", "Auto preview", false);
    dialogElement.appendChild(autoPreviewContainer);

    let previewTimeout = null;
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

    angleSlider.addEventListener("input", () => {
      valueLabel.textContent = `${angleSlider.value}°`;
      schedulePreview();
    });

    autoPreviewCheckbox.addEventListener("change", () => {
      if (autoPreviewCheckbox.checked) {
        schedulePreview();
      } else {
        if (previewTimeout) clearTimeout(previewTimeout);
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
    });

    const restoreOriginal = () => {
      if (previewTimeout) clearTimeout(previewTimeout);
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

    const { buttonContainer, cancelButton, applyButton } = dialogs.createButtonContainer(
      "Cancel",
      "Rotate",
    );

    const cleanup = () => {
      dialogCleanup();
      document.removeEventListener("keydown", escapeHandler);
      if (document.body.contains(backdrop)) document.body.removeChild(backdrop);
    };

    cancelButton.addEventListener("click", () => {
      restoreOriginal();
      cleanup();
    });
    applyButton.addEventListener("click", () => {
      const angle = parseFloat(angleSlider.value);
      if (angle === 0) {
        restoreOriginal();
        cleanup();
        return;
      }
      restoreOriginal();
      this.freeRotate(angle, expandCheckbox.checked);
      cleanup();
    });

    dialogElement.appendChild(buttonContainer);
    backdrop.appendChild(dialogElement);
    document.body.appendChild(backdrop);

    const escapeHandler = (e) => {
      if (e.key === "Escape") {
        restoreOriginal();
        cleanup();
      }
    };
    document.addEventListener("keydown", escapeHandler);

    angleSlider.focus();
  }

  applyRotatePreview(originalSrc, originalWidth, originalHeight, angle, expand) {
    const tempImg = new Image();
    tempImg.onload = () => {
      const sourceCanvas = transforms.imageToCanvas(tempImg, this.canvasPool);
      const canvas = transforms.freeRotateImage(sourceCanvas, angle, expand, this.canvasPool);
      transforms.canvasToBlob(canvas).then((blob) => {
        const url = URL.createObjectURL(blob);
        this.refs.image.src = url;
        this.refs.image.onload = () => {
          this.refs.image.onload = null;
          this.originalWidth = canvas.width;
          this.originalHeight = canvas.height;
          if (this.auto) this.zoomToFit();
          else this.updateTransform();
          this.emitter.emit("did-update");
        };
      });
    };
    tempImg.src = originalSrc;
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
    this.refs.image.src = originalSrc;
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
    dialogs.showAdjustmentDialog(
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
    dialogs.showAdjustmentDialog(
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
    dialogs.showAdjustmentDialog(
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
    dialogs.showAdjustmentDialog(
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
    dialogs.showAdjustmentDialog(
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
    dialogs.showAdjustmentDialog(
      "Blur",
      [{ label: "Radius", min: 1, max: 50, default: 12, step: 1 }],
      () => this.getSelectionArea(),
      (values) => this.blurImage(values[0]),
      this.emitter,
      this.createAdjustmentPreviewOptions(
        (imageData, width, height, values) =>
          filters.fastGaussianBlur(imageData, width, height, values[0] * 2),
        768,
      ),
    );
  }

  showSharpenDialog() {
    if (!this.loaded) {
      lumine.notifications.addError("Image not loaded");
      return;
    }
    dialogs.showAdjustmentDialog(
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

    const backdrop = dialogs.createDialogBackdrop();
    const dialogElement = document.createElement("div");
    dialogElement.className = "image-editor-properties-dialog";

    const titleElement = document.createElement("h3");
    titleElement.className = "dialog-title";
    titleElement.textContent = "Image Properties";
    dialogElement.appendChild(titleElement);

    const table = document.createElement("table");
    table.className = "properties-table";

    const addRow = (label, value) => {
      const row = document.createElement("tr");
      const labelCell = document.createElement("td");
      labelCell.className = "property-label";
      labelCell.textContent = label + ":";
      const valueCell = document.createElement("td");
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

    const { buttonContainer, applyButton } = dialogs.createButtonContainer("", "Close");
    applyButton.className = "btn btn-primary";
    buttonContainer.innerHTML = "";
    buttonContainer.appendChild(applyButton);
    buttonContainer.style.marginTop = "15px";

    const cleanup = () => {
      imageLoadDisposable.dispose();
      imageUpdateDisposable.dispose();
      document.removeEventListener("keydown", escapeHandler);
      if (document.body.contains(backdrop)) document.body.removeChild(backdrop);
    };

    applyButton.addEventListener("click", cleanup);
    dialogElement.appendChild(buttonContainer);
    backdrop.appendChild(dialogElement);
    document.body.appendChild(backdrop);

    const escapeHandler = (e) => {
      if (e.key === "Escape") cleanup();
    };
    document.addEventListener("keydown", escapeHandler);
    const imageLoadDisposable = this.onDidLoad(refreshProperties);
    const imageUpdateDisposable = this.onDidUpdate(refreshProperties);

    await refreshProperties();
    applyButton.focus();
  }
};
