const fs = require("fs");
const path = require("path");
const { Disposable } = require("lumine");

const samplePath = path.join(__dirname, "fixtures", "sample.png");
const otherPath = path.join(__dirname, "fixtures", "other.png");

function pollUntil(condition, timeoutMs = 15000) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) resolve();
      else if (performance.now() - start > timeoutMs) reject(new Error("Timed out waiting"));
      else requestAnimationFrame(check);
    };
    check();
  });
}

describe("image-editor folder list", () => {
  let item, view, ImageEditor;

  async function showList() {
    await view.showFileList();
    return view.fileListView.selectList;
  }

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.activatePackage("image-editor");
    ImageEditor = require("../lib/editor");
    item = await lumine.workspace.open(samplePath, { pending: true });
    view = item.view;
    await pollUntil(() => view.loaded && view.refs.image.complete);
  });

  afterEach(async () => {
    const files = [];
    const host = view.fileListView?.selectListHost;
    for (const paneItem of lumine.workspace.getPaneItems()) {
      if (paneItem instanceof ImageEditor) {
        if (paneItem.file) files.push(paneItem.file);
        paneItem.destroy();
      }
    }
    await host?.destroy();
    await Promise.all(files.map((file) => file.closed));
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
  });

  it("shows folder filenames in navigation order and selects the current image", async () => {
    const list = await showList();

    expect(list.getItems().map((row) => row.name)).toEqual(["other.png", "sample.png"]);
    expect(list.getItems().map((row) => row.filePath)).toEqual([otherPath, samplePath]);
    expect(list.getSelectedItem().filePath).toBe(samplePath);
    expect(list.getElement().querySelector("li").textContent).toBe("other.png");
    expect(list.getElement().querySelector("li").textContent).not.toContain(
      path.dirname(otherPath),
    );
  });

  it("confirms the current filename without discarding or reloading its edits", async () => {
    view.invertColors();
    expect(item.getFileState()).toBe("modified");
    const load = spyOn(view, "loadImageFromNavigation");
    const confirm = spyOn(lumine.window, "confirm");
    const list = await showList();

    await list.confirmSelection();

    expect(load).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(item.getPath()).toBe(samplePath);
    expect(item.getFileState()).toBe("modified");
    expect(view.fileListView.selectListHost.isVisible()).toBe(false);
  });

  it("filters filenames without preview and opens the confirmed file in the source view", async () => {
    const image = view.refs.image;
    const element = item.element;
    const load = spyOn(view, "loadImageFromNavigation").and.callThrough();
    const list = await showList();
    const unrelated = { unrelated: true };
    spyOn(lumine.workspace, "getActivePaneItem").and.returnValue(unrelated);

    list.getQueryEditor().setText("other");
    await lumine.views.getNextUpdatePromise();
    expect(list.getFilteredItems().map((row) => row.filePath)).toEqual([otherPath]);
    expect(list.getElement().querySelectorAll(".character-match").length).toBeGreaterThan(0);
    await list.selectItemById(list.getFilteredItems()[0].id);
    expect(load).not.toHaveBeenCalled();
    expect(item.getPath()).toBe(samplePath);

    await list.confirmSelection();

    expect(load).toHaveBeenCalledTimes(1);
    const [loadedPath, options] = load.calls.mostRecent().args;
    expect(loadedPath).toBe(otherPath);
    expect(typeof options.signal.addEventListener).toBe("function");
    expect(typeof options.signal.aborted).toBe("boolean");
    expect(item.getPath()).toBe(otherPath);
    expect(item.element).toBe(element);
    expect(item.view).toBe(view);
    expect(view.refs.image).toBe(image);
    expect(view.fileListView.selectListHost.isVisible()).toBe(false);
  });

  it("keeps the edited image after Cancel and allows a second navigation attempt", async () => {
    view.invertColors();
    const editedState = view.historyManager.getCurrentState();
    spyOn(lumine.window, "confirm").and.resolveTo(1);
    const list = await showList();
    await list.selectItemById(list.getItems().find((row) => row.filePath === otherPath).id);

    await list.confirmSelection();

    expect(lumine.window.confirm).toHaveBeenCalledTimes(1);
    expect(item.getPath()).toBe(samplePath);
    expect(item.getFileState()).toBe("modified");
    expect(view.historyManager.getCurrentState()).toBe(editedState);
    expect(view.fileListView.selectListHost.isVisible()).toBe(true);

    lumine.window.confirm.and.resolveTo(2);
    await list.confirmSelection();

    expect(lumine.window.confirm).toHaveBeenCalledTimes(2);
    expect(item.getPath()).toBe(otherPath);
    expect(item.view).toBe(view);
    expect(view.fileListView.selectListHost.isVisible()).toBe(false);
  });

  it("keeps its command and shortcut on the image surface and out of the application menu", () => {
    const show = spyOn(view, "showFileList");
    const workspace = lumine.views.getView(lumine.workspace);

    lumine.commands.dispatch(workspace, "image-editor:list");
    expect(show).not.toHaveBeenCalled();
    lumine.commands.dispatch(item.element, "image-editor:list");
    expect(show).toHaveBeenCalledTimes(1);

    const root = path.join(__dirname, "..");
    const keymap = JSON.parse(fs.readFileSync(path.join(root, "keymaps", "main.json"), "utf8"));
    expect(keymap[".image-editor"].g).toBe("image-editor:list");
    expect(keymap[".image-editor"]["shift-g"]).toBe("image-editor:grayscale");
    const menu = JSON.parse(fs.readFileSync(path.join(root, "menus", "main.json"), "utf8"));
    expect(JSON.stringify(menu.menu || [])).not.toContain("image-editor:list");
  });

  it("destroys the folder picker with its image view", async () => {
    await showList();
    const host = view.fileListView.selectListHost;
    const file = item.file;

    item.destroy();
    await file.closed;

    expect(host.isDestroyed()).toBe(true);
    expect(view.fileListView.rows).toEqual([]);
  });

  it("explains why an image without a disk path cannot browse a folder", () => {
    spyOn(item, "getPath").and.returnValue(null);
    spyOn(lumine.notifications, "addWarning");

    view.showFileList();

    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "Save this image before browsing its folder.",
    );
    expect(view.fileListView).toBeUndefined();
  });
});

