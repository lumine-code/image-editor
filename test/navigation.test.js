/**
 * The navigator consumes the tree service's ordered list without a DOM or an
 * editor. Real files are needed only to check filesystem path aliases.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ImageNavigator = require("../lib/navigation");
const paths = require("../lib/paths");

let dir;

function filePaths(names, directory = dir) {
  return names.map((name) => path.join(directory, name));
}

function navigatorFor(names, options = {}) {
  const files = filePaths(names);
  return new ImageNavigator({ listDirectoryFiles: async () => files, ...options });
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-editor-nav-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("getFileList", () => {
  it("waits for the service watcher before listing and invalidates on directory changes", async () => {
    let ready,
      changed,
      reads = 0;
    const files = filePaths(["first.png", "second.png"]);
    const navigator = new ImageNavigator({
      listDirectoryFiles: async () => {
        reads++;
        return files;
      },
      watchDirectory: (directory, callback) => {
        assert.equal(directory, dir);
        changed = callback;
        return {
          ready: new Promise((resolve) => {
            ready = resolve;
          }),
          dispose() {},
        };
      },
    });
    const listing = navigator.getFileList(files[0]);
    assert.equal(reads, 0);
    ready();
    await listing;
    let invalidations = 0;
    const subscription = navigator.onDidInvalidate(() => invalidations++);
    files.push(path.join(dir, "third.png"));
    changed();
    assert.equal(invalidations, 1);
    assert.equal((await navigator.getFileList(files[0])).files.length, 3);
    assert.equal(reads, 2);
    subscription.dispose();
    changed();
    assert.equal(invalidations, 1);
    navigator.destroy();
  });

  it("releases service watchers when switching folders and when destroyed", async () => {
    const watched = [];
    const released = [];
    const navigator = new ImageNavigator({
      listDirectoryFiles: async (directory) => [path.join(directory, "image.png")],
      watchDirectory: (directory) => {
        watched.push(directory);
        return { ready: Promise.resolve(), dispose: () => released.push(directory) };
      },
    });
    await navigator.getFileList(path.join(dir, "image.png"));
    await navigator.getFileList(path.join(dir, "image.png"));
    const next = path.join(dir, "other");
    await navigator.getFileList(path.join(next, "image.png"));
    assert.deepEqual(watched, [dir, next]);
    assert.deepEqual(released, [dir]);
    navigator.destroy();
    assert.deepEqual(released, [dir, next]);
  });

  it("preserves the service's order and visibility while narrowing formats", async () => {
    const supplied = filePaths(["img10.png", "readme.txt", "img2.JPG", "IMG_3939 - Copy.png"]);
    const navigator = new ImageNavigator({
      listDirectoryFiles: async (directory) => {
        assert.equal(directory, dir);
        return supplied;
      },
    });

    const list = await navigator.getFileList(supplied[2]);

    assert.deepEqual(list.files, [supplied[0], supplied[2], supplied[3]]);
    assert.equal(list.currentIndex, 1);
    assert.equal(navigator.stepFrom(list, -1, { cycle: false }), supplied[0]);
    assert.deepEqual(
      supplied,
      filePaths(["img10.png", "readme.txt", "img2.JPG", "IMG_3939 - Copy.png"]),
    );
  });

  it("does not discover disk images when no service is available", async () => {
    const imagePath = path.join(dir, "unlisted.png");
    fs.writeFileSync(imagePath, "");

    const list = await new ImageNavigator().getFileList(imagePath);

    assert.deepEqual(list.files, []);
    assert.equal(list.currentIndex, -1);
  });

  it("keeps an empty service list empty", async () => {
    const list = await navigatorFor([]).getFileList(path.join(dir, "hidden.png"));

    assert.deepEqual(list.files, []);
    assert.equal(list.currentIndex, -1);
  });

  it("keeps only configured extensions, whatever their case", async () => {
    const navigator = navigatorFor(["a.png", "b.JPG", "c.txt", "d.jpeg", "e.md", "f.WEBP"], {
      extensions: [".jpg", ".webp"],
    });
    const list = await navigator.getFileList(path.join(dir, "b.JPG"));

    assert.deepEqual(list.files, filePaths(["b.JPG", "f.WEBP"]));
    assert.equal(list.currentIndex, 0);
  });

  it("includes icons and optional SVG images in the default formats", async () => {
    const list = await navigatorFor(["a.ico", "b.png", "c.svg"]).getFileList(
      path.join(dir, "a.ico"),
    );

    assert.deepEqual(list.files, filePaths(["a.ico", "b.png", "c.svg"]));
    assert.equal(list.currentIndex, 0);
  });

  it("matches a different case only when the filesystem accepts that alias", async () => {
    fs.writeFileSync(path.join(dir, "alias.png"), "");
    const navigator = navigatorFor(["a.png", "alias.png"]);
    const spelled = path.join(dir, "ALIAS.PNG").replace(/\\/g, "/");
    const list = await navigator.getFileList(spelled);

    assert.equal(list.currentIndex, fs.existsSync(spelled) ? 1 : -1);
  });

  it(
    "accepts a POSIX case alias only when both spellings identify the same file",
    {
      skip: process.platform === "win32",
    },
    async (t) => {
      const listedPath = path.join(dir, "linked.png");
      const aliasPath = path.join(dir, "LINKED.PNG");
      fs.writeFileSync(listedPath, "");
      if (fs.existsSync(aliasPath)) {
        t.skip("Requires distinct case-sensitive path spellings");
        return;
      }
      fs.linkSync(listedPath, aliasPath);
      const navigator = navigatorFor(["linked.png"]);

      assert.equal((await navigator.getFileList(aliasPath)).currentIndex, 0);

      fs.unlinkSync(aliasPath);
      fs.writeFileSync(aliasPath, "different file");
      assert.equal((await navigator.getFileList(aliasPath)).currentIndex, -1);
    },
  );

  it("reports no current index for an image omitted by the service", async () => {
    const list = await navigatorFor(["a.png"]).getFileList(path.join(dir, "gone.png"));

    assert.equal(list.currentIndex, -1);
    assert.deepEqual(list.files, filePaths(["a.png"]));
  });

  it("returns an empty list when the service cannot read the directory", async (t) => {
    const error = new Error("Directory unavailable");
    const report = t.mock.method(console, "error", () => {});
    const navigator = new ImageNavigator({
      listDirectoryFiles: async () => {
        throw error;
      },
    });

    assert.deepEqual(await navigator.getFileList(path.join(dir, "a.png")), {
      directory: null,
      files: [],
      currentIndex: -1,
    });
    assert.equal(report.mock.calls.length, 1);
    assert.ok(report.mock.calls[0].arguments.includes(error));
  });

  it("returns an empty list without calling the service when asked about nothing", async () => {
    let reads = 0;
    const navigator = navigatorFor([], {
      listDirectoryFiles: async () => {
        reads++;
        return [];
      },
    });

    assert.deepEqual(await navigator.getFileList(null), {
      directory: null,
      files: [],
      currentIndex: -1,
    });
    assert.equal(reads, 0);
  });

  it("calls the service once and serves later lookups from cache until invalidated", async () => {
    let reads = 0;
    const navigator = navigatorFor([], {
      listDirectoryFiles: async () => {
        reads++;
        return filePaths(["a.png", "b.png"]);
      },
    });

    await navigator.getFileList(path.join(dir, "a.png"));
    await navigator.getFileList(path.join(dir, "b.png"));
    await navigator.getFileList(path.join(dir, "a.png"));
    assert.equal(reads, 1);

    navigator.invalidateCache();
    await navigator.getFileList(path.join(dir, "a.png"));
    assert.equal(reads, 2);
  });

  it("exposes a folded directory key the watcher can match on", async () => {
    const navigator = navigatorFor(["a.png"]);
    await navigator.getFileList(path.join(dir, "a.png"));

    assert.equal(navigator.fileListCache.directoryKey, paths.normalizePathKey(dir));
    assert.equal(navigator.fileListCache.directory, dir);
  });

  it("keeps the index in step with the service list it belongs to", async () => {
    let supplied = filePaths(["b.png", "a.png"]);
    const navigator = new ImageNavigator({ listDirectoryFiles: async () => supplied });
    await navigator.getFileList(path.join(dir, "a.png"));
    assert.equal(navigator.fileListCache.index.size, 2);
    assert.equal(navigator.fileListCache.currentIndex, 1);

    navigator.invalidateCache();
    assert.equal(navigator.fileListCache.index.size, 0);
    assert.equal(navigator.fileListCache.directoryKey, null);

    supplied = filePaths(["c.png", "b.png", "a.png"]);
    await navigator.getFileList(path.join(dir, "c.png"));
    assert.equal(navigator.fileListCache.index.size, 3);
    assert.equal(navigator.fileListCache.currentIndex, 0);
  });

  it("tracks the current index across cached lookups", async () => {
    const navigator = navigatorFor(["a.png", "b.png", "c.png"]);

    assert.equal((await navigator.getFileList(path.join(dir, "a.png"))).currentIndex, 0);
    assert.equal((await navigator.getFileList(path.join(dir, "c.png"))).currentIndex, 2);
    assert.equal((await navigator.getFileList(path.join(dir, "b.png"))).currentIndex, 1);
  });

  it("keeps the latest directory cached when an older service response finishes later", async () => {
    const directoryA = path.join(dir, "A");
    const directoryB = path.join(dir, "B");
    let finishA, finishB;
    const navigator = new ImageNavigator({
      listDirectoryFiles: (directory) =>
        new Promise((resolve) => {
          if (directory === directoryA) finishA = resolve;
          else finishB = resolve;
        }),
    });

    const readingA = navigator.getFileList(path.join(directoryA, "a.png"));
    const readingB = navigator.getFileList(path.join(directoryB, "b.png"));
    finishB(filePaths(["c.png", "b.png"], directoryB));
    const listB = await readingB;
    finishA(filePaths(["a.png"], directoryA));
    const listA = await readingA;

    assert.equal(navigator.fileListCache.directory, directoryB);
    assert.deepEqual(listB.files, filePaths(["c.png", "b.png"], directoryB));
    assert.equal(listB.currentIndex, 1);
    assert.deepEqual(listA.files, filePaths(["a.png"], directoryA));
    assert.equal(listA.currentIndex, 0);
  });

  it("keeps returned snapshots independent of later lookups, callers and invalidation", async () => {
    const navigator = navigatorFor(["a.png", "b.png"]);
    const listA = await navigator.getFileList(path.join(dir, "a.png"));
    const listB = await navigator.getFileList(path.join(dir, "b.png"));
    listA.files.pop();
    const listC = await navigator.getFileList(path.join(dir, "a.png"));
    navigator.invalidateCache();

    assert.equal(listA.currentIndex, 0);
    assert.equal(listB.currentIndex, 1);
    assert.deepEqual(listB.files, filePaths(["a.png", "b.png"]));
    assert.deepEqual(listC.files, listB.files);
  });

  it("keeps an in-flight service response from restoring an invalidated cache", async () => {
    let finish;
    const navigator = new ImageNavigator({
      listDirectoryFiles: () => new Promise((resolve) => (finish = resolve)),
    });

    const reading = navigator.getFileList(path.join(dir, "a.png"));
    navigator.invalidateCache();
    finish(filePaths(["a.png"]));
    const list = await reading;

    assert.deepEqual(list.files, filePaths(["a.png"]));
    assert.equal(list.currentIndex, 0);
    assert.equal(navigator.fileListCache.directory, null);
    assert.equal(navigator.fileListCache.files.length, 0);
  });
});

describe("getAdjacentImage and friends", () => {
  const withCycle = async (cycle, run) => {
    const previous = globalThis.lumine;
    globalThis.lumine = { config: { get: () => cycle } };
    try {
      return await run();
    } finally {
      globalThis.lumine = previous;
    }
  };

  it("steps forward and back in service order", async () => {
    const navigator = navigatorFor(["c.png", "b.png", "a.png"]);
    await withCycle(true, async () => {
      assert.equal(await navigator.getNextImage(path.join(dir, "c.png")), path.join(dir, "b.png"));
      assert.equal(
        await navigator.getPreviousImage(path.join(dir, "a.png")),
        path.join(dir, "b.png"),
      );
    });
  });

  it("wraps at the ends when cycling is on", async () => {
    const navigator = navigatorFor(["b.png", "a.png"]);
    await withCycle(true, async () => {
      assert.equal(await navigator.getNextImage(path.join(dir, "a.png")), path.join(dir, "b.png"));
      assert.equal(
        await navigator.getPreviousImage(path.join(dir, "b.png")),
        path.join(dir, "a.png"),
      );
    });
  });

  it("stops at the ends when cycling is off", async () => {
    const navigator = navigatorFor(["a.png", "b.png"]);
    await withCycle(false, async () => {
      assert.equal(await navigator.getNextImage(path.join(dir, "b.png")), null);
      assert.equal(await navigator.getPreviousImage(path.join(dir, "a.png")), null);
    });
  });

  it("has nowhere to step in an empty service list", async () => {
    const navigator = navigatorFor([]);
    await withCycle(true, async () => {
      assert.equal(await navigator.getNextImage(path.join(dir, "a.png")), null);
    });
    assert.equal(await navigator.getFirstImage(path.join(dir, "a.png")), null);
    assert.equal(await navigator.getLastImage(path.join(dir, "a.png")), null);
    assert.equal(await navigator.isAtStart(path.join(dir, "a.png")), false);
    assert.equal(await navigator.isAtEnd(path.join(dir, "a.png")), false);
    assert.equal(await navigator.getPositionInfo(path.join(dir, "a.png")), null);
  });

  it("steps from a listing already in hand, without consulting anything", () => {
    const navigator = new ImageNavigator();
    const list = { files: ["/a.png", "/b.png", "/c.png"], currentIndex: 1 };

    assert.equal(navigator.stepFrom(list, 1, { cycle: false }), "/c.png");
    assert.equal(navigator.stepFrom(list, -1, { cycle: false }), "/a.png");
    assert.equal(navigator.stepFrom({ ...list, currentIndex: 2 }, 1, { cycle: true }), "/a.png");
    assert.equal(navigator.stepFrom({ ...list, currentIndex: 0 }, -1, { cycle: true }), "/c.png");
    assert.equal(navigator.stepFrom({ ...list, currentIndex: 2 }, 1, { cycle: false }), null);
    assert.equal(navigator.stepFrom({ ...list, currentIndex: 0 }, -1, { cycle: false }), null);
    assert.equal(navigator.stepFrom({ files: [], currentIndex: -1 }, 1, { cycle: true }), null);
    assert.equal(navigator.stepFrom({ ...list, currentIndex: -1 }, 1, { cycle: true }), null);

    const single = { files: ["/only.png"], currentIndex: 0 };
    assert.equal(navigator.stepFrom(single, 1, { cycle: true }), "/only.png");
    assert.equal(navigator.stepFrom(single, 1, { cycle: false }), null);
  });

  it("reports boundaries and position from the service order", async () => {
    const navigator = navigatorFor(["b.png", "a.png"]);

    assert.equal(await navigator.isAtStart(path.join(dir, "b.png")), true);
    assert.equal(await navigator.isAtStart(path.join(dir, "a.png")), false);
    assert.equal(await navigator.isAtEnd(path.join(dir, "a.png")), true);
    assert.equal(await navigator.getFirstImage(path.join(dir, "a.png")), path.join(dir, "b.png"));
    assert.equal(await navigator.getLastImage(path.join(dir, "b.png")), path.join(dir, "a.png"));
    assert.equal(await navigator.getPositionInfo(path.join(dir, "a.png")), "2 / 2");
    assert.equal(await navigator.getPositionInfo(path.join(dir, "unlisted.png")), null);
  });
});
