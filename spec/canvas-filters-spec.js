const canvasFilters = require("../lib/canvas-filters");

/** A canvas filled with one colour, so any edge artefact stands out. */
function solid(width, height, colour = "rgb(40, 90, 200)") {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

function pixelAt(canvas, x, y) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

describe("canvas filters", () => {
  it("reports whether the platform will apply a filter at all", () => {
    // An unparsed filter string leaves the property at "none" and the draw
    // then quietly succeeds unblurred, so this has to be asked rather than
    // assumed.
    expect(canvasFilters.supportsCanvasFilter()).toBe(true);
  });

  describe("marginForSigma", () => {
    it("reaches past where a blur of that radius can", () => {
      expect(canvasFilters.marginForSigma(10)).toBe(32);
      expect(canvasFilters.marginForSigma(100)).toBe(302);
    });

    it("never returns nothing, however small the radius", () => {
      expect(canvasFilters.marginForSigma(0)).toBeGreaterThan(0);
      expect(canvasFilters.marginForSigma(0.1)).toBeGreaterThan(0);
    });
  });

  describe("createBlurSource", () => {
    it("grows the region by the margin on every side", () => {
      const source = solid(50, 40);
      const area = { left: 10, top: 10, width: 20, height: 15 };
      const scratch = canvasFilters.createBlurSource(source, 50, 40, area, 5);

      expect(scratch.width).toBe(30);
      expect(scratch.height).toBe(25);
    });

    it("takes real neighbours for a region well inside the image", () => {
      const source = solid(50, 40, "rgb(10, 20, 30)");
      const ctx = source.getContext("2d");
      ctx.fillStyle = "rgb(200, 100, 50)";
      ctx.fillRect(20, 20, 5, 5); // a mark outside the region but inside the margin

      const area = { left: 25, top: 25, width: 10, height: 10 };
      const scratch = canvasFilters.createBlurSource(source, 50, 40, area, 8);

      // The mark sits at (20,20), which is (3,3) in a scratch whose origin is
      // (17,17). If the margin were not real pixels it would not be there.
      expect(pixelAt(scratch, 3, 3)).toEqual([200, 100, 50, 255]);
    });

    it("replicates the boundary where the region runs off the image", () => {
      const source = solid(20, 20, "rgb(70, 140, 210)");
      const area = { left: 0, top: 0, width: 5, height: 5 };
      const margin = 6;
      const scratch = canvasFilters.createBlurSource(source, 20, 20, area, margin);

      // Everything left of and above the image is the corner pixel repeated,
      // which is exactly what clamping to the edge means.
      expect(pixelAt(scratch, 0, 0)).toEqual([70, 140, 210, 255]);
      expect(pixelAt(scratch, margin - 1, 0)).toEqual([70, 140, 210, 255]);
      expect(pixelAt(scratch, 0, margin - 1)).toEqual([70, 140, 210, 255]);
    });
  });

  describe("blurRegion", () => {
    it("leaves a solid image solid, corners included", () => {
      // The one test that catches a margin that is too small or a geometry
      // that is off by one: either shows up as a darkened or translucent band
      // around the edge, and on a single colour nothing else can.
      const canvas = solid(60, 45);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      expect(canvasFilters.blurRegion(ctx, { left: 0, top: 0, width: 60, height: 45 }, 100)).toBe(
        true,
      );

      for (const [x, y] of [
        [0, 0],
        [59, 0],
        [0, 44],
        [59, 44],
        [30, 0],
        [0, 22],
        [30, 22],
      ]) {
        expect(pixelAt(canvas, x, y)).toEqual([40, 90, 200, 255], `pixel ${x},${y}`);
      }
    });

    it("leaves everything outside the region untouched", () => {
      const canvas = solid(60, 60, "rgb(0, 0, 0)");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "rgb(255, 255, 255)";
      ctx.fillRect(20, 20, 20, 20);

      canvasFilters.blurRegion(ctx, { left: 20, top: 20, width: 20, height: 20 }, 4);

      // A hard edge at the boundary: the pixel just outside is still black.
      expect(pixelAt(canvas, 19, 30)).toEqual([0, 0, 0, 255]);
      expect(pixelAt(canvas, 40, 30)).toEqual([0, 0, 0, 255]);
    });

    it("blurs a region using content from beyond it", () => {
      // Half black, half white, with the region entirely inside the white
      // half but close enough to the seam for the blur to reach it. If the
      // region were its own source, its edge would stay pure white.
      const canvas = solid(80, 40, "rgb(255, 255, 255)");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "rgb(0, 0, 0)";
      ctx.fillRect(0, 0, 40, 40);

      canvasFilters.blurRegion(ctx, { left: 40, top: 0, width: 20, height: 40 }, 6);

      const [r] = pixelAt(canvas, 41, 20);
      expect(r).toBeLessThan(255);
      expect(r).toBeGreaterThan(0);
    });

    it("does nothing at all for a zero radius or an empty region", () => {
      const canvas = solid(10, 10);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      expect(canvasFilters.blurRegion(ctx, { left: 0, top: 0, width: 10, height: 10 }, 0)).toBe(
        true,
      );
      expect(canvasFilters.blurRegion(ctx, { left: 0, top: 0, width: 0, height: 0 }, 5)).toBe(true);
      expect(pixelAt(canvas, 5, 5)).toEqual([40, 90, 200, 255]);
    });
  });
});
