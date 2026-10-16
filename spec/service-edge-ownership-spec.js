const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Image service edge ownership", () => {
  let main, directory, temporary, image, leases, roots;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    spyOn(lumine.clipboard, "write");
    leases = [];
    roots = [];
    temporary = fs.realpathSync.native(os.tmpdir());
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, "image-edges-owned-")));
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("tree-view");
    const pack = await lumine.packages.activatePackage("image-editor");
    main = pack.mainModule;
    for (const name of ["first.png", "second.png"])
      fs.copyFileSync(path.join(pack.path, "spec/fixtures/sample.png"), path.join(directory, name));
    image = await lumine.workspace.open(path.join(directory, "first.png"));
    await conditionPromise(() => image.view.loaded && image.view.refs.image.complete);
  });
  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    for (const item of lumine.workspace.getPaneItems()) item.destroy?.();
    if (lumine.packages.isPackageLoaded("image-editor"))
      await lumine.packages.unloadPackage("image-editor");
    for (const root of roots) root.remove();
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(fs.realpathSync.native(directory)) !== temporary ||
      !path.basename(directory).startsWith("image-edges-owned-")
    )
      throw Error("Unsafe owned image service cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function provide(name, service) {
    const payload =
      name === "status-bar"
        ? {
            observeWindows(create) {
              const window = lumine.workspace.getMainWindow();
              return create(service, {
                window,
                document: window.getDocument(),
                editorContainer: window.getEditorContainer(),
              });
            },
          }
        : service;
    const lease = lumine.packages.serviceHub.provide(
      name,
      name === "status-bar" ? "2.0.0" : "1.0.0",
      payload,
    );
    leases.push(lease);
    return lease;
  }
  function status() {
    const root = document.createElement("div");
    lumine.workspace.getElement().append(root);
    roots.push(root);
    return {
      root,
      addLeftTile({ item }) {
        root.append(item.element);
        return { destroy: () => item.element.remove() };
      },
    };
  }
  it("retains a real status tile until the last shared service edge retires", () => {
    const service = status();
    const first = provide("status-bar", service);
    const second = provide("status-bar", service);
    const element = service.root.querySelector(".status-image");
    expect(element.textContent).toContain("2x2");
    first.dispose();
    expect(service.root.querySelector(".status-image")).toBe(element);
    second.dispose();
    expect(service.root.querySelector(".status-image")).toBeNull();
  });
  it("owns independent tiles for overlapping service providers", () => {
    const a = status(),
      b = status();
    provide("status-bar", a);
    const second = provide("status-bar", b);
    expect(a.root.querySelector(".status-image")?.textContent).toContain("2x2");
    expect(b.root.querySelector(".status-image")?.textContent).toContain("2x2");
    second.dispose();
    expect(b.root.querySelector(".status-image")).toBeNull();
    expect(a.root.querySelector(".status-image")?.textContent).toContain("2x2");
  });
  it("stops a retired status view from observing actual image transformations", async () => {
    const service = status();
    const lease = provide("status-bar", service);
    const retired = main.imageEditorStatusView;
    const updated = spyOn(retired, "getImageSize").and.callThrough();
    lease.dispose();
    image.view.resizeImage(4, 3);
    await conditionPromise(
      () =>
        image.view.refs.image.naturalWidth === 4 &&
        image.view.refs.image.naturalHeight === 3 &&
        image.view.loaded,
    );
    expect(updated).not.toHaveBeenCalled();
    expect(service.root.querySelector(".status-image")).toBeNull();
  });
  it("uses ordinary live status providers", () => {
    const service = status();
    provide("status-bar", service);
    expect(service.root.querySelector(".status-image").textContent).toContain("2x2");
  });
  it("does not publish properties after its image closes during the owned directory read", async () => {
    const view = image.view;
    view.navigator.invalidateCache();
    const readdir = fs.promises.readdir.bind(fs.promises);
    const entries = await readdir(directory);
    let release,
      entered = false;
    const held = new Promise((resolve) => (release = resolve));
    spyOn(fs.promises, "readdir").and.callFake((target, ...args) => {
      if (target !== directory) return readdir(target, ...args);
      entered = true;
      return held;
    });
    const show = spyOn(view, "showPropertiesDialog").and.callThrough();
    const listen = spyOn(document, "addEventListener").and.callThrough();
    lumine.commands.dispatch(image.element, "image-editor:show-properties");
    const opening = show.calls.mostRecent().returnValue.catch((error) => error);
    await conditionPromise(() => entered);
    await lumine.workspace.paneForItem(image).destroyItem(image, true);
    release(entries);
    const result = await opening;
    const backdrop = document.querySelector(".image-editor-dialog-backdrop");
    try {
      expect(result).toBeUndefined();
      expect(backdrop).toBeNull();
    } finally {
      for (const [type, listener] of listen.calls.allArgs())
        if (type === "keydown") document.removeEventListener(type, listener);
      backdrop?.remove();
    }
  });
  it("opens ordinary live image properties from the current command", async () => {
    const show = spyOn(image.view, "showPropertiesDialog").and.callThrough();
    lumine.commands.dispatch(image.element, "image-editor:show-properties");
    await show.calls.mostRecent().returnValue;
    const backdrop = document.querySelector(".image-editor-dialog-backdrop");
    try {
      expect(backdrop?.textContent).toContain("first.png");
      expect(backdrop?.textContent).toContain("Position in folder");
    } finally {
      backdrop?.querySelector("button")?.click();
    }
  });
});
