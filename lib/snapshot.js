const encodedBlobs = new WeakMap();

async function encodeBlob(blob) {
  if (!blob) return null;
  let result = encodedBlobs.get(blob);
  if (!result) {
    result = blob
      .arrayBuffer()
      .then(
        (bytes) =>
          `data:${blob.type || "image/png"};base64,${Buffer.from(bytes).toString("base64")}`,
      );
    encodedBlobs.set(blob, result);
  }
  return result;
}

function decodeDataUrl(url) {
  if (typeof url !== "string" || !url.startsWith("data:image/"))
    throw new TypeError("An image snapshot requires an image data URL.");
  const comma = url.indexOf(",");
  if (comma < 0) throw new TypeError("Invalid image snapshot data URL.");
  const header = url.slice(5, comma);
  const bytes = /;base64$/i.test(header)
    ? Buffer.from(url.slice(comma + 1), "base64")
    : Buffer.from(decodeURIComponent(url.slice(comma + 1)));
  return new Blob([bytes], { type: header.split(";")[0] });
}

module.exports = { encodeBlob, decodeDataUrl };
