const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ZoomController = require("../lib/zoom-controller");

describe("preset zoom levels", () => {
  it("advances and reverses through the menu presets", () => {
    const controller = new ZoomController();
    assert.deepEqual(controller.levels, [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);
    for (const scale of [1.25, 1.5, 2, 3, 4]) {
      controller.setZoom(controller.getNextZoomLevel());
      assert.equal(controller.getZoom(), scale);
    }
    assert.equal(controller.getNextZoomLevel(), null);
    for (const scale of [3, 2, 1.5, 1.25, 1, 0.75, 0.5]) {
      controller.setZoom(controller.getPreviousZoomLevel());
      assert.equal(controller.getZoom(), scale);
    }
    assert.equal(controller.getPreviousZoomLevel(), null);
  });

  it("chooses the neighboring presets from an intermediate scale", () => {
    const controller = new ZoomController();
    controller.setZoom(0.73);
    assert.equal(controller.getNextZoomLevel(), 0.75);
    assert.equal(controller.getPreviousZoomLevel(), 0.5);
    controller.setZoom(0.25);
    assert.equal(controller.getNextZoomLevel(), 0.5);
    assert.equal(controller.getPreviousZoomLevel(), null);
    controller.setZoom(6);
    assert.equal(controller.getNextZoomLevel(), null);
    assert.equal(controller.getPreviousZoomLevel(), 4);
  });

  it("ignores floating-point drift around a preset and at the bounds", () => {
    const controller = new ZoomController();
    for (const drift of [-1e-10, 0, 1e-10]) {
      controller.setZoom(1.25 + drift);
      assert.equal(controller.getNextZoomLevel(), 1.5);
      assert.equal(controller.getPreviousZoomLevel(), 1);
      controller.setZoom(4 + drift);
      assert.equal(controller.getNextZoomLevel(), null);
      controller.setZoom(0.5 + drift);
      assert.equal(controller.getPreviousZoomLevel(), null);
    }
  });
});
