const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const paths = require("../lib/paths");

describe("encodeFileURL", () => {
  it("turns backslashes into forward slashes", () => {
    assert.equal(paths.encodeFileURL("C:\\Data\\Photos\\a.png"), "file://C:/Data/Photos/a.png");
  });

  it("escapes the question mark, so an appended query stays unambiguous", () => {
    const url = paths.encodeFileURL("C:\\Data\\od?d\\x.jpg");
    assert.equal(url, "file://C:/Data/od%3Fd/x.jpg");
    assert.equal(url.indexOf("?"), -1, "no bare ? survives into the path");
    assert.equal(`${url}?v=1-2`.split("?").length, 2, "exactly one query separator");
  });

  it("escapes the hash, so a path containing one does not read as a fragment", () => {
    assert.equal(paths.encodeFileURL("/home/u/img #1.png"), "file:///home/u/img%20%231.png");
  });

  it("percent-encodes spaces and non-ASCII", () => {
    assert.equal(
      paths.encodeFileURL("C:\\Data\\zaz\u00f3\u0142\u0107.png"),
      "file://C:/Data/zaz%C3%B3%C5%82%C4%87.png",
    );
  });

  it("leaves the characters encodeURI considers safe alone", () => {
    assert.equal(paths.encodeFileURL("/tmp/a+b&c=d,e.png"), "file:///tmp/a+b&c=d,e.png");
  });

  it("handles a UNC path", () => {
    assert.equal(
      paths.encodeFileURL("\\\\server\\share\\pic.png"),
      "file:////server/share/pic.png",
    );
  });
});

describe("normalizePathKey", () => {
  it("folds case, so two spellings of one file agree", () => {
    assert.equal(paths.normalizePathKey("C:/Data/A.PNG"), paths.normalizePathKey("C:/data/a.png"));
  });

  it("folds separators on Windows", { skip: path.sep !== "\\" }, () => {
    assert.equal(
      paths.normalizePathKey("C:/Data/Photos/a.png"),
      paths.normalizePathKey("C:\\Data\\Photos\\a.png"),
    );
  });

  it("resolves . and .. segments", () => {
    assert.equal(
      paths.normalizePathKey(path.join("a", "b", "..", "c.png")),
      paths.normalizePathKey(path.join("a", "c.png")),
    );
  });

  it("is idempotent", () => {
    const once = paths.normalizePathKey("C:\\Data\\..\\Data\\A.PNG");
    assert.equal(paths.normalizePathKey(once), once);
  });

  it("keeps genuinely different files apart", () => {
    assert.notEqual(paths.normalizePathKey("/a/b.png"), paths.normalizePathKey("/a/c.png"));
  });
});

describe("cacheKeyForStats", () => {
  it("names one revision by mtime and size together", () => {
    assert.equal(
      paths.cacheKeyForStats({ mtimeMs: 1712345678901.5, size: 9 }),
      "1712345678901.5-9",
    );
  });

  it("changes when either field changes", () => {
    const base = { mtimeMs: 100, size: 10 };
    assert.notEqual(
      paths.cacheKeyForStats(base),
      paths.cacheKeyForStats({ mtimeMs: 101, size: 10 }),
    );
    assert.notEqual(
      paths.cacheKeyForStats(base),
      paths.cacheKeyForStats({ mtimeMs: 100, size: 11 }),
    );
  });

  it("is stable across calls for unchanged stats, which is the whole point", () => {
    const stats = { mtimeMs: 100, size: 10 };
    assert.equal(paths.cacheKeyForStats(stats), paths.cacheKeyForStats(stats));
  });

  it("falls back to a fresh key when there are no stats to go on", () => {
    for (const missing of [null, undefined]) {
      assert.match(paths.cacheKeyForStats(missing), /^\d+$/);
    }
  });
});
