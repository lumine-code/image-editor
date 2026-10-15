describe("Image preview dialog window ownership", () => {
  let extra, preview;

  beforeEach(async () => {
    extra = await lumine.workspace.openEditorWindow({ show: false });
  });

  afterEach(async () => {
    preview?.cleanup();
    await lumine.workspace.discardEditorWindows();
  });

  function createPreview(renderPreview = jasmine.createSpy("render preview")) {
    const document = extra.getDocument();
    const source = document.createElement("canvas");
    source.width = source.height = 2;
    source.naturalWidth = source.naturalHeight = 2;
    preview = require("../lib/dialogs").forDocument(document).createPreviewPanel({
      sourceImage: source,
      renderPreview,
    });
    document.body.append(preview.container);
    return renderPreview;
  }

  it("uses the preview document's resize observer and debounce clock", () => {
    const window = extra.getDOMWindow();
    const resize = spyOn(window, "ResizeObserver").and.callThrough();
    const timer = spyOn(window, "setTimeout").and.callThrough();
    createPreview();
    preview.schedulePreview([3]);
    expect(resize).toHaveBeenCalled();
    expect(timer).toHaveBeenCalled();
  });

  it("ignores an already queued preview after cleanup", () => {
    const callbacks = [];
    for (const target of [window, extra.getDOMWindow()]) {
      spyOn(target, "setTimeout").and.callFake((callback) => {
        callbacks.push(callback);
        return callbacks.length;
      });
      spyOn(target, "clearTimeout");
    }
    const render = createPreview();
    preview.schedulePreview([3]);
    const callback = callbacks.at(-1);
    preview.cleanup();
    callback();
    expect(render).not.toHaveBeenCalled();
  });

  it("releases the preview when its presentation unloads", () => {
    const window = extra.getDOMWindow();
    const resize = spyOn(window, "ResizeObserver").and.callThrough();
    createPreview();
    const observer = resize.calls.mostRecent()?.returnValue;
    if (!observer) {
      fail("The preview did not create an observer in its owning window");
      return;
    }
    const disconnect = spyOn(observer, "disconnect").and.callThrough();
    window.dispatchEvent(new window.Event("unload"));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
