const fs = require("fs");
const os = require("os");
const path = require("path");
const { FileState } = require("lumine");
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
  const otherPath = path.join(__dirname, "fixtures", "other.png");

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

  describe("window surfaces", () => {
    afterEach(() => workspaceElement.focus({ preventScroll: true }));

    it("rebinds canvas allocation, observers and pointer listeners in both directions", async () => {
      const item = await lumine.workspace.open(samplePath);
      const view = item.view;
      await pollUntil(() => view.loaded);
      const originalParent = view.element.parentNode;
      const frame = document.createElement("iframe");
      jasmine.attachToDOM(frame);
      spyOn(view.mouseHandler, "handleMouseMove");

      const detach = await item.beginWindowSurfaceTransition();
      frame.contentDocument.body.appendChild(view.element);
      await detach.commit();
      frame.contentWindow.dispatchEvent(
        new frame.contentWindow.MouseEvent("mousemove", { clientX: 5, clientY: 7 }),
      );

      expect(view.element.ownerDocument).toBe(frame.contentDocument);
      expect(view.canvasPool.document).toBe(frame.contentDocument);
      expect(view.mouseHandler.handleMouseMove).toHaveBeenCalled();
      view.showBrightnessContrastDialog();
      expect(frame.contentDocument.querySelector(".image-editor-dialog-backdrop")).not.toBeNull();

      view.mouseHandler.handleMouseMove.calls.reset();
      const attach = await item.beginWindowSurfaceTransition();
      expect(frame.contentDocument.querySelector(".image-editor-dialog-backdrop")).toBeNull();
      originalParent.appendChild(view.element);
      await attach.commit();
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 8, clientY: 9 }));

      expect(view.element.ownerDocument).toBe(document);
      expect(view.canvasPool.document).toBe(document);
      expect(view.mouseHandler.handleMouseMove).toHaveBeenCalled();

      const failedDetach = await item.beginWindowSurfaceTransition();
      frame.contentDocument.body.appendChild(view.element);
      await failedDetach.commit();
      view.updateTransform();
      expect(view.transformRAFWindow).toBe(frame.contentWindow);
      originalParent.appendChild(view.element);
      await failedDetach.rollback();
      view.updateTransform();
      expect(view.transformRAFWindow).toBe(window);

      item.destroy();
      frame.remove();
    });

    it("restarts an unresolved navigation Image in the destination realm", async () => {
      const item = await lumine.workspace.open(samplePath);
      const view = item.view;
      await pollUntil(() => view.loaded);
      const originalParent = view.element.parentNode;
      const frame = document.createElement("iframe");
      jasmine.attachToDOM(frame);
      const images = [];
      spyOn(view, "createRealmImage").and.callFake((domWindow) => {
        const image = {
          domWindow,
          naturalWidth: 16,
          naturalHeight: 8,
          onload: null,
          onerror: null,
          source: null,
          set src(value) {
            this.source = value;
          },
          get src() {
            return this.source;
          },
        };
        images.push(image);
        return image;
      });
      spyOn(view, "applyImageWithMetadata").and.callThrough();

      const navigation = view.loadImageFromNavigation(samplePath);
      await pollUntil(() => images.length === 1);
      const staleLoad = images[0].onload;
      expect(images[0].domWindow).toBe(window);

      const transition = await item.beginWindowSurfaceTransition();
      frame.contentDocument.body.appendChild(view.element);
      await transition.commit();

      expect(images.length).toBe(2);
      expect(images[1].domWindow).toBe(frame.contentWindow);
      staleLoad();
      expect(view.applyImageWithMetadata).not.toHaveBeenCalled();

      images[1].onload();
      await navigation;
      expect(view.applyImageWithMetadata.calls.count()).toBe(1);
      expect(view.applyImageWithMetadata.calls.mostRecent().args[1].img).toBe(images[1]);
      expect(view.realmImageLoads.has("navigation")).toBe(false);
      expect(view.refs.loadingSpinner.classList.contains("visible")).toBe(false);

      const attach = await item.beginWindowSurfaceTransition();
      originalParent.appendChild(view.element);
      await attach.commit();
      item.destroy();
      frame.remove();
    });

    it("invalidates unresolved Image callbacks on transition and destroy", async () => {
      const item = await lumine.workspace.open(samplePath);
      const view = item.view;
      await pollUntil(() => view.loaded);
      const images = [];
      spyOn(view, "createRealmImage").and.callFake(() => {
        const image = {
          naturalWidth: 8,
          naturalHeight: 8,
          onload: null,
          onerror: null,
          set src(value) {
            this.source = value;
          },
        };
        images.push(image);
        return image;
      });
      spyOn(view, "commitCanvas");

      const preview = view.applyRotatePreview(view.refs.image.src, 1, 1, 15, true);
      const stalePreviewLoad = images[0].onload;
      const transition = await item.beginWindowSurfaceTransition();
      await transition.rollback();
      stalePreviewLoad();
      await preview;
      expect(view.commitCanvas).not.toHaveBeenCalled();

      const navigation = view.loadImageFromNavigation(samplePath);
      await pollUntil(() => images.length === 2);
      const staleNavigationLoad = images[1].onload;
      spyOn(view, "applyImageWithMetadata");
      item.destroy();
      staleNavigationLoad();
      await navigation;
      expect(view.applyImageWithMetadata).not.toHaveBeenCalled();
      expect(view.realmImageLoads.size).toBe(0);
      expect(view.refs.loadingSpinner.classList.contains("visible")).toBe(false);
    });

    it("rebinds an unresolved display-image load after DOM adoption", async () => {
      const item = await lumine.workspace.open(samplePath);
      const view = item.view;
      await pollUntil(() => view.loaded);
      const originalParent = view.element.parentNode;
      const frame = document.createElement("iframe");
      jasmine.attachToDOM(frame);
      spyOn(view, "setImageSource");
      const didLoad = jasmine.createSpy("didLoad");
      const load = view.startDisplayImageLoad({
        source: "spec://unresolved-image",
        purpose: "spec",
        onLoad: didLoad,
        onError: () => {},
      });
      const staleLoad = view.refs.image.onload;

      const transition = await item.beginWindowSurfaceTransition();
      frame.contentDocument.body.appendChild(view.element);
      await transition.commit();
      const destinationLoad = view.refs.image.onload;

      expect(view.setImageSource.calls.count()).toBe(2);
      staleLoad();
      expect(didLoad).not.toHaveBeenCalled();
      destinationLoad();
      await load;
      expect(didLoad.calls.count()).toBe(1);
      expect(view.displayImageLoad).toBeNull();

      const attach = await item.beginWindowSurfaceTransition();
      originalParent.appendChild(view.element);
      await attach.commit();
      item.destroy();
      frame.remove();
    });

    it("drops a preview encode that completes after its transition token", async () => {
      const item = await lumine.workspace.open(samplePath);
      const view = item.view;
      await pollUntil(() => view.loaded);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      let completeEncode;
      canvas.toBlob = (callback) => {
        completeEncode = callback;
      };
      const releaseCanvas = jasmine.createSpy("releaseCanvas");
      const cancelled = jasmine.createSpy("cancelled");
      spyOn(view, "startDisplayImageLoad");
      const generation = ++view.rotatePreviewGeneration;
      view.commitCanvas(canvas, {
        recordHistory: false,
        spinner: false,
        purpose: "rotate-preview",
        isCurrent: () => generation === view.rotatePreviewGeneration,
        releaseCanvas,
        onCancel: cancelled,
      });

      const transition = await item.beginWindowSurfaceTransition();
      completeEncode(new Blob(["preview"], { type: "image/png" }));
      await transition.rollback();

      expect(releaseCanvas.calls.count()).toBe(1);
      expect(cancelled.calls.count()).toBe(1);
      expect(view.startDisplayImageLoad).not.toHaveBeenCalled();
      item.destroy();
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

    it("publishes one exclusive file state through edits, conflicts, removal, and save", async () => {
      const { item, view } = await openZoomedView();
      const states = [];
      item.onDidChangeFileState((fileState) => states.push(fileState));

      expect(item.getFileState()).toBe(FileState.UNMODIFIED);
      view.invertColors();
      await pollUntil(() => item.getFileState() === FileState.MODIFIED);

      item.noteExternalChange();
      await view.updateImageURI();
      expect(item.getFileState()).toBe(FileState.MODIFIED);

      item.noteExternalChange();
      item.confirmExternalChange();
      expect(item.getFileState()).toBe(FileState.CONFLICTED);

      fs.rmSync(tempPath);
      item.file.emitter.emit("did-delete");
      expect(item.getFileState()).toBe(FileState.REMOVED);
      await view.undo();
      await pollUntil(
        () =>
          view.refs.image.complete &&
          view.refs.image.naturalWidth > 0 &&
          !view.refs.loadingSpinner.classList.contains("visible"),
      );
      expect(item.getFileState()).toBe(FileState.REMOVED);

      expect(await item.save()).toBe(true);
      expect(item.getFileState()).toBe(FileState.UNMODIFIED);
      expect(fs.existsSync(tempPath)).toBe(true);
      expect(states).toEqual([
        FileState.MODIFIED,
        FileState.CONFLICTED,
        FileState.REMOVED,
        FileState.UNMODIFIED,
      ]);
    });

    it("prompts for every non-unmodified state unless dirty prompts are disabled", async () => {
      const { item, view } = await openZoomedView();
      expect(item.shouldPromptToSave()).toBe(false);

      view.invertColors();
      await pollUntil(() => item.getFileState() === FileState.MODIFIED);
      expect(item.shouldPromptToSave()).toBe(true);

      item.noteExternalChange();
      item.confirmExternalChange();
      expect(item.shouldPromptToSave()).toBe(true);
      item.setFileState(FileState.REMOVED);
      expect(item.shouldPromptToSave()).toBe(true);

      lumine.config.set("core.promptOnCloseDirtyBuffer", false);
      expect(item.shouldPromptToSave()).toBe(false);
    });

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
    it("opens temporary editors through the workspace", async () => {
      const service = mainModule.provideImageEditor();
      expect(typeof service.openFromDataUrl).toBe("function");
      const open = spyOn(lumine.workspace, "open").and.callThrough();

      const editor = await service.openFromDataUrl(DATA_URL, "Test Image");
      expect(editor instanceof ImageEditor).toBe(true);
      expect(editor.isTemporary()).toBe(true);
      expect(editor.getTitle()).toBe("Test Image");
      expect(editor.getDataUrl()).toBe(DATA_URL);
      expect(editor.getFileState()).toBe(FileState.MODIFIED);
      expect(lumine.workspace.getActivePaneItem()).toBe(editor);
      expect(open).toHaveBeenCalledWith(editor);
    });

    it("opens explicitly selected files through the workspace", async () => {
      const open = spyOn(lumine.workspace, "open").and.callThrough();

      const editor = await mainModule.openInImageEditor(samplePath);

      expect(editor instanceof ImageEditor).toBe(true);
      expect(editor.getPath()).toBe(samplePath);
      expect(open).toHaveBeenCalledWith(editor);
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

    it("activates the image item through the workspace before navigating it", async () => {
      const adapter = mainModule.provideNavigationAdapter();
      const item = await lumine.workspace.open(samplePath);
      const open = spyOn(lumine.workspace, "open").and.callThrough();
      const navigate = spyOn(item.view, "loadImageFromNavigation").and.returnValue(
        Promise.resolve(),
      );
      const element = lumine.views.getView(item);
      const focus = spyOn(element, "focus");

      await adapter.navigateTo(item, { filePath: otherPath });

      expect(open).toHaveBeenCalledWith(item, { searchAllPanes: true });
      expect(navigate).toHaveBeenCalledWith(otherPath);
      expect(focus).toHaveBeenCalled();
    });
  });

  describe("undo history", () => {
    let item, view;

    beforeEach(async () => {
      item = await lumine.workspace.open(samplePath);
      view = item.view;
      await pollUntil(() => view.loaded);
      view.disableAutoZoom();
    });

    afterEach(() => {
      for (const paneItem of lumine.workspace.getPaneItems()) {
        if (paneItem instanceof ImageEditor) paneItem.destroy();
      }
    });

    /**
     * The image's pixels, so an undo can be checked rather than assumed.
     * Null while a replacement is still decoding, which is the window the
     * polling below is waiting out.
     */
    function currentPixels() {
      const image = view.refs.image;
      if (!image.complete || image.naturalWidth === 0) return null;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data).join();
    }

    it("keeps frames as blobs and puts the pixels back on undo", async () => {
      const before = currentPixels();
      expect(before).not.toBe(null);

      view.invertColors();
      await pollUntil(() => view.historyManager.length === 2);
      await pollUntil(() => view.historyManager.history.every((entry) => entry.settled));
      await pollUntil(() => currentPixels() !== null && currentPixels() !== before);

      const entry = view.historyManager.getCurrentState();
      expect(entry.blob instanceof Blob).toBe(true);
      expect(entry.imageData).toBeUndefined();
      expect(view.refs.image.src.startsWith("blob:")).toBe(true);

      await view.undo();
      await pollUntil(() => currentPixels() === before);
      expect(currentPixels()).toBe(before);
    });

    it("gives the pooled canvas back only once the encoder has read it", async () => {
      // Returning it any sooner lets the pool resize and clear the canvas out
      // from under the encode, which records a blank frame.
      view.invertColors();
      await pollUntil(() => view.historyManager.length === 2);

      const entry = view.historyManager.getCurrentState();
      await entry.ready;

      expect(entry.blob).not.toBe(null);
      expect(entry.blob.size).toBeGreaterThan(0);
    });

    it("encodes an edit once, and shares that one blob with the history", async () => {
      // The displayed pixels used to be encoded for the screen and then again,
      // synchronously and off a second full-size canvas, for the history.
      const real = HTMLCanvasElement.prototype.toBlob;
      let encodes = 0;
      HTMLCanvasElement.prototype.toBlob = function (...args) {
        encodes++;
        return real.apply(this, args);
      };

      try {
        view.historyManager.needsInitialSave = false; // isolate the edit itself
        view.invertColors();
        await pollUntil(() => view.historyManager.length === 1);
        const entry = view.historyManager.getCurrentState();
        await entry.ready;

        expect(encodes).toBe(1);
        expect(entry.compact).toBe(false);
        expect(entry.blob).not.toBe(null);
      } finally {
        HTMLCanvasElement.prototype.toBlob = real;
      }
    });

    it("encodes twice only when the frame is one it means to compress", async () => {
      const real = HTMLCanvasElement.prototype.toBlob;
      let encodes = 0;
      HTMLCanvasElement.prototype.toBlob = function (...args) {
        encodes++;
        return real.apply(this, args);
      };

      try {
        view.historyManager.needsInitialSave = false;
        view.historyManager.largeImagePixels = 1; // anything counts as large
        view.invertColors();
        await pollUntil(() => view.historyManager.length === 1);
        const entry = view.historyManager.getCurrentState();
        await entry.ready;

        expect(entry.compact).toBe(true);
        expect(encodes).toBe(2);
        expect(entry.blob.type).toBe("image/webp");
      } finally {
        HTMLCanvasElement.prototype.toBlob = real;
      }
    });

    it("records exactly one state per edit, whichever edit it is", async () => {
      const edits = [
        ["invertColors", () => view.invertColors()],
        ["applySepia", () => view.applySepia()],
        ["rotate", () => view.rotate(90)],
        ["flipHorizontal", () => view.flipHorizontal()],
        ["flipVertical", () => view.flipVertical()],
        ["resizeImage", () => view.resizeImage(4, 4)],
      ];

      for (const [name, run] of edits) {
        view.historyManager.reset();
        view.historyManager.needsInitialSave = false;

        run();
        await pollUntil(() => view.historyManager.length === 1, 10000);
        const entry = view.historyManager.getCurrentState();
        await entry.ready;
        await pollUntil(() => view.refs.image.complete && view.refs.image.naturalWidth > 0);

        expect(view.historyManager.length).toBe(1, name);
        expect(entry.blob instanceof Blob).toBe(true, name);
        expect(entry.imageWidth).toBe(view.refs.image.naturalWidth, name);
        expect(entry.imageHeight).toBe(view.refs.image.naturalHeight, name);
      }
    });

    it("keeps the pool stocked instead of dropping what it borrows", async () => {
      // Six of the edit paths never gave their canvases back, so the pool was
      // always empty and every operation allocated afresh.
      view.historyManager.needsInitialSave = false;
      view.flipHorizontal();
      await pollUntil(() => view.historyManager.length === 1);
      await view.historyManager.getCurrentState().ready;

      expect(view.canvasPool.pool.length).toBeGreaterThan(0);
    });

    it("shows a free-rotate preview without recording it", async () => {
      view.historyManager.needsInitialSave = false;
      const before = view.historyManager.length;

      view.applyRotatePreview(view.refs.image.src, 2, 2, 30, true);
      await pollUntil(() => view.refs.image.naturalWidth !== 2);

      expect(view.historyManager.length).toBe(before);
    });

    it("keeps showing the frame it is on when the history is thrown away", async () => {
      // A save resets the history while the image element is still pointed at
      // whatever undo left on screen. When the history owned that URL, the
      // reset revoked it out from under the view.
      view.invertColors();
      await pollUntil(() => view.historyManager.length === 2);
      await pollUntil(() => view.historyManager.history.every((entry) => entry.settled));

      await view.undo();
      await pollUntil(() => view.refs.image.complete && view.refs.image.naturalWidth > 0);
      const shown = view.refs.image.src;
      expect(shown.startsWith("blob:")).toBe(true);

      view.historyManager.reset();

      // Still decodable: a fresh element loading the same URL must succeed.
      const probe = new Image();
      const loaded = await new Promise((resolve) => {
        probe.onload = () => resolve(true);
        probe.onerror = () => resolve(false);
        probe.src = shown;
      });
      expect(loaded).toBe(true);
    });

    it("releases every frame when the editor goes away", async () => {
      view.invertColors();
      await pollUntil(() => view.historyManager.length === 2);
      await pollUntil(() => view.historyManager.history.every((entry) => entry.settled));

      const entries = view.historyManager.history.slice();
      const blobs = await Promise.all(entries.map((e) => view.historyManager.blobFor(e)));
      expect(blobs.every((blob) => blob instanceof Blob)).toBe(true);

      item.destroy();

      expect(entries.every((entry) => entry.released && entry.blob === null)).toBe(true);
    });
  });

  describe("running a filter", () => {
    let item, view;

    beforeEach(async () => {
      item = await lumine.workspace.open(samplePath);
      view = item.view;
      await pollUntil(() => view.loaded);
      view.historyManager.needsInitialSave = false;
    });

    afterEach(() => {
      for (const paneItem of lumine.workspace.getPaneItems()) {
        if (paneItem instanceof ImageEditor) paneItem.destroy();
      }
    });

    it("completes an operation that waits for the spinner to paint", async () => {
      // The deferral used to be a setTimeout, which the spec runner freezes,
      // so nothing here could reach the blur and sharpen paths at all.
      view.blurImage(1);
      await pollUntil(() => view.historyManager.length === 1, 10000);
      await view.historyManager.getCurrentState().ready;

      expect(view.historyManager.getCurrentState().blob instanceof Blob).toBe(true);
      expect(view.filterInProgress).toBe(false);
    });

    it("refuses a read-only image before doing the work, not after", async () => {
      const encoded = [];
      const real = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (...args) {
        encoded.push(1);
        return real.apply(this, args);
      };
      view.readOnly = true;

      try {
        view.applySepia();
        expect(encoded.length).toBe(0);
        expect(view.historyManager.length).toBe(0);
      } finally {
        HTMLCanvasElement.prototype.toBlob = real;
        view.readOnly = false;
      }
    });

    it("still transforms a read-only image, without recording an undo state", async () => {
      // The SVG paths have always rasterised and rotated on screen; Save As is
      // how that gets kept. Only the undo state was ever refused.
      view.readOnly = true;
      const before = view.refs.image.src;

      let published = false;
      const subscription = view.onDidUpdate(() => (published = true));

      try {
        view.rotate(90);
        // The fixture is square, so the dimensions cannot show the rotation
        // happened; the new source can. Waiting on did-update rather than on
        // the element, so the load handler has finished before we look.
        await pollUntil(() => view.refs.image.src !== before);
        await pollUntil(() => published);

        expect(view.refs.image.src.startsWith("blob:")).toBe(true);
        expect(view.historyManager.length).toBe(0);
        expect(view.refs.loadingSpinner.classList.contains("visible")).toBe(false);
      } finally {
        subscription.dispose();
        view.readOnly = false;
      }
    });

    it("clears the spinner when a filter refuses a read-only image", async () => {
      expect(view.refs.loadingSpinner.classList.contains("visible")).toBe(false);
      view.readOnly = true;

      try {
        view.applySepia();
        expect(view.refs.loadingSpinner.classList.contains("visible")).toBe(false);
      } finally {
        view.readOnly = false;
      }
    });

    it("falls back to the whole image when a selection has been dragged flat", async () => {
      // A visible selection with no area used to refuse everywhere except
      // auto-adjust, which quietly dropped it and treated the whole image as
      // the target. All ten do that now.
      view.setSelectionVisibility(true);
      view.selectionStartImg = { x: 1, y: 1 };
      view.selectionEndImg = { x: 1, y: 2 };
      expect(view.getSelectionArea()).toBe(null);

      view.invertColors();
      await pollUntil(() => view.historyManager.length === 1);

      expect(view.historyManager.getCurrentState().imageWidth).toBe(2);
    });

    it("checks the image is loaded on every filter, not four of ten", async () => {
      view.loaded = false;
      const before = view.historyManager.length;

      // These four went straight to naturalWidth without checking.
      view.applyBrightnessContrast(10, 10);
      view.applySaturation(10);
      view.applyHueShift(90);
      view.applyPosterize(4);

      expect(view.historyManager.length).toBe(before);
      view.loaded = true;
    });
  });

  describe("item-owned native dialogs", () => {
    let item, view, asked, owners, answer;

    beforeEach(async () => {
      item = await lumine.workspace.open(samplePath);
      view = item.view;
      await pollUntil(() => view.loaded);
      // The initial frame is wanted here: modified means there is a state to
      // go back to, which takes two.
      asked = [];
      owners = [];
      answer = 1;
      spyOn(lumine.workspace, "confirmForPaneItem").and.callFake((owner, options) => {
        owners.push(owner);
        asked.push(options);
        return Promise.resolve(answer);
      });
    });

    afterEach(() => {
      for (const paneItem of lumine.workspace.getPaneItems()) {
        if (paneItem instanceof ImageEditor) paneItem.destroy();
      }
    });

    async function makeDirty() {
      view.invertColors();
      await pollUntil(() => view.historyManager.length === 2);
      await pollUntil(() => view.isModified());
    }

    it("says nothing when there is nothing to lose", async () => {
      const before = view.editor.getPath();
      await view.nextImage();
      await pollUntil(() => view.editor.getPath() !== before);

      expect(asked.length).toBe(0);
    });

    it("asks before an arrow key would throw the edits away", async () => {
      // Reloading has always refused to overwrite unsaved work; stepping to
      // the next image went straight past that and reset the history on
      // arrival, so the edits went without a word.
      await makeDirty();
      const before = view.editor.getPath();

      answer = 1; // Cancel
      await view.nextImage();

      expect(asked.length).toBe(1);
      expect(owners).toEqual([item]);
      expect(asked[0].buttons).toEqual(["Save", "Cancel", "Don't Save"]);
      expect(view.editor.getPath()).toBe(before);
      expect(view.isModified()).toBe(true);
    });

    it("goes anyway when told to", async () => {
      await makeDirty();
      const before = view.editor.getPath();

      answer = 2; // Don't Save
      await view.nextImage();
      await pollUntil(() => view.editor.getPath() !== before);

      expect(view.editor.getPath()).not.toBe(before);
    });

    it("guards every way out, not just the arrow keys", async () => {
      await makeDirty();
      answer = 1;

      // Two entry points that would both move: the guard sits in the load
      // itself, so it does not matter which command got there.
      await view.firstImage();
      await view.previousImage();

      expect(asked.length).toBe(2);
      expect(owners).toEqual([item, item]);
    });

    it("owns Save As with the image item and settles cancellation", async () => {
      const choosePath = spyOn(lumine.workspace, "showSaveDialogForPaneItem").and.returnValue(
        Promise.resolve({ canceled: true }),
      );

      expect(await view.saveImage()).toBe(false);
      expect(choosePath.calls.mostRecent().args[0]).toBe(item);
      expect(choosePath.calls.mostRecent().args[1]).toEqual(
        jasmine.objectContaining({ defaultPath: item.getPath() }),
      );
    });
  });

  describe("the properties dialog", () => {
    let item, view;

    beforeEach(async () => {
      item = await lumine.workspace.open(samplePath);
      view = item.view;
      await pollUntil(() => view.loaded);
    });

    afterEach(() => {
      for (const backdrop of document.querySelectorAll(".image-editor-dialog-backdrop")) {
        backdrop.remove();
      }
      for (const paneItem of lumine.workspace.getPaneItems()) {
        if (paneItem instanceof ImageEditor) paneItem.destroy();
      }
    });

    it("draws its rows, including where the file sits in the folder", async () => {
      // It reaches across into the navigator part way through building the
      // table, so anything missing there takes the whole dialog down before a
      // single row reaches the screen.
      await view.showPropertiesDialog();

      const rows = Array.from(document.querySelectorAll(".image-editor-dialog-backdrop tr"));
      const labels = rows.map((row) => row.cells[0] && row.cells[0].textContent);

      expect(labels).toContain("Dimensions:");
      expect(labels).toContain("Position in folder:");

      const position = rows.find((row) => row.cells[0].textContent === "Position in folder:");
      expect(position.cells[1].textContent).toBe("2 / 2");
    });
  });

  describe("the compressed undo format", () => {
    /** Round-trip a half-transparent canvas and report the alpha that survived. */
    async function alphaAfter(type, quality) {
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "rgba(255, 0, 0, 1)";
      ctx.fillRect(0, 0, 1, 1); // opaque red beside a transparent pixel

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
      if (!blob) return null;

      const url = URL.createObjectURL(blob);
      try {
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
          image.src = url;
        });
        const out = document.createElement("canvas");
        out.width = 2;
        out.height = 1;
        const outCtx = out.getContext("2d", { willReadFrequently: true });
        outCtx.drawImage(image, 0, 0);
        return Array.from(outCtx.getImageData(0, 0, 2, 1).data);
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    it("keeps transparency, which is what the old format destroyed", async () => {
      const webp = await alphaAfter("image/webp", 0.92);
      expect(webp).not.toBe(null);
      expect(webp[7]).toBe(0, "the transparent pixel stays transparent");
      expect(webp[3]).toBe(255, "the opaque one stays opaque");

      // The reason for the change, stated as a fact about the format rather
      // than a claim: JPEG carries no alpha channel at all, so the pixel comes
      // back fully opaque over whatever it was flattened onto.
      const jpeg = await alphaAfter("image/jpeg", 0.95);
      expect(jpeg[7]).toBe(255, "JPEG loses the transparency");
    });
  });

  describe("blob URL ownership", () => {
    let view, minted, revoked, createObjectURL, revokeObjectURL;

    beforeEach(async () => {
      const item = await lumine.workspace.open(samplePath);
      view = item.view;
      await pollUntil(() => view.loaded);

      minted = [];
      revoked = [];
      createObjectURL = URL.createObjectURL;
      revokeObjectURL = URL.revokeObjectURL;
      URL.createObjectURL = (...args) => {
        const url = createObjectURL(...args);
        minted.push(url);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        revoked.push(url);
        return revokeObjectURL(url);
      };
    });

    afterEach(() => {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      for (const item of lumine.workspace.getPaneItems()) {
        if (item instanceof ImageEditor) item.destroy();
      }
    });

    /** A blob of the current image, standing in for one an edit produces. */
    async function freshBlob() {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      canvas.getContext("2d").drawImage(view.refs.image, 0, 0);
      return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    }

    async function showAFreshBlob() {
      const url = view.setImageSource(URL.createObjectURL(await freshBlob()));
      await pollUntil(() => view.refs.image.src === url && view.refs.image.complete);
      return url;
    }

    it("holds on to a blob URL until its replacement has loaded", async () => {
      const first = await showAFreshBlob();
      expect(revoked).not.toContain(first);

      const blob = await freshBlob();
      const second = view.setImageSource(URL.createObjectURL(blob));
      // Still on screen: the replacement has not decoded yet, and releasing
      // here would leave nothing to fall back to if it never does.
      expect(revoked).not.toContain(first);

      await pollUntil(() => revoked.includes(first));
      expect(revoked).not.toContain(second);
      expect(view.refs.image.src).toBe(second);
    });

    it("keeps a pinned source alive across swaps, and lets it go afterwards", async () => {
      const pinned = await showAFreshBlob();
      view.pinImageUrl(pinned);

      await showAFreshBlob();
      await showAFreshBlob();
      expect(revoked).not.toContain(pinned);

      // Put it back the way a free-rotate cancel does; it is on screen again,
      // so unpinning must not release it.
      view.setImageSource(pinned);
      await pollUntil(() => view.refs.image.src === pinned);
      view.unpinImageUrl(pinned);
      expect(revoked).not.toContain(pinned);
    });

    it("releases a pinned URL it is no longer showing", async () => {
      const pinned = await showAFreshBlob();
      view.pinImageUrl(pinned);
      await showAFreshBlob();

      view.unpinImageUrl(pinned);
      expect(revoked).toContain(pinned);
    });

    it("hands back every blob URL it still owns when the view goes away", async () => {
      const shown = await showAFreshBlob();
      const held = URL.createObjectURL(new Blob(["x"]));
      view.pinImageUrl(held);

      view.editor.destroy();

      expect(revoked).toContain(shown);
      expect(revoked).toContain(held);
      expect(minted.every((url) => revoked.includes(url))).toBe(true);
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

    it("is consulted once per step, for the boundary and the step together", async () => {
      // Taken separately, the boundary check and the step were two awaits with
      // a window between them: a file event can invalidate the cache in that
      // window, and the overlay would then describe a boundary the step no
      // longer sees.
      const real = view.navigator.getFileList.bind(view.navigator);
      let calls = 0;
      view.navigator.getFileList = (...args) => {
        calls++;
        return real(...args);
      };

      try {
        await view.nextImage();
        await pollUntil(() => view.editor.getPath() !== samplePath);
        expect(calls).toBe(1);
      } finally {
        delete view.navigator.getFileList;
      }
    });

    it("is read again when the user explicitly asks for a reload", async () => {
      // A plain load says nothing about the folder. Asking for a reload does:
      // it means read it all again, and the folder is part of that.
      await view.nextImage();
      await pollUntil(() => view.editor.getPath() !== samplePath);
      expect(reads).toBe(1);

      await view.updateImageURI({ force: true });
      await pollUntil(() => view.loaded);
      await view.previousImage();
      await pollUntil(() => view.editor.getPath() === samplePath);

      expect(reads).toBe(2);
    });

    it("outlives an ordinary reload of the image itself", async () => {
      // A load the watcher asks for says nothing about what is in the folder,
      // but it used to throw the listing away on its way out, so the next step
      // paid for a full re-read. Only an explicit reload does that now.
      await view.nextImage();
      await pollUntil(() => view.editor.getPath() !== samplePath);
      expect(reads).toBe(1);

      // Touched, so the load is not waved through as already showing.
      const current = view.editor.getPath();
      const later = new Date(fs.statSync(current).mtimeMs + 5000);
      fs.utimesSync(current, later, later);
      await view.updateImageURI();
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
