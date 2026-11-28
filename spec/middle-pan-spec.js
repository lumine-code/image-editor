const path = require("node:path");

describe("image editor middle-button panning", () => {
  let item, view, container;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const pack = await lumine.packages.activatePackage("image-editor");
    item = await lumine.workspace.open(path.join(pack.path, "spec", "fixtures", "sample.png"));
    view = item.view;
    container = view.refs.imageContainer;
    view.element.style.cssText = "position:absolute;width:700px;height:500px;top:0;left:0";
    await conditionPromise(() => view.loaded && view.renderedTransform?.zoom === view.zoom);
    view.applyAutoZoom({ immediate: true });
  });

  afterEach(async () => {
    item?.destroy();
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
  });

  function mouse(target, type, options = {}) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 1,
      clientX: 160,
      clientY: 140,
      ...options,
    });
    target.dispatchEvent(event);
    return event;
  }

  function middleClick(target = container) {
    expect(mouse(target, "mousedown", { buttons: 4 }).defaultPrevented).toBe(true);
    mouse(target, "mouseup");
  }

  function transform() {
    return [view.translateX, view.translateY, view.zoom];
  }

  function twoFrames() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  it("autoscrolls from the held pointer position and stops on middle release", async () => {
    const [x, y, zoom] = transform();
    expect(mouse(container, "mousedown", { buttons: 4 }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.element);
    mouse(container, "mousemove", { buttons: 4, clientX: 166, clientY: 145 });
    await twoFrames();
    expect(transform()).toEqual([x, y, zoom]);
    expect(view.auto).toBe(true);

    mouse(window, "mousemove", { buttons: 4, clientX: 240, clientY: 90 });
    await conditionPromise(() => view.translateX < x && view.translateY > y);
    const firstX = view.translateX;
    await conditionPromise(() => view.translateX < firstX);
    expect(view.zoom).toBe(zoom);
    expect(view.auto).toBe(false);

    mouse(window, "mouseup");
    const stopped = transform();
    mouse(window, "mousemove", { clientX: 260, clientY: 100 });
    await twoFrames();
    expect(transform()).toEqual(stopped);
    expect(container.classList.contains("middle-autopan")).toBe(false);
    container.addEventListener("contextmenu", (event) => event.stopPropagation(), { once: true });
    expect(mouse(container, "contextmenu", { button: 2 }).defaultPrevented).toBe(false);
  });

  it("toggles from a short middle click without moving, then pauses at the origin", async () => {
    const [x, y, zoom] = transform();
    middleClick();
    await twoFrames();
    expect(transform()).toEqual([x, y, zoom]);
    expect(view.auto).toBe(true);
    expect(container.classList.contains("middle-autopan")).toBe(true);

    mouse(window, "mousemove", { clientY: 220 });
    await conditionPromise(() => view.translateY < y);
    expect(view.translateX).toBe(x);
    expect(view.zoom).toBe(zoom);
    mouse(window, "mousemove");
    const paused = transform();
    await twoFrames();
    expect(transform()).toEqual(paused);

    mouse(window, "mousemove", { clientX: 80 });
    await conditionPromise(() => view.translateX > x);
    middleClick();
    const stopped = transform();
    mouse(window, "mousemove", { clientX: 60 });
    await twoFrames();
    expect(transform()).toEqual(stopped);
    expect(view.mouseHandler.middlePan).toBeNull();
    expect(container.classList.contains("middle-autopan")).toBe(false);
  });

  it("stops on Escape, window blur, wheel and window transfer without stealing the toolbar", async () => {
    middleClick();
    mouse(window, "mousemove", { clientX: 240 });
    const start = view.translateX;
    await conditionPromise(() => view.translateX < start);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    view.element.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    const stopped = transform();
    await twoFrames();
    expect(transform()).toEqual(stopped);

    middleClick();
    window.dispatchEvent(new Event("blur"));
    expect(view.mouseHandler.middlePan).toBeNull();
    middleClick();
    view.prepareWindowChange();
    expect(view.mouseHandler.middlePan).toBeNull();

    middleClick();
    const toolbar = view.refs.zoomToFitButton;
    const wheel = new WheelEvent("wheel", { deltaY: -20, bubbles: true, cancelable: true });
    toolbar.dispatchEvent(wheel);
    expect(view.mouseHandler.middlePan).toBeNull();
    expect(wheel.defaultPrevented).toBe(true);
    expect(view.zoom).toBeGreaterThan(stopped[2]);

    middleClick();
    expect(mouse(toolbar, "mousedown", { buttons: 4 }).defaultPrevented).toBe(true);
    mouse(toolbar, "mouseup");
    expect(mouse(toolbar, "auxclick").defaultPrevented).toBe(true);
    expect(view.mouseHandler.middlePan).toBeNull();
    expect(view.zoomMode).toBe("auto");
  });

  it("does not keep panning when another pane becomes active", async () => {
    middleClick();
    const start = view.translateX;
    mouse(window, "mousemove", { clientX: 240 });
    await conditionPromise(() => view.translateX < start);
    const next = await lumine.workspace.open(path.join(path.dirname(item.getPath()), "other.png"), {
      split: "right",
    });
    try {
      expect(lumine.workspace.getActivePaneItem()).toBe(next);
      expect(view.mouseHandler.middlePan).toBeNull();
      const stopped = transform();
      mouse(window, "mousemove", { clientX: 250 });
      await twoFrames();
      expect(transform()).toEqual(stopped);
    } finally {
      next.destroy();
    }
  });
});
