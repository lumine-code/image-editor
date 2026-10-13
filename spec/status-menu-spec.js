const path = require("node:path");

describe("Image Editor status action menu", () => {
  let image;
  const tile = () => lumine.workspace.getElement().querySelector(".status-image");
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("status-bar");
    await lumine.packages.activatePackage("image-editor");
    image = await lumine.workspace.open(path.join(__dirname, "fixtures/sample.png"));
    await conditionPromise(() => image.view.loaded && tile()?.textContent.includes("2x2"));
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("image-editor");
  });
  it("offers properties and opens the same view exactly once through either input", async () => {
    const element = tile();
    const menu = lumine.contextMenu.templateForElement(element);
    expect(menu.map((item) => item.command)).toEqual(["image-editor:show-properties"]);
    const [tooltip] = lumine.tooltips.findTooltips(element);
    expect(tooltip.getTitle()).toContain("Click to show image properties.");
    const properties = spyOn(image.view, "showPropertiesDialog");
    element.dispatchEvent(new MouseEvent("click", { button: 2, bubbles: true }));
    lumine.contextMenu.templateForElement(element);
    expect(properties).not.toHaveBeenCalled();
    element.click();
    expect(properties).toHaveBeenCalledTimes(1);
    await lumine.commands.dispatch(element, menu[0].command);
    expect(properties).toHaveBeenCalledTimes(2);
  });
  it("retires tile commands and listeners on deactivation", async () => {
    const element = tile();
    await lumine.packages.deactivatePackage("image-editor");
    const dispatch = spyOn(lumine.commands, "dispatch");
    element.click();
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      lumine.contextMenu.templateForElement(element).map((item) => item.command),
    ).not.toContain("image-editor:show-properties");
  });
  it("looks up a custom properties shortcut on the image view and suppresses it without an image", async () => {
    const element = tile();
    const keys = lumine.keymaps.add("image-status-shortcut-spec", {
      ".image-editor": { "ctrl-alt-1": "image-editor:show-properties" },
    });
    try {
      const menu = lumine.contextMenu.templateForElement(element);
      const label = process.platform === "darwin" ? "⌃⌥1" : "Ctrl+Alt+1";
      expect(menu[0].keyBindingLabel).toBe(label);
      const popup = lumine.contextMenu.show(element, menu);
      try {
        expect(popup.element.querySelector(".menu-item-keystroke").textContent).toBe(label);
      } finally {
        popup.close();
      }
      await lumine.workspace.open();
      expect(lumine.contextMenu.templateForElement(element)[0].keyBindingLabel).toBe("");
    } finally {
      keys.dispose();
    }
  });
});
