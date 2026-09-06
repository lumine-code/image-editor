const assert = require("node:assert/strict");
const test = require("node:test");
const selection = require("../lib/selection");

test("selection bounds retain the part outside the image", () => {
  assert.deepEqual(selection.getSelectionBounds({ x: -10, y: -20 }, { x: 50, y: 60 }), {
    left: -10,
    top: -20,
    width: 60,
    height: 80,
  });
});

test("selection area contains only the intersection with the image", () => {
  assert.deepEqual(
    selection.getSelectionArea({ x: -10, y: -20 }, { x: 50, y: 60 }, 100, 100, true),
    {
      hasSelection: true,
      left: 0,
      top: 0,
      width: 50,
      height: 60,
    },
  );
});
