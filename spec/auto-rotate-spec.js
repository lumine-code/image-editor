const path = require("node:path");
const { createRequire } = require("node:module");

describe("image-editor auto-rotate command", () => {
  const command = "image-editor:auto-rotate";
  let item, view, image, detector;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const pkg = await lumine.packages.activatePackage("image-editor");
    const requireFromPackage = createRequire(path.join(pkg.path, "package.json"));
    detector = spyOn(requireFromPackage("./lib/auto-orientation"), "detectOrientation");

    const canvas = document.createElement("canvas");
    canvas.width = 3;
    canvas.height = 2;
    const context = canvas.getContext("2d");
    context.fillRect(0, 0, 1, 1);
    item = await pkg.mainModule.openFromDataUrl(canvas.toDataURL(), "Auto-rotate sample");
    view = item.view;
    image = view.refs.image;
    await conditionPromise(() => view.loaded && image.complete);
  });

  afterEach(() => {
    item?.destroy();
    item = null;
  });

  it("rotates the displayed image and can undo the rotation", async () => {
    detector.and.resolveTo({ degrees: 90, confidence: 22 });

    await lumine.commands.dispatch(image, command);
    await conditionPromise(() => image.complete && image.naturalWidth === 2);

    expect(detector).toHaveBeenCalledTimes(1);
    const [pngBuffer] = detector.calls.argsFor(0);
    expect(pngBuffer.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(image.naturalHeight).toBe(3);
    expect(view.historyManager.canUndo()).toBe(true);

    await lumine.commands.dispatch(image, "image-editor:undo");
    await conditionPromise(() => image.complete && image.naturalWidth === 3);
    expect(image.naturalHeight).toBe(2);
  });

  it("leaves upright and uncertain images unchanged", async () => {
    const rotate = spyOn(view, "rotateInOperation");
    const initialSource = image.src;
    const initialHistoryLength = view.historyManager.length;

    for (const result of [
      { degrees: 0, confidence: 22 },
      { degrees: 90, confidence: 10 },
      { degrees: null, confidence: null },
    ]) {
      detector.and.resolveTo(result);
      await lumine.commands.dispatch(image, command);
    }

    expect(detector).toHaveBeenCalledTimes(3);
    expect(rotate).not.toHaveBeenCalled();
    expect(image.src).toBe(initialSource);
    expect(view.historyManager.length).toBe(initialHistoryLength);
  });

  it("rotates before a flip dispatched during orientation detection", async () => {
    const detection = Promise.withResolvers();
    detector.and.returnValue(detection.promise);
    const initialSource = image.src;

    const rotation = lumine.commands.dispatch(image, command);
    await conditionPromise(() => detector.calls.any());
    const flip = lumine.commands.dispatch(image, "image-editor:flip-horizontal");
    expect(item.document.operationQueue.waiting).toEqual(["Flip Horizontally"]);
    expect(image.src).toBe(initialSource);
    detection.resolve({ degrees: 90, confidence: 22 });
    await Promise.all([rotation, flip]);

    expect(image.naturalWidth).toBe(2);
    expect(image.naturalHeight).toBe(3);
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 3;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(255);
    expect(context.getImageData(1, 0, 1, 1).data[3]).toBe(0);
    expect(view.historyManager.length).toBe(3);
  });

  it("runs the local detector from the renderer", async () => {
    detector.and.callThrough();
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 400;
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));

    const result = await detector(Buffer.from(await blob.arrayBuffer()));
    expect(result.degrees).toBeNull();
  }, 35000);

  it("cancels detection when the image closes", async () => {
    const detection = Promise.withResolvers();
    detector.and.returnValue(detection.promise);
    const rotation = lumine.commands.dispatch(image, command);
    await conditionPromise(() => detector.calls.any());

    const [, { signal }] = detector.calls.argsFor(0);
    item.destroy();
    item = null;
    detection.resolve({ degrees: 90, confidence: 22 });
    await rotation;

    expect(signal.aborted).toBe(true);
  });
});
