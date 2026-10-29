const path = require("node:path");

describe("image metadata", () => {
  let pack, image;
  const rows = (item) => item.getMetadata().flatMap((section) => section.rows);

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    pack = await lumine.packages.activatePackage("image-editor");
    image = await lumine.workspace.open(path.join(__dirname, "fixtures/sample.png"));
    await conditionPromise(() => image.editorView?.loaded);
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("image-editor");
  });

  it("reports current shared pixels after an unsaved resize and retires subscriptions", async () => {
    const copy = image.copy();
    const changed = jasmine.createSpy("metadata changed");
    const lease = copy.onDidChangeMetadata(changed);
    try {
      expect(rows(copy).find((row) => row.id === "width").value).toBe(2);
      image.view.resizeImage(4, 3);
      await conditionPromise(() => rows(copy).find((row) => row.id === "width")?.value === 4);
      expect(rows(copy).find((row) => row.id === "height").value).toBe(3);
      expect(rows(copy).find((row) => row.id === "rgba-size")).toEqual({
        id: "rgba-size",
        label: "RGBA buffer estimate",
        value: 48,
        format: "bytes",
      });
      expect(changed).toHaveBeenCalled();
      lease.dispose();
      changed.calls.reset();
      image.document.emitter.emit("did-change-history");
      expect(changed).not.toHaveBeenCalled();
    } finally {
      lease.dispose();
      copy.destroy();
    }
  });

  it("handles images without paths and respects cancellation", () => {
    const ImageEditor = image.constructor;
    const temporary = ImageEditor.fromDataUrl("data:image/png;base64,", "Untitled image");
    try {
      temporary.document.publishPixels({ width: 12, height: 8 });
      expect(temporary.getPath()).toBeNull();
      expect(rows(temporary).find((row) => row.id === "width").value).toBe(12);
      expect(rows(temporary).find((row) => row.id === "format").value).toBe("PNG");
      const controller = new AbortController();
      controller.abort();
      expect(() => temporary.getMetadata({ signal: controller.signal })).toThrow();
    } finally {
      temporary.destroy();
    }
  });

  it("owns each metadata service edge and disables the retained action without one", async () => {
    const main = pack.mainModule;
    const first = { showForItem: jasmine.createSpy("first").and.resolveTo() };
    const second = { showForItem: jasmine.createSpy("second").and.resolveTo() };
    const firstLease = main.consumeMetadata(first);
    const secondLease = main.consumeMetadata(second);
    firstLease.dispose();
    await main.showMetadata(image);
    expect(first.showForItem).not.toHaveBeenCalled();
    expect(second.showForItem).toHaveBeenCalledOnceWith(image, { focus: true });
    secondLease.dispose();
    expect(lumine.commands.canDispatch(image.element, "image-editor:show-properties")).toBe(false);
  });
});
