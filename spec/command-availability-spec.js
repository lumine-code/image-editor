const withAvailability = require("../lib/command-availability");

describe("image command availability", () => {
  it("checks loaded pixels, selection, read-only state and history without doing image work", () => {
    const element = document.createElement("div");
    const view = {
      loaded: false,
      readOnly: false,
      selectionVisible: false,
      historyManager: { canUndo: () => false, canRedo: () => false },
    };
    const handler = jasmine.createSpy("pixel work");
    const actions = [
      "crop-to-selection",
      "copy-selection",
      "invert-colors",
      "zoom-to-selection",
      "undo",
      "redo",
    ];
    const lease = lumine.commands.add(
      element,
      withAvailability(
        view,
        Object.fromEntries(actions.map((name) => ["image-editor:" + name, handler])),
      ),
    );
    const available = (name) => lumine.commands.canDispatch(element, "image-editor:" + name);
    try {
      expect(available("invert-colors")).toBe(false);
      view.loaded = true;
      expect(available("invert-colors")).toBe(true);
      expect(available("crop-to-selection")).toBe(false);
      expect(available("copy-selection")).toBe(true);
      view.selectionVisible = true;
      expect(available("crop-to-selection")).toBe(true);
      view.readOnly = true;
      expect(available("crop-to-selection")).toBe(false);
      expect(available("copy-selection")).toBe(false);
      expect(available("zoom-to-selection")).toBe(true);
      expect(available("undo")).toBe(false);
      view.historyManager.canUndo = () => true;
      expect(available("undo")).toBe(true);
      expect(available("redo")).toBe(false);
      expect(handler).not.toHaveBeenCalled();
      view._destroyed = true;
      expect(available("copy-selection")).toBe(false);
    } finally {
      lease.dispose();
    }
  });
});
