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
    this.extensions = options.extensions || paths.NAVIGABLE_EXTENSIONS;
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

  // Get sorted list of image files in directory
  async getFileList(currentPath) {
    const generation = ++this.listGeneration;
    if (!currentPath) {
      return { directory: null, files: [], currentIndex: -1 };
    }
    const directory = path.dirname(currentPath);

    // Normalize separators and fold Windows case, where the watcher, tree
    // view and readdir can spell the same directory differently.
    if (
      this.fileListCache.directoryKey === paths.normalizePathKey(directory) &&
      this.fileListCache.files.length > 0
    ) {
      return this._locate(currentPath, this.fileListCache, generation);
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

    const listing = this._buildListing(directory, files);
    if (generation === this.listGeneration) this.fileListCache = listing;
    return this._locate(currentPath, listing, generation);
  }

  // Invalidate file list cache
  invalidateCache() {
    this.listGeneration++;
    this.fileListCache = this._buildListing(null, []);
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
