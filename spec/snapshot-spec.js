const path = require("node:path");

function pixels(color, width = 2) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = 2;
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, width, 2);
  return canvas;
}

function color(view) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  context.drawImage(view.refs.image, 0, 0);
  return [...context.getImageData(0, 0, 1, 1).data];
}

describe("shared image snapshots", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("image-editor");
  });
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
  });

  it("waits for pending pixels and restores one untitled document, undo and independent views", async () => {
    const Editor = require("../lib/editor");
    const original = Editor.fromDataUrl(pixels("red").toDataURL(), "Unsaved drawing");
    await lumine.workspace.open(original);
    await conditionPromise(() => original.view.loaded);
    original.view.historyManager.ensureInitialSaved(() => original.view.saveToHistory());
    const copy = await original.copy();
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    extra.getEditorContainer().getActivePane().activateItem(copy, { activatePane: true });
    await conditionPromise(() => copy.view.loaded);
    original.view.zoom = 2;
    original.view.auto = false;
    copy.view.zoom = 4;
    copy.view.auto = false;
    const canvas = pixels("blue", 3);
    const encode = canvas.toBlob.bind(canvas);
    let publish;
    spyOn(canvas, "toBlob").and.callFake((callback) => {
      publish = () => encode(callback);
    });
    original.view.commitCanvas(canvas);
    let captured = false;
    const capture = lumine.captureState({ isUnloading: true }).then((state) => {
      captured = true;
      return state;
    });
    await Promise.resolve();
    expect(captured).toBe(false);
    publish();
    const state = JSON.parse(JSON.stringify(await capture));
    expect(Object.keys(state.packageStates["image-editor"].documents).length).toBe(1);
    await lumine.deserialize(state);
    const views = lumine.workspace.getPaneItems().filter((item) => item instanceof Editor);
    expect(views.length).toBe(2);
    expect(views[0].document).toBe(views[1].document);
    await conditionPromise(() => views.every((item) => item.view.loaded));
    expect(views.map((item) => item.view.zoom).sort()).toEqual([2, 4]);
    expect(views[0].getTitle()).toBe("Unsaved drawing");
    expect(views[0].getFileState()).toBe("modified");
    expect(color(views[0].view)).toEqual([0, 0, 255, 255]);
    await views[0].view.undo();
    await conditionPromise(() => color(views[1].view)[0] === 255);
    expect(color(views[0].view)).toEqual([255, 0, 0, 255]);
    await views[1].view.redo();
    await conditionPromise(() => color(views[0].view)[2] === 255);
  });

  it("restores modified file pixels instead of rereading the original file", async () => {
    const image = await lumine.workspace.open(path.join(__dirname, "fixtures/sample.png"));
    await conditionPromise(() => image.view.loaded);
    image.view.historyManager.ensureInitialSaved(() => image.view.saveToHistory());
    image.view.commitCanvas(pixels("lime"));
    const documentId = image.document.id;
    const state = JSON.parse(JSON.stringify(await lumine.captureState()));
    await lumine.deserialize(state);
    const restored = lumine.workspace
      .getPaneItems()
      .find((item) => item.getPaneItemDocument?.()?.id === documentId);
    await conditionPromise(() => restored.view.loaded);
    expect(restored.getPath()).toBe(path.join(__dirname, "fixtures/sample.png"));
    expect(restored.getFileState()).toBe("modified");
    expect(color(restored.view)).toEqual([0, 255, 0, 255]);
  });
});
