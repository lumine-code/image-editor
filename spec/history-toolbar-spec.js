const path = require("node:path");

describe("image history toolbar availability", () => {
  let pack, items;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    pack = await lumine.packages.activatePackage("image-editor");
    items = [];
  });

  afterEach(async () => {
    for (const item of items) item.destroy();
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
  });

  async function open() {
    const item = await lumine.workspace.open(path.join(pack.path, "spec/fixtures/sample.png"));
    items.push(item);
    await ready(item.view);
    return item;
  }

  function ready(view) {
    return conditionPromise(
      () => view.loaded && view.refs.image.complete && !view.refs.image.onload,
    );
  }

  function expectButtons(view, undo, redo) {
    expect(view.refs.undoButton.disabled).toBe(!undo);
    expect(view.refs.redoButton.disabled).toBe(!redo);
  }

  async function edit(view) {
    const previous = view.refs.image.src;
    view.invertColors();
    await conditionPromise(() => view.refs.image.src !== previous);
    await ready(view);
  }

  it("disables empty history while loading and after the view is destroyed", async () => {
    const ImageEditor = require("../lib/editor");
    const item = new ImageEditor(path.join(pack.path, "spec/fixtures/sample.png"));
    items.push(item);
    const view = item.view;
    expect(view.loaded).toBe(false);
    expectButtons(view, false, false);
    await lumine.workspace.open(item);
    await ready(view);
    expectButtons(view, false, false);
    expect(getComputedStyle(view.refs.undoButton).cursor).toBe("default");
    expect(getComputedStyle(view.refs.redoButton).cursor).toBe("default");
    const undo = spyOn(view, "undo");
    const redo = spyOn(view, "redo");
    view.refs.undoButton.click();
    view.refs.redoButton.click();
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    item.destroy();
    expectButtons(view, false, false);
  });

  it("follows edits, every undo and redo boundary, and history reset", async () => {
    const view = (await open()).view;
    await edit(view);
    await edit(view);
    expectButtons(view, true, false);
    const undoing = view.undo();
    expectButtons(view, true, true);
    await undoing;
    await ready(view);
    const undoingFirst = view.undo();
    expectButtons(view, false, true);
    await undoingFirst;
    await ready(view);
    const redoing = view.redo();
    expectButtons(view, true, true);
    await redoing;
    await ready(view);
    await view.redo();
    await ready(view);
    expectButtons(view, true, false);
    await view.undo();
    await ready(view);
    await edit(view);
    expectButtons(view, true, false);
    await view.undo();
    await ready(view);
    await view.undo();
    await ready(view);
    expect(view.isModified()).toBe(false);
    expectButtons(view, false, true);
    view.historyManager.reset();
    expectButtons(view, false, false);
  });

  it("keeps copied views synchronized and follows a replacement document", async () => {
    const original = await open();
    await edit(original.view);
    await edit(original.view);
    const { item: copy } = await lumine.workspace.copyPaneItem(original, {
      splitDirection: "right",
    });
    items.push(copy);
    await ready(copy.view);
    expectButtons(copy.view, true, false);
    const undoing = copy.view.undo();
    expectButtons(copy.view, true, true);
    expectButtons(original.view, true, true);
    await undoing;
    await ready(copy.view);
    await original.view.pixelSyncPromise;
    spyOn(lumine.workspace.getWindowForElement(original.view.element), "confirm").and.resolveTo(2);
    expect(
      await original.view.loadImageFromNavigation(path.join(pack.path, "spec/fixtures/other.png")),
    ).toBe(true);
    await ready(original.view);
    expectButtons(original.view, false, false);
    expectButtons(copy.view, true, true);
    copy.view.historyManager.reset();
    expectButtons(copy.view, false, false);
  });

  it("keeps history controls disabled for a read-only view", async () => {
    const view = (await open()).view;
    await edit(view);
    view.readOnly = true;
    view.historyManager.undo();
    expectButtons(view, false, false);
  });
});
