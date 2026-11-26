/**
 * File operations module
 * Contains save and file metadata operations
 */

const fs = require("fs");
const path = require("path");
const { canvasToBlob } = require("./transforms");

function getSaveDialogOptions(defaultPath) {
  return {
    defaultPath: defaultPath || "untitled.png",
    filters: [
      { name: "PNG Images", extensions: ["png"] },
      { name: "JPEG Images", extensions: ["jpg", "jpeg"] },
      { name: "All Files", extensions: ["*"] },
    ],
  };
}

async function chooseSavePath(imageElement, defaultPath) {
  const window = lumine.workspace.getWindowForElement(imageElement) ?? lumine.window;
  const result = await window.showSaveDialog(getSaveDialogOptions(defaultPath));
  return result.canceled ? null : result.filePath || null;
}

async function saveImage(imageElement, filePath, operation, beforeWrite) {
  operation.signal.throwIfAborted();
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

  // Capture the current pixels before yielding to the encoder.
  const canvas = imageElement.ownerDocument.createElement("canvas");
  canvas.width = imageElement.naturalWidth;
  canvas.height = imageElement.naturalHeight;
  canvas.getContext("2d").drawImage(imageElement, 0, 0);

  const blob = await canvasToBlob(canvas, mimeType);
  operation.signal.throwIfAborted();
  if (!blob) throw new Error("Could not encode the image");
  const buffer = Buffer.from(await blob.arrayBuffer());
  if (beforeWrite && !(await beforeWrite())) return null;
  operation.commit();
  await fs.promises.writeFile(filePath, buffer);
  return { stats: getFileStats(filePath) };
}

// Get file stats
function getFileStats(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

module.exports = {
  getSaveDialogOptions,
  chooseSavePath,
  saveImage,
  getFileStats,
};
