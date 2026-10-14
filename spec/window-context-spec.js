const path = require("node:path");

describe("image presentation windows", () => {
  let image;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("status-bar");
    await lumine.packages.activatePackage("image-editor");
    image = await lumine.workspace.open(path.join(__dirname, "fixtures/sample.png"));
    await conditionPromise(() => image.view.loaded);
  });
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
  });

  function expectFitted(view) {
    const container = view.refs.imageContainer;
    const zoom = Math.min(
      container.offsetWidth / view.refs.image.naturalWidth,
      container.offsetHeight / view.refs.image.naturalHeight,
    );
    const transform = new view.window.DOMMatrix(
      view.window.getComputedStyle(view.refs.image).transform,
    );
    expect(transform.a).toBeCloseTo(zoom, 4);
    expect(transform.e).toBeCloseTo(
      (container.offsetWidth - view.refs.image.naturalWidth * zoom) / 2,
      3,
    );
    expect(transform.f).toBeCloseTo(
      (container.offsetHeight - view.refs.image.naturalHeight * zoom) / 2,
      3,
    );
  }

  it("finishes a deferred filter after its source window is attached and closed", async () => {
    const extra = await lumine.workspace.detachPane(lumine.workspace.paneForItem(image));
    const view = image.view;
    const frames = [];
    spyOn(extra.getDOMWindow(), "requestAnimationFrame").and.callFake((callback) =>
      frames.push(callback),
    );
    spyOn(extra.getDOMWindow(), "cancelAnimationFrame");
    const apply = jasmine.createSpy("filter pixels");
    view.runFilterOperation({ apply, defer: true });
    expect(view.filterInProgress).toBeTrue();
    frames.shift()();
    const lateFrame = frames.shift();
    await lumine.workspace.attachWindow(extra);
    lateFrame();
    await conditionPromise(() => apply.calls.count() === 1);
    expect(view.filterInProgress).toBeFalse();
    expect(view.deferredFilterRun).toBeNull();
  });

  it("animates zoom using the clock of the image's current window", async () => {
    const extra = await lumine.workspace.detachPane(lumine.workspace.paneForItem(image));
    const view = image.view;
    const domWindow = extra.getDOMWindow();
    view.element.style.height = "300px";
    view.disableAutoZoom();
    view.zoom = 1;
    view.updateTransform({ immediate: true });
    const frames = [];
    spyOn(window.performance, "now").and.returnValue(20000);
    spyOn(domWindow.performance, "now").and.returnValue(100);
    spyOn(domWindow, "requestAnimationFrame").and.callFake((callback) => frames.push(callback));
    spyOn(domWindow, "cancelAnimationFrame");
    view.zoom = 2;
    view.updateTransformSmooth(120);
    frames[0](99);
    const transform = () => new domWindow.DOMMatrix(view.refs.image.style.transform);
    expect(transform().a).toBe(1);
    frames[1](160);
    expect(transform().a).toBeGreaterThan(1);
    expect(transform().a).toBeLessThan(2);
    frames[2](220);
    expect(transform().a).toBe(2);
    expect(view.smoothTransformRAF).toBeNull();
  });

  it("fits resized image bounds before paint, without waiting for another animation frame", async () => {
    lumine.config.set("image-editor.autoZoomLimit", false);
    const view = image.view;
    view.element.style.height = "300px";
    const container = view.refs.imageContainer;
    Object.assign(container.style, { flex: "none", width: "160px", height: "100px" });
    view.zoomToFit();
    await conditionPromise(() => view.renderedTransform?.zoom === 50);
    const resized = new Promise((resolve) => {
      const observer = new ResizeObserver(() => {
        if (container.offsetWidth !== 80) return;
        expectFitted(view);
        observer.disconnect();
        resolve();
      });
      observer.observe(container);
    });
    container.style.width = "80px";
    await resized;
  });

  it("fits the adopted image to its attached pane before the transfer completes", async () => {
    lumine.config.set("image-editor.autoZoomLimit", false);
    const extra = await lumine.workspace.detachPane(lumine.workspace.paneForItem(image));
    const view = image.view;
    view.element.style.height = "300px";
    Object.assign(view.refs.imageContainer.style, {
      flex: "none",
      width: "160px",
      height: "100px",
    });
    await conditionPromise(() => view.renderedTransform?.zoom === 50);
    view.refs.imageContainer.style.width = "80px";
    await lumine.workspace.attachWindow(extra);
    expect(view.document).toBe(document);
    expectFitted(view);
  });

  it("keeps a manual viewport, including a pending pan, when its pane is attached", async () => {
    const extra = await lumine.workspace.detachPane(lumine.workspace.paneForItem(image));
    const view = image.view;
    view.disableAutoZoom();
    view.zoom = 2;
    view.translateX = 17;
    view.translateY = 23;
    view.updateTransform();
    await lumine.workspace.attachWindow(extra);
    const transform = new DOMMatrix(getComputedStyle(view.refs.image).transform);
    expect(view.auto).toBeFalse();
    expect(transform.a).toBe(2);
    expect(transform.e).toBe(17);
    expect(transform.f).toBe(23);
  });

  it("keeps the same pixels, view and document while rebinding pointer input to its new window", async () => {
    const view = image.view;
    const element = lumine.views.getView(image);
    const document = image.document;
    const pixels = view.refs.image.naturalWidth;
    const move = spyOn(view.mouseHandler, "handleMouseMove");
    const extra = await lumine.workspace.detachPane(lumine.workspace.paneForItem(image));
    expect(image.view).toBe(view);
    expect(image.document).toBe(document);
    expect(view.refs.image.naturalWidth).toBe(pixels);
    extra
      .getDocument()
      .body.dispatchEvent(new (extra.getDOMWindow().MouseEvent)("mousemove", { bubbles: true }));
    expect(move).toHaveBeenCalledTimes(1);
    window.document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(move).toHaveBeenCalledTimes(1);
    expect(element.ownerDocument).toBe(extra.getDocument());
    await lumine.workspace.attachWindow(extra);
    window.document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(move).toHaveBeenCalledTimes(2);
  });

  it("uses a local status tile and opens properties in that image's document", async () => {
    const extra = await lumine.workspace.detachPane(lumine.workspace.paneForItem(image));
    await conditionPromise(() =>
      extra.getElement().querySelector(".status-image")?.textContent.includes("2x2"),
    );
    const mainTile = lumine.workspace.getMainWindow().getElement().querySelector(".status-image");
    expect(mainTile.style.display).toBe("none");
    extra.getElement().querySelector(".status-image").click();
    await conditionPromise(() =>
      extra.getDocument().body.querySelector(".image-editor-properties-dialog"),
    );
  });

  it("opens Save As in the image's window", async () => {
    const extra = await lumine.workspace.detachPane(lumine.workspace.paneForItem(image));
    const dialog = spyOn(extra, "showSaveDialog").and.resolveTo({ canceled: true });
    const mainDialog = spyOn(lumine.window, "showSaveDialog").and.resolveTo({ canceled: true });
    expect(await image.saveAs()).toBeFalse();
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(mainDialog).not.toHaveBeenCalled();
  });

  it("does not ask about shared dirty contents when another image view remains", async () => {
    const copy = image.copy();
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    extra.getEditorContainer().getActivePane().activateItem(copy);
    image.setFileState("modified");
    lumine.config.set("core.promptOnCloseDirtyBuffer", true);
    const confirm = spyOn(extra, "confirm").and.resolveTo(1);
    expect(await extra.close()).toBeTrue();
    expect(confirm).not.toHaveBeenCalled();
    expect(image.destroyed).toBeFalse();
  });
});
