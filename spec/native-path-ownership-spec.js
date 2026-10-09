const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("image native path ownership", () => {
  let pack, directory, items;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    pack = await lumine.packages.activatePackage("image-editor");
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "image-path-owned-")));
    items = [];
    jasmine.attachToDOM(lumine.workspace.getElement());
  });

  afterEach(async () => {
    for (const item of items) item.destroy();
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe image path scratch");
    fs.rmSync(directory, { recursive: true, force: true });
    pack = directory = items = null;
  });

  function image(name) {
    const file = path.join(directory, name);
    fs.copyFileSync(path.join(pack.path, "spec/fixtures/sample.png"), file);
    return file;
  }

  async function open(file) {
    const item = await lumine.workspace.open(file, { pending: false });
    items.push(item);
    const start = performance.now();
    while (!item.view.loaded || !item.view.refs.image.complete) {
      if (performance.now() - start > 5000) throw new Error("Owned image load exceeded budget");
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return item;
  }

  if (process.platform === "linux")
    it("navigates between two actual case-distinct image files", async () => {
      const upper = image("A.png");
      const lower = image("a.png");
      expect(fs.statSync(upper).ino).not.toBe(fs.statSync(lower).ino);
      const item = await open(upper);
      const listing = await item.view.getFileList();
      expect(listing.files[listing.currentIndex]).toBe(upper);
      await item.view.nextImage();
      expect(item.getPath()).toBe(lower);
    });

  it("keeps ordinary native folder navigation", async () => {
    const first = image("first.png");
    const second = image("second.png");
    const item = await open(first);
    await item.view.nextImage();
    expect(item.getPath()).toBe(second);
  });

  it("resolves a native case alias without reloading the same listed file", async () => {
    const file = image("alias.png");
    const alias = path.join(directory, "ALIAS.PNG");
    if (!fs.existsSync(alias)) {
      const ImageNavigator = require(path.join(pack.path, "lib/navigation"));
      expect((await new ImageNavigator().getFileList(alias)).currentIndex).toBe(-1);
      return;
    }
    expect(fs.statSync(alias).ino).toBe(fs.statSync(file).ino);
    const item = await open(alias);
    const binding = item.file;
    const listing = await item.view.getFileList();
    expect(listing.files[listing.currentIndex]).toBe(file);
    await item.view.nextImage();
    expect(item.file).toBe(binding);
  });
});
