/**
 * Path and file-URL helpers shared by the editor, the view and the navigator.
 *
 * Everything here is pure and depends only on `path`, so the modules that use
 * it stay loadable outside a browser and outside the editor runtime.
 */

const path = require("path");

/**
 * Extensions the editor opens without being asked.
 *
 * Shared with the navigator, so a file the editor will open is one the arrow
 * keys can reach. They used to be two lists that disagreed: an .ico opened
 * happily and then never appeared in the folder it was sitting in.
 */
const IMAGE_EXTENSIONS = [".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp"];

/**
 * Extensions the editor opens only when asked, by command or context menu.
 *
 * Navigable all the same: once one is open, the images beside it are the ones
 * beside it.
 */
const OPTIONAL_IMAGE_EXTENSIONS = [".svg"];

/** Everything the editor can show, however it was opened. */
const NAVIGABLE_EXTENSIONS = [...IMAGE_EXTENSIONS, ...OPTIONAL_IMAGE_EXTENSIONS];

/**
 * Build the `file://` URL for a path on disk.
 *
 * `?` is escaped so a query string appended to the result stays unambiguous,
 * and `#` so a path containing one does not read as a fragment.
 *
 * @param {string} filePath
 * @returns {string}
 */
function encodeFileURL(filePath) {
  return `file://${encodeURI(filePath.replace(/\\/g, "/"))
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F")}`;
}

/**
 * Fold a path into a key two spellings of the same file agree on.
 *
 * Windows paths reach us with either separator and in any case, from the
 * watcher, from the tree view and from `readdir` alike, so comparing them
 * raw silently misses.
 *
 * @param {string} filePath
 * @returns {string}
 */
function normalizePathKey(filePath) {
  return path.normalize(filePath).toLowerCase();
}

/**
 * Build the cache key that identifies one revision of a file's contents.
 *
 * Both fields matter: mtime alone is coarse on FAT32 (2 s) and exFAT (10 ms),
 * so a same-size overwrite inside that window would reuse the old decode until
 * the next forced reload. `isSelfWrite` already accepts that trade with the
 * same pair of fields.
 *
 * With no stats to go on there is no basis for a stable key, so fall back to
 * the clock and let the load miss the cache the way it always used to.
 *
 * @param {import("fs").Stats|null|undefined} stats
 * @returns {string}
 */
function cacheKeyForStats(stats) {
  return stats ? `${stats.mtimeMs}-${stats.size}` : String(Date.now());
}

module.exports = {
  IMAGE_EXTENSIONS,
  OPTIONAL_IMAGE_EXTENSIONS,
  NAVIGABLE_EXTENSIONS,
  encodeFileURL,
  normalizePathKey,
  cacheKeyForStats,
};
