/**
 * Image navigation module
 * Contains file list management and navigation
 */

const fs = require("fs");
const path = require("path");
const paths = require("./paths");

class ImageNavigator {
  constructor(options = {}) {
    this.extensions = options.extensions || paths.NAVIGABLE_EXTENSIONS;
    this.listDirectoryFiles = options.listDirectoryFiles;
    this.watchDirectory = options.watchDirectory;
    this.invalidationListeners = new Set();
    this.listGeneration = 0;
    this.fileListCache = this._buildListing(null, []);
  }

  /**
   * Build a listing with its lookup, independently of any in-flight read.
   *
   * `directory` is kept alongside its normalized key (case-folded on Windows)
   * because it is what a person reads in a debugger.
   */
  _buildListing(directory, files) {
    const index = new Map();
    for (let i = 0; i < files.length; i++) index.set(paths.normalizePathKey(files[i]), i);
    return {
      directory,
      directoryKey: directory && paths.normalizePathKey(directory),
      files,
      index,
      currentIndex: -1,
    };
  }

  /** Return a stable snapshot, with the cursor belonging to this request. */
  async _locate(currentPath, listing, generation) {
    let currentIndex = listing.index.get(paths.normalizePathKey(currentPath)) ?? -1;
    if (currentIndex < 0 && process.platform !== "win32") {
      // A case-insensitive POSIX volume can accept another spelling. Resolve
      // only that rare miss, never stat every entry in a normal listing.
      const name = path.basename(currentPath).toLowerCase();
      const candidates = listing.files.filter((file) => path.basename(file).toLowerCase() === name);
      if (candidates.length === 1) {
        try {
          const [requested, listed] = await Promise.all([
            fs.promises.stat(currentPath, { bigint: true }),
            fs.promises.stat(candidates[0], { bigint: true }),
          ]);
          if (requested.ino !== 0n && requested.dev === listed.dev && requested.ino === listed.ino)
            currentIndex = listing.files.indexOf(candidates[0]);
        } catch {
          // A nonexistent spelling is not an alias.
        }
      }
    }
    if (listing === this.fileListCache && generation === this.listGeneration)
      listing.currentIndex = currentIndex;
    return { directory: listing.directory, files: listing.files.slice(), currentIndex };
  }

  // Narrow the service's ordered, visible files to navigable images.
  async getFileList(currentPath) {
    const generation = ++this.listGeneration;
    if (!currentPath) {
      this.resetDirectoryWatcher();
      this.fileListCache = this._buildListing(null, []);
      return { directory: null, files: [], currentIndex: -1 };
    }
    const directory = path.dirname(currentPath);

    // Normalize separators and fold Windows case across service and item paths.
    if (
      this.fileListCache.directoryKey === paths.normalizePathKey(directory) &&
      this.fileListCache.files.length > 0
    ) {
      return this._locate(currentPath, this.fileListCache, generation);
    }

    let files;
    let cacheable = true;
    try {
      if (this.watchDirectory) cacheable = await this.ensureDirectoryWatcher(directory);
      const providedFiles = (await this.listDirectoryFiles?.(directory)) ?? [];
      // The service owns order and visibility. Never sort its result again.
      files = providedFiles.filter((file) =>
        this.extensions.includes(path.extname(file).toLowerCase()),
      );
    } catch (e) {
      console.error("Error reading directory:", e);
      return {
        directory: null,
        files: [],
        currentIndex: -1,
      };
    }

    const listing = this._buildListing(directory, files);
    if (cacheable && generation === this.listGeneration) this.fileListCache = listing;
    return this._locate(currentPath, listing, generation);
  }

  async ensureDirectoryWatcher(directory) {
    const key = paths.normalizePathKey(directory);
    let watcher;
    try {
      if (this.watchedDirectoryKey !== key) {
        this.resetDirectoryWatcher();
        this.watchedDirectoryKey = key;
        this.directoryWatcher = this.watchDirectory(directory, () => this.invalidateCache());
      }
      watcher = this.directoryWatcher;
      await watcher?.ready;
      return watcher != null && watcher === this.directoryWatcher;
    } catch {
      if (!this.directoryWatcher || this.directoryWatcher === watcher) this.resetDirectoryWatcher();
      // A readable folder can be unavailable to the watcher. Keep navigation
      // working from fresh service snapshots until watching succeeds.
      return false;
    }
  }

  // Invalidate file list cache
  invalidateCache() {
    this.listGeneration++;
    this.fileListCache = this._buildListing(null, []);
    for (const callback of this.invalidationListeners) callback();
  }

  onDidInvalidate(callback) {
    this.invalidationListeners.add(callback);
    return { dispose: () => this.invalidationListeners.delete(callback) };
  }

  resetDirectoryWatcher() {
    this.directoryWatcher?.dispose();
    this.directoryWatcher = null;
    this.watchedDirectoryKey = null;
  }

  destroy() {
    this.resetDirectoryWatcher();
    this.invalidationListeners.clear();
    this.invalidateCache();
  }

  /**
   * The file `direction` steps away in an already-fetched listing.
   *
   * Synchronous, and takes `cycle` rather than reading it, so a caller can
   * decide about the boundary and take the step from one snapshot of the
   * listing instead of two — and so this is testable without the editor.
   *
   * @param {object} fileList as returned by getFileList
   * @param {number} direction 1 or -1
   * @param {{cycle: boolean}} options
   * @returns {string|null} null at a boundary when not cycling
   */
  stepFrom(fileList, direction, { cycle }) {
    if (fileList.files.length === 0 || fileList.currentIndex === -1) return null;

    let newIndex = fileList.currentIndex + direction;
    if (newIndex < 0) {
      newIndex = cycle ? fileList.files.length - 1 : null;
    } else if (newIndex >= fileList.files.length) {
      newIndex = cycle ? 0 : null;
    }

    return newIndex !== null ? fileList.files[newIndex] : null;
  }

  // Get adjacent image path
  async getAdjacentImage(currentPath, direction) {
    const fileList = await this.getFileList(currentPath);
    const cycle = lumine.config.get("image-editor.scrollCycle") !== false;
    return this.stepFrom(fileList, direction, { cycle });
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

  // Where this file sits among the images beside it, for the properties dialog.
  async getPositionInfo(currentPath) {
    const fileList = await this.getFileList(currentPath);
    if (fileList.currentIndex >= 0 && fileList.files.length > 0) {
      return `${fileList.currentIndex + 1} / ${fileList.files.length}`;
    }
    return null;
  }
}

module.exports = ImageNavigator;
