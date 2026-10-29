const fs = require("node:fs");
const path = require("node:path");

describe("image controls at the top pane boundary", () => {
  let item, theme;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const pack = await lumine.packages.activatePackage("image-editor");
    const themePath = lumine.packages.resolvePackagePath("one-theme");
    theme = lumine.styles.addStyleSheet(
      fs.readFileSync(path.join(themePath, "styles", "ui", "main.css"), "utf8"),
      { sourcePath: path.join(themePath, "styles", "ui", "main.css") },
    );
    item = await lumine.workspace.open(path.join(pack.path, "spec", "fixtures", "sample.png"));
    await conditionPromise(() => item.view.loaded && item.view.refs.image.complete);
  });

  afterEach(async () => {
    item?.destroy();
    theme?.dispose();
    await lumine.packages.deactivatePackage("image-editor");
    await lumine.fileWatchClient.settlePendingTeardown();
    item = theme = null;
  });

  it("shares the pane separator without changing ordinary themed button borders or metrics", () => {
    const controls = item.view.element.querySelector(".image-controls");
    const group = controls.querySelector(".btn-group");
    item.view.element.style.setProperty("--tool-panel-background-color", "rgb(10, 20, 30)");
    expect(getComputedStyle(group).backgroundColor).toBe("rgb(10, 20, 30)");
    expect(getComputedStyle(group).opacity).toBe("1");
    const reference = document.createElement("button");
    reference.className = "btn";
    reference.textContent = "+";
    jasmine.attachToDOM(reference);
    const referenceStyle = getComputedStyle(reference);
    expect(referenceStyle.borderTopWidth).toBe("1px");
    expect(referenceStyle.borderBottomWidth).toBe("1px");
    expect(controls.getBoundingClientRect().top).toBe(
      item.view.element.getBoundingClientRect().top,
    );
    expect(getComputedStyle(group).borderTopWidth).toBe("0px");

    const buttons = [...group.querySelectorAll(":scope > .btn")];
    expect(buttons.length).toBeGreaterThan(1);
    for (const button of buttons) {
      const style = getComputedStyle(button);
      expect(style.borderTopWidth).toBe("0px");
      expect(style.borderBottomWidth).toBe(referenceStyle.borderBottomWidth);
      expect(style.paddingTop).toBe(referenceStyle.paddingTop);
      expect(style.paddingBottom).toBe(referenceStyle.paddingBottom);
      expect(style.lineHeight).toBe(referenceStyle.lineHeight);
      expect(style.fontSize).toBe(referenceStyle.fontSize);
    }
    expect(getComputedStyle(buttons[0]).borderTopLeftRadius).toBe("0px");
    expect(getComputedStyle(buttons[0]).borderBottomLeftRadius).toBe(
      referenceStyle.borderBottomLeftRadius,
    );
    expect(getComputedStyle(buttons.at(-1)).borderTopRightRadius).toBe("0px");
    expect(getComputedStyle(buttons.at(-1)).borderBottomRightRadius).toBe(
      referenceStyle.borderBottomRightRadius,
    );
    reference.disabled = true;
    expect(getComputedStyle(buttons.find((button) => button.disabled)).opacity).toBe(
      getComputedStyle(reference).opacity,
    );
    item.view.element.style.setProperty("--tool-panel-background-color", "rgb(80, 90, 100)");
    expect(getComputedStyle(group).backgroundColor).toBe("rgb(80, 90, 100)");
  });

  it("uses the native button font for the current image, total and zoom label", () => {
    const view = item.view;
    const elements = [
      view.refs.imagePosition,
      view.refs.imagePositionInput,
      view.refs.imagePositionCount,
      view.refs.zoomToFitButton,
    ];
    view.element.style.fontFamily = "var(--ui-font-family)";
    for (const [family, size, height] of [
      ["monospace", "14px", "30px"],
      ["serif", "17px", "38px"],
    ]) {
      view.element.style.setProperty("--ui-font-family", family);
      view.element.style.setProperty("--ui-font-size", size);
      view.element.style.setProperty("--ui-unit", size);
      view.element.style.setProperty("--ui-row-height", height);
      view.element.style.setProperty("--ui-control-height", height);
      const native = getComputedStyle(view.refs.zoomInButton);
      expect(native.fontFamily).toBe(family);
      expect(native.fontSize).toBe(size);
      expect(native.fontVariantNumeric).toBe("tabular-nums");
      for (const element of elements) {
        const actual = getComputedStyle(element);
        for (const property of [
          "fontFamily",
          "fontSize",
          "fontWeight",
          "lineHeight",
          "fontVariantNumeric",
        ])
          expect(actual[property])
            .withContext(`${element.className}: ${property}`)
            .toBe(native[property]);
      }
    }
  });
});
