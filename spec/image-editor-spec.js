const fs = require("fs");
const os = require("os");
const path = require("path");
const ImageEditor = require("../lib/editor");

// A 1x1 transparent PNG.
const DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// The spec runner freezes setTimeout, so async work is awaited by polling on
// animation frames instead of timers.
function pollUntil(condition, timeoutMs = 15000) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) {
        resolve();
      } else if (performance.now() - start > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  });
}

describe("image-editor", () => {
  let workspaceElement, mainModule;
  const samplePath = path.join(__dirname, "fixtures", "sample.png");

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    const pkg = await lumine.packages.activatePackage("image-editor");
    mainModule = pkg.mainModule;
  });

  describe("opener", () => {
    it("opens .png URIs as an ImageEditor pane item", async () => {
      const item = await lumine.workspace.open(samplePath);
      expect(item instanceof ImageEditor).toBe(true);
      expect(item.getPath()).toBe(samplePath);
      expect(item.getTitle()).toBe("sample.png");
      expect(item.getURI()).toBe(samplePath);
    });

    it("does not intercept non-image URIs", async () => {
      const item = await lumine.workspace.open(path.join(__dirname, "image-editor-spec.js"));
      expect(item instanceof ImageEditor).toBe(false);
      expect(lumine.workspace.isTextEditor(item)).toBe(true);
    });
  });

  describe("serialization", () => {
    it("round-trips through serialize/deserialize", async () => {
      const item = await lumine.workspace.open(samplePath);
      const state = item.serialize();
      expect(state.deserializer).toBe("ImageEditor");
      expect(state.filePath).toBe(samplePath);

      const restored = mainModule.deserialize(state);
      expect(restored instanceof ImageEditor).toBe(true);
      expect(restored.getPath()).toBe(samplePath);
      restored.destroy();
    });

    it("refuses to deserialize a missing file", () => {
      const restored = mainModule.deserialize({
        filePath: path.join(__dirname, "fixtures", "missing.png"),
      });
      expect(restored).toBeUndefined();
    });

    it("does not serialize temporary data-URL editors", () => {
      const editor = ImageEditor.fromDataUrl(DATA_URL, "Temp");
      expect(editor.serialize()).toBeNull();
      editor.destroy();
    });
  });

  describe("saving", () => {
    let tempDir, tempPath;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-editor-"));
      tempPath = path.join(tempDir, "sample.png");
      fs.copyFileSync(samplePath, tempPath);
    });

    afterEach(() => {
      // Close the editor before the file goes away, so its watcher stops first.
      for (const item of lumine.workspace.getPaneItems()) {
        if (item instanceof ImageEditor) item.destroy();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    async function openZoomedView() {
      const item = await lumine.workspace.open(tempPath);
      const view = item.view;
      await pollUntil(() => view.loaded);
      // The spec workspace has no height, so zoom is set the way a manual zoom
      // leaves it rather than through updateSize, which needs a laid-out element.
      view.disableAutoZoom();
      view.zoom = 2;
      view.translateX = 40;
      view.translateY = -25;
      return { item, view };
    }

    function expectViewport(view) {
      expect(view.zoom).toBe(2);
      expect(view.translateX).toBe(40);
      expect(view.translateY).toBe(-25);
    }

    it("does not reload the file it just wrote", async () => {
      const { item, view } = await openZoomedView();
      const src = view.refs.image.src;

      await item.save();
      await pollUntil(() => view.lastSelfWrite != null);

      // Stands in for the watcher event the save raises.
      await view.updateImageURI();
      expect(view.lastSelfWrite.path).toBe(tempPath);
      expect(view.refs.image.src).toBe(src);
      expectViewport(view);
    });

    it("puts the file's revision in the image URL rather than the clock", async () => {
      const { view } = await openZoomedView();
      const stats = fs.statSync(tempPath);

      expect(view.refs.image.src).toContain(`?v=${stats.mtimeMs}-${stats.size}`);

      // Touching the file gives a new key, so the reload is not served the
      // decode the browser already has.
      const later = new Date(stats.mtimeMs + 5000);
      fs.utimesSync(tempPath, later, later);
      await view.updateImageURI();
      await pollUntil(() => !view.refs.image.src.includes(`${stats.mtimeMs}-`));
      expect(view.refs.image.src).toContain(`${fs.statSync(tempPath).mtimeMs}-`);
    });

    it("does no work when asked to reload a file that has not changed", async () => {
      const { view } = await openZoomedView();
      let loads = 0;
      const subscription = view.onDidLoad(() => loads++);

      // Stands in for a watcher event that reports no actual change. Reloading
      // would decode the image again and reset the undo history on the way, so
      // the load must not be entered at all.
      await view.updateImageURI();

      expect(loads).toBe(0);
      expect(view.loaded).toBe(true);
      expect(view.refs.image.naturalWidth).toBeGreaterThan(0);
      expect(view.refs.loadingSpinner.classList.contains("visible")).toBe(false);
      expectViewport(view);

      // A real change still gets through.
      const later = new Date(fs.statSync(tempPath).mtimeMs + 5000);
      fs.utimesSync(tempPath, later, later);
      await view.updateImageURI();
      expect(loads).toBe(1);

      subscription.dispose();
    });

    it("keeps the zoom and pan across a forced reload of the same image", async () => {
      const { view } = await openZoomedView();

      await view.updateImageURI({ force: true });
      expectViewport(view);
    });
  });

  describe("provided image-editor service", () => {
    it("exposes openFromDataUrl and opens a temporary editor", () => {
      const service = mainModule.provideImageEditor();
      expect(typeof service.openFromDataUrl).toBe("function");

      const editor = service.openFromDataUrl(DATA_URL, "Test Image");
      expect(editor instanceof ImageEditor).toBe(true);
      expect(editor.isTemporary()).toBe(true);
      expect(editor.getTitle()).toBe("Test Image");
      expect(editor.getDataUrl()).toBe(DATA_URL);
      expect(editor.isModified()).toBe(true);
      expect(lumine.workspace.getActivePaneItem()).toBe(editor);
    });
  });

  describe("provided navigation.adapter service", () => {
    it("handles only ImageEditor items and lists folder images", async () => {
      const adapter = mainModule.provideNavigationAdapter();
      expect(typeof adapter.handlesItem).toBe("function");
      expect(typeof adapter.observeHeaders).toBe("function");
      expect(typeof adapter.navigateTo).toBe("function");

      const item = await lumine.workspace.open(samplePath);
      expect(adapter.handlesItem(item)).toBe(true);
      expect(adapter.handlesItem({})).toBe(false);

      let headers = null;
      const disposable = adapter.observeHeaders(item, (list) => {
        headers = list;
      });
      await pollUntil(() => headers != null && headers.length > 0);

      const names = headers.map((header) => header.text);
      expect(names).toContain("sample.png");
      expect(names).toContain("other.png");
      const current = headers.find((header) => header.currentCount === 1);
      expect(current.text).toBe("sample.png");

      disposable.dispose();
    });
  });

  describe("the directory listing", () => {
    let item, view, readdir, reads;

    beforeEach(async () => {
      item = await lumine.workspace.open(samplePath);
      view = item.view;
      await pollUntil(() => view.loaded);

      readdir = fs.promises.readdir;
      reads = 0;
      fs.promises.readdir = (...args) => {
        reads++;
        return readdir(...args);
      };
    });

    afterEach(() => {
      fs.promises.readdir = readdir;
      for (const paneItem of lumine.workspace.getPaneItems()) {
        if (paneItem instanceof ImageEditor) paneItem.destroy();
      }
    });

    it("is read once across a round trip through the next and previous image", async () => {
      await view.nextImage();
      await pollUntil(() => view.editor.getPath() !== samplePath);
      await view.previousImage();
      await pollUntil(() => view.editor.getPath() === samplePath);

      expect(reads).toBe(1);
    });

    it("outlives a reload of the image itself", async () => {
      // A load says nothing about what is in the directory, but it used to
      // throw the listing away on its way out, so the next step paid for a
      // full re-read.
      await view.nextImage();
      await pollUntil(() => view.editor.getPath() !== samplePath);
      expect(reads).toBe(1);

      await view.updateImageURI({ force: true });
      await pollUntil(() => view.loaded);

      await view.previousImage();
      await pollUntil(() => view.editor.getPath() === samplePath);
      expect(reads).toBe(1);
    });

    it("hands external callers a copy they cannot corrupt", async () => {
      const list = await view.getFileList();
      const before = view.navigator.fileListCache.files.slice();

      list.files.reverse();

      expect(view.navigator.fileListCache.files).toEqual(before);
    });

    it("is invalidated by a file event, without reaching through the view getter", async () => {
      // The getter builds a view when there is none, running statSync and
      // starting a load, so a file event anywhere in the project would have
      // materialized one for every image tab that had so far avoided it.
      let getterCalls = 0;
      const inherited = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(item), "view");
      Object.defineProperty(item, "view", {
        configurable: true,
        get() {
          getterCalls++;
          return inherited.get.call(this);
        },
      });

      try {
        mainModule.handleFileSystemChanges([
          { path: path.join(__dirname, "fixtures", "added.png"), action: "created" },
        ]);

        expect(getterCalls).toBe(0);
        expect(view.navigator.fileListCache.directoryKey).toBe(null);
        expect(view.navigator.fileListCache.files.length).toBe(0);
      } finally {
        delete item.view;
      }
    });
  });
});
