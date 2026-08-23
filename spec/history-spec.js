const HistoryManager = require("../lib/history");

// A canvas of a given pixel count, which is what the compact gate measures.
function canvasOf(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#3366aa";
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

const VIEW_STATE = { translateX: 0, translateY: 0, zoom: 1, auto: true };

describe("HistoryManager", () => {
  describe("the compact gate", () => {
    it("keeps small images lossless and deep", () => {
      // 3 pixels against a 4-pixel threshold, so the sizes stay trivial while
      // the branch under test is the real one.
      const history = new HistoryManager({ largeImagePixels: 4 });
      history.saveStateWithCanvas(canvasOf(1, 3), VIEW_STATE);

      const entry = history.getCurrentState();
      expect(entry.compact).toBe(false);
      expect(entry.imageData.startsWith("data:image/png")).toBe(true);
    });

    it("compresses larger ones", () => {
      const history = new HistoryManager({ largeImagePixels: 4 });
      history.saveStateWithCanvas(canvasOf(3, 3), VIEW_STATE);

      const entry = history.getCurrentState();
      expect(entry.compact).toBe(true);
      expect(entry.imageData.startsWith("data:image/png")).toBe(false);
    });

    it("measures pixels, not the bytes the file happened to occupy", () => {
      // The old gate read the size on disk, which an edit never updated: a
      // crop to a thumbnail went on reporting the original file's size.
      const history = new HistoryManager({ largeImagePixels: 4 });
      history.saveStateWithCanvas(canvasOf(100, 100), VIEW_STATE);
      expect(history.getCurrentState().compact).toBe(true);

      history.saveStateWithCanvas(canvasOf(1, 1), VIEW_STATE);
      expect(history.getCurrentState().compact).toBe(false);
    });
  });

  describe("the size cap", () => {
    it("keeps the newest states and points at the last one", () => {
      const history = new HistoryManager({ maxHistorySize: 3, largeImagePixels: 1e9 });
      for (let i = 0; i < 5; i++) history.saveStateWithCanvas(canvasOf(1, 1), VIEW_STATE);

      expect(history.length).toBe(3);
      expect(history.historyIndex).toBe(2);
      expect(history.getCurrentState()).toBe(history.history[2]);
    });

    it("trims more than one state when the cap drops in a single step", () => {
      // A resize can take an image over the threshold at once, dropping the
      // cap from 50 to 10 with far more than one entry to shed.
      const history = new HistoryManager({
        maxHistorySize: 50,
        compactHistorySize: 2,
        largeImagePixels: 4,
      });
      for (let i = 0; i < 6; i++) history.saveStateWithCanvas(canvasOf(1, 1), VIEW_STATE);
      expect(history.length).toBe(6);

      history.saveStateWithCanvas(canvasOf(3, 3), VIEW_STATE);

      expect(history.length).toBe(2);
      expect(history.historyIndex).toBe(1);
      expect(history.getCurrentState().compact).toBe(true);
    });
  });

  describe("undo and redo", () => {
    let history;

    beforeEach(() => {
      history = new HistoryManager({ largeImagePixels: 1e9 });
      for (let i = 0; i < 3; i++) history.saveStateWithCanvas(canvasOf(1, 1), VIEW_STATE);
    });

    it("walks back and forward without falling off either end", () => {
      expect(history.canRedo()).toBe(false);
      expect(history.undo()).toBe(history.history[1]);
      expect(history.undo()).toBe(history.history[0]);
      expect(history.canUndo()).toBe(false);
      expect(history.undo()).toBe(null);

      expect(history.redo()).toBe(history.history[1]);
      expect(history.redo()).toBe(history.history[2]);
      expect(history.redo()).toBe(null);
    });

    it("drops the forward states once a new one is saved over them", () => {
      history.undo();
      history.undo();
      history.saveStateWithCanvas(canvasOf(1, 1), VIEW_STATE);

      expect(history.length).toBe(2);
      expect(history.canRedo()).toBe(false);
      expect(history.historyIndex).toBe(1);
    });

    it("reports modified only once there is something to go back to", () => {
      const seen = [];
      const tracked = new HistoryManager({
        largeImagePixels: 1e9,
        onModifiedStateChange: (modified) => seen.push(modified),
      });

      tracked.saveStateWithCanvas(canvasOf(1, 1), VIEW_STATE);
      expect(tracked.isModified()).toBe(false);

      tracked.saveStateWithCanvas(canvasOf(1, 1), VIEW_STATE);
      expect(tracked.isModified()).toBe(true);

      tracked.undo();
      expect(tracked.isModified()).toBe(false);
      expect(seen).toEqual([true, false]);
    });
  });

  it("forgets everything on reset", () => {
    const history = new HistoryManager({ largeImagePixels: 1e9 });
    history.saveStateWithCanvas(canvasOf(1, 1), VIEW_STATE);
    history.saveStateWithCanvas(canvasOf(1, 1), VIEW_STATE);

    history.reset();

    expect(history.length).toBe(0);
    expect(history.getCurrentState()).toBe(null);
    expect(history.isModified()).toBe(false);
    expect(history.needsInitialSave).toBe(true);
  });
});
