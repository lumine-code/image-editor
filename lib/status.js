const { CompositeDisposable, Disposable } = require("atom");
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
  constructor(statusBar) {
    this.statusBar = statusBar;
    this.disposables = new CompositeDisposable();

    this.element = document.createElement("div");
    this.element.classList.add("status-image", "inline-block");
    this.element.title = "Show image properties";

    this.imageSizeStatus = document.createElement("span");
    this.imageSizeStatus.classList.add("image-size");
    this.element.appendChild(this.imageSizeStatus);

    this.mousePositionStatus = document.createElement("span");
    this.mousePositionStatus.classList.add("mouse-position");
    this.mousePositionStatus.style.marginLeft = "10px";
    this.element.appendChild(this.mousePositionStatus);

    const clickHandler = () => this.showProperties();
    this.element.addEventListener("click", clickHandler);

    this.disposables.add(
      new Disposable(() => this.element.removeEventListener("click", clickHandler)),
      atom.workspace.getCenter().onDidChangeActivePaneItem(() => {
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

    const editor = atom.workspace.getCenter().getActivePaneItem();
    if (editor instanceof ImageEditor && editor.view instanceof ImageEditorView) {
      this.editorView = editor.view;
      this.element.classList.add("active");
      if (this.editorView.loaded) {
        this.getImageSize(this.editorView);
      }

      this.imageLoadCompositeDisposable = new CompositeDisposable();
      const callback = () => {
        if (editor === atom.workspace.getCenter().getActivePaneItem()) {
          this.getImageSize(this.editorView);
        }
      };
      this.imageLoadCompositeDisposable.add(this.editorView.onDidLoad(callback));
      this.imageLoadCompositeDisposable.add(this.editorView.onDidUpdate(callback));

      // Set up mouse position tracking - using ...args to capture all arguments
      this.imageLoadCompositeDisposable.add(
        this.editorView.onMousePosition((args) => {
          if (editor === atom.workspace.getCenter().getActivePaneItem()) {
            this.updateMousePosition(args.imgX, args.imgY);
          }
        }),
      );
    } else {
      this.editorView = null;
      this.element.classList.remove("active");
      this.imageSizeStatus.style.display = "none";
      this.mousePositionStatus.style.display = "none";
    }
  }

  showProperties() {
    const editor = atom.workspace.getCenter().getActivePaneItem();
    if (
      editor instanceof ImageEditor &&
      editor.view instanceof ImageEditorView &&
      editor.view.loaded
    ) {
      editor.view.showPropertiesDialog();
    }
  }
};
