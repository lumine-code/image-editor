/**
 * ImageNavigator only ever calls readdir and works on strings, so it runs here
 * without a DOM or the editor. That matters: the spec suite is Linux-only, and
 * most of what this module does is fold Windows paths.
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ImageNavigator = require("../lib/navigation");
const paths = require("../lib/paths");

let dir;

/** Create empty files with the given names; the navigator never reads bytes. */
function makeFiles(names) {
  for (const name of names) fs.writeFileSync(path.join(dir, name), "");
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-editor-nav-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { force: true });
});

describe("getFileList", () => {
  it("orders numbered names the way a person reads them", async () => {
    makeFiles(["img1.png", "img2.png", "img10.png", "img20.png"]);
    const list = await new ImageNavigator().getFileList(path.join(dir, "img1.png"));
    assert.deepEqual(
      list.files.map((f) => path.basename(f)),
      ["img1.png", "img2.png", "img10.png", "img20.png"],
    );
  });

  it("orders names case-insensitively", async () => {
    makeFiles(["b.png", "A.png", "c.png"]);
    const list = await new ImageNavigator().getFileList(path.join(dir, "A.png"));
    assert.deepEqual(
      list.files.map((f) => path.basename(f)),
      ["A.png", "b.png", "c.png"],
    );
  });

  it("keeps only the extensions it was given, whatever their case", async () => {
    makeFiles(["a.png", "b.JPG", "c.txt", "d.jpeg", "e.md", "f.WEBP"]);
    const list = await new ImageNavigator().getFileList(path.join(dir, "a.png"));
    assert.deepEqual(
      list.files.map((f) => path.basename(f)),
      ["a.png", "b.JPG", "d.jpeg", "f.WEBP"],
    );
  });

  it("finds the current file when its path is spelled differently", async () => {
    // The watcher, the tree view and readdir disagree about case and
    // separators on Windows, and this is the lookup that has to survive it.
    makeFiles(["a.png", "b.png"]);
    const navigator = new ImageNavigator();
    const spelled = path.join(dir, "B.PNG").replace(/\\/g, "/");
    const list = await navigator.getFileList(spelled);
    assert.equal(list.currentIndex, 1);
  });

  it("reports no current index for a file that is not there", async () => {
    makeFiles(["a.png"]);
    const list = await new ImageNavigator().getFileList(path.join(dir, "gone.png"));
    assert.equal(list.currentIndex, -1);
    assert.equal(list.files.length, 1);
  });

  it("returns an empty list for a directory that does not exist", async () => {
    const list = await new ImageNavigator().getFileList(path.join(dir, "nope", "a.png"));
    assert.deepEqual(list, { directory: null, files: [], currentIndex: -1 });
  });

  it("returns an empty list when asked about nothing", async () => {
    const list = await new ImageNavigator().getFileList(null);
    assert.deepEqual(list, { directory: null, files: [], currentIndex: -1 });
  });

  it("reads the directory once and serves the rest from cache", async () => {
    makeFiles(["a.png", "b.png"]);
    const navigator = new ImageNavigator();
    const real = fs.promises.readdir;
    let reads = 0;
    fs.promises.readdir = (...args) => {
      reads++;
      return real(...args);
    };
    try {
      await navigator.getFileList(path.join(dir, "a.png"));
      await navigator.getFileList(path.join(dir, "b.png"));
      await navigator.getFileList(path.join(dir, "a.png"));
      assert.equal(reads, 1);

      navigator.invalidateCache();
      await navigator.getFileList(path.join(dir, "a.png"));
      assert.equal(reads, 2, "invalidateCache forces a re-read");
    } finally {
      fs.promises.readdir = real;
    }
  });

  it("exposes a folded directory key the watcher can match on", async () => {
    makeFiles(["a.png"]);
    const navigator = new ImageNavigator();
    await navigator.getFileList(path.join(dir, "a.png"));
    assert.equal(navigator.fileListCache.directoryKey, paths.normalizePathKey(dir));
    assert.equal(navigator.fileListCache.directory, dir, "the readable form is kept too");
  });

  it("keeps the index in step with the listing it belongs to", async () => {
    makeFiles(["a.png", "b.png"]);
    const navigator = new ImageNavigator();
    await navigator.getFileList(path.join(dir, "a.png"));
    assert.equal(navigator.fileListCache.index.size, 2);

    navigator.invalidateCache();
    assert.equal(navigator.fileListCache.index.size, 0);
    assert.equal(navigator.fileListCache.directoryKey, null);

    makeFiles(["a.png", "b.png", "c.png"]);
    await navigator.getFileList(path.join(dir, "c.png"));
    assert.equal(navigator.fileListCache.index.size, 3);
    assert.equal(navigator.fileListCache.currentIndex, 2);
  });

  it("tracks the current index across cached lookups", async () => {
    makeFiles(["a.png", "b.png", "c.png"]);
    const navigator = new ImageNavigator();
    assert.equal((await navigator.getFileList(path.join(dir, "a.png"))).currentIndex, 0);
    assert.equal((await navigator.getFileList(path.join(dir, "c.png"))).currentIndex, 2);
    assert.equal((await navigator.getFileList(path.join(dir, "b.png"))).currentIndex, 1);
  });
});

