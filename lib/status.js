const { CompositeDisposable, Disposable } = require("lumine");
const ImageEditor = require("./editor");
const ImageEditorView = require("./view");

// Minimal replacement for the `bytes` package: format a byte count with a
// binary-unit suffix (e.g. 1536 -> "1.5KB"), matching its default output.
function formatBytes(size) {
  if (!Number.isFinite(size)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let value = size;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}${units[index]}`;
}

module.exports = class ImageEditorStatusView {
  constructor(statusBar, context = {}) {
    this.window = context.window ?? lumine.workspace.getMainWindow();
    this.container = context.editorContainer ?? this.window.getEditorContainer();
    this.document = this.window.getDocument();
    this.statusBar = statusBar;
    this.disposables = new CompositeDisposable();

    this.element = this.document.createElement("status-bar-tile");
    this.element.classList.add("status-image");
    this.element.setAttribute("data-context-menu-boundary", "");

    this.imageSizeStatus = this.document.createElement("span");
    this.imageSizeStatus.classList.add("image-size");
    this.element.appendChild(this.imageSizeStatus);

    this.mousePositionStatus = this.document.createElement("span");
    this.mousePositionStatus.classList.add("mouse-position");
    this.mousePositionStatus.style.marginLeft = "10px";
    this.element.appendChild(this.mousePositionStatus);

    const clickHandler = (event) => {
      if (event.button !== 0 || (process.platform === "darwin" && event.ctrlKey)) return;
      lumine.commands.dispatch(this.element, "image-editor:show-properties");
    };
    this.element.addEventListener("click", clickHandler);

    this.disposables.add(
      lumine.contextMenu.add({
        ".status-image": [
          { type: "separator" },
          {
            label: "Image Properties",
            command: "image-editor:show-properties",
            shouldDisplay: (event) => this.element.contains(event.target),
            keyBindingTarget: () => this.editorView?.element ?? null,
          },
          { type: "separator" },
        ],
      }),
      lumine.commands.add(this.element, {
        "image-editor:show-properties": (event) => {
          event.stopPropagation();
          return this.showProperties();
        },
      }),
      lumine.tooltips.add(this.element, {
        html: false,
        keyBindingCommand: "image-editor:show-properties",
        keyBindingTarget: () => this.editorView?.element ?? null,
        title: () =>
          [this.imageSizeStatus.textContent, "Click to show image properties"]
            .filter(Boolean)
            .join(". ") + ".",
      }),
      new Disposable(() => this.element.removeEventListener("click", clickHandler)),
      this.container.onDidChangeActivePaneItem(() => {
        this.updateImageSize();
      }),
    );
  }

  attach() {
    if (this.statusBarTile) return;
    // View-info band, see the priority convention in the status-bar package
    // README.
    this.statusBarTile = this.statusBar.addLeftTile({ item: this, priority: 520 });
    this.updateImageSize();
  }

  destroy() {
    this.imageLoadCompositeDisposable?.dispose();
    this.imageLoadCompositeDisposable = null;
    this.editorView = null;
    if (this.statusBarTile) {
      this.statusBarTile.destroy();
    }
    this.disposables.dispose();
  }

  getImageSize({ originalHeight, originalWidth, imageSize }) {
    this.imageSizeStatus.textContent = `${originalWidth}x${originalHeight} ${formatBytes(imageSize)}`;
    this.imageSizeStatus.style.display = "";
  }

  updateMousePosition(x, y) {
    if (x !== null && y !== null) {
      this.mousePositionStatus.textContent = `(${x}, ${y})`;
      this.mousePositionStatus.style.display = "";
    } else {
      this.mousePositionStatus.style.display = "none";
    }
  }

  updateImageSize() {
    if (this.imageLoadCompositeDisposable) {
      this.imageLoadCompositeDisposable.dispose();
    }

    const editor = this.container.getActivePaneItem();
    if (editor instanceof ImageEditor && editor.view instanceof ImageEditorView) {
      this.editorView = editor.view;
      this.element.style.display = "";
      this.element.classList.add("active");
      if (this.editorView.loaded) {
        this.getImageSize(this.editorView);
      }

      this.imageLoadCompositeDisposable = new CompositeDisposable();
      const callback = () => {
        if (editor === this.container.getActivePaneItem()) {
          this.getImageSize(this.editorView);
        }
      };
      this.imageLoadCompositeDisposable.add(this.editorView.onDidLoad(callback));
      this.imageLoadCompositeDisposable.add(this.editorView.onDidUpdate(callback));

      // Set up mouse position tracking - using ...args to capture all arguments
      this.imageLoadCompositeDisposable.add(
        this.editorView.onMousePosition((args) => {
          if (editor === this.container.getActivePaneItem()) {
            this.updateMousePosition(args.imgX, args.imgY);
          }
        }),
      );
    } else {
      this.editorView = null;
      this.element.style.display = "none";
      this.element.classList.remove("active");
      this.imageSizeStatus.style.display = "none";
      this.mousePositionStatus.style.display = "none";
    }
  }

  showProperties() {
    const editor = this.container.getActivePaneItem();
    if (
      editor instanceof ImageEditor &&
      editor.view instanceof ImageEditorView &&
      editor.view.loaded
    ) {
      return lumine.commands.dispatch(editor.view.element, "image-editor:show-properties");
    }
  }
};
