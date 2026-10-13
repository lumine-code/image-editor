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
