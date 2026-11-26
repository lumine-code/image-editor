/**
 * Transfer the source pixels to a single-use worker, then transfer the result back.
 * The caller recreates ImageData from the resulting Uint8ClampedArray.
 */
async function applyFilter(imageData, name, args = [], signal) {
  signal?.throwIfAborted();
  const { data, width, height } = imageData;
  const entry = require.resolve("./filter-worker");
  let url;
  let worker;
  let onAbort;

  try {
    if (process.type === "renderer") {
      // Use Chromium's worker platform in Electron. Lumine enables Node
      // integration in workers, so the bootstrap can load the package from asar.
      const source = `require(${JSON.stringify(entry)}).connect(self);`;
      url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Chromium Worker in Electron.
      worker = new globalThis.Worker(url);
    } else {
      const { Worker } = require("node:worker_threads");
      worker = new Worker(entry);
    }

    return await new Promise((resolve, reject) => {
      const onMessageError = () =>
        reject(new Error("Unable to read the image filter worker result"));
      if (url) {
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => {
          event.preventDefault();
          reject(new Error(event.message || "Image filter worker failed"));
        };
        worker.onmessageerror = onMessageError;
      } else {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("messageerror", onMessageError);
        worker.once("exit", (code) =>
          reject(new Error(`Image filter worker exited with code ${code}`)),
        );
      }
      onAbort = () => reject(signal.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.postMessage({ imageData: { data, width, height }, name, args }, [data.buffer]);
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await worker?.terminate();
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }
}

module.exports = { applyFilter };
