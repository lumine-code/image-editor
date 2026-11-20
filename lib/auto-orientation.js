const { fork } = require("node:child_process");

async function detectOrientation(image, { signal } = {}) {
  // Tesseract's Node worker cannot run inside an Electron renderer.
  const processWorker = fork(__filename, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" },
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    signal,
    windowsHide: true,
    timeout: 30_000,
  });
  try {
    return await new Promise((resolve, reject) => {
      processWorker.once("error", reject);
      processWorker.once("exit", () =>
        reject(new Error("Orientation process exited before returning a result")),
      );
      processWorker.once("message", ({ orientation, error }) => {
        if (error) reject(new Error(error));
        else resolve(orientation);
      });
      processWorker.send(image, (error) => {
        if (error) reject(error);
      });
    });
  } finally {
    processWorker.kill();
  }
}

async function runDetection(image) {
  const { createWorker, OEM } = require("tesseract.js");
  const { langPath } = require("@tesseract.js-data/osd");
  const worker = await createWorker("osd", OEM.TESSERACT_ONLY, {
    langPath,
    cacheMethod: "none",
  });
  try {
    const { data } = await worker.detect(image);
    return { degrees: data.orientation_degrees, confidence: data.orientation_confidence };
  } finally {
    await worker.terminate();
  }
}

if (require.main === module && process.send) {
  // eslint-disable-next-line n/no-process-exit -- This child has no owner after IPC disconnects.
  process.once("disconnect", () => process.exit());
  process.once("message", async (image) => {
    try {
      process.send({ orientation: await runDetection(image) });
    } catch (error) {
      process.send({ error: String(error) });
    }
  });
}

module.exports = { detectOrientation };