describe("image-editor folder list lifecycle", () => {
  let picker, view, pathListeners;

  const listing = {
    directory: path.dirname(samplePath),
    files: [otherPath, samplePath],
    currentIndex: 1,
  };

  beforeEach(() => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    pathListeners = new Set();
    let currentPath = samplePath;
    view = {
      _destroyed: false,
      documentGeneration: 1,
      loadingAbortController: {},
      navigator: { invalidateCache: jasmine.createSpy("invalidateCache") },
      editor: {
        file: {},
        destroyed: false,
        getPath: () => currentPath,
        onDidChangePath(callback) {
          pathListeners.add(callback);
          return new Disposable(() => pathListeners.delete(callback));
        },
        changePath(nextPath) {
          currentPath = nextPath;
          this.file = {};
          for (const callback of pathListeners) callback(nextPath);
        },
      },
      getFileList: jasmine.createSpy("getFileList").and.resolveTo(listing),
      loadImageFromNavigation: jasmine.createSpy("loadImageFromNavigation").and.resolveTo(true),
    };
    picker = new (require("../lib/file-list"))(view);
  });

  afterEach(async () => {
    const host = picker.selectListHost;
    picker.destroy();
    await host.destroy();
  });

  it("rereads on opening and does not publish a cancelled older folder result", async () => {
    const reads = [];
    view.getFileList.and.callFake(() => new Promise((resolve) => reads.push(resolve)));
    const firstOpening = picker.show();
    picker.selectListHost.cancel();
    const secondOpening = picker.show();
    const newestFile = path.join(path.dirname(samplePath), "newest.png");
    reads[1]({ ...listing, files: [newestFile] });
    await secondOpening;
    reads[0](listing);
    await firstOpening;

    expect(view.navigator.invalidateCache).toHaveBeenCalledTimes(2);
    expect(picker.selectList.getItems().map((row) => row.filePath)).toEqual([newestFile]);
    expect(picker.rows.map((row) => row.filePath)).toEqual([newestFile]);
    expect(view.loadImageFromNavigation).not.toHaveBeenCalled();
  });

  it("keeps distinct filenames that differ only in case", async () => {
    const upperPath = path.join(path.dirname(samplePath), "Sample.png");
    view.getFileList.and.resolveTo({ ...listing, files: [upperPath, samplePath], currentIndex: 1 });

    await picker.show();

    const rows = picker.selectList.getItems();
    expect(rows.map((row) => row.name)).toEqual(["Sample.png", "sample.png"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(picker.selectList.getSelectedItem().filePath).toBe(samplePath);
    if (process.platform !== "win32") {
      await picker.selectList.selectItemById(rows[0].id);
      await picker.selectList.confirmSelection();
      expect(view.loadImageFromNavigation.calls.mostRecent().args[0]).toBe(upperPath);
    }
  });

  for (const changed of ["path", "load", "document"]) {
    it(`rejects a late folder result after the source ${changed} changes`, async () => {
      let finish;
      view.getFileList.and.returnValue(new Promise((resolve) => (finish = resolve)));
      const opening = picker.show();
      if (changed === "path") view.editor.changePath(otherPath);
      else if (changed === "load") view.loadingAbortController = {};
      else view.documentGeneration++;
      finish(listing);
      await opening;

      expect(picker.rows).toEqual([]);
      expect(picker.selectList.getItems()).toEqual([]);
      expect(picker.selectListHost.isVisible()).toBe(false);
      expect(view.loadImageFromNavigation).not.toHaveBeenCalled();
    });
  }

  it("aborts an outstanding navigation when the picker is cancelled", async () => {
    await picker.show();
    let finish;
    view.loadImageFromNavigation.and.callFake(() => new Promise((resolve) => (finish = resolve)));
    await picker.selectList.selectItemById(
      picker.rows.find((row) => row.filePath === otherPath).id,
    );
    const confirmation = picker.selectList.confirmSelection();
    await pollUntil(() => view.loadImageFromNavigation.calls.count() === 1);
    const signal = view.loadImageFromNavigation.calls.mostRecent().args[1].signal;

    picker.selectListHost.cancel();

    expect(signal.aborted).toBe(true);
    finish(false);
    await confirmation;
    expect(picker.selectListHost.isVisible()).toBe(false);
  });

  it("allows retry after a failed load changes the view's loading generation", async () => {
    await picker.show();
    let attempts = 0;
    view.loadImageFromNavigation.and.callFake(async () => {
      view.loadingAbortController = {};
      return ++attempts > 1;
    });
    await picker.selectList.selectItemById(
      picker.rows.find((row) => row.filePath === otherPath).id,
    );

    await picker.selectList.confirmSelection();

    expect(picker.selectListHost.isVisible()).toBe(true);
    expect(attempts).toBe(1);
    await picker.selectList.confirmSelection();
    expect(attempts).toBe(2);
    expect(picker.selectListHost.isVisible()).toBe(false);
  });

  it("drops a late read and its path observer after destruction", async () => {
    let finish;
    view.getFileList.and.returnValue(new Promise((resolve) => (finish = resolve)));
    const opening = picker.show();
    expect(pathListeners.size).toBe(1);

    picker.destroy();
    finish(listing);
    await opening;

    expect(pathListeners.size).toBe(0);
    expect(picker.selectListHost.isDestroyed()).toBe(true);
    expect(picker.rows).toEqual([]);
    expect(view.loadImageFromNavigation).not.toHaveBeenCalled();
  });

  it("shows an empty folder result and cancels without navigation", async () => {
    view.getFileList.and.resolveTo({ ...listing, files: [], currentIndex: -1 });
    await picker.show();
    await pollUntil(() => picker.selectList.getElement().textContent.includes("No images found"));
    expect(picker.selectList.getElement().textContent).toContain("No images found");

    await picker.selectList.confirmSelection();

    expect(picker.selectListHost.isVisible()).toBe(false);
    expect(view.loadImageFromNavigation).not.toHaveBeenCalled();
  });
});
