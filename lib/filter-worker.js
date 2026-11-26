const filters = require("./filters");

function runFilter({ imageData, name, args }, port) {
  if (!Object.hasOwn(filters, name)) throw new Error(`Unknown image filter: ${name}`);
  filters[name](imageData, ...args);
  port.postMessage(imageData.data, [imageData.data.buffer]);
}

if (require.main === module) {
  const { parentPort } = require("node:worker_threads");
  parentPort.once("message", (request) => runFilter(request, parentPort));
}

exports.connect = (scope) => {
  scope.onmessage = ({ data }) => runFilter(data, scope);
};
