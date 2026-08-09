/**
 * File operations module
 * Contains save and file metadata operations
 */

const fs = require("fs");
const path = require("path");

// Save image to the current path
async function saveImage(imageElement, filePath, onSuccess, onError) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

    // Create canvas from current image
    const canvas = document.createElement("canvas");
    canvas.width = imageElement.naturalWidth;
    canvas.height = imageElement.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imageElement, 0, 0);

    // Convert to blob and save
    canvas.toBlob(async (blob) => {
      try {
        const buffer = Buffer.from(await blob.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        if (onSuccess) onSuccess(filePath);
      } catch (error) {
        if (onError) onError(error);
      }
    }, mimeType);
  } catch (error) {
    if (onError) onError(error);
  }
}

// Save image with dialog (Save As)
async function saveImageAs(imageElement, defaultPath, onSuccess, onError) {
  try {
    const result = await atom.window.showSaveDialog({
      defaultPath: defaultPath || "untitled.png",
      filters: [
        { name: "PNG Images", extensions: ["png"] },
        { name: "JPEG Images", extensions: ["jpg", "jpeg"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return;
    }

    const savePath = result.filePath;
    const ext = path.extname(savePath).toLowerCase();
    const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

    // Create canvas from current image
    const canvas = document.createElement("canvas");
    canvas.width = imageElement.naturalWidth;
    canvas.height = imageElement.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imageElement, 0, 0);

    // Convert to blob and save
    canvas.toBlob(async (blob) => {
      try {
        const buffer = Buffer.from(await blob.arrayBuffer());
        fs.writeFileSync(savePath, buffer);
        if (onSuccess) onSuccess(savePath);
      } catch (error) {
        if (onError) onError(error);
      }
    }, mimeType);
  } catch (error) {
    if (onError) onError(error);
  }
}

// Get file stats
function getFileStats(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

// Format bytes to human readable string
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

// Format date to locale string
function formatDate(date) {
  return date.toLocaleDateString() + " " + date.toLocaleTimeString();
}

module.exports = {
  saveImage,
  saveImageAs,
  getFileStats,
  formatBytes,
  formatDate,
};
