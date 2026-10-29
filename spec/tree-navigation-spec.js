const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Disposable } = require("lumine");

describe("image-editor tree directory navigation", () => {
  let main, directory, temporary, image, view, leases, providers;
  let original, copy, last, hidden, text;

  beforeEach(async () => {
    jasmine.useRealClock();
    leases = [];
    providers = [];
    temporary = fs.realpathSync.native(os.tmpdir());
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(temporary, "image-tree-navigation-")),
    );
    original = path.join(directory, "IMG_3939.png");
    copy = path.join(directory, "IMG_3939 - Copy.png");
    last = path.join(directory, "IMG_3940.png");
    hidden = path.join(directory, "hidden.png");
    text = path.join(directory, "notes.txt");
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.deactivatePackage("tree-view");
    const pack = await lumine.packages.activatePackage("image-editor");
    main = pack.mainModule;
    for (const file of [original, copy, last, hidden])
      fs.copyFileSync(path.join(pack.path, "spec/fixtures/sample.png"), file);
    fs.writeFileSync(text, "Not an image.");
    image = await lumine.workspace.open(original);
    view = image.view;
    await conditionPromise(() => view.loaded && view.refs.image.complete);
  });

  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    const files = [];
    const picker = view?.fileListView?.selectListHost;
    for (const item of lumine.workspace.getPaneItems()) {
      if (item.file) files.push(item.file);
      item.destroy?.();
    }
    await picker?.destroy();
    await Promise.all(files.map((file) => file.closed));
    if (lumine.packages.isPackageLoaded("image-editor"))
      await lumine.packages.unloadPackage("image-editor");
    for (const provider of providers) {
      expect(provider.listeners.size).toBe(0);
      expect(provider.watchers.size).toBe(0);
    }
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(fs.realpathSync.native(directory)) !== temporary ||
      !path.basename(directory).startsWith("image-tree-navigation-")
    )
      throw Error("Unsafe image tree navigation cleanup");
    await fs.promises.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  function provider(files) {
    const service = {
      files,
      listeners: new Set(),
      watchers: new Set(),
      retiredListeners: 0,
      retiredWatches: 0,
      listFiles: jasmine.createSpy("listFiles").and.callFake(async () => service.files.slice()),
      watchDirectory: jasmine.createSpy("watchDirectory").and.callFake((directory, callback) => {
        const watcher = { directory, callback };
        service.watchers.add(watcher);
        return Object.assign(
          new Disposable(() => {
            service.watchers.delete(watcher);
            service.retiredWatches++;
          }),
          { ready: service.ready ?? Promise.resolve() },
        );
      }),
      onDidChange(callback) {
        service.listeners.add(callback);
        return new Disposable(() => {
          service.listeners.delete(callback);
          service.retiredListeners++;
        });
      },
      change(files) {
        service.files = files;
        for (const callback of service.listeners) callback();
      },
    };
    providers.push(service);
    return service;
  }

  function provide(service) {
    const lease = lumine.packages.serviceHub.provide("tree-view.directory", "1.0.0", service);
    leases.push(lease);
    return lease;
  }

  async function navigate(command, expected) {
    view.lastNavigationTime = 0;
    lumine.commands.dispatch(image.element, command);
    await conditionPromise(
      () => image.getPath() === expected && view.loaded && view.refs.image.complete,
    );
  }

  it("uses the provider's visible image order for arrows and first/last commands", async () => {
    const service = provider([last, text, original, copy]);
    provide(service);

    expect(await view.getFileList()).toEqual({
      directory,
      files: [last, original, copy],
      currentIndex: 1,
    });
    expect(service.listFiles).toHaveBeenCalledWith(directory);
    expect(service.watchDirectory.calls.mostRecent().args[0]).toBe(directory);
    expect(typeof service.watchDirectory.calls.mostRecent().args[1]).toBe("function");

    await navigate("image-editor:next-image", copy);
    await navigate("image-editor:previous-image", original);
    await navigate("image-editor:first-image", last);
    await navigate("image-editor:last-image", copy);

    expect(service.listFiles).toHaveBeenCalledTimes(1);
    expect((await view.getFileList()).files).not.toContain(hidden);
  });

  it("shows the same sequence in the picker, navigation headers and toolbar position", async () => {
    provide(provider([last, original, text, copy]));

    await view.showFileList();
    const list = view.fileListView.selectList;
    expect(list.getItems().map((row) => row.filePath)).toEqual([last, original, copy]);
    expect(list.getSelectedItem().filePath).toBe(original);
    view.fileListView.selectListHost.cancel("test");

    let headers;
    leases.push(
      main.provideNavigationAdapter().observeHeaders(image, (value) => (headers = value)),
    );
    await conditionPromise(() => headers != null);
    expect(headers.map((header) => header.filePath)).toEqual([last, original, copy]);
    expect(headers.map((header) => header.currentCount)).toEqual([0, 1, 0]);

    await view.refreshImagePosition();
    expect(view.refs.imagePositionInput.value).toBe("2");
    expect(view.refs.imagePositionCount.textContent).toBe("/ 3");
  });

  it("invalidates an existing view when the provider changes order or visibility", async () => {
    const service = provider([original, copy, last]);
    provide(service);
    expect((await view.getFileList()).files).toEqual([original, copy, last]);

    service.change([last, original]);

    expect((await view.getFileList()).files).toEqual([last, original]);
    expect(await view.navigator.getPositionInfo(original)).toBe("2 / 2");
    await navigate("image-editor:previous-image", last);
    expect(service.listFiles).toHaveBeenCalledTimes(2);
  });

  it("keeps the toolbar counter in sync with the shared ordered listing and disables unavailable positions", async () => {
    const service = provider([last, text, original, copy]);
    const edge = provide(service);
    const input = view.refs.imagePositionInput;
    const count = view.refs.imagePositionCount;
    await conditionPromise(
      () => !input.disabled && input.value === "2" && count.textContent === "/ 3",
    );
    await view.getFileList();
    expect(service.listFiles).toHaveBeenCalledTimes(1);
    await navigate("image-editor:next-image", copy);
    await conditionPromise(() => input.value === "3");
    service.change([copy, original]);
    await conditionPromise(() => input.value === "1" && count.textContent === "/ 2");
    service.change([original]);
    await conditionPromise(() => input.disabled);
    expect(input.value).toBe("");
    expect(count.textContent).toBe("/ –");
    edge.dispose();
    expect(input.disabled).toBe(true);
  });

  it("places an editable image number immediately before zoom and navigates with Enter or cancels with Escape", async () => {
    provide(provider([last, original, copy]));
    const input = view.refs.imagePositionInput;
    const field = view.refs.imagePosition;
    await conditionPromise(() => !input.disabled);
    expect(field.nextElementSibling).toBe(view.refs.zoomToFitButton);
    expect(field.previousElementSibling).toBe(view.refs.zoomOutButton);
    input.focus();
    const resetZoom = spyOn(view, "resetZoom");
    const keyEvent = lumine.keymaps.constructor.buildKeydownEvent("7", { target: input });
    lumine.keymaps.handleKeyboardEvent(keyEvent);
    expect(keyEvent.defaultPrevented).toBe(false);
    expect(resetZoom).not.toHaveBeenCalled();
    input.value = "3";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    await conditionPromise(() => image.getPath() === copy && view.loaded && input.value === "3");
    await view.imagePositionCommit;
    expect(document.activeElement).toBe(view.element);
    input.focus();
    input.value = "1";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
    );
    expect(input.value).toBe("3");
    expect(image.getPath()).toBe(copy);
    expect(document.activeElement).toBe(view.element);
    input.focus();
    input.value = "999";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await view.imagePositionCommit;
    expect(input.value).toBe("3");
    expect(image.getPath()).toBe(copy);
  });

  it("keeps first/last bounded and updates previous/next cycling from the cached listing", async () => {
    const buttons = [
      view.refs.firstImageButton,
      view.refs.prevImageButton,
      view.refs.nextImageButton,
      view.refs.lastImageButton,
    ];
    const disabled = () => buttons.map((button) => button.disabled);
    const cycle = lumine.config.get("image-editor.scrollCycle");
    lumine.config.set("image-editor.scrollCycle", false);
    try {
      expect(disabled()).toEqual([true, true, true, true]);
      const service = provider([last, original, copy]);
      const edge = provide(service);
      await conditionPromise(() => view.refs.imagePositionInput.value === "2");
      expect(disabled()).toEqual([false, false, false, false]);

      await navigate("image-editor:last-image", copy);
      await conditionPromise(() => view.refs.imagePositionInput.value === "3");
      expect(disabled()).toEqual([false, false, true, true]);
      expect(getComputedStyle(buttons[2]).cursor).toBe("default");
      const nextImage = spyOn(view, "nextImage").and.callThrough();
      const lastImage = spyOn(view, "lastImage").and.callThrough();
      buttons[2].click();
      buttons[3].click();
      expect(nextImage).not.toHaveBeenCalled();
      expect(lastImage).not.toHaveBeenCalled();

      const scans = service.listFiles.calls.count();
      lumine.config.set("image-editor.scrollCycle", true);
      expect(disabled()).toEqual([false, false, false, true]);
      expect(service.listFiles.calls.count()).toBe(scans);
      view.lastNavigationTime = 0;
      buttons[2].click();
      await conditionPromise(
        () => image.getPath() === last && view.loaded && view.refs.imagePositionInput.value === "1",
      );
      expect(nextImage).toHaveBeenCalledTimes(1);
      expect(disabled()).toEqual([true, false, false, false]);
      expect(getComputedStyle(buttons[0]).cursor).toBe("default");
      const firstImage = spyOn(view, "firstImage").and.callThrough();
      const previousImage = spyOn(view, "previousImage").and.callThrough();
      buttons[0].click();
      expect(firstImage).not.toHaveBeenCalled();

      lumine.config.set("image-editor.scrollCycle", false);
      expect(disabled()).toEqual([true, true, false, false]);
      buttons[1].click();
      expect(previousImage).not.toHaveBeenCalled();
      expect(service.listFiles.calls.count()).toBe(scans);
      lumine.config.set("image-editor.scrollCycle", true);
      expect(disabled()).toEqual([true, false, false, false]);
      view.lastNavigationTime = 0;
      buttons[1].click();
      await conditionPromise(
        () => image.getPath() === copy && view.loaded && view.refs.imagePositionInput.value === "3",
      );
      expect(previousImage).toHaveBeenCalledTimes(1);

      service.change([copy]);
      await conditionPromise(() => view.refs.imagePositionCount.textContent === "/ 1");
      expect(disabled()).toEqual([true, true, true, true]);
      lumine.config.set("image-editor.scrollCycle", false);
      expect(disabled()).toEqual([true, true, true, true]);
      service.change([original]);
      await conditionPromise(() => view.refs.imagePositionInput.disabled);
      expect(disabled()).toEqual([true, true, true, true]);
      lumine.config.set("image-editor.scrollCycle", true);
      expect(disabled()).toEqual([true, true, true, true]);
      edge.dispose();
      expect(disabled()).toEqual([true, true, true, true]);
    } finally {
      lumine.config.set("image-editor.scrollCycle", cycle);
    }
  });

  it("navigates images with the wheel over the counter input and total, respecting boundaries and cycling", async () => {
    provide(provider([last, original, copy]));
    const input = view.refs.imagePositionInput;
    const count = view.refs.imagePositionCount;
    const cycle = lumine.config.get("image-editor.scrollCycle");
    const scrollMode = lumine.config.get("image-editor.switchZoomAndNavigation");
    const next = spyOn(view, "nextImage").and.callThrough();
    const previous = spyOn(view, "previousImage").and.callThrough();
    const zoom = spyOn(view, "zoomToCenterPoint");
    const bubble = jasmine.createSpy("counter wheel bubble");
    view.element.addEventListener("wheel", bubble);
    await conditionPromise(() => input.value === "2");
    async function step(target, deltaY, expected, options = {}) {
      view.lastNavigationTime = 0;
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY,
        ...options,
      });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await (deltaY > 0 ? next : previous).calls.mostRecent().returnValue;
      await conditionPromise(
        () =>
          image.getPath() === expected &&
          view.loaded &&
          input.value === String([last, original, copy].indexOf(expected) + 1),
      );
    }
    try {
      lumine.config.set("image-editor.scrollCycle", false);
      lumine.config.set("image-editor.switchZoomAndNavigation", true);
      view.element.focus();
      await step(input, -0.25, last);
      expect(document.activeElement).toBe(view.element);
      input.focus();
      input.value = "99";
      await step(input, -1, last);
      expect(input.value).toBe("1");
      expect(document.activeElement).toBe(input);
      view.element.focus();
      await step(count, 80, original, { ctrlKey: true });
      lumine.config.set("image-editor.switchZoomAndNavigation", false);
      await step(input, 1, copy, { altKey: true });
      await step(count, 1, copy);
      lumine.config.set("image-editor.scrollCycle", true);
      await step(count, 1, last);
      await step(input, -1, copy, { metaKey: true });
      expect(document.activeElement).toBe(view.element);
      expect(zoom).not.toHaveBeenCalled();
      expect(bubble).not.toHaveBeenCalled();
    } finally {
      lumine.config.set("image-editor.scrollCycle", cycle);
      lumine.config.set("image-editor.switchZoomAndNavigation", scrollMode);
      view.element.removeEventListener("wheel", bubble);
    }
  });

  it("refreshes visible navigation headers when the directory policy changes", async () => {
    const service = provider([last, original, copy]);
    provide(service);
    const updates = [];
    const headers = main
      .provideNavigationAdapter()
      .observeHeaders(image, (value) => updates.push(value));
    leases.push(headers);
    await conditionPromise(() => updates.length === 1);
    expect(updates[0].map((header) => header.filePath)).toEqual([last, original, copy]);

    service.change([copy, original]);

    await conditionPromise(() => updates.length === 2);
    expect(updates[1].map((header) => header.filePath)).toEqual([copy, original]);
    expect(updates[1].map((header) => header.currentCount)).toEqual([0, 1]);
    headers.dispose();
    service.change([last, original]);
    await Promise.resolve();
    expect(updates.length).toBe(2);
  });

  it("refreshes cached siblings through its directory watch outside project roots", async () => {
    spyOn(lumine.project, "getPaths").and.returnValue([]);
    const service = provider([original, copy]);
    provide(service);
    expect((await view.getFileList()).files).toEqual([original, copy]);
    expect(service.watchers.size).toBe(1);

    service.files = [original, copy, last];
    for (const watcher of [...service.watchers]) watcher.callback();

    expect((await view.getFileList()).files).toEqual([original, copy, last]);
    expect(service.listFiles).toHaveBeenCalledTimes(2);
    expect(service.watchers.size).toBe(1);
  });

  it("keeps listing through the service when directory watching is unavailable", async () => {
    spyOn(console, "error");
    const service = provider([original, copy]);
    service.ready = Promise.reject(new Error("Directory watch unavailable"));
    provide(service);

    expect((await view.getFileList()).files).toEqual([original, copy]);
    service.files = [original, last];
    expect((await view.getFileList()).files).toEqual([original, last]);
    expect(service.listFiles).toHaveBeenCalledTimes(2);
  });

  it("waits for the shared directory service instead of scanning independently", async () => {
    const readdir = spyOn(fs.promises, "readdir").and.callThrough();
    expect((await view.getFileList()).files).toEqual([]);
    expect(readdir).not.toHaveBeenCalled();
    const service = provider([original, last]);
    const lease = provide(service);

    expect((await view.getFileList()).files).toEqual([original, last]);

    lease.dispose();

    expect((await view.getFileList()).files).toEqual([]);
    expect(readdir).not.toHaveBeenCalled();
    expect(service.listeners.size).toBe(0);
    expect(service.retiredListeners).toBe(1);
    expect(service.watchers.size).toBe(0);
    expect(service.retiredWatches).toBe(1);
  });

  it("preserves the newest provider when an older overlapping edge retires", async () => {
    const first = provider([original, copy]);
    const second = provider([last, original]);
    const firstLease = provide(first);
    const secondLease = provide(second);
    expect((await view.getFileList()).files).toEqual([last, original]);

    firstLease.dispose();

    expect((await view.getFileList()).files).toEqual([last, original]);
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    secondLease.dispose();
    expect((await view.getFileList()).files).toEqual([]);
    expect(first.retiredListeners).toBe(1);
    expect(second.retiredListeners).toBe(1);
  });

  it("restores the older provider after the newest overlapping edge retires", async () => {
    const first = provider([original, copy]);
    const second = provider([last, original]);
    provide(first);
    const secondLease = provide(second);
    expect((await view.getFileList()).files).toEqual([last, original]);

    secondLease.dispose();

    expect((await view.getFileList()).files).toEqual([original, copy]);
    expect(first.listeners.size).toBe(1);
    expect(second.listeners.size).toBe(0);
  });

  it("retires each subscription exactly once for repeated edges to one service", async () => {
    const service = provider([original, last]);
    const first = provide(service);
    const second = provide(service);
    expect(service.listeners.size).toBe(2);
    first.dispose();

    expect((await view.getFileList()).files).toEqual([original, last]);
    expect(service.listeners.size).toBe(1);
    expect(service.retiredListeners).toBe(1);

    second.dispose();
    first.dispose();
    second.dispose();
    expect((await view.getFileList()).files).toEqual([]);
    expect(service.listeners.size).toBe(0);
    expect(service.retiredListeners).toBe(2);
  });

  it("ignores a retired provider's pending result and uses its replacement", async () => {
    let release;
    const retired = provider([original, copy]);
    retired.listFiles.and.returnValue(new Promise((resolve) => (release = resolve)));
    const edge = provide(retired);
    const listing = view.getFileList();
    await conditionPromise(() => retired.listFiles.calls.count() === 1);
    edge.dispose();
    const replacement = provider([last, original]);
    provide(replacement);
    release([original, copy]);

    expect((await listing).files).toEqual([last, original]);
    expect((await view.getFileList()).files).toEqual([last, original]);
    expect(retired.listeners.size).toBe(0);
  });

  it("releases and reacquires service subscriptions across package generations", async () => {
    const service = provider([last, original]);
    provide(service);
    expect((await view.getFileList()).files).toEqual([last, original]);

    await lumine.packages.unloadPackage("image-editor");

    expect(service.listeners.size).toBe(0);
    expect(service.retiredListeners).toBe(1);
    expect(service.watchers.size).toBe(0);
    const pack = await lumine.packages.activatePackage("image-editor");
    main = pack.mainModule;
    image = await lumine.workspace.open(original);
    view = image.view;
    await conditionPromise(() => view.loaded && view.refs.image.complete);
    expect(service.listeners.size).toBe(1);
    expect((await view.getFileList()).files).toEqual([last, original]);
    expect(service.watchers.size).toBe(1);
    service.change([original, copy]);
    expect((await view.getFileList()).files).toEqual([original, copy]);
  });
});
