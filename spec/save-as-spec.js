const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("image editor Save As", () => {
  let item, view, window, directory, original, destination, releaseEncode;

  beforeEach(async () => {
    item = directory = releaseEncode = null;
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const { mainModule } = await lumine.packages.activatePackage("image-editor");
    const canvas = document.createElement("canvas");
    canvas.width = 6;
    canvas.height = 4;
    item = await mainModule.openFromDataUrl(canvas.toDataURL(), "Save As sample");
    view = item.view;
    await conditionPromise(() => view.loaded && view.refs.image.complete);
    window = lumine.workspace.getWindowForElement(view.element);
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "image-save-as-"));
    original = path.join(directory, "original.png");
    destination = path.join(directory, "chosen.png");
  });

  afterEach(async () => {
    const file = item?.file;
    item?.destroy();
    releaseEncode?.();
    await file?.closed;
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
    if (directory) {
      await fs.promises.rm(original, { force: true });
      await fs.promises.rm(destination, { force: true });
      await fs.promises.rmdir(directory);
    }
  });

  function selectCrop() {
    view.selectionStartImg = { x: 0, y: 0 };
    view.selectionEndImg = { x: 6, y: 3 };
    view.setSelectionVisibility(true);
    view.updateSelectionBox();
  }

  function holdEncode(width, height) {
    const encoding = Promise.withResolvers();
    const encode = HTMLCanvasElement.prototype.toBlob;
    let intercepted = false;
    spyOn(HTMLCanvasElement.prototype, "toBlob").and.callFake(function (callback, ...args) {
      if (intercepted || this.width !== width || this.height !== height)
        return encode.call(this, callback, ...args);
      intercepted = true;
      releaseEncode = () => {
        releaseEncode = null;
        encode.call(this, callback, ...args);
      };
      encoding.resolve();
    });
    return encoding.promise;
  }

  it("uses one core dialog and saves the pending crop to the chosen path", async () => {
    const selection = Promise.withResolvers();
    const showDialog = spyOn(window, "showSaveDialog").and.returnValue(selection.promise);
    const saving = lumine.commands.dispatch(view.element, "core:save-as");
    expect(showDialog).toHaveBeenCalledTimes(1);
    const [options] = showDialog.calls.mostRecent().args;
    expect(options.defaultPath).toBe("untitled.png");
    expect(Array.from(options.filters, ({ extensions }) => Array.from(extensions))).toEqual([
      ["png"],
      ["jpg", "jpeg"],
      ["*"],
    ]);

    selectCrop();
    const encoding = holdEncode(6, 3);
    const cropping = lumine.commands.dispatch(view.element, "image-editor:crop-to-selection");
    await encoding;

    selection.resolve({ canceled: false, filePath: destination });
    await conditionPromise(() => item.document.operationQueue.waiting.length === 1);
    expect(fs.existsSync(destination)).toBe(false);
    releaseEncode();
    await Promise.all([cropping, saving]);

    expect(showDialog).toHaveBeenCalledTimes(1);
    expect(item.getPath()).toBe(destination);
    const written = await fs.promises.readFile(destination);
    expect(written.readUInt32BE(16)).toBe(6);
    expect(written.readUInt32BE(20)).toBe(3);
    expect(item.getFileState()).toBe("unmodified");
  });

  it("writes the original through Save before writing an accepted Save As path", async () => {
    expect(await item.saveAs(original)).toBe(true);
    const showDialog = spyOn(window, "showSaveDialog").and.resolveTo({
      canceled: false,
      filePath: destination,
    });
    const writeFile = spyOn(fs.promises, "writeFile").and.callThrough();
    selectCrop();
    const encoding = holdEncode(6, 3);
    const cropping = lumine.commands.dispatch(view.element, "image-editor:crop-to-selection");
    await encoding;

    const saving = lumine.commands.dispatch(view.element, "core:save");
    const savingAs = lumine.commands.dispatch(view.element, "core:save-as");
    await conditionPromise(() => item.document.operationQueue.waiting.length === 2);
    expect(fs.existsSync(destination)).toBe(false);

    releaseEncode();
    await Promise.all([cropping, saving, savingAs]);

    expect(showDialog).toHaveBeenCalledTimes(1);
    expect(showDialog.calls.mostRecent().args[0].defaultPath).toBe(original);
    const writtenPaths = writeFile.calls
      .allArgs()
      .map(([target]) => target)
      .filter((target) => target === original || target === destination);
    expect(writtenPaths).toEqual([original, destination]);
    expect((await fs.promises.readFile(original)).readUInt32BE(20)).toBe(3);
    expect((await fs.promises.readFile(destination)).readUInt32BE(20)).toBe(3);
    expect(item.getPath()).toBe(destination);
  });

  it("discards a canceled core dialog before queuing any write", async () => {
    const showDialog = spyOn(window, "showSaveDialog").and.resolveTo({ canceled: true });
    const saveAs = spyOn(item, "saveAs").and.callThrough();

    await lumine.commands.dispatch(view.element, "core:save-as");

    expect(showDialog).toHaveBeenCalledTimes(1);
    expect(saveAs).not.toHaveBeenCalled();
    expect(item.getPath()).toBeNull();
    expect(item.document.operationQueue.running).toBeNull();
  });

  it("reports cancellation to the pane callback after the path has been chosen", async () => {
    const showDialog = spyOn(window, "showSaveDialog").and.resolveTo({
      canceled: false,
      filePath: destination,
    });
    const pane = lumine.workspace.paneForItem(item);
    const finish = jasmine.createSpy("save callback");
    const encoding = holdEncode(6, 4);
    const saving = pane.saveItemAs(item, finish);
    await encoding;

    item.document.operationQueue.cancel();
    releaseEncode();
    await saving;

    expect(showDialog).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.calls.mostRecent().args[0]?.name).toBe("SaveCancelledError");
    expect(fs.existsSync(destination)).toBe(false);
    expect(item.getPath()).toBeNull();
  });

  it("reports the real file-write error to the pane callback", async () => {
    const showDialog = spyOn(window, "showSaveDialog").and.resolveTo({
      canceled: false,
      filePath: path.join(directory, "absent", "chosen.png"),
    });
    const pane = lumine.workspace.paneForItem(item);
    const finish = jasmine.createSpy("save callback");

    await pane.saveItemAs(item, finish);

    expect(showDialog).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.calls.mostRecent().args[0]?.code).toBe("ENOENT");
    expect(item.getPath()).toBeNull();
  });
});
