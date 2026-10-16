const fs = require("fs");
const os = require("os");
const path = require("path");
const { CompositeDisposable } = require("lumine");

describe("image-editor shared file opening actions", () => {
  let directory, sourcePath, targetPath, item, picker, pane, leases, external;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "image-file-actions-")),
    );
    sourcePath = path.join(directory, "source.png");
    targetPath = path.join(directory, "target.svg");
    fs.copyFileSync(path.join(__dirname, "fixtures", "sample.png"), sourcePath);
    fs.writeFileSync(targetPath, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    await lumine.packages.activatePackage("tree-view");
    await lumine.packages.activatePackage("image-editor");
    external = (await lumine.packages.activatePackage("open-external")).mainModule;
    item = await lumine.workspace.open(sourcePath);
    pane = lumine.workspace.paneForItem(item);
    const started = Date.now();
    while (!item.view.loaded || !item.view.refs.image.complete) {
      if (Date.now() - started > 3000) throw new Error("Source image did not finish loading");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    leases = new CompositeDisposable();
    await item.view.showFileList();
    picker = item.view.fileListView;
    await picker.selectList.selectItem(picker.rows.find((row) => row.filePath === targetPath));
  });

  afterEach(async () => {
    leases.dispose();
    await picker.selectListHost.destroy();
    for (const candidate of [...lumine.workspace.getPaneItems()]) {
      if ([sourcePath, targetPath].includes(candidate.getPath?.())) {
        const file = candidate.file;
        await lumine.workspace.paneForItem(candidate).destroyItem(candidate, true);
        await file?.closed;
      }
    }
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), directory);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("Image opening scratch directory escaped the temporary root");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function click(modifiers) {
    const done = new Promise((resolve) => {
      const lease = picker.selectList.onDidFinishAction((result) => {
        lease.dispose();
        resolve(result);
      });
    });
    picker.selectList
      .getElement()
      .querySelector('[role="option"].selected')
      .dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          ...modifiers,
        }),
      );
    return done;
  }

  for (const pending of [true, false]) {
    it(`opens the actual default SVG text editor with pending ${pending}`, async () => {
      lumine.config.set("core.allowPendingPaneItems", pending);
      expect((await picker.selectList.confirmSelection()).status).toBe("success");
      const opened = pane.getActiveItem();
      expect(lumine.workspace.isTextEditor(opened)).toBe(true);
      expect(opened.getPath()).toBe(targetPath);
      expect(pane.getPendingItem()).toBe(pending ? opened : null);
      expect(item.getPath()).toBe(sourcePath);
    });
  }

  for (const modifiers of [{ shiftKey: true }, { ctrlKey: true, shiftKey: true }]) {
    it(`selects without opening for ${modifiers.ctrlKey ? "Ctrl+Shift" : "Shift"}-click`, async () => {
      const list = picker.selectList;
      const selected = list.getItems()[0];
      await list.selectNone();
      const open = spyOn(lumine.workspace, "open").and.callThrough();
      const action = spyOn(list, "runAction").and.callThrough();
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...modifiers,
      });
      list.getElement().querySelector('[role="option"]').dispatchEvent(event);
      await Promise.resolve();

      expect(event.defaultPrevented).toBe(true);
      expect(list.getSelectedItem()).toBe(selected);
      expect(action).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(picker.selectListHost.isVisible()).toBe(true);
    });
  }

  it("passes the selected filename and source pane to the chooser", async () => {
    await lumine.packages.deactivatePackage("launcher");
    const choose = jasmine.createSpy("choose image opener");
    leases.add(
      lumine.commands.add("lumine-workspace", {
        "launcher:open": (event) => {
          event.stopPropagation();
          choose(event.detail);
        },
      }),
    );
    expect((await click({ altKey: true })).status).toBe("success");
    expect(choose).toHaveBeenCalledOnceWith({ path: targetPath, pane });
  });

  it("uses registered external and reveal handlers for the selected filename", async () => {
    const open = spyOn(external, "openExternal").and.resolveTo("");
    const show = spyOn(external, "showInFolder").and.resolveTo("");
    expect((await click({ ctrlKey: true, altKey: true })).status).toBe("success");
    await item.view.showFileList();
    await picker.selectList.selectItem(picker.rows.find((row) => row.filePath === targetPath));
    expect((await click({ altKey: true, shiftKey: true })).status).toBe("success");
    expect(open).toHaveBeenCalledOnceWith(targetPath);
    expect(show).toHaveBeenCalledOnceWith(targetPath);
  });

  it("finishes a committed opening before retiring the replaced pending source's picker", async () => {
    pane.setPendingItem(item);
    lumine.config.set("core.allowPendingPaneItems", true);
    expect((await picker.selectList.confirmSelection()).status).toBe("success");
    expect(pane.getActiveItem().getPath()).toBe(targetPath);
    expect(lumine.workspace.isTextEditor(pane.getActiveItem())).toBe(true);
    expect(picker.selectListHost.isDestroyed()).toBe(true);
  });

  it("resolves chooser, external and reveal keys without a separate pending binding", () => {
    const target = picker.selectList.getQueryEditor().getElement();
    for (const [keystrokes, command] of [
      ["alt-enter", "image-editor:open-selected-with"],
      ["ctrl-alt-enter", "image-editor:open-selected-external"],
      ["alt-shift-enter", "image-editor:show-selected-in-folder"],
    ])
      expect(lumine.keymaps.findKeyBindings({ target, keystrokes })[0]?.command).toBe(command);
    for (const keystrokes of ["shift-enter", "ctrl-shift-enter"])
      expect(
        lumine.keymaps
          .findKeyBindings({ target, keystrokes })
          .some((binding) => binding.command.startsWith("image-editor:")),
      ).toBe(false);
  });
});
