const path = require("path");
const ImageEditor = require("../lib/editor");

// A 1x1 transparent PNG.
const DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// The spec runner freezes setTimeout, so async work is awaited by polling on
// animation frames instead of timers.
function pollUntil(condition, timeoutMs = 15000) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) {
        resolve();
      } else if (performance.now() - start > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  });
}

describe("image-editor", () => {
  let workspaceElement, mainModule;
  const samplePath = path.join(__dirname, "fixtures", "sample.png");

  beforeEach(async () => {
    workspaceElement = atom.views.getView(atom.workspace);
    jasmine.attachToDOM(workspaceElement);
    const pkg = await atom.packages.activatePackage("image-editor");
    mainModule = pkg.mainModule;
  });

  describe("opener", () => {
    it("opens .png URIs as an ImageEditor pane item", async () => {
      const item = await atom.workspace.open(samplePath);
      expect(item instanceof ImageEditor).toBe(true);
      expect(item.getPath()).toBe(samplePath);
      expect(item.getTitle()).toBe("sample.png");
      expect(item.getURI()).toBe(samplePath);
    });

    it("does not intercept non-image URIs", async () => {
      const item = await atom.workspace.open(path.join(__dirname, "image-editor-spec.js"));
      expect(item instanceof ImageEditor).toBe(false);
      expect(atom.workspace.isTextEditor(item)).toBe(true);
    });
  });

  describe("serialization", () => {
    it("round-trips through serialize/deserialize", async () => {
      const item = await atom.workspace.open(samplePath);
      const state = item.serialize();
      expect(state.deserializer).toBe("ImageEditor");
      expect(state.filePath).toBe(samplePath);

      const restored = mainModule.deserialize(state);
      expect(restored instanceof ImageEditor).toBe(true);
      expect(restored.getPath()).toBe(samplePath);
      restored.destroy();
    });

    it("refuses to deserialize a missing file", () => {
      const restored = mainModule.deserialize({
        filePath: path.join(__dirname, "fixtures", "missing.png"),
      });
      expect(restored).toBeUndefined();
    });

    it("does not serialize temporary data-URL editors", () => {
      const editor = ImageEditor.fromDataUrl(DATA_URL, "Temp");
      expect(editor.serialize()).toBeNull();
      editor.destroy();
    });
  });

  describe("provided image-editor service", () => {
    it("exposes openFromDataUrl and opens a temporary editor", () => {
      const service = mainModule.provideImageEditor();
      expect(typeof service.openFromDataUrl).toBe("function");

      const editor = service.openFromDataUrl(DATA_URL, "Test Image");
      expect(editor instanceof ImageEditor).toBe(true);
      expect(editor.isTemporary()).toBe(true);
      expect(editor.getTitle()).toBe("Test Image");
      expect(editor.getDataUrl()).toBe(DATA_URL);
      expect(editor.isModified()).toBe(true);
      expect(atom.workspace.getActivePaneItem()).toBe(editor);
    });
  });

  describe("provided navigation-adapter service", () => {
    it("handles only ImageEditor items and lists folder images", async () => {
      const adapter = mainModule.provideNavigationAdapter();
      expect(typeof adapter.handlesItem).toBe("function");
      expect(typeof adapter.observeHeaders).toBe("function");
      expect(typeof adapter.navigateTo).toBe("function");

      const item = await atom.workspace.open(samplePath);
      expect(adapter.handlesItem(item)).toBe(true);
      expect(adapter.handlesItem({})).toBe(false);

      let headers = null;
      const disposable = adapter.observeHeaders(item, (list) => {
        headers = list;
      });
      await pollUntil(() => headers != null && headers.length > 0);

      const names = headers.map((header) => header.text);
      expect(names).toContain("sample.png");
      expect(names).toContain("other.png");
      const current = headers.find((header) => header.currentCount === 1);
      expect(current.text).toBe("sample.png");

      disposable.dispose();
    });
  });
});
