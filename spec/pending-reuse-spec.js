const fs = require("fs");
const os = require("os");
const path = require("path");

function pollUntil(condition, timeoutMs = 15000) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) resolve();
      else if (performance.now() - start > timeoutMs) reject(new Error("Timed out waiting"));
      else requestAnimationFrame(check);
    };
    check();
  });
}

describe("image-editor pending reuse", () => {
  const samplePath = path.join(__dirname, "fixtures", "sample.png");
  const otherPath = path.join(__dirname, "fixtures", "other.png");
  let item, view, ImageEditor, tempDir;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.activatePackage("image-editor");
    ImageEditor = require("../lib/editor");
    item = await lumine.workspace.open(samplePath, { pending: true });
    view = item.view;
    await pollUntil(() => view.loaded && view.refs.image.complete);
  });

  afterEach(async () => {
    const files = [];
    for (const paneItem of lumine.workspace.getPaneItems()) {
      if (paneItem instanceof ImageEditor) {
        if (paneItem.file) files.push(paneItem.file);
        paneItem.destroy();
      }
    }
    await Promise.all(files.map((file) => file.closed));
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("reuses the item, view and image element, and publishes the new resource", async () => {
    const element = item.element;
    const image = view.refs.image;
    const oldFile = item.file;
    const paths = [],
      uris = [],
      titles = [],
      opened = [];
    item.onDidChangePath((value) => paths.push(value));
    item.onDidChangeURI((value) => uris.push(value));
    item.onDidChangeTitle(() => titles.push(item.getTitle()));
    const didOpen = lumine.workspace.onDidOpen((event) => opened.push(event));
    const confirm = spyOn(lumine.window, "confirm");
    view.disableAutoZoom();
    view.zoom = 2;
    view.selectionStartImg = { x: 1, y: 1 };
    view.selectionEndImg = { x: 2, y: 2 };
    view.setSelectionVisibility(true);

    const nextItem = await lumine.workspace.open(otherPath, { pending: true });

    expect(nextItem).toBe(item);
    expect(item.view).toBe(view);
    expect(item.element).toBe(element);
    expect(view.refs.image).toBe(image);
    expect(item.file).not.toBe(oldFile);
    expect(item.getPath()).toBe(otherPath);
    expect(item.getTitle()).toBe("other.png");
    expect(item.getFileState()).toBe("unmodified");
    expect(paths).toEqual([otherPath]);
    expect(uris).toEqual([{ oldURI: samplePath, newURI: otherPath }]);
    expect(titles).toEqual(["other.png"]);
    expect(opened.length).toBe(1);
    expect(opened[0].item).toBe(item);
    expect(lumine.workspace.paneForItem(item).getPendingItem()).toBe(item);
    expect(view.historyManager.length).toBe(0);
    expect(view.selectionVisible).toBe(false);
    expect(view.auto).toBe(true);
    expect(view.shownFile.path).toBe(otherPath);
    expect(view.lastSelfWrite).toBe(null);
    expect(confirm).not.toHaveBeenCalled();
    didOpen.dispose();
    await oldFile.closed;
  });

  it("promotes the reused tab when the replacement image is edited", async () => {
    await lumine.workspace.open(otherPath, { pending: true });
    await pollUntil(() => view.refs.image.complete);
    view.invertColors();

    expect(lumine.workspace.paneForItem(item).getPendingItem()).toBe(null);
    expect(item.getFileState()).toBe("modified");
    const nextItem = await lumine.workspace.open(samplePath, { pending: true });
    expect(nextItem).not.toBe(item);
    expect(lumine.workspace.paneForItem(item)).toBeDefined();
    expect(item.getPath()).toBe(otherPath);
  });

  it("creates a separate item for an ordinary open", async () => {
    const nextItem = await lumine.workspace.open(otherPath);
    expect(nextItem).not.toBe(item);
    expect(item.destroyed).toBe(true);
    expect(nextItem.getPath()).toBe(otherPath);
  });

  it("leaves optional SVG files to the normal opener order", async () => {
    const svg = await lumine.workspace.open(path.join(__dirname, "fixtures", "optional.svg"), {
      pending: true,
    });
    expect(svg instanceof ImageEditor).toBe(false);
    expect(lumine.workspace.isTextEditor(svg)).toBe(true);
  });

  it("awaits folder navigation and emits path and URI changes for it", async () => {
    const changes = [];
    item.onDidChangeURI((event) => changes.push(event));
    const result = await view.loadImageFromNavigation(otherPath);
    expect(result).toBe(true);
    expect(item.getPath()).toBe(otherPath);
    expect(view.shownFile.path).toBe(otherPath);
    expect(changes).toEqual([{ oldURI: samplePath, newURI: otherPath }]);
  });

  it("keeps the previous document and viewport after a decode failure", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-reuse-"));
    const invalidPath = path.join(tempDir, "invalid.png");
    fs.writeFileSync(invalidPath, "This is not an image");
    const imageUrl = view.refs.image.src;
    const oldFile = item.file;
    view.disableAutoZoom();
    view.zoom = 2;
    view.translateX = 40;
    view.translateY = -25;
    view.setSelectionVisibility(true);
    const uris = [];
    item.onDidChangeURI((event) => uris.push(event));

    await expectAsync(view.loadImageFromNavigation(invalidPath, { pending: true })).toBeRejected();

    expect(item.file).toBe(oldFile);
    expect(item.getPath()).toBe(samplePath);
    expect(view.refs.image.src).toBe(imageUrl);
    expect(view.loaded).toBe(true);
    expect(view.zoom).toBe(2);
    expect(view.translateX).toBe(40);
    expect(view.translateY).toBe(-25);
    expect(view.selectionVisible).toBe(true);
    expect(uris).toEqual([]);
    expect(view.refs.loadingSpinner.classList.contains("visible")).toBe(false);
  });

  it("leaves the previous document intact when the next file is missing", async () => {
    const oldFile = item.file;
    const imageUrl = view.refs.image.src;
    const imageSize = view.imageSize;
    await expectAsync(
      view.loadImageFromNavigation(path.join(__dirname, "fixtures", "missing.png"), {
        pending: true,
      }),
    ).toBeRejected();
    expect(item.file).toBe(oldFile);
    expect(view.refs.image.src).toBe(imageUrl);
    expect(view.imageSize).toBe(imageSize);
    expect(item.getFileState()).toBe("unmodified");
  });

  it("keeps the previous document if the replacement watcher cannot be created", async () => {
    const oldFile = item.file;
    const imageUrl = view.refs.image.src;
    const shownFile = view.shownFile;
    view.zoom = 2;
    view.setSelectionVisibility(true);
    const error = new Error("File watch client is closed");
    spyOn(lumine.fileWatchClient, "watchFile").and.throwError(error);

    await expectAsync(view.loadImageFromNavigation(otherPath, { pending: true })).toBeRejectedWith(
      error,
    );

    expect(item.file).toBe(oldFile);
    expect(item.getPath()).toBe(samplePath);
    expect(view.refs.image.src).toBe(imageUrl);
    expect(view.shownFile).toBe(shownFile);
    expect(view.zoom).toBe(2);
    expect(view.selectionVisible).toBe(true);
    expect(item.getFileState()).toBe("unmodified");
  });

  it("clears a temporary image source and title when ordinary navigation opens a file", async () => {
    const temporary = ImageEditor.fromDataUrl(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "Temporary image",
    );
    await lumine.workspace.open(temporary);
    const temporaryView = temporary.view;
    await pollUntil(() => temporaryView.loaded && temporaryView.refs.image.complete);
    spyOn(lumine.window, "confirm").and.returnValue(Promise.resolve(2));

    const result = await temporaryView.loadImageFromNavigation(otherPath);

    expect(result).toBe(true);
    expect(temporary.isTemporary()).toBe(false);
    expect(temporary.getDataUrl()).toBe(null);
    expect(temporary.getTitle()).toBe("other.png");
    expect(temporary.getFileState()).toBe("unmodified");
    expect(temporary.serialize().filePath).toBe(otherPath);
    expect(temporaryView.historyManager.length).toBe(0);
  });

  it("promotes a tab and refuses resource replacement while Save As is pending", async () => {
    let cancelSave;
    spyOn(lumine.window, "showSaveDialog").and.returnValue(
      new Promise((resolve) => (cancelSave = resolve)),
    );
    const save = view.saveImage();
    expect(view.isSaving).toBe(true);
    expect(lumine.workspace.paneForItem(item).getPendingItem()).toBe(null);
    const nextItem = await lumine.workspace.open(otherPath, { pending: true });
    expect(nextItem).not.toBe(item);
    expect(lumine.workspace.paneForItem(item)).toBeDefined();
    expect(item.getPath()).toBe(samplePath);
    expect(await view.loadImageFromNavigation(otherPath)).toBe(false);

    cancelSave({ canceled: true });
    expect(await save).toBe(false);
    expect(view.isSaving).toBe(false);
    expect(item.getPath()).toBe(samplePath);
  });

  it("ignores an old preview encode that completes after the document is replaced", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 3;
    canvas.height = 4;
    canvas.getContext("2d").fillRect(0, 0, 3, 4);
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    let encode;
    spyOn(HTMLCanvasElement.prototype, "toBlob").and.callFake(function (callback, ...args) {
      encode = () =>
        new Promise((resolve) => {
          toBlob.call(
            this,
            (blob) => {
              callback(blob);
              resolve();
            },
            ...args,
          );
        });
    });
    const release = jasmine.createSpy("releaseCanvas");
    const onLoad = jasmine.createSpy("onLoad");
    view.commitCanvas(canvas, {
      recordHistory: false,
      spinner: false,
      releaseCanvas: release,
      onLoad,
    });

    await lumine.workspace.open(otherPath, { pending: true });
    const imageUrl = view.refs.image.src;
    await encode();

    expect(item.getPath()).toBe(otherPath);
    expect(view.refs.image.src).toBe(imageUrl);
    expect(view.historyManager.length).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("discards a stale edit encode after ordinary navigation discards that document", async () => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    const encodes = [];
    spyOn(HTMLCanvasElement.prototype, "toBlob").and.callFake(function (callback, ...args) {
      encodes.push(
        () =>
          new Promise((resolve) => {
            toBlob.call(
              this,
              (blob) => {
                callback(blob);
                resolve();
              },
              ...args,
            );
          }),
      );
    });
    view.invertColors();
    expect(view.historyManager.length).toBe(2);
    spyOn(lumine.window, "confirm").and.returnValue(Promise.resolve(2));

    await view.loadImageFromNavigation(otherPath);
    const imageUrl = view.refs.image.src;
    await Promise.all(encodes.map((encode) => encode()));

    expect(item.getPath()).toBe(otherPath);
    expect(view.refs.image.src).toBe(imageUrl);
    expect(view.historyManager.length).toBe(0);
    expect(item.getFileState()).toBe("unmodified");
  });

  for (const [showDialog, applyMethod] of [
    ["showBrightnessContrastDialog", "applyBrightnessContrast"],
    ["showResizeDialog", "resizeImage"],
    ["showRotateAngleDialog", "freeRotate"],
  ]) {
    it(`closes ${showDialog} and refuses its stale apply action after replacement`, async () => {
      view[showDialog]();
      const backdrop = document.querySelector(".image-editor-dialog-backdrop");
      const applyButton = Array.from(backdrop.querySelectorAll("button")).find((button) =>
        ["Apply", "Resize", "Rotate"].includes(button.textContent),
      );
      const apply = spyOn(view, applyMethod);

      await lumine.workspace.open(otherPath, { pending: true });
      applyButton.click();

      expect(document.body.contains(backdrop)).toBe(false);
      expect(apply).not.toHaveBeenCalled();
      expect(item.getPath()).toBe(otherPath);
    });
  }

  it("closes a free-rotate dialog without restoring the previous document", async () => {
    view.showFreeRotateDialog();
    const backdrop = document.querySelector(".image-editor-dialog-backdrop");
    const autoPreview = backdrop.querySelector("#auto-preview");
    autoPreview.checked = true;
    autoPreview.dispatchEvent(new Event("change"));
    const cancelButton = Array.from(backdrop.querySelectorAll("button")).find(
      (button) => button.textContent === "Cancel",
    );
    const preview = spyOn(view, "applyRotatePreview");
    const restore = spyOn(view, "restoreOriginalImage");

    await lumine.workspace.open(otherPath, { pending: true });
    cancelButton.click();
    advanceClock(200);

    expect(document.body.contains(backdrop)).toBe(false);
    expect(preview).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(item.getPath()).toBe(otherPath);
  });

  it("does not commit an aborted load whose stat returns later", async () => {
    const stat = fs.promises.stat.bind(fs.promises);
    let release;
    const heldStat = new Promise((resolve) => (release = resolve));
    spyOn(fs.promises, "stat").and.callFake((filePath) =>
      filePath === otherPath ? heldStat : stat(filePath),
    );
    const controller = new AbortController();
    const navigation = view
      .loadImageFromNavigation(otherPath, { pending: true, signal: controller.signal })
      .catch((error) => error);
    controller.abort();
    expect(view.refs.loadingSpinner.classList.contains("visible")).toBe(false);
    release(await stat(otherPath));
    const result = await navigation;

    expect(result.name).toBe("AbortError");
    expect(item.getPath()).toBe(samplePath);
    expect(view.shownFile.path).toBe(samplePath);
    expect(view.refs.loadingSpinner.classList.contains("visible")).toBe(false);
  });

  it("keeps the newest document when an older request finishes stat later", async () => {
    const stat = fs.promises.stat.bind(fs.promises);
    let release;
    const heldStat = new Promise((resolve) => (release = resolve));
    spyOn(fs.promises, "stat").and.callFake((filePath) =>
      filePath === otherPath ? heldStat : stat(filePath),
    );
    const older = view
      .loadImageFromNavigation(otherPath, { pending: true })
      .catch((error) => error);
    const newer = await view.loadImageFromNavigation(samplePath, { pending: true });
    release(await stat(otherPath));
    const olderResult = await older;

    expect(newer).toBe(true);
    expect(olderResult.name).toBe("AbortError");
    expect(item.getPath()).toBe(samplePath);
    expect(view.shownFile.path).toBe(samplePath);
    expect(view.refs.loadingSpinner.classList.contains("visible")).toBe(false);
  });

  it("cancels a pending decode before changing any document state", async () => {
    const decode = view._decodeImage.bind(view);
    let entered = false,
      release;
    const held = new Promise((resolve) => (release = resolve));
    spyOn(view, "_decodeImage").and.callFake(async (...args) => {
      entered = true;
      await held;
      return decode(...args);
    });
    const controller = new AbortController();
    const navigation = view
      .loadImageFromNavigation(otherPath, { pending: true, signal: controller.signal })
      .catch((error) => error);
    await pollUntil(() => entered);
    controller.abort();
    release();
    const result = await navigation;

    expect(result.name).toBe("AbortError");
    expect(item.getPath()).toBe(samplePath);
    expect(view.shownFile.path).toBe(samplePath);
  });

  it("preserves an edit made while the next image is decoding", async () => {
    const decode = view._decodeImage.bind(view);
    let entered = false,
      release;
    const held = new Promise((resolve) => (release = resolve));
    spyOn(view, "_decodeImage").and.callFake(async (...args) => {
      entered = true;
      const image = await decode(...args);
      await held;
      return image;
    });
    const navigation = view.loadImageFromNavigation(otherPath, { pending: true });
    await pollUntil(() => entered);
    view.invertColors();
    release();
    const result = await navigation;

    expect(result).toBe(false);
    expect(item.getPath()).toBe(samplePath);
    expect(item.getFileState()).toBe("modified");
    expect(view.historyManager.length).toBe(2);
  });

  it("finishes the requested replacement when the old source asks for a watcher reload", async () => {
    const decode = view._decodeImage.bind(view);
    let entered = false,
      release;
    const held = new Promise((resolve) => (release = resolve));
    spyOn(view, "_decodeImage").and.callFake(async (...args) => {
      const image = await decode(...args);
      entered = true;
      await held;
      return image;
    });
    const opening = lumine.workspace.open(otherPath, { pending: true }).catch((error) => error);
    await pollUntil(() => entered);
    await view.updateImageURI();
    release();
    const result = await opening;

    expect(result).toBe(item);
    expect(item.getPath()).toBe(otherPath);
    expect(view.shownFile.path).toBe(otherPath);
  });

  it("reconciles a deferred watcher reload when replacement fails", async () => {
    const stat = fs.promises.stat.bind(fs.promises);
    const previousRevision = fs.statSync(samplePath).mtimeMs;
    spyOn(fs.promises, "stat").and.callFake(async (filePath) => {
      const stats = await stat(filePath);
      if (filePath === samplePath) stats.mtimeMs = previousRevision + 1000;
      return stats;
    });
    const decode = view._decodeImage.bind(view);
    let entered = false,
      release,
      sourceDecodes = 0;
    const held = new Promise((resolve) => (release = resolve));
    const error = new Error("The replacement failed to decode");
    spyOn(view, "_decodeImage").and.callFake(async (...args) => {
      if (args[0].includes("other.png")) {
        entered = true;
        await held;
        throw error;
      }
      sourceDecodes++;
      return decode(...args);
    });
    const opening = lumine.workspace.open(otherPath, { pending: true }).catch((failure) => failure);
    await pollUntil(() => entered);
    await view.updateImageURI();
    expect(sourceDecodes).toBe(0);
    release();
    const result = await opening;

    expect(result).toBe(error);
    expect(item.getPath()).toBe(samplePath);
    expect(view.shownFile.path).toBe(samplePath);
    expect(view.shownFile.mtimeMs).toBe(previousRevision + 1000);
    expect(sourceDecodes).toBe(1);
    expect(view.refs.loadingSpinner.classList.contains("visible")).toBe(false);
  });

  it("publishes URI changes when the existing file is relocated", async () => {
    const changes = [];
    item.onDidChangeURI((event) => changes.push(event));
    item.setPath(otherPath);
    expect(changes).toEqual([{ oldURI: samplePath, newURI: otherPath }]);
    expect(view.shownFile.path).toBe(otherPath);
  });

  it("keeps navigation headers on the reused resource after an old directory read finishes", async () => {
    const main = lumine.packages.getActivePackage("image-editor").mainModule;
    const readings = [];
    spyOn(view, "getFileList").and.callFake(() => new Promise((resolve) => readings.push(resolve)));
    const headers = [];
    const observer = main
      .provideNavigationAdapter()
      .observeHeaders(item, (list) => headers.push(list));
    await lumine.workspace.open(otherPath, { pending: true });
    await pollUntil(() => readings.length >= 2);
    const currentListing = { files: [otherPath], currentIndex: 0 };
    for (const complete of readings.slice(1)) complete(currentListing);
    await pollUntil(() => headers.length > 0);
    readings[0]({ files: [samplePath], currentIndex: 0 });
    await Promise.resolve();
    await Promise.resolve();

    expect(headers[headers.length - 1][0].filePath).toBe(otherPath);
    expect(item._navigationHeaders[0].filePath).toBe(otherPath);
    observer.dispose();
  });

  it("keeps the newest navigation refresh when its URI has not changed", async () => {
    const main = lumine.packages.getActivePackage("image-editor").mainModule;
    const readings = [];
    spyOn(view, "getFileList").and.callFake(() => new Promise((resolve) => readings.push(resolve)));
    const headers = [];
    const observer = main
      .provideNavigationAdapter()
      .observeHeaders(item, (list) => headers.push(list));
    item.emitter.emit("did-change");
    readings[1]({ files: [otherPath, samplePath], currentIndex: 1 });
    await pollUntil(() => headers.length > 0);
    readings[0]({ files: [samplePath], currentIndex: 0 });
    await Promise.resolve();
    await Promise.resolve();

    expect(headers.length).toBe(1);
    expect(item._navigationHeaders.map((header) => header.filePath)).toEqual([
      otherPath,
      samplePath,
    ]);
    observer.dispose();
  });

  for (const stop of ["dispose", "destroy"]) {
    it(`does not publish a navigation result after observer ${stop}`, async () => {
      const main = lumine.packages.getActivePackage("image-editor").mainModule;
      let finish;
      spyOn(view, "getFileList").and.returnValue(new Promise((resolve) => (finish = resolve)));
      const callback = jasmine.createSpy("headers");
      const observer = main.provideNavigationAdapter().observeHeaders(item, callback);
      if (stop === "dispose") observer.dispose();
      else item.destroy();
      finish({ files: [samplePath], currentIndex: 0 });
      await Promise.resolve();
      await Promise.resolve();

      expect(callback).not.toHaveBeenCalled();
      expect(item._navigationHeaders).toBe(null);
      observer.dispose();
    });
  }

  it("refreshes navigation headers once when the resource path is relocated", async () => {
    const main = lumine.packages.getActivePackage("image-editor").mainModule;
    const getFileList = spyOn(view, "getFileList").and.callFake(() =>
      Promise.resolve({ files: [item.getPath()], currentIndex: 0 }),
    );
    let headers;
    const observer = main
      .provideNavigationAdapter()
      .observeHeaders(item, (list) => (headers = list));
    await pollUntil(() => headers != null);
    item.setPath(otherPath);
    await pollUntil(() => headers[0].filePath === otherPath);

    expect(getFileList).toHaveBeenCalledTimes(2);
    observer.dispose();
  });

  it("does not navigate a reused resource using a directory result from its previous file", async () => {
    let finish;
    spyOn(view.navigator, "getFirstImage").and.returnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    const navigation = view.firstImage();
    await lumine.workspace.open(otherPath, { pending: true });
    finish(samplePath);
    await navigation;

    expect(item.getPath()).toBe(otherPath);
    expect(view.shownFile.path).toBe(otherPath);
  });

  it("keeps an old directory result from cancelling a newer replacement before it commits", async () => {
    let finishListing;
    spyOn(view.navigator, "getFirstImage").and.returnValue(
      new Promise((resolve) => (finishListing = resolve)),
    );
    const navigation = view.firstImage();
    const decode = view._decodeImage.bind(view);
    let entered = false,
      finishDecode;
    const held = new Promise((resolve) => (finishDecode = resolve));
    spyOn(view, "_decodeImage").and.callFake(async (...args) => {
      const image = await decode(...args);
      entered = true;
      await held;
      return image;
    });
    const load = spyOn(view, "loadImageFromNavigation").and.callThrough();
    const opening = lumine.workspace.open(otherPath, { pending: true }).catch((error) => error);
    await pollUntil(() => entered);
    expect(item.getPath()).toBe(samplePath);
    finishListing(otherPath);
    await Promise.resolve();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    finishDecode();
    const [result] = await Promise.all([opening, navigation]);

    expect(result).toBe(item);
    expect(item.getPath()).toBe(otherPath);
    expect(view.shownFile.path).toBe(otherPath);
  });

  it("terminates pending state in its own pane while another pane is active", () => {
    const ownPane = lumine.workspace.paneForItem(item);
    ownPane.splitRight({ items: [document.createElement("div")], activate: true });
    item.terminatePendingState();
    expect(ownPane.getPendingItem()).toBe(null);
  });
});
