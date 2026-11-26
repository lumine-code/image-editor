const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("closing an image with an uncommitted edit", () => {
  const cropCommand = "image-editor:crop-to-selection";
  const width = 12;
  const sourceHeight = 10;
  const cropHeight = 6;
  let item, otherView, view, pane, directory, filePath, file, original, releaseEncode;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    lumine.config.set("core.promptOnCloseDirtyBuffer", true);
    await lumine.packages.activatePackage("image-editor");
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "image-pending-close-"));
    filePath = path.join(directory, "sample.png");
    original = png(width, sourceHeight);
    await fs.promises.writeFile(filePath, original);
    item = await lumine.workspace.open(filePath);
    file = item.file;
    view = item.view;
    pane = lumine.workspace.paneForItem(item);
    releaseEncode = null;
    await ready(view);
  });

  afterEach(async () => {
    otherView?.destroy();
    otherView = null;
    item?.destroy();
    item = null;
    releaseEncode?.();
    await file?.closed;
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
    if (directory) {
      await fs.promises.rm(path.join(directory, "sample.png"), { force: true });
      await fs.promises.rmdir(directory);
    }
  });

  function png(imageWidth, imageHeight) {
    const canvas = document.createElement("canvas");
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    canvas.getContext("2d").fillRect(0, 0, imageWidth, imageHeight);
    return Buffer.from(canvas.toDataURL().split(",")[1], "base64");
  }

  function ready(imageView) {
    return conditionPromise(
      () => imageView.loaded && imageView.refs.image.complete && !imageView.pixelSyncPromise,
    );
  }

  function confirmClose(...responses) {
    const window = lumine.workspace.getWindowForElement(view.element);
    return spyOn(window, "confirm").and.returnValues(
      ...responses.map((response) => Promise.resolve(response)),
    );
  }

  async function startCrop() {
    const encoded = Promise.withResolvers();
    const nativeEncode = HTMLCanvasElement.prototype.toBlob;
    let intercept = true;
    spyOn(HTMLCanvasElement.prototype, "toBlob").and.callFake(function (callback, ...args) {
      if (!intercept || this.width !== width || this.height !== cropHeight)
        return nativeEncode.call(this, callback, ...args);
      intercept = false;
      return nativeEncode.call(
        this,
        (blob) => {
          releaseEncode = () => {
            releaseEncode = null;
            callback(blob);
          };
          encoded.resolve();
        },
        ...args,
      );
    });
    view.selectionStartImg = { x: 0, y: 0 };
    view.selectionEndImg = { x: width, y: cropHeight };
    view.setSelectionVisibility(true);
    const cropping = lumine.commands.dispatch(view.element, cropCommand);
    await encoded.promise;
    expect(item.getFileState()).toBe("unmodified");
    return { cropping };
  }

  it("asks during the first crop and leaves it running when the close is canceled", async () => {
    const { cropping } = await startCrop();
    const confirm = confirmClose(1);

    expect(await pane.destroyItem(item)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(pane.getItems()).toContain(item);
    expect(view.refs.image.naturalHeight).toBe(sourceHeight);

    releaseEncode();
    await cropping;
    expect(view.refs.image.naturalHeight).toBe(cropHeight);
    expect(item.getFileState()).toBe("modified");
  });

  it("discards the pending edit when closing its last view without saving", async () => {
    const { cropping } = await startCrop();
    const confirm = confirmClose(2);
    const imageDocument = item.document;
    const { signal } = imageDocument.operationQueue.running;

    expect(await pane.destroyItem(item)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(pane.getItems()).not.toContain(item);
    expect(imageDocument.destroyed).toBe(true);
    expect(signal.aborted).toBe(true);

    releaseEncode();
    await cropping;
    expect((await fs.promises.readFile(filePath)).equals(original)).toBe(true);
  });

  it("closes the initiating view without a prompt when another view shares the image", async () => {
    ({ item: otherView } = await lumine.workspace.copyPaneItem(item, { splitDirection: "right" }));
    await ready(otherView.view);
    const { cropping } = await startCrop();
    const confirm = confirmClose(1);
    const imageDocument = item.document;
    expect(item.shouldPromptToSave({ lastView: true })).toBe(true);

    expect(await pane.destroyItem(item)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(otherView.document).toBe(imageDocument);
    expect(imageDocument.destroyed).toBe(false);

    releaseEncode();
    await cropping;
    await conditionPromise(() => otherView.view.refs.image.naturalHeight === cropHeight);
    expect(otherView.getFileState()).toBe("modified");
    expect(otherView.view.historyManager.canUndo()).toBe(true);
  });

  it("saves the completed crop before closing the last view", async () => {
    const { cropping } = await startCrop();
    const confirm = confirmClose(0);
    const closing = pane.destroyItem(item);
    await conditionPromise(() => item.document.operationQueue.waiting.length > 0);
    expect(pane.getItems()).toContain(item);

    releaseEncode();
    await cropping;
    expect(await closing).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    const saved = await fs.promises.readFile(filePath);
    expect(saved.readUInt32BE(20)).toBe(cropHeight);
  });

  it("keeps the last view open when the queued save is canceled", async () => {
    const { cropping } = await startCrop();
    const confirm = confirmClose(0);
    const closing = pane.destroyItem(item);
    await conditionPromise(() => item.document.operationQueue.waiting.length > 0);

    view.refs.operationCancelButton.click();
    expect(await closing).toBe(false);
    releaseEncode();
    await cropping;

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(pane.getItems()).toContain(item);
    expect(item.getFileState()).toBe("unmodified");
    expect(view.refs.image.naturalHeight).toBe(sourceHeight);
    expect((await fs.promises.readFile(filePath)).equals(original)).toBe(true);
  });

  it("keeps the cropped image open when an external change makes the queued save conflict", async () => {
    lumine.config.set("core.promptOnSaveConflictedFile", true);
    const { cropping } = await startCrop();
    const confirm = confirmClose(0, 1);
    const closing = pane.destroyItem(item);
    await conditionPromise(() => item.document.operationQueue.waiting.length > 0);
    const external = png(1, 1);
    await fs.promises.writeFile(filePath, external);

    releaseEncode();
    await cropping;
    expect(await closing).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(Array.from(confirm.calls.mostRecent().args[0].buttons)).toEqual(["Overwrite", "Cancel"]);
    expect(pane.getItems()).toContain(item);
    expect(item.getFileState()).toBe("conflicted");
    expect(view.refs.image.naturalHeight).toBe(cropHeight);
    expect((await fs.promises.readFile(filePath)).equals(external)).toBe(true);
  });

  it("keeps the cropped image open when writing fails", async () => {
    const { cropping } = await startCrop();
    const nativeWrite = fs.promises.writeFile.bind(fs.promises);
    spyOn(fs.promises, "writeFile").and.callFake((destination, ...args) => {
      if (destination !== filePath) return nativeWrite(destination, ...args);
      return Promise.reject(Object.assign(new Error("Write denied"), { code: "EACCES" }));
    });
    const confirm = confirmClose(0);
    const warning = spyOn(lumine.notifications, "addWarning");
    const closing = pane.destroyItem(item);
    await conditionPromise(() => item.document.operationQueue.waiting.length > 0);

    releaseEncode();
    await cropping;
    expect(await closing).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(warning.calls.mostRecent().args[0]).toBe("Unable to save file");
    expect(pane.getItems()).toContain(item);
    expect(item.getFileState()).toBe("modified");
    expect(view.refs.image.naturalHeight).toBe(cropHeight);
    expect((await fs.promises.readFile(filePath)).equals(original)).toBe(true);
  });
});
