/**
 * HistoryManager keeps Blobs and touches no canvas, no DOM and no URL, so it
 * runs here rather than inside the editor.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const HistoryManager = require("../lib/history");

const VIEW_STATE = { translateX: 0, translateY: 0, zoom: 1, auto: true };
const SMALL = { width: 1, height: 1 };
const LARGE = { width: 100, height: 100 };

const blobOf = (text) => new Blob([text], { type: "image/png" });

/** Reserve and settle in one go, the common case. */
function record(history, size = SMALL, text = "x") {
  const entry = history.beginEntry(VIEW_STATE, size);
  history.settleEntry(entry, blobOf(text));
  return entry;
}

describe("reserving a slot", () => {
  it("fixes an entry's position before its pixels are encoded", async () => {
    const history = new HistoryManager();

    // Two edits in flight at once, settled in the order they did NOT start.
    // The array must still read in reservation order, or an undo would walk
    // back through the frames in the wrong sequence.
    const first = history.beginEntry(VIEW_STATE, SMALL);
    const second = history.beginEntry(VIEW_STATE, SMALL);
    assert.equal(history.history[0], first);
    assert.equal(history.history[1], second);

    history.settleEntry(second, blobOf("second"));
    history.settleEntry(first, blobOf("first"));

    assert.equal(history.history[0], first);
    assert.equal(history.history[1], second);
    assert.ok((await history.blobFor(history.history[0])) instanceof Blob);
  });

  it("counts as modified the moment the slot is taken, not when it fills", () => {
    const seen = [];
    const history = new HistoryManager({ onModifiedStateChange: (m) => seen.push(m) });

    history.beginEntry(VIEW_STATE, SMALL);
    assert.equal(history.isModified(), false);

    history.beginEntry(VIEW_STATE, SMALL);
    assert.equal(history.isModified(), true, "before either has settled");
    assert.deepEqual(seen, [true]);
  });

  it("refuses to reserve anything once disposed", () => {
    const history = new HistoryManager();
    history.dispose();
    assert.equal(history.beginEntry(VIEW_STATE, SMALL), null);
    assert.equal(history.length, 0);
  });
});

describe("blobFor", () => {
  it("hands back the blob itself, never a URL over it", async () => {
    // Whoever displays a frame mints its own URL and owns it. The history
    // holding one too would mean two owners for one string, and a save that
    // resets the history would revoke what the view is still showing.
    const history = new HistoryManager();
    const entry = record(history);

    const blob = await history.blobFor(entry);
    assert.ok(blob instanceof Blob);
    assert.equal(await history.blobFor(entry), blob, "the same blob each time");
    assert.equal(entry.url, undefined, "no URL is kept on the entry");
  });

  it("waits for an entry that has not encoded yet", async () => {
    const history = new HistoryManager();
    const entry = history.beginEntry(VIEW_STATE, SMALL);

    const pending = history.blobFor(entry);
    let settled = false;
    pending.then(() => (settled = true));
    await null;
    assert.equal(settled, false);

    history.settleEntry(entry, blobOf("late"));
    assert.ok((await pending) instanceof Blob);
  });

  it("gives up on a frame that failed to encode, without losing its place", async () => {
    const history = new HistoryManager();
    const good = record(history);
    const bad = history.beginEntry(VIEW_STATE, SMALL);
    history.settleEntry(bad, null);

    assert.equal(await history.blobFor(bad), null);
    assert.equal(history.length, 2, "the entry stays, so indices do not shift");
    assert.ok((await history.blobFor(good)) instanceof Blob);
  });

  it("resolves rather than hanging when the entry is released first", async () => {
    const history = new HistoryManager();
    const entry = history.beginEntry(VIEW_STATE, SMALL);
    const pending = history.blobFor(entry);
    history.releaseEntry(entry);
    assert.equal(await pending, null);
  });
});

describe("releasing", () => {
  it("drops the pixels of an evicted entry", async () => {
    const history = new HistoryManager({ maxHistorySize: 2 });
    const first = record(history);
    record(history);
    record(history);

    assert.equal(history.length, 2);
    assert.equal(first.released, true);
    assert.equal(await history.blobFor(first), null);
  });

  it("drops the pixels of states a new edit made unreachable", async () => {
    const history = new HistoryManager();
    record(history);
    const middle = record(history);
    const newest = record(history);

    history.undo();
    record(history);

    assert.equal(newest.released, true, "the state that was ahead of the cursor");
    assert.equal(middle.released, false, "the one still behind it");
    assert.ok((await history.blobFor(middle)) instanceof Blob);
  });

  it("drops everything on reset and on dispose", async () => {
    for (const method of ["reset", "dispose"]) {
      const history = new HistoryManager();
      const entries = [];
      for (let i = 0; i < 3; i++) entries.push(record(history));

      history[method]();

      for (const entry of entries) {
        assert.equal(entry.released, true, `${method} released it`);
        assert.equal(entry.blob, null);
      }
      assert.equal(history.length, 0);
      assert.equal(history.needsInitialSave, true);
    }
  });

  it("takes nothing from an encode that outlived its slot", async () => {
    const history = new HistoryManager();
    const entry = history.beginEntry(VIEW_STATE, SMALL);
    history.reset();

    history.settleEntry(entry, blobOf("too late"));

    assert.equal(entry.blob, null);
    assert.equal(await history.blobFor(entry), null);
  });
});

describe("the compact gate", () => {
  it("marks frames above the threshold for compression, and no others", () => {
    const history = new HistoryManager({ largeImagePixels: 100 });
    assert.equal(history.beginEntry(VIEW_STATE, { width: 10, height: 10 }).compact, false);
    assert.equal(history.beginEntry(VIEW_STATE, { width: 11, height: 10 }).compact, true);
  });

  it("keeps fewer states once they are being compressed", () => {
    const history = new HistoryManager({
      maxHistorySize: 50,
      compactHistorySize: 2,
      largeImagePixels: 100,
    });
    for (let i = 0; i < 6; i++) record(history, SMALL);
    assert.equal(history.length, 6);

    record(history, LARGE);

    assert.equal(history.length, 2, "trims all the way down, not one per save");
    assert.equal(history.historyIndex, 1);
  });
});

describe("walking the history", () => {
  it("moves back and forward without falling off either end", () => {
    const history = new HistoryManager();
    const entries = [record(history), record(history), record(history)];

    assert.equal(history.canRedo(), false);
    assert.equal(history.undo(), entries[1]);
    assert.equal(history.undo(), entries[0]);
    assert.equal(history.undo(), null);
    assert.equal(history.redo(), entries[1]);
    assert.equal(history.redo(), entries[2]);
    assert.equal(history.redo(), null);
  });

  it("reports position for the properties dialog", () => {
    const history = new HistoryManager();
    record(history);
    record(history);
    assert.deepEqual(history.getPosition(), { current: 2, total: 2 });
    history.undo();
    assert.deepEqual(history.getPosition(), { current: 1, total: 2 });
  });

  it("keeps the viewport of the state under the cursor up to date", () => {
    const history = new HistoryManager();
    record(history);
    history.updateCurrentState({ translateX: 5, translateY: 6, zoom: 3, auto: false });

    const entry = history.getCurrentState();
    assert.equal(entry.translateX, 5);
    assert.equal(entry.zoom, 3);
    assert.equal(entry.auto, false);
  });
});
