/**
 * Image navigation module
 * Contains file list management and navigation
 */

const fs = require("fs");
const path = require("path");
const paths = require("./paths");

// Built once. Passing an options object to localeCompare constructs a collator
// per call, and a sort makes O(n log n) of them: at 5,000 files that measured
// 294ms against 27ms for this.
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

class ImageNavigator {
  constructor(options = {}) {
    this.extensions = options.extensions || [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".bmp",
      ".webp",
      ".svg",
    ];
    this.fileListCache = {
      directory: null,
      directoryKey: null,
      files: [],
      index: new Map(),
      currentIndex: -1,
    };
  }

  /**
   * Replace the cached listing, rebuilding the lookup that goes with it.
   *
   * The only place `files` is assigned, so the array and its index cannot drift
   * apart. `directory` is kept alongside its folded key because it is what a
   * person reads in a debugger.
   */
  _setFiles(directory, files) {
    const index = new Map();
    for (let i = 0; i < files.length; i++) index.set(paths.normalizePathKey(files[i]), i);
    this.fileListCache.directory = directory;
    this.fileListCache.directoryKey = directory && paths.normalizePathKey(directory);
    this.fileListCache.files = files;
    this.fileListCache.index = index;
    this.fileListCache.currentIndex = -1;
  }

  /** Point the cached listing at `currentPath`, or at nothing if it is absent. */
  _locate(currentPath) {
    this.fileListCache.currentIndex =
      this.fileListCache.index.get(paths.normalizePathKey(currentPath)) ?? -1;
    return this.fileListCache;
  }

  // Get sorted list of image files in directory
  async getFileList(currentPath) {
    if (!currentPath) {
      return { directory: null, files: [], currentIndex: -1 };
    }
    const directory = path.dirname(currentPath);

    // Folded, because the watcher, the tree view and readdir do not agree on
    // the case or the separators of the same directory.
    if (
      this.fileListCache.directoryKey === paths.normalizePathKey(directory) &&
      this.fileListCache.files.length > 0
    ) {
      return this._locate(currentPath);
    }

    let files;
    try {
      const entries = await fs.promises.readdir(directory);
      // Sorted before joining, not after: readdir already hands back bare
      // names, so joining first only meant calling basename twice per
      // comparison to undo it. Two entries in one directory cannot share a
      // name, so the order is the same either way.
      files = entries
        .filter((file) => this.extensions.includes(path.extname(file).toLowerCase()))
        .sort(nameCollator.compare)
        .map((file) => path.join(directory, file));
    } catch (e) {
      console.error("Error reading directory:", e);
      return {
        directory: null,
        files: [],
        currentIndex: -1,
      };
    }

    this._setFiles(directory, files);
    return this._locate(currentPath);
  }

  // Invalidate file list cache
  invalidateCache() {
    this._setFiles(null, []);
  }

  // Get adjacent image path
  async getAdjacentImage(currentPath, direction) {
    const fileList = await this.getFileList(currentPath);

    if (fileList.files.length === 0 || fileList.currentIndex === -1) {
      return null;
    }

    let newIndex = fileList.currentIndex + direction;
    const cycle = lumine.config.get("image-editor.scrollCycle") !== false;

    if (newIndex < 0) {
      newIndex = cycle ? fileList.files.length - 1 : null;
    } else if (newIndex >= fileList.files.length) {
      newIndex = cycle ? 0 : null;
    }

    return newIndex !== null ? fileList.files[newIndex] : null;
  }

  // Get next image path
  async getNextImage(currentPath) {
    return this.getAdjacentImage(currentPath, 1);
  }

  // Get previous image path
  async getPreviousImage(currentPath) {
    return this.getAdjacentImage(currentPath, -1);
  }

  // Get first image path
  async getFirstImage(currentPath) {
    const fileList = await this.getFileList(currentPath);
    return fileList.files.length > 0 ? fileList.files[0] : null;
  }

  // Get last image path
  async getLastImage(currentPath) {
    const fileList = await this.getFileList(currentPath);
    return fileList.files.length > 0 ? fileList.files[fileList.files.length - 1] : null;
  }

  // Check if at start of file list
  async isAtStart(currentPath) {
    const fileList = await this.getFileList(currentPath);
    return fileList.files.length > 0 && fileList.currentIndex === 0;
  }

  // Check if at end of file list
  async isAtEnd(currentPath) {
    const fileList = await this.getFileList(currentPath);
    return fileList.files.length > 0 && fileList.currentIndex === fileList.files.length - 1;
  }
}

module.exports = ImageNavigator;
