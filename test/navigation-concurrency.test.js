const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const ImageNavigator = require("../lib/navigation");

const directory = path.join(os.tmpdir(), "image-editor-navigation-concurrency");
const file = (name, parent = directory) => path.join(parent, name);

function deferred() {
  let resolve;
  const promise = new Promise((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("concurrent directory listings", () => {
  it("shares watcher readiness and the listing while locating each requested path", async () => {
    const ready = deferred();
    const listed = deferred();
    const started = deferred();
    let reads = 0;
    let watches = 0;
    const navigator = new ImageNavigator({
      watchDirectory() {
        watches++;
        return { ready: ready.promise, dispose() {} };
      },
      listDirectoryFiles() {
        reads++;
        started.resolve();
        return listed.promise;
      },
    });

    const first = navigator.getFileList(file("first.png"));
    const second = navigator.getFileList(file("second.png"));
    assert.equal(reads, 0);
    assert.equal(watches, 1);
    ready.resolve();
    await started.promise;
    const third = navigator.getFileList(file("third.png"));
    assert.equal(reads, 1);
    listed.resolve([file("second.png"), file("notes.txt"), file("first.png"), file("third.png")]);

    const [firstList, secondList, thirdList] = await Promise.all([first, second, third]);
    const ordered = [file("second.png"), file("first.png"), file("third.png")];
    assert.deepEqual(firstList.files, ordered);
    assert.deepEqual(secondList.files, ordered);
    assert.deepEqual(thirdList.files, ordered);
    assert.deepEqual(
      [firstList.currentIndex, secondList.currentIndex, thirdList.currentIndex],
      [1, 0, 2],
    );
    firstList.files.pop();
    assert.deepEqual(secondList.files, ordered);
    assert.deepEqual((await navigator.getFileList(file("first.png"))).files, ordered);
    assert.equal(reads, 1);
    assert.equal(navigator.listGeneration, 0);
    navigator.destroy();
  });

  it("keeps an invalidated request from replacing a newer cached listing", async () => {
    const replies = [];
    const navigator = new ImageNavigator({
      listDirectoryFiles() {
        const reply = deferred();
        replies.push(reply);
        return reply.promise;
      },
    });
    const old = navigator.getFileList(file("old.png"));
    navigator.invalidateCache();
    const current = navigator.getFileList(file("current.png"));
    const peer = navigator.getFileList(file("second.png"));
    assert.equal(replies.length, 2);
    assert.equal(navigator.listGeneration, 1);

    replies[1].resolve([file("second.png"), file("current.png")]);
    const [currentList, peerList] = await Promise.all([current, peer]);
    replies[0].resolve([file("old.png")]);
    const oldList = await old;

    assert.equal(currentList.currentIndex, 1);
    assert.equal(peerList.currentIndex, 0);
    assert.equal(oldList.currentIndex, 0);
    assert.deepEqual(navigator.fileListCache.files, currentList.files);
    assert.deepEqual((await navigator.getFileList(file("current.png"))).files, currentList.files);
    assert.equal(replies.length, 2);
  });

  it("does not remove the replacement pending request when an invalidated read finishes", async () => {
    const replies = [];
    const navigator = new ImageNavigator({
      listDirectoryFiles() {
        const reply = deferred();
        replies.push(reply);
        return reply.promise;
      },
    });
    const old = navigator.getFileList(file("old.png"));
    navigator.invalidateCache();
    const current = navigator.getFileList(file("current.png"));
    replies[0].resolve([file("old.png")]);
    await old;
    assert.equal(navigator.fileListCache.directory, null);

    const peer = navigator.getFileList(file("second.png"));
    assert.equal(replies.length, 2);
    replies[1].resolve([file("current.png"), file("second.png")]);
    assert.deepEqual(
      (await Promise.all([current, peer])).map((listing) => listing.currentIndex),
      [0, 1],
    );
  });

  it("keeps the latest requested directory cached when another directory finishes later", async () => {
    const replies = new Map();
    const navigator = new ImageNavigator({
      listDirectoryFiles(parent) {
        const reply = deferred();
        replies.set(parent, reply);
        return reply.promise;
      },
    });
    const firstDirectory = path.join(directory, "first");
    const secondDirectory = path.join(directory, "second");
    const firstPath = file("image.png", firstDirectory);
    const secondPath = file("image.png", secondDirectory);
    const first = navigator.getFileList(firstPath);
    const second = navigator.getFileList(secondPath);
    replies.get(secondDirectory).resolve([secondPath]);
    await second;
    replies.get(firstDirectory).resolve([firstPath]);
    assert.equal((await first).currentIndex, 0);

    assert.equal(navigator.fileListCache.directory, secondDirectory);
    assert.deepEqual((await navigator.getFileList(secondPath)).files, [secondPath]);
    assert.equal(replies.size, 2);
  });

  it("clears an in-flight listing when the current path disappears", async () => {
    const reply = deferred();
    const navigator = new ImageNavigator({ listDirectoryFiles: () => reply.promise });
    const listing = navigator.getFileList(file("image.png"));

    assert.deepEqual(await navigator.getFileList(null), {
      directory: null,
      files: [],
      currentIndex: -1,
    });
    reply.resolve([file("image.png")]);
    assert.equal((await listing).currentIndex, 0);
    assert.equal(navigator.fileListCache.directory, null);
  });

  it("caches an empty watched listing until the watcher invalidates it", async () => {
    let reads = 0;
    let changed;
    const navigator = new ImageNavigator({
      watchDirectory(parent, callback) {
        changed = callback;
        return { ready: Promise.resolve(), dispose() {} };
      },
      listDirectoryFiles() {
        reads++;
        return [];
      },
    });

    await navigator.getFileList(file("hidden.png"));
    await navigator.getFileList(file("also-hidden.png"));
    assert.equal(reads, 1);
    changed();
    await navigator.getFileList(file("hidden.png"));
    assert.equal(reads, 2);
    navigator.destroy();
  });

  it("shares an unavailable watcher's pending read but reads again after it settles", async () => {
    const started = deferred();
    const reply = deferred();
    let reads = 0;
    const navigator = new ImageNavigator({
      watchDirectory: () => null,
      listDirectoryFiles() {
        reads++;
        started.resolve();
        return reads === 1 ? reply.promise : [file("second.png")];
      },
    });

    const first = navigator.getFileList(file("first.png"));
    const peer = navigator.getFileList(file("first.png"));
    await started.promise;
    assert.equal(reads, 1);
    reply.resolve([file("first.png")]);
    assert.deepEqual(
      (await Promise.all([first, peer])).map((listing) => listing.currentIndex),
      [0, 0],
    );
    assert.equal(navigator.fileListCache.directory, null);

    assert.deepEqual((await navigator.getFileList(file("second.png"))).files, [file("second.png")]);
    assert.equal(reads, 2);
  });
});
