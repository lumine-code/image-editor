const path = require("node:path");

describe("image scroll commands", () => {
  let item;
  const directions = ["up", "down", "left", "right"];

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const pack = await lumine.packages.activatePackage("image-editor");
    item = await lumine.workspace.open(path.join(pack.path, "spec", "fixtures", "sample.png"));
    item.view.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await conditionPromise(() => item.view.loaded && item.view.refs.image.complete);
  });

  afterEach(async () => {
    item?.destroy();
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
    item = null;
  });

  function key(value, target) {
    const event = lumine.keymaps.constructor.buildKeydownEvent(value, { target });
    lumine.keymaps.handleKeyboardEvent(event);
    return event;
  }

  it("pans smoothly through the public commands and each plain arrow", async () => {
    const view = item.view;
    view.resetZoom();
    await conditionPromise(() => view.renderedTransform?.zoom === 1);
    const start = { x: view.translateX, y: view.translateY };
    const width = view.refs.imageContainer.offsetWidth / 10;
    const height = view.refs.imageContainer.offsetHeight / 10;
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);

    for (const dispatch of [
      (direction) => lumine.commands.dispatch(view.refs.image, `image-editor:scroll-${direction}`),
      (direction) => key(direction, view.element),
    ]) {
      dispatch("up");
      expect(view.translateY).toBeCloseTo(start.y + height, 8);
      dispatch("left");
      expect(view.translateX).toBeCloseTo(start.x + width, 8);
      expect(view.smoothTransformRAF).not.toBeNull();
      expect(view.auto).toBe(false);
      await conditionPromise(
        () =>
          view.renderedTransform.translateX === view.translateX &&
          view.renderedTransform.translateY === view.translateY,
      );
      dispatch("down");
      dispatch("right");
      expect(view.translateX).toBeCloseTo(start.x, 8);
      expect(view.translateY).toBeCloseTo(start.y, 8);
    }
  });

  it("leaves numeric input arrows native without panning the image", () => {
    const view = item.view;
    const input = view.element.querySelector("input.native-key-bindings");
    expect(input).not.toBeNull();
    const start = { x: view.translateX, y: view.translateY };
    for (const direction of directions) expect(key(direction, input).defaultPrevented).toBe(false);
    expect(view.translateX).toBe(start.x);
    expect(view.translateY).toBe(start.y);
  });

  it("requires loaded pixels and a live view before dispatching scroll commands", () => {
    const view = item.view;
    const target = view.refs.image;
    const available = () =>
      directions.map((direction) =>
        lumine.commands.canDispatch(target, `image-editor:scroll-${direction}`),
      );
    expect(available()).toEqual([true, true, true, true]);
    view.loaded = false;
    expect(available()).toEqual([false, false, false, false]);
    view.loaded = true;
    view._destroyed = true;
    expect(available()).toEqual([false, false, false, false]);
    view._destroyed = false;
    item.destroy();
    item = null;
    expect(available()).toEqual([false, false, false, false]);
  });
});
