const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("native image pixels and ownership", () => {
  let main, items, directory, pending, nativeEncode;
  const wait = async (predicate) => {
    const start = performance.now();
    while (!predicate()) {
      if (performance.now() - start > 5000) throw new Error("Owned image wait exceeded budget");
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  };
  function canvas(width = 5, height = 5, colour = "white") {
    const result = document.createElement("canvas");
    result.width = width;
    result.height = height;
    const context = result.getContext("2d");
    context.fillStyle = colour;
    context.fillRect(0, 0, width, height);
    return result;
  }
  function pixels(view) {
    if (!view?.refs.image.complete || !view.refs.image.naturalWidth) return null;
    const result = canvas(view.refs.image.naturalWidth, view.refs.image.naturalHeight);
    result.getContext("2d").drawImage(view.refs.image, 0, 0);
    return Array.from(result.getContext("2d").getImageData(0, 0, result.width, result.height).data);
  }
  async function open(source = canvas()) {
    const item = await main.openFromDataUrl(source.toDataURL(), "Owned pixels");
    items.push(item);
    await wait(() => item.view?.loaded && item.view.refs.image.complete);
    return item;
  }
  function holdEncodes(count = 1) {
    pending = [];
    nativeEncode = HTMLCanvasElement.prototype.toBlob;
    spyOn(HTMLCanvasElement.prototype, "toBlob").and.callFake(function (callback, ...args) {
      if (pending.length < count) pending.push({ canvas: this, callback, args });
      else return nativeEncode.call(this, callback, ...args);
    });
  }
  function release(index) {
    const entry = pending[index];
    nativeEncode.call(entry.canvas, entry.callback, ...entry.args);
  }
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const name of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, name).and.resolveTo();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.deactivatePackage("image-editor");
    if (lumine.packages.getLoadedPackage("image-editor"))
      await lumine.packages.unloadPackage("image-editor");
    main = (await lumine.packages.activatePackage("image-editor")).mainModule;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "image-owned-audit-"));
    items = [];
    pending = null;
  });
  afterEach(async () => {
    const files = [];
    for (const item of items) {
      item.destroy();
      if (item.file) files.push(item.file);
      // The original late Save As defect creates a watcher after destruction.
      // Retire that exact scratch watcher before deleting the owned directory.
      item.fileSubscriptions.dispose();
    }
    await Promise.all(files.map((file) => file.closed));
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
    lumine.config.unset("image-editor.autoSelectTolerance");
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe owned image scratch");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("selects every pixel through the current command, including a one-pixel image", async () => {
    for (const [width, height] of [
      [5, 3],
      [1, 1],
    ]) {
      const item = await open(canvas(width, height));
      lumine.commands.dispatch(item.view.element, "image-editor:select-all");
      expect(item.view.getSelectionArea()).toEqual({
        hasSelection: true,
        left: 0,
        top: 0,
        width,
        height,
      });
    }
  });

  it("keeps inclusive detected pixels and respects explicit zero tolerance", async () => {
    for (const [size, colour] of [
      [2, "black"],
      [1, "black"],
      [2, "rgb(250,250,250)"],
    ]) {
      const source = canvas();
      source.getContext("2d").fillStyle = colour;
      source.getContext("2d").fillRect(1, 1, size, size);
      const item = await open(source);
      lumine.config.set("image-editor.autoSelectTolerance", 0);
      lumine.commands.dispatch(item.view.element, "image-editor:auto-select");
      expect(item.view.getSelectionArea()).toEqual({
        hasSelection: true,
        left: 1,
        top: 1,
        width: size,
        height: size,
      });
    }
  });

  it("copies a temporary image through an actual Core split", async () => {
    const item = await open(canvas(3, 2, "red"));
    const { pane } = await lumine.workspace.copyPaneItem(item, { splitDirection: "right" });
    const copy = pane.getActiveItem();
    items.push(copy);
    expect(copy.isTemporary()).toBe(true);
    expect(copy.getTitle()).toBe(item.getTitle());
    expect(copy.view).toBeDefined();
    if (copy.view) {
      await wait(() => copy.view.loaded && copy.view.refs.image.complete);
      expect(pixels(copy.view)).toEqual(pixels(item.view));
    }
  });

  it("copies the unsaved native pixels of a disk image through a Core split", async () => {
    const file = path.join(directory, "saved.png");
    fs.writeFileSync(file, Buffer.from(canvas(2, 2, "red").toDataURL().split(",")[1], "base64"));
    const item = await lumine.workspace.open(file);
    items.push(item);
    await wait(() => item.view.loaded && item.view.refs.image.complete);
    const before = pixels(item.view).join();
    item.view.invertColors();
    await wait(() => pixels(item.view)?.join() !== before);
    const { pane } = await lumine.workspace.copyPaneItem(item, { splitDirection: "right" });
    const copy = pane.getActiveItem();
    items.push(copy);
    await wait(() => copy.view.loaded && copy.view.refs.image.complete);
    expect(pixels(copy.view)).toEqual(pixels(item.view));
    expect(copy.getFileState()).toBe("modified");
    const copied = pixels(copy.view).join();
    copy.view.invertColors();
    await wait(() => pixels(copy.view)?.join() !== copied);
    await copy.view.undo();
    await wait(() => pixels(copy.view)?.join() === copied);
    expect(copy.getFileState()).toBe("modified");
  });

  it("shares pixels and undo history while each copy owns its viewport and selection", async () => {
    const original = await open(canvas(3, 2, "red"));
    original.view.auto = false;
    original.view.zoom = 0.75;
    original.view.translateX = 19;
    original.view.selectAll();
    const { item: copy } = await lumine.workspace.copyPaneItem(original, {
      splitDirection: "right",
    });
    items.push(copy);
    await wait(() => copy.view.loaded && copy.view.refs.image.complete);
    expect(copy.document).toBe(original.document);
    expect(copy.view.historyManager).toBe(original.view.historyManager);
    expect(copy.view.zoom).toBe(0.75);
    expect(copy.view.selectionStartImg).not.toBe(original.view.selectionStartImg);
    const before = pixels(original.view).join();
    copy.view.auto = false;
    copy.view.zoom = 0.5;
    copy.view.translateX = 31;
    copy.view.setSelectionVisibility(false);
    copy.view.invertColors();
    await wait(
      () =>
        pixels(copy.view)?.join() !== before &&
        pixels(original.view)?.join() === pixels(copy.view)?.join(),
    );
    expect(original.view.zoom).toBe(0.75);
    expect(copy.view.zoom).toBe(0.5);
    await original.view.undo();
    await wait(
      () => pixels(original.view)?.join() === before && pixels(copy.view)?.join() === before,
    );
    const document = copy.document;
    original.destroy();
    expect(document.destroyed).toBe(false);
    expect(document.historyManager.disposed).toBe(false);
    copy.view.invertColors();
    await wait(() => pixels(copy.view)?.join() !== before);
  });

  it("finishes an accepted pixel encode after its source view closes", async () => {
    const original = await open(canvas(3, 2, "red"));
    const { item: copy } = await lumine.workspace.copyPaneItem(original, {
      splitDirection: "right",
    });
    items.push(copy);
    await wait(() => copy.view.loaded && copy.view.refs.image.complete);
    const before = pixels(copy.view).join();
    holdEncodes(2);
    original.view.invertColors();
    expect(pending.length).toBe(2);
    original.destroy();
    release(0);
    release(1);
    await wait(() => pixels(copy.view)?.join() !== before);
    expect(copy.view.historyManager.canUndo()).toBe(true);
    await copy.view.undo();
    await wait(() => pixels(copy.view)?.join() === before);
  });

  it("keeps the shared original document when one view navigates to another file", async () => {
    const file = path.join(directory, "original.png");
    const otherFile = path.join(directory, "next.png");
    fs.writeFileSync(file, Buffer.from(canvas(3, 2, "red").toDataURL().split(",")[1], "base64"));
    fs.writeFileSync(
      otherFile,
      Buffer.from(canvas(3, 2, "blue").toDataURL().split(",")[1], "base64"),
    );
    const original = await lumine.workspace.open(file);
    items.push(original);
    await wait(() => original.view.loaded && original.view.refs.image.complete);
    const { item: copy } = await lumine.workspace.copyPaneItem(original, {
      splitDirection: "right",
    });
    items.push(copy);
    await wait(() => copy.view.loaded && copy.view.refs.image.complete);
    expect(copy.file).toBe(original.file);
    const oldDocument = copy.document;
    const before = pixels(copy.view).join();
    expect(await original.view.loadImageFromNavigation(otherFile)).toBe(true);
    await wait(() => pixels(original.view)?.join() !== before);
    expect(original.document).not.toBe(oldDocument);
    expect(copy.document).toBe(oldDocument);
    expect(copy.getPath()).toBe(file);
    expect(oldDocument.destroyed).toBe(false);
    expect(pixels(copy.view).join()).toBe(before);
  });

  it("cancels a copy waiting for an encode without adding a document owner", async () => {
    const original = await open(canvas(3, 2, "red"));
    holdEncodes(2);
    original.view.invertColors();
    const controller = new AbortController();
    const copying = original.copy({ signal: controller.signal });
    controller.abort();
    await expectAsync(copying).toBeRejected();
    expect(original.document.references).toBe(1);
    release(0);
    release(1);
    await wait(() => original.document.historyManager.getCurrentState().settled);
  });

  it("keeps a live dialog preview out of the shared committed pixels", async () => {
    const original = await open(canvas(3, 2, "red"));
    const { item: copy } = await lumine.workspace.copyPaneItem(original, {
      splitDirection: "right",
    });
    items.push(copy);
    await wait(() => copy.view.loaded && copy.view.refs.image.complete);
    const before = pixels(copy.view).join();
    original.view.commitCanvas(canvas(3, 2, "blue"), { recordHistory: false });
    await wait(() => pixels(original.view)?.join() !== before);
    expect(pixels(copy.view).join()).toBe(before);
    expect(copy.view.historyManager.length).toBe(0);
  });

  it("applies a sibling edit after the accepted pixels have encoded and synchronized", async () => {
    const original = await open(canvas(3, 2, "red"));
    const { item: copy } = await lumine.workspace.copyPaneItem(original, {
      splitDirection: "right",
    });
    items.push(copy);
    await wait(() => copy.view.loaded && copy.view.refs.image.complete);
    const before = pixels(copy.view).join();
    holdEncodes(2);
    original.view.invertColors();
    copy.view.invertColors();
    expect(pending.length).toBe(2);
    release(0);
    release(1);
    await wait(
      () =>
        copy.view.historyManager.length === 3 &&
        pixels(copy.view)?.join() === before &&
        pixels(original.view)?.join() === before,
    );
  });

  it("completes a shared save after the initiating view closes", async () => {
    const file = path.join(directory, "shared-save.png");
    fs.writeFileSync(file, Buffer.from(canvas(3, 2, "red").toDataURL().split(",")[1], "base64"));
    const original = await lumine.workspace.open(file);
    items.push(original);
    await wait(() => original.view.loaded && original.view.refs.image.complete);
    const { item: copy } = await lumine.workspace.copyPaneItem(original, {
      splitDirection: "right",
    });
    items.push(copy);
    await wait(() => copy.view.loaded && copy.view.refs.image.complete);
    const before = pixels(copy.view).join();
    copy.view.invertColors();
    await wait(
      () =>
        pixels(copy.view)?.join() !== before &&
        pixels(original.view)?.join() === pixels(copy.view)?.join(),
    );
    holdEncodes();
    const saving = original.save();
    expect(copy.view.isSaving).toBe(true);
    original.destroy();
    release(0);
    expect(await saving).toBe(true);
    expect(copy.document.destroyed).toBe(false);
    expect(copy.getFileState()).toBe("unmodified");
    expect(copy.view.isSaving).toBe(false);
  });

  it("retargets every shared view when saving a temporary document as a file", async () => {
    const original = await open(canvas(3, 2, "red"));
    const { item: copy } = await lumine.workspace.copyPaneItem(original, {
      splitDirection: "right",
    });
    items.push(copy);
    await wait(() => copy.view.loaded && copy.view.refs.image.complete);
    const file = path.join(directory, "kept.png");
    spyOn(lumine.window, "showSaveDialog").and.resolveTo({ canceled: false, filePath: file });
    expect(await copy.saveAs()).toBe(true);
    expect(original.document).toBe(copy.document);
    expect(original.getPath()).toBe(file);
    expect(original.file).toBe(copy.file);
    expect(original.isTemporary()).toBe(false);
    expect(copy.getFileState()).toBe("unmodified");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("preserves a newer edit when the accepted older save finishes writing", async () => {
    const file = path.join(directory, "saved.png");
    fs.writeFileSync(file, Buffer.from(canvas(2, 2, "red").toDataURL().split(",")[1], "base64"));
    const item = await lumine.workspace.open(file);
    items.push(item);
    await wait(() => item.view.loaded && item.view.refs.image.complete);
    const before = pixels(item.view).join();
    holdEncodes();
    const saving = item.save();
    expect(pending.length).toBe(1);
    item.view.invertColors();
    await wait(() => pixels(item.view)?.join() !== before);
    release(0);
    expect(await saving).toBe(true);
    expect(item.getFileState()).toBe("modified");
    expect(item.view.historyManager.canUndo()).toBe(true);
    const saved = await open(canvas());
    saved.view.refs.image.src = "data:image/png;base64," + fs.readFileSync(file).toString("base64");
    await saved.view.refs.image.decode();
    expect(pixels(saved.view).join()).toBe(before);
    await item.view.undo();
    await wait(() => pixels(item.view)?.join() === before);
    expect(item.getFileState()).toBe("unmodified");
  });

  it("finishes the accepted Save As write without recreating a destroyed editor watcher", async () => {
    const item = await open(canvas(2, 2, "red"));
    const file = path.join(directory, "accepted.png");
    spyOn(lumine.window, "showSaveDialog").and.resolveTo({ canceled: false, filePath: file });
    holdEncodes();
    const saving = item.saveAs();
    await wait(() => pending.length === 1);
    item.destroy();
    release(0);
    expect(await saving).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(item.file).toBeNull();
    expect(item.fileSubscriptions.disposed).toBe(true);
  });

  it("keeps the current Save As pixels captured after the dialog marked as saved", async () => {
    const item = await open(canvas(2, 2, "red"));
    let accept;
    spyOn(lumine.window, "showSaveDialog").and.returnValue(
      new Promise((resolve) => (accept = resolve)),
    );
    const file = path.join(directory, "latest-accepted.png");
    const saving = item.saveAs();
    const before = pixels(item.view).join();
    item.view.invertColors();
    await wait(() => pixels(item.view)?.join() !== before);
    accept({ canceled: false, filePath: file });
    expect(await saving).toBe(true);
    expect(item.getFileState()).toBe("unmodified");
    expect(item.view.isModified()).toBe(false);
    expect(item.getPath()).toBe(file);
  });

  it("keeps the latest same-document pixels when native encodes settle in reverse order", async () => {
    const item = await open();
    holdEncodes(2);
    item.view.commitCanvas(canvas(2, 2, "red"));
    item.view.commitCanvas(canvas(2, 2, "blue"));
    release(1);
    await wait(() => pixels(item.view)?.[2] === 255 && pixels(item.view)?.[0] === 0);
    const latest = pixels(item.view);
    release(0);
    await wait(() => item.view.historyManager.history.every((entry) => entry.settled));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(pixels(item.view)).toEqual(latest);
  });

  it("keeps a completed native Undo visible when the pending later encode settles", async () => {
    const item = await open();
    item.view.ensureInitialHistorySaved();
    item.view.commitCanvas(canvas(2, 2, "red"));
    await wait(() => pixels(item.view)?.[0] === 255 && pixels(item.view)?.[2] === 0);
    const previous = pixels(item.view);
    holdEncodes();
    item.view.commitCanvas(canvas(2, 2, "blue"));
    const entry = item.view.historyManager.getCurrentState();
    await item.view.undo();
    await wait(() => pixels(item.view)?.join() === previous.join());
    release(0);
    await entry.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(pixels(item.view)).toEqual(previous);
    expect(item.view.historyManager.getCurrentState()).not.toBe(entry);
  });

  it("releases the completed save flag after a live owned file-path replacement", async () => {
    const first = path.join(directory, "first.png");
    const next = path.join(directory, "next.png");
    for (const [file, colour] of [
      [first, "red"],
      [next, "blue"],
    ])
      fs.writeFileSync(file, Buffer.from(canvas(2, 2, colour).toDataURL().split(",")[1], "base64"));
    const item = await lumine.workspace.open(first);
    items.push(item);
    await wait(() => item.view.loaded && item.view.refs.image.complete);
    holdEncodes();
    const saving = item.save();
    item.load(next);
    release(0);
    expect(await saving).toBe(true);
    expect(item.getPath()).toBe(next);
    expect(item.view.isSaving).toBe(false);
    if (!item.view.isSaving) {
      await item.view.updateImageURI({ force: true });
      await wait(() => item.view.refs.image.complete && pixels(item.view)?.[2] === 255);
      expect(await item.save()).toBe(true);
    }
  });
});
