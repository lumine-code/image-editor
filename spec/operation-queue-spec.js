const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("image editor operation queue", () => {
  const crop = "image-editor:crop-to-selection";
  const autoSelect = "image-editor:auto-select-with-border";
  const saveAll = "window:save-all";
  const sourceHeight = 100;
  const cropHeight = 84;
  const width = 120;
  const croppedContent = { hasSelection: true, left: 19, top: 19, width: 72, height: 62 };

  let main, items, releaseEncode, directory;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("image-editor")).mainModule;
    items = [];
    releaseEncode = null;
    directory = null;
  });

  afterEach(async () => {
    const files = new Set(items.map((item) => item.file).filter(Boolean));
    for (const item of items) item.destroy();
    releaseEncode?.();
    await Promise.all([...files].map((file) => file.closed));
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
    if (directory) {
      await fs.promises.rm(path.join(directory, "sample.png"), { force: true });
      await fs.promises.rmdir(directory);
    }
  });

  function sample() {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = sourceHeight;
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, width, sourceHeight);
    context.fillStyle = "black";
    context.fillRect(20, 20, 70, 60);
    context.fillRect(10, 85, 20, 3);
    return canvas;
  }

  async function ready(item) {
    items.push(item);
    const view = item.view;
    await conditionPromise(() => view.loaded && view.refs.image.complete);
    return view;
  }

  async function openSample(title = "Image with a caption") {
    return ready(await main.openFromDataUrl(sample().toDataURL(), title));
  }

  async function openFileSample() {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "image-operation-queue-"));
    const filePath = path.join(directory, "sample.png");
    const original = Buffer.from(sample().toDataURL().split(",")[1], "base64");
    await fs.promises.writeFile(filePath, original);
    return { filePath, original, view: await ready(await lumine.workspace.open(filePath)) };
  }

  function samplePixel(image, x, y) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    context.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  }

  function selectCrop(view) {
    view.selectionStartImg = { x: 0, y: 0 };
    view.selectionEndImg = { x: width, y: cropHeight };
    view.setSelectionVisibility(true);
    view.updateSelectionBox();
  }

  function holdCropEncode() {
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
          releaseEncode = (result = blob) => {
            releaseEncode = null;
            callback(result);
          };
          encoded.resolve();
        },
        ...args,
      );
    });
    return encoded.promise;
  }

  function dispatch(view, command) {
    return lumine.commands.dispatch(view.element, command);
  }

  it("runs Auto Select With Border after the crop replaces the displayed pixels", async () => {
    const view = await openSample();
    selectCrop(view);
    const encoded = holdCropEncode();
    const cropping = dispatch(view, crop);
    await encoded;

    const selecting = dispatch(view, autoSelect);
    expect(view.refs.image.naturalHeight).toBe(sourceHeight);
    expect(view.selectionEndImg).toEqual({ x: width, y: cropHeight });

    releaseEncode();
    await Promise.all([cropping, selecting]);
    await conditionPromise(
      () => view.refs.image.naturalHeight === cropHeight && view.selectionVisible,
    );
    expect(view.getSelectionArea()).toEqual(croppedContent);
  });

  it("waits for shared pixels before selecting in a sibling pane", async () => {
    const source = await openSample();
    const { item } = await lumine.workspace.copyPaneItem(source.editor, {
      splitDirection: "right",
    });
    const sibling = await ready(item);
    selectCrop(source);
    const encoded = holdCropEncode();
    const cropping = dispatch(source, crop);
    await encoded;

    const selecting = dispatch(sibling, autoSelect);
    expect(sibling.selectionVisible).toBe(false);

    releaseEncode();
    await Promise.all([cropping, selecting]);
    await conditionPromise(
      () => sibling.refs.image.naturalHeight === cropHeight && sibling.selectionVisible,
    );
    expect(sibling.getSelectionArea()).toEqual(croppedContent);
    expect(source.selectionVisible).toBe(false);
  });

  it("runs an operation on a different image while the first image is busy", async () => {
    const source = await openSample();
    lumine.workspace.paneForItem(source.editor).splitRight({ activate: true });
    const other = await openSample("Another image with a caption");
    selectCrop(source);
    const encoded = holdCropEncode();
    const cropping = dispatch(source, crop);
    await encoded;

    const selecting = dispatch(other, autoSelect);
    await selecting;
    expect(source.refs.image.naturalHeight).toBe(sourceHeight);
    expect(other.getSelectionArea()).toEqual({
      hasSelection: true,
      left: 8,
      top: 18,
      width: 84,
      height: 72,
    });

    releaseEncode();
    await cropping;
    await conditionPromise(() => source.refs.image.naturalHeight === cropHeight);
  });

  it("cancels a crop before publication and clears the operations behind it", async () => {
    const view = await openSample();
    selectCrop(view);
    const image = view.refs.image;
    const originalSrc = image.src;
    const originalFileState = view.editor.getFileState();
    const encoded = holdCropEncode();
    const cropping = dispatch(view, crop);
    await encoded;
    const selecting = dispatch(view, autoSelect);

    const button = view.refs.operationCancelButton;
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    button.click();
    releaseEncode();
    await Promise.all([cropping, selecting]);
    await conditionPromise(() => !view.refs.loadingSpinner.classList.contains("visible"));

    expect(button.hidden).toBe(true);
    expect(image.src).toBe(originalSrc);
    expect(image.naturalHeight).toBe(sourceHeight);
    expect(view.selectionVisible).toBe(true);
    expect(view.selectionEndImg).toEqual({ x: width, y: cropHeight });
    expect(view.historyManager.length).toBe(0);
    expect(view.editor.getFileState()).toBe(originalFileState);
  });

  it("clears waiting operations after a crop has already committed", async () => {
    const view = await openSample();
    selectCrop(view);
    const displaying = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const displayImage = view.displayOperationImage.bind(view);
    spyOn(view, "displayOperationImage").and.callFake(async (...args) => {
      displaying.resolve();
      await resume.promise;
      return displayImage(...args);
    });
    const cropping = dispatch(view, crop);
    try {
      await displaying.promise;
      const selecting = dispatch(view, autoSelect);
      const button = view.refs.operationCancelButton;
      expect(button.getAttribute("aria-label")).toBe("Clear queued operations");
      expect(view.refs.operationQueueBadge.textContent).toBe("1");
      button.click();
      await selecting;
      expect(button.hidden).toBe(true);
      expect(view.editor.document.pixelHeight).toBe(cropHeight);
    } finally {
      resume.resolve();
      await cropping;
    }
    expect(view.refs.image.naturalHeight).toBe(cropHeight);
    expect(view.selectionVisible).toBe(false);
    expect(view.historyManager.canUndo()).toBe(true);
  });

  it("saves the cropped pixels when Save is invoked during the crop", async () => {
    const { view, filePath } = await openFileSample();
    selectCrop(view);
    const encoded = holdCropEncode();
    const cropping = dispatch(view, crop);
    await encoded;

    const saving = view.editor.save();
    releaseEncode();
    const [, saved] = await Promise.all([cropping, saving]);
    expect(saved).toBe(true);
    const written = await fs.promises.readFile(filePath);
    expect(written.readUInt32BE(16)).toBe(width);
    expect(written.readUInt32BE(20)).toBe(cropHeight);
  });

  it("saves the first pending crop through Save All before a later edit", async () => {
    const { view, filePath } = await openFileSample();
    const target = lumine.workspace.getElement();
    expect(lumine.commands.canDispatch(target, saveAll)).toBe(false);
    selectCrop(view);
    const encoded = holdCropEncode();
    const cropping = dispatch(view, crop);
    await encoded;
    expect(view.editor.getFileState()).toBe("unmodified");
    expect(lumine.commands.canDispatch(target, saveAll)).toBe(true);
    const saving = lumine.commands.dispatch(target, saveAll);
    const flipping = dispatch(view, "image-editor:flip-horizontal");

    releaseEncode();
    await Promise.all([cropping, saving, flipping]);

    const written = await fs.promises.readFile(filePath);
    const savedImage = document.createElement("img");
    savedImage.src = "data:image/png;base64," + written.toString("base64");
    await savedImage.decode();
    expect(savedImage.naturalWidth).toBe(width);
    expect(savedImage.naturalHeight).toBe(cropHeight);
    expect(samplePixel(savedImage, 25, 30)).toEqual([0, 0, 0, 255]);
    expect(samplePixel(view.refs.image, 25, 30)).toEqual([255, 255, 255, 255]);
    expect(view.editor.getFileState()).toBe("modified");
  });

  it("skips the queued Save All when the preceding crop publishes no change", async () => {
    const { view, filePath, original } = await openFileSample();
    const writeFile = spyOn(fs.promises, "writeFile").and.callThrough();
    selectCrop(view);
    const encoded = holdCropEncode();
    const cropping = dispatch(view, crop);
    await encoded;
    const saving = lumine.commands.dispatch(lumine.workspace.getElement(), saveAll);
    expect(saving).not.toBeNull();

    releaseEncode(null);
    await Promise.all([cropping, saving]);

    expect(writeFile.calls.allArgs().some(([target]) => target === filePath)).toBe(false);
    expect((await fs.promises.readFile(filePath)).equals(original)).toBe(true);
    expect(view.editor.getFileState()).toBe("unmodified");
  });

  for (const [label, command] of [
    ["Save", "core:save"],
    ["Save All", saveAll],
  ]) {
    it(`honors the core conflict prompt when queued ${label} reaches a conflicted image`, async () => {
      const { view, filePath } = await openFileSample();
      const getConfig = spyOn(lumine.config, "get").and.callThrough();
      getConfig.withArgs("core.promptOnSaveConflictedFile").and.returnValue(true);
      const window = lumine.workspace.getWindowForElement(view.element);
      const confirm = spyOn(window, "confirm").and.resolveTo(1);
      selectCrop(view);
      const encoded = holdCropEncode();
      const cropping = dispatch(view, crop);
      await encoded;
      const saving = lumine.commands.dispatch(view.element, command);
      expect(confirm).not.toHaveBeenCalled();
      const externalImage = document.createElement("canvas");
      externalImage.width = externalImage.height = 1;
      const external = Buffer.from(externalImage.toDataURL().split(",")[1], "base64");
      await fs.promises.writeFile(filePath, external);

      releaseEncode();
      await Promise.all([cropping, saving]);

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(Array.from(confirm.calls.mostRecent().args[0].buttons)).toEqual([
        "Overwrite",
        "Cancel",
      ]);
      expect((await fs.promises.readFile(filePath)).equals(external)).toBe(true);
      expect(view.editor.getFileState()).toBe("conflicted");
    });
  }
});