describe("getAdjacentImage and friends", () => {
  // Awaited, not just returned: getAdjacentImage reads the global after its
  // first await, so restoring it synchronously would pull it out from under.
  const withCycle = async (cycle, run) => {
    const previous = globalThis.lumine;
    globalThis.lumine = { config: { get: () => cycle } };
    try {
      return await run();
    } finally {
      globalThis.lumine = previous;
    }
  };

  it("steps forward and back", async () => {
    makeFiles(["a.png", "b.png", "c.png"]);
    const navigator = new ImageNavigator();
    await withCycle(true, async () => {
      assert.equal(path.basename(await navigator.getNextImage(path.join(dir, "a.png"))), "b.png");
      assert.equal(
        path.basename(await navigator.getPreviousImage(path.join(dir, "c.png"))),
        "b.png",
      );
    });
  });

  it("wraps at the ends when cycling is on", async () => {
    makeFiles(["a.png", "b.png"]);
    const navigator = new ImageNavigator();
    await withCycle(true, async () => {
      assert.equal(path.basename(await navigator.getNextImage(path.join(dir, "b.png"))), "a.png");
      assert.equal(
        path.basename(await navigator.getPreviousImage(path.join(dir, "a.png"))),
        "b.png",
      );
    });
  });

  it("stops at the ends when cycling is off", async () => {
    makeFiles(["a.png", "b.png"]);
    const navigator = new ImageNavigator();
    await withCycle(false, async () => {
      assert.equal(await navigator.getNextImage(path.join(dir, "b.png")), null);
      assert.equal(await navigator.getPreviousImage(path.join(dir, "a.png")), null);
    });
  });

  it("has nowhere to step in an empty directory", async () => {
    const navigator = new ImageNavigator();
    await withCycle(true, async () => {
      assert.equal(await navigator.getNextImage(path.join(dir, "a.png")), null);
    });
  });

  it("reports the ends", async () => {
    makeFiles(["a.png", "b.png"]);
    const navigator = new ImageNavigator();
    assert.equal(await navigator.isAtStart(path.join(dir, "a.png")), true);
    assert.equal(await navigator.isAtStart(path.join(dir, "b.png")), false);
    assert.equal(await navigator.isAtEnd(path.join(dir, "b.png")), true);
    assert.equal(path.basename(await navigator.getFirstImage(path.join(dir, "b.png"))), "a.png");
    assert.equal(path.basename(await navigator.getLastImage(path.join(dir, "a.png"))), "b.png");
  });
});
