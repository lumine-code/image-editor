const { createRequire } = require("node:module");
const path = require("node:path");

describe("displayed image readiness", () => {
  const selectAll = "image-editor:select-all";
  let pack, item, subscriptions, releaseDecode;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    pack = await lumine.packages.activatePackage("image-editor");
    subscriptions = [];
    releaseDecode = null;
  });

  afterEach(async () => {
    const file = item?.file;
    for (const subscription of subscriptions) subscription.dispose();
    item?.destroy();
    item = null;
    releaseDecode?.();
    await file?.closed;
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
  });

  function holdDisplayDecode(view) {
    const image = view.refs.image;
    const nativeDecode = image.decode.bind(image);
    const decoded = Promise.withResolvers();
    const release = Promise.withResolvers();
    releaseDecode = release.resolve;
    let intercept = true;
    spyOn(image, "decode").and.callFake(async () => {
      if (!intercept) return nativeDecode();
      intercept = false;
      await nativeDecode();
      decoded.resolve();
      await release.promise;
    });
    return decoded.promise;
  }

  function observeLoad(view) {
    const didLoad = jasmine.createSpy("did-load");
    subscriptions.push(view.onDidLoad(didLoad));
    return didLoad;
  }

  async function openFile() {
    item = await lumine.workspace.open(path.join(pack.path, "spec/fixtures/sample.png"));
    const view = item.view;
    await conditionPromise(() => view.loaded && view.refs.image.complete && !view.pixelSyncPromise);
    return view;
  }

  it("waits for the displayed element before reporting readiness or processing commands on first open", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 7;
    canvas.height = 5;
    canvas.getContext("2d").fillRect(0, 0, 7, 5);
    const requireFromPackage = createRequire(path.join(pack.path, "package.json"));
    const ImageEditor = requireFromPackage("./lib/editor");
    item = ImageEditor.fromDataUrl(canvas.toDataURL(), "New image");
    const view = item.view;
    const decoded = holdDisplayDecode(view);
    const didLoad = observeLoad(view);
    await lumine.workspace.open(item);
    await decoded;

    const selecting = lumine.commands.dispatch(view.element, selectAll);
    await flushMicrotasks();
    expect(view.loaded).toBe(false);
    expect(didLoad).not.toHaveBeenCalled();
    expect(view.selectionVisible).toBe(false);

    releaseDecode();
    await selecting;
    await conditionPromise(() => view.selectionVisible);
    expect(view.loaded).toBe(true);
    expect(didLoad).toHaveBeenCalledTimes(1);
    expect(view.selectionEndImg).toEqual({ x: 7, y: 5 });
  });

  it("keeps navigation and pixel commands pending until the destination is displayed", async () => {
    const view = await openFile();
    const decoded = holdDisplayDecode(view);
    const didLoad = observeLoad(view);
    const destination = path.join(pack.path, "spec/fixtures/other.png");
    let finished = false;
    const navigating = view.loadImageFromNavigation(destination).then((result) => {
      finished = true;
      return result;
    });
    await decoded;

    const selecting = lumine.commands.dispatch(view.element, selectAll);
    await flushMicrotasks();
    expect(finished).toBe(false);
    expect(didLoad).not.toHaveBeenCalled();
    expect(view.selectionVisible).toBe(false);

    releaseDecode();
    expect(await navigating).toBe(true);
    await selecting;
    await conditionPromise(() => view.selectionVisible);
    expect(item.getPath()).toBe(destination);
    expect(didLoad).toHaveBeenCalledTimes(1);
    expect(view.selectionEndImg).toEqual({ x: 2, y: 2 });
  });

  it("does not report readiness for a superseded presentation", async () => {
    const view = await openFile();
    const decoded = holdDisplayDecode(view);
    const didLoad = observeLoad(view);
    const initialPath = item.getPath();
    const first = view.loadImageFromNavigation(path.join(pack.path, "spec/fixtures/other.png"));
    await decoded;

    expect(await view.loadImageFromNavigation(initialPath)).toBe(true);
    expect(didLoad).toHaveBeenCalledTimes(1);

    releaseDecode();
    expect(await first).toBe(false);
    expect(didLoad).toHaveBeenCalledTimes(1);
    expect(item.getPath()).toBe(initialPath);
  });
});
