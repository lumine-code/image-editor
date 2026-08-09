/**
 * Image navigation module
 * Contains file list management and navigation
 */

const fs = require("fs");
const path = require("path");

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
      files: [],
      currentIndex: -1,
    };
    this.treeView = options.treeView || null;
  }

  // Set tree-view reference for faster file listing
  setTreeView(treeView) {
    this.treeView = treeView;
  }

  // Get sorted list of image files in directory
  async getFileList(currentPath) {
    if (!currentPath) {
      return { directory: null, files: [], currentIndex: -1 };
    }
    const directory = path.dirname(currentPath);

    // Check if cache is valid for the directory
    if (this.fileListCache.directory === directory && this.fileListCache.files.length > 0) {
      // Update current index based on actual current file
      this.fileListCache.currentIndex = this.fileListCache.files.findIndex(
        (f) => path.normalize(f).toLowerCase() === path.normalize(currentPath).toLowerCase(),
      );
      return this.fileListCache;
    }

    // Try to get files from tree-view first (much faster!)
    let files = [];

    if (this.treeView && this.treeView.entryForPath) {
      try {
        const dirEntry = this.treeView.entryForPath(directory);
        if (dirEntry && dirEntry.children) {
          files = Array.from(dirEntry.children)
            .filter((entry) => {
              if (!entry.file || !entry.path) return false;
              const ext = path.extname(entry.path).toLowerCase();
              return this.extensions.includes(ext);
            })
            .map((entry) => entry.path)
            .sort((a, b) =>
              path.basename(a).localeCompare(path.basename(b), undefined, {
                numeric: true,
                sensitivity: "base",
              }),
            );
        }
      } catch {
        // Fall through to filesystem
      }
    }

    // Fallback to filesystem if tree-view didn't work
    if (files.length === 0) {
      try {
        const entries = await fs.promises.readdir(directory);
        files = entries
          .filter((file) => this.extensions.includes(path.extname(file).toLowerCase()))
          .map((file) => path.join(directory, file))
          .sort((a, b) =>
            path.basename(a).localeCompare(path.basename(b), undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          );
      } catch (e) {
        console.error("Error reading directory:", e);
        return {
          directory: null,
          files: [],
          currentIndex: -1,
        };
      }
    }

    // Update cache
    this.fileListCache.directory = directory;
    this.fileListCache.files = files;
    this.fileListCache.currentIndex = files.findIndex(
      (f) => path.normalize(f).toLowerCase() === path.normalize(currentPath).toLowerCase(),
    );

    return this.fileListCache;
  }

  // Invalidate file list cache
  invalidateCache() {
    this.fileListCache.directory = null;
    this.fileListCache.files = [];
    this.fileListCache.currentIndex = -1;
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

  // Encode file path for URL
  encodeFilePath(filePath) {
    return `file://${encodeURI(filePath.replace(/\\/g, "/"))
      .replace(/#/g, "%23")
      .replace(/\?/g, "%3F")}`;
  }

  // Get position info string
  async getPositionInfo(currentPath) {
    const fileList = await this.getFileList(currentPath);
    if (fileList.currentIndex >= 0 && fileList.files.length > 0) {
      return `${fileList.currentIndex + 1} / ${fileList.files.length}`;
    }
    return null;
  }
}

module.exports = ImageNavigator;
