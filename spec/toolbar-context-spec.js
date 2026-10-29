const path = require("node:path");

describe("image toolbar context events", () => {
  let item;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const pack = await lumine.packages.activatePackage("image-editor");
    item = await lumine.workspace.open(path.join(pack.path, "spec", "fixtures", "sample.png"));
    item.view.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await conditionPromise(() => item.view.loaded && item.view.refs.image.complete);
  });

  afterEach(async () => {
    item?.destroy();
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
    item = null;
  });

  function rightClick(target) {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    target.dispatchEvent(event);
    return event;
  }

  async function imageReady(width, height) {
    const image = item.view.refs.image;
    await conditionPromise(
      () =>
        image.complete &&
        !image.onload &&
        image.naturalWidth === width &&
        image.naturalHeight === height,
    );
  }

  async function expectWidthFit() {
    const view = item.view;
    await conditionPromise(() => view.renderedTransform?.zoom === view.zoom);
    expect(view.zoomMode).toBe("fit-width");
    expect(view.auto).toBe(true);
    expect(view.refs.zoomToFitButton.dataset.zoomMode).toBe("fit-width");
    expect(view.refs.image.getBoundingClientRect().width).toBeCloseTo(
      view.refs.imageContainer.offsetWidth,
      2,
    );
  }

  it("shows the image over the native theme background and follows theme changes", () => {
    const view = item.view;
    const container = view.refs.imageContainer;
    view.element.style.setProperty("--app-background-color", "rgb(17, 34, 51)");
    expect(container.hasAttribute("background")).toBe(false);
    expect(getComputedStyle(container).backgroundColor).toBe("rgb(17, 34, 51)");
    expect(getComputedStyle(container).backgroundImage).toBe("none");
    view.element.style.setProperty("--app-background-color", "rgb(221, 238, 255)");
    expect(getComputedStyle(container).backgroundColor).toBe("rgb(221, 238, 255)");
  });

  it("stops toolbar context events before the image menu without invoking button actions", () => {
    const view = item.view;
    const imageMenu = jasmine.createSpy("image menu bubble");
    view.element.addEventListener("contextmenu", imageMenu);
    const actions = [
      "firstImage",
      "previousImage",
      "undo",
      "zoomOut",
      "zoomToFit",
      "zoomIn",
      "redo",
      "nextImage",
      "lastImage",
    ].map((name) => spyOn(view, name));
    const zoom = view.zoom;
    const filePath = item.getPath();
    try {
      for (const button of view.refs.imageControls.querySelectorAll(".btn-group > .btn")) {
        expect(rightClick(button).defaultPrevented).toBe(true);
      }
      expect(rightClick(view.refs.imageControls.querySelector(".btn-group")).defaultPrevented).toBe(
        true,
      );
      expect(imageMenu).not.toHaveBeenCalled();
      for (const action of actions) expect(action).not.toHaveBeenCalled();
      expect(view.zoom).toBe(zoom);
      expect(item.getPath()).toBe(filePath);

      view.refs.zoomInButton.click();
      expect(view.zoomIn).toHaveBeenCalledTimes(1);
    } finally {
      view.element.removeEventListener("contextmenu", imageMenu);
    }
  });

  it("keeps ordinary image content context events available to the image menu", () => {
    const view = item.view;
    const imageMenu = jasmine.createSpy("image menu bubble").and.callFake((event) => {
      expect(event.defaultPrevented).toBe(false);
      event.stopPropagation();
    });
    view.element.addEventListener("contextmenu", imageMenu);
    try {
      expect(rightClick(view.refs.imageContainer).defaultPrevented).toBe(false);
      expect(imageMenu).toHaveBeenCalledTimes(1);
      const commands = lumine.contextMenu
        .templateForElement(view.refs.imageContainer)
        .map((row) => row.command);
      expect(commands).toContain("image-editor:copy-selection");
      expect(commands).toContain("pane:close");
    } finally {
      view.element.removeEventListener("contextmenu", imageMenu);
    }
  });

  it("returns pointer focus to the image while retaining keyboard button focus", () => {
    const view = item.view;
    const button = view.refs.zoomInButton;
    view.element.focus();
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(document.activeElement).toBe(view.element);
    button.focus();
    button.click();
    expect(document.activeElement).toBe(button);
  });

  it("opens zoom presets through the shared menu and dispatches the selected scale", async () => {
    const view = item.view;
    view.resetZoom();
    const showPopup = spyOn(lumine.menu, "showPopup").and.callThrough();
    rightClick(view.refs.zoomToFitButton);
    const menu = view.zoomMenu;
    expect(menu).not.toBeNull();
    expect(view.refs.zoomToFitButton.getAttribute("aria-expanded")).toBe("true");
    const rows = [...menu.element.querySelectorAll('[role="menuitemradio"]')];
    const labels = rows.map((row) => row.querySelector(".menu-item-name").textContent.trim());
    expect(labels).toEqual([
      "Automatic Zoom",
      "Fit to View",
      "Fit Width",
      "50%",
      "75%",
      "100%",
      "125%",
      "150%",
      "200%",
      "300%",
      "400%",
    ]);
    const hundred = rows[labels.indexOf("100%")];
    expect(hundred.getAttribute("aria-checked")).toBe("true");
    expect(hundred.querySelector(".menu-item-keystroke").textContent).toBe("0");
    const hundredPreset = showPopup.calls
      .mostRecent()
      .args[0].template.find((row) => row.label === "100%");
    expect(hundredPreset.command).toBe("image-editor:zoom-100");
    expect(hundredPreset.commandDetail).toBeUndefined();
    rows[labels.indexOf("150%")].click();
    await conditionPromise(() => menu.closed);
    expect(view.zoom).toBe(1.5);
    expect(view.auto).toBe(false);
    expect(view.zoomMenu).toBeNull();
    expect(view.refs.zoomToFitButton.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(view.element);

    rightClick(view.refs.zoomToFitButton);
    const hundredMenu = view.zoomMenu;
    const resetZoom = spyOn(view, "resetZoom").and.callThrough();
    [...hundredMenu.element.querySelectorAll('[role="menuitemradio"]')]
      .find((row) => row.querySelector(".menu-item-name").textContent.trim() === "100%")
      .click();
    await conditionPromise(() => hundredMenu.closed);
    expect(resetZoom).toHaveBeenCalledTimes(1);
    expect(view.zoom).toBe(1);
    expect(view.auto).toBe(false);

    view.refs.zoomToFitButton.focus();
    view.refs.zoomToFitButton.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F10", shiftKey: true }),
    );
    expect(view.zoomMenu).not.toBeNull();
    view.zoomMenu.close({ cancelled: true });
    expect(document.activeElement).toBe(view.refs.zoomToFitButton);
  });

  it("distinguishes capped auto zoom, whole-image fit, width fit and 100%", () => {
    const view = item.view;
    const container = view.refs.imageContainer;
    const image = view.refs.image;
    Object.defineProperties(container, {
      offsetWidth: { configurable: true, value: 400 },
      offsetHeight: { configurable: true, value: 300 },
    });
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 100 },
      naturalHeight: { configurable: true, value: 200 },
    });
    const previous = lumine.config.get("image-editor.autoZoomLimit");
    lumine.config.set("image-editor.autoZoomLimit", true);
    try {
      for (const [mode, expected] of [
        ["auto", 1],
        ["fit-image", 1.5],
        ["fit-width", 4],
      ]) {
        lumine.commands.dispatch(view.element, "image-editor:set-zoom", { mode });
        expect(view.zoom).toBe(expected);
        expect(view.auto).toBe(true);
      }
      lumine.commands.dispatch(view.element, "image-editor:zoom-100");
      expect(view.zoom).toBe(1);
      expect(view.auto).toBe(false);
      lumine.commands.dispatch(view.element, "image-editor:set-zoom", { scale: -1 });
      expect(view.zoom).toBe(1);
    } finally {
      lumine.config.set("image-editor.autoZoomLimit", previous);
    }
  });

  it("keeps width fitting through real rotation, resize, undo and redo", async () => {
    const view = item.view;
    view.resizeImage(100, 200);
    await imageReady(100, 200);
    view.historyManager.reset();
    lumine.commands.dispatch(view.element, "image-editor:fit-width");
    await expectWidthFit();

    lumine.commands.dispatch(view.element, "image-editor:rotate-90-cw");
    await imageReady(200, 100);
    await expectWidthFit();
    view.resizeImage(120, 400);
    await imageReady(120, 400);
    await expectWidthFit();
    await view.undo();
    await imageReady(200, 100);
    await expectWidthFit();
    await view.redo();
    await imageReady(120, 400);
    await expectWidthFit();

    lumine.commands.dispatch(view.element, "image-editor:automatic-zoom");
    expect(view.zoomMode).toBe("auto");
    expect(view.zoom).toBe(1);
  });

  it("restores width fitting after a real rotation preview is cancelled", async () => {
    const view = item.view;
    view.resizeImage(100, 200);
    await imageReady(100, 200);
    lumine.commands.dispatch(view.element, "image-editor:fit-width");
    await expectWidthFit();
    const originalSource = view.refs.image.src;
    const historyLength = view.historyManager.length;
    view.showFreeRotateDialog();
    const backdrop = document.querySelector(".image-editor-dialog-backdrop");
    backdrop.querySelector("#auto-preview").click();
    const angle = backdrop.querySelector("input[type=range]");
    angle.value = "30";
    angle.dispatchEvent(new Event("input", { bubbles: true }));
    await conditionPromise(
      () =>
        view.refs.image.src !== originalSource &&
        view.refs.image.complete &&
        !view.refs.image.onload,
    );
    await expectWidthFit();
    [...backdrop.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel")
      .click();
    await imageReady(100, 200);
    await expectWidthFit();
    expect(view.refs.image.src).toBe(originalSource);
    expect(view.historyManager.length).toBe(historyLength);
    expect(document.body.contains(backdrop)).toBe(false);
  });

  it("uses the shared zoom shortcuts and keeps fit modes active across a resize", async () => {
    const view = item.view;
    const button = view.refs.zoomToFitButton;
    const container = view.refs.imageContainer;
    let width = 400;
    let height = 300;
    Object.defineProperties(container, {
      offsetWidth: { configurable: true, get: () => width },
      offsetHeight: { configurable: true, get: () => height },
    });
    Object.defineProperties(view.refs.image, {
      naturalWidth: { configurable: true, value: 100 },
      naturalHeight: { configurable: true, value: 200 },
    });
    button.style.setProperty("--ui-site-color-2", "rgb(20, 180, 50)");
    button.style.setProperty("--ui-site-color-3", "rgb(220, 120, 10)");
    button.style.setProperty("--button-background-color", "rgb(230, 230, 230)");
    const key = (value) =>
      lumine.keymaps.handleKeyboardEvent(
        lumine.keymaps.constructor.buildKeydownEvent(value, { target: view.element }),
      );
    view.zoomToCenterPoint(1.25);
    const manual = getComputedStyle(button).backgroundColor;
    key("a");
    expect(view.zoomMode).toBe("auto");
    expect(button.classList.contains("selected")).toBe(true);
    key("f");
    expect(view.zoomMode).toBe("fit-image");
    expect(view.zoom).toBe(1.5);
    expect(button.classList.contains("selected")).toBe(false);
    const fit = getComputedStyle(button).backgroundColor;
    height = 200;
    view.element.style.height = "750px";
    await conditionPromise(() => view.zoom === 1);
    expect(view.zoomMode).toBe("fit-image");
    rightClick(button);
    const checkedRows = [...view.zoomMenu.element.querySelectorAll('[aria-checked="true"]')];
    expect(
      checkedRows.map((row) => row.querySelector(".menu-item-name").textContent.trim()),
    ).toEqual(["Fit to View"]);
    view.zoomMenu.close({ cancelled: true });
    key("w");
    expect(view.zoomMode).toBe("fit-width");
    expect(view.zoom).toBe(4);
    const fitWidth = getComputedStyle(button).backgroundColor;
    expect(fitWidth).not.toBe(fit);
    expect(fitWidth).not.toBe(manual);
    expect(fit).not.toBe(manual);
    width = 250;
    view.element.style.width = "900px";
    await conditionPromise(() => view.zoom === 2.5);
    expect(view.zoomMode).toBe("fit-width");
    key("0");
    expect(view.zoomMode).toBeNull();
    expect(view.zoom).toBe(1);
    expect(getComputedStyle(button).backgroundColor).toBe(manual);
    expect(button.classList.contains("selected")).toBe(false);
    view.zoomToCenterPoint(1.25);
    key(`${process.platform === "darwin" ? "cmd" : "ctrl"}-0`);
    expect(view.zoom).toBe(1);
    expect(view.zoomMode).toBeNull();
  });

  it("zooms naturally with plain controls and steps presets with modifier keys", async () => {
    const view = item.view;
    const key = (value) =>
      lumine.keymaps.handleKeyboardEvent(
        lumine.keymaps.constructor.buildKeydownEvent(value, { target: view.element }),
      );
    const modifier = process.platform === "darwin" ? "cmd" : "ctrl";
    view.resetZoom();
    view.refs.zoomInButton.click();
    expect(view.zoom).toBeCloseTo(1.1, 10);
    view.refs.zoomOutButton.click();
    expect(view.zoom).toBeCloseTo(1, 10);
    key("+");
    expect(view.zoom).toBeCloseTo(1.1, 10);
    key("-");
    expect(view.zoom).toBeCloseTo(1, 10);

    for (const expected of [1.25, 1.5, 2, 3, 4, 4]) {
      key(`${modifier}-+`);
      expect(view.zoom).toBe(expected);
    }
    await conditionPromise(() => view.renderedTransform?.zoom === 4);
    for (const expected of [3, 2, 1.5, 1.25, 1, 0.75, 0.5, 0.5]) {
      key(`${modifier}--`);
      expect(view.zoom).toBe(expected);
    }
    await conditionPromise(() => view.renderedTransform?.zoom === 0.5);
    view.zoomToCenterPoint(0.73);
    key(`${modifier}-=`);
    expect(view.zoom).toBe(0.75);
    view.zoomToCenterPoint(0.73);
    key(`${modifier}-_`);
    expect(view.zoom).toBe(0.5);
    view.zoomToCenterPoint(1.25 + 1e-10);
    key(`${modifier}--`);
    expect(view.zoom).toBe(1);
    expect(view.auto).toBe(false);

    view.zoomToCenterPoint(1.23456);
    await conditionPromise(() => view.renderedTransform?.zoom === 1.23456);
    expect(view.refs.zoomToFitButton.textContent).toBe("123%");
    expect(view.zoomController.getZoomPercentage()).toBe("123%");
    expect(view.zoom).toBe(1.23456);
  });

  it("removes the toolbar context listener when its view is destroyed", () => {
    const controls = item.view.refs.imageControls;
    const button = item.view.refs.zoomInButton;
    expect(rightClick(button).defaultPrevented).toBe(true);
    item.destroy();
    item = null;
    expect(rightClick(button).defaultPrevented).toBe(false);
    const bubble = jasmine.createSpy("detached controls bubble");
    controls.addEventListener("contextmenu", bubble);
    try {
      rightClick(button);
      expect(bubble).toHaveBeenCalledTimes(1);
    } finally {
      controls.removeEventListener("contextmenu", bubble);
    }
  });
});
