const path = require("node:path");

describe("Image transient UI across presentation windows", () => {
  let image;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("image-editor");
    image = await lumine.workspace.open(path.join(__dirname, "fixtures/sample.png"));
    await conditionPromise(() => image.view.loaded);
  });

  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
  });

  it("uses the rotation dialog's clock and ignores its callback after cancellation", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    await lumine.workspace.movePaneItem(image, {
      targetPane: extra.getEditorContainer().getActivePane(),
    });
    const view = image.view;
    const targetWindow = extra.getDOMWindow();
    const mainTimer = spyOn(window, "setTimeout").and.callThrough();
    const timer = spyOn(targetWindow, "setTimeout").and.callThrough();
    const apply = spyOn(view, "applyRotatePreview");
    spyOn(view, "restoreOriginalImage");
    view.showFreeRotateDialog();
    const dialog = extra.getDocument().querySelector(".image-editor-adjustment-dialog");
    dialog.querySelector("#auto-preview").click();
    const slider = dialog.querySelector("input[type=range]");
    slider.value = "30";
    slider.dispatchEvent(new targetWindow.Event("input", { bubbles: true }));
    const callback = [...mainTimer.calls.allArgs(), ...timer.calls.allArgs()]
      .filter((args) => args[1] === 150)
      .at(-1)[0];
    expect(timer).toHaveBeenCalled();
    dialog.querySelector(".dialog-buttons button").click();
    callback();
    expect(apply).not.toHaveBeenCalled();
  });

  it("retires a source boundary overlay timer before showing one in the destination", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const view = image.view;
    const sourceTimer = spyOn(window, "setTimeout").and.callThrough();
    const cancel = spyOn(window, "clearTimeout").and.callThrough();
    view.showBoundaryOverlay("left");
    const callback = sourceTimer.calls.mostRecent().args[0];
    const handle = sourceTimer.calls.mostRecent().returnValue;
    await lumine.workspace.movePaneItem(image, {
      targetPane: extra.getEditorContainer().getActivePane(),
    });
    expect(cancel).toHaveBeenCalledWith(handle);
    const timer = spyOn(extra.getDOMWindow(), "setTimeout").and.callThrough();
    view.showBoundaryOverlay("right");
    expect(timer).toHaveBeenCalled();
    callback();
    expect(view.refs.boundaryOverlay.classList.contains("active")).toBeTrue();
  });

  it("closes a source dialog when its image is attached and the source window closes", async () => {
    const extra = await lumine.workspace.detachPane(lumine.workspace.paneForItem(image));
    const sourceWindow = extra.getDOMWindow();
    const body = extra.getDocument().body;
    image.view.showResizeDialog();
    const backdrop = body.querySelector(".image-editor-dialog-backdrop");
    expect(backdrop).not.toBeNull();
    await lumine.workspace.attachWindow(extra);
    await conditionPromise(() => sourceWindow.closed);
    expect(body.contains(backdrop)).toBeFalse();
    expect(image.destroyed).toBeFalse();
  });
});
