/**
 * Pins the pixel output of every filter before the pipeline is rewritten.
 *
 * The reference implementations here are written from each filter's definition
 * rather than copied from its loop, so they stay a specification when the loops
 * are replaced by lookup tables and a narrower sharpen kernel. Each stores into
 * a Uint8ClampedArray, which is what makes the comparison exact: assignment
 * rounds half-to-even, and a reference that rounded any other way would report
 * differences the shipped code never had.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const filters = require("../lib/filters");
const { img, noise, clamped, maxAbsDiff } = require("./helpers");

const LUMA_601 = [0.299, 0.587, 0.114];

describe("applyGrayscaleAmount", () => {
  it("mixes toward Rec.601 luma by the given percentage", () => {
    const pixel = [200, 100, 50, 255];
    const gray = LUMA_601[0] * 200 + LUMA_601[1] * 100 + LUMA_601[2] * 50;

    for (const amount of [0, 25, 50, 100]) {
      const subject = img(pixel);
      filters.applyGrayscaleAmount(subject, amount);
      const factor = amount / 100;
      for (let c = 0; c < 3; c++) {
        assert.equal(
          subject.data[c],
          clamped(pixel[c] + (gray - pixel[c]) * factor),
          `channel ${c} at amount ${amount}`,
        );
      }
      assert.equal(subject.data[3], 255, "alpha");
    }
  });

  it("uses Rec.601 and not the Rec.709 luma CSS grayscale() would apply", () => {
    // Guards the note in the plan: moving this to ctx.filter would silently
    // shift every red and green. If someone does, this fails rather than the
    // difference reaching an image.
    const subject = img([255, 0, 0, 255]);
    filters.applyGrayscaleAmount(subject, 100);
    assert.equal(subject.data[0], clamped(0.299 * 255), "Rec.601 luma of pure red");
    assert.notEqual(subject.data[0], clamped(0.2126 * 255), "must not be Rec.709");
  });

  it("clamps the amount to 0..100", () => {
    const over = img([200, 100, 50, 255]);
    const at100 = img([200, 100, 50, 255]);
    filters.applyGrayscaleAmount(over, 500);
    filters.applyGrayscaleAmount(at100, 100);
    assert.deepEqual([...over.data], [...at100.data]);

    const under = img([200, 100, 50, 255]);
    filters.applyGrayscaleAmount(under, -80);
    assert.deepEqual([...under.data], [200, 100, 50, 255], "negative behaves as 0");
  });
});

describe("invertColors", () => {
  it("subtracts each colour channel from 255 and leaves alpha alone", () => {
    const subject = img([0, 128, 255, 7, 10, 20, 30, 0]);
    filters.invertColors(subject);
    assert.deepEqual([...subject.data], [255, 127, 0, 7, 245, 235, 225, 0]);
  });

  it("is its own inverse", () => {
    const original = noise(8, 8, 42);
    const subject = img(original.data);
    filters.invertColors(subject);
    filters.invertColors(subject);
    assert.deepEqual([...subject.data], [...original.data]);
  });
});

describe("applySepia", () => {
  it("applies the standard matrix, clamped at the top only", () => {
    const pixel = [120, 200, 60, 128];
    const subject = img(pixel);
    filters.applySepia(subject);
    const [r, g, b] = pixel;
    assert.equal(subject.data[0], clamped(Math.min(255, r * 0.393 + g * 0.769 + b * 0.189)));
    assert.equal(subject.data[1], clamped(Math.min(255, r * 0.349 + g * 0.686 + b * 0.168)));
    assert.equal(subject.data[2], clamped(Math.min(255, r * 0.272 + g * 0.534 + b * 0.131)));
    assert.equal(subject.data[3], 128, "alpha untouched");
  });

  it("clips white's red and green but lets blue fall, which is what warms it", () => {
    const subject = img([255, 255, 255, 255]);
    filters.applySepia(subject);
    assert.deepEqual([...subject.data], [255, 255, clamped(255 * 0.937), 255]);
  });
});

describe("applyBrightnessContrast", () => {
  const reference = (bytes, brightness, contrast) => {
    const out = Uint8ClampedArray.from(bytes);
    const shift = brightness * 2.55;
    const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    for (let i = 0; i < out.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = factor * (bytes[i + c] - 128) + 128 + shift;
        out[i + c] = Math.min(255, Math.max(0, v));
      }
    }
    return out;
  };

  it("matches the reference across the parameter extremes", () => {
    const source = noise(16, 16, 7);
    for (const [brightness, contrast] of [
      [0, 0],
      [100, 0],
      [-100, 0],
      [0, 100],
      [0, -100],
      [100, 100],
      [-100, -100],
      [37, -14],
    ]) {
      const subject = img(source.data);
      filters.applyBrightnessContrast(subject, brightness, contrast);
      const { worst, at } = maxAbsDiff(subject.data, reference(source.data, brightness, contrast));
      assert.equal(
        worst,
        0,
        `brightness ${brightness}, contrast ${contrast} differs at byte ${at}`,
      );
    }
  });

  it("is identity at zero and leaves alpha alone", () => {
    const source = noise(4, 4, 3);
    const subject = img(source.data);
    filters.applyBrightnessContrast(subject, 0, 0);
    assert.deepEqual([...subject.data], [...source.data]);
  });
});

describe("applySaturation", () => {
  it("is identity at zero", () => {
    const source = noise(4, 4, 11);
    const subject = img(source.data);
    filters.applySaturation(subject, 0);
    assert.deepEqual([...subject.data], [...source.data]);
  });

  it("collapses to Rec.601 grey at -100", () => {
    const source = noise(4, 4, 12);
    const desaturated = img(source.data);
    filters.applySaturation(desaturated, -100);

    const fullGrey = img(source.data);
    filters.applyGrayscaleAmount(fullGrey, 100);
    assert.equal(maxAbsDiff(desaturated.data, fullGrey.data).worst, 0);
  });

  it("pushes away from grey at +100", () => {
    const subject = img([150, 100, 120, 255]);
    filters.applySaturation(subject, 100);
    const grey = LUMA_601[0] * 150 + LUMA_601[1] * 100 + LUMA_601[2] * 120;
    for (const [c, v] of [
      [0, 150],
      [1, 100],
      [2, 120],
    ]) {
      assert.equal(subject.data[c], clamped(Math.min(255, Math.max(0, grey + 2 * (v - grey)))));
    }
  });
});

describe("applyHueShift", () => {
  it("is exact identity at 0 and at 360 degrees", () => {
    for (const degrees of [0, 360]) {
      const source = noise(8, 8, 5);
      const subject = img(source.data);
      filters.applyHueShift(subject, degrees);
      const { worst, at } = maxAbsDiff(subject.data, source.data);
      assert.equal(worst, 0, `${degrees} degrees is not identity, byte ${at}`);
    }
  });

  it("walks the primaries round at 120 degree steps", () => {
    const red = img([255, 0, 0, 255]);
    filters.applyHueShift(red, 120);
    assert.deepEqual([...red.data], [0, 255, 0, 255], "red to green");

    const green = img([0, 255, 0, 255]);
    filters.applyHueShift(green, 120);
    assert.deepEqual([...green.data], [0, 0, 255, 255], "green to blue");
  });

  it("leaves greys alone, having no hue to rotate", () => {
    const subject = img([128, 128, 128, 255]);
    filters.applyHueShift(subject, 90);
    assert.deepEqual([...subject.data], [128, 128, 128, 255]);
  });
});

describe("applyPosterize", () => {
  const reference = (bytes, levels) => {
    const out = Uint8ClampedArray.from(bytes);
    const step = 255 / (levels - 1);
    for (let i = 0; i < out.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        out[i + c] = Math.round(Math.round(bytes[i + c] / step) * step);
      }
    }
    return out;
  };

  it("matches the reference over a full ramp at every level the dialog offers", () => {
    // A ramp rather than noise, so every input byte 0..255 is exercised — the
    // lookup table replacing this has to agree on all 256, not on a sample.
    const ramp = new Uint8ClampedArray(256 * 4);
    for (let v = 0; v < 256; v++) {
      ramp[v * 4] = v;
      ramp[v * 4 + 1] = 255 - v;
      ramp[v * 4 + 2] = (v * 7) % 256;
      ramp[v * 4 + 3] = v;
    }
    for (let levels = 2; levels <= 32; levels++) {
      const subject = img(ramp);
      filters.applyPosterize(subject, levels);
      const { worst, at } = maxAbsDiff(subject.data, reference(ramp, levels));
      assert.equal(worst, 0, `levels ${levels} differs at byte ${at}`);
    }
  });

  it("snaps every channel to an endpoint at two levels, and keeps alpha", () => {
    // 128 rounds up: 128/255 is 0.502, so mid grey lands on white, not black.
    const subject = img([10, 200, 128, 64]);
    filters.applyPosterize(subject, 2);
    assert.deepEqual([...subject.data], [0, 255, 255, 64]);
  });
});

describe("autoAdjustColors", () => {
  it("stretches each channel to the full range independently", () => {
    const subject = img([50, 100, 10, 255, 150, 100, 60, 255]);
    filters.autoAdjustColors(subject);
    // Red spans 50..150, blue 10..60, green is flat at 100.
    assert.equal(subject.data[0], 0);
    assert.equal(subject.data[4], 255);
    assert.equal(subject.data[2], 0);
    assert.equal(subject.data[6], 255);
    assert.equal(subject.data[1], 100, "a flat channel is left alone");
    assert.equal(subject.data[5], 100, "a flat channel is left alone");
  });

  it("leaves a uniform image untouched, the zero-range branch", () => {
    const subject = img([77, 77, 77, 255, 77, 77, 77, 128]);
    filters.autoAdjustColors(subject);
    assert.deepEqual([...subject.data], [77, 77, 77, 255, 77, 77, 77, 128]);
  });

  it("is idempotent once every channel spans the range", () => {
    const source = noise(8, 8, 9);
    const once = img(source.data);
    filters.autoAdjustColors(once);
    const twice = img(once.data);
    filters.autoAdjustColors(twice);
    assert.equal(maxAbsDiff(once.data, twice.data).worst, 0);
  });
});

describe("applySharpenKernel", () => {
  /**
   * The kernel is [0,-s,0, -s,1+4s,-s, 0,-s,0]. Written out as the full 3x3
   * convolution it is defined by, including the four zero taps, so that a
   * five-tap rewrite has something independent to agree with.
   */
  const reference = (bytes, width, height, strength) => {
    const kernel = [0, -strength, 0, -strength, 1 + 4 * strength, -strength, 0, -strength, 0];
    const out = Uint8ClampedArray.from(bytes);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              sum += bytes[((y + ky) * width + (x + kx)) * 4 + c] * kernel[(ky + 1) * 3 + kx + 1];
            }
          }
          out[(y * width + x) * 4 + c] = Math.min(255, Math.max(0, sum));
        }
      }
    }
    return out;
  };

  it("matches the reference convolution over a noise buffer", () => {
    const [width, height] = [24, 18];
    const source = noise(width, height, 2024);
    for (const strength of [0, 0.5, 1, 2.5]) {
      const subject = img(source.data);
      filters.applySharpenKernel(subject, width, height, strength);
      const { worst, at } = maxAbsDiff(
        subject.data,
        reference(source.data, width, height, strength),
      );
      assert.equal(worst, 0, `strength ${strength} differs at byte ${at}`);
    }
  });

  it("copies the border through untouched", () => {
    const [width, height] = [5, 5];
    const source = noise(width, height, 4);
    const subject = img(source.data);
    filters.applySharpenKernel(subject, width, height, 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (y !== 0 && y !== height - 1 && x !== 0 && x !== width - 1) continue;
        const i = (y * width + x) * 4;
        assert.deepEqual(
          [...subject.data.slice(i, i + 4)],
          [...source.data.slice(i, i + 4)],
          `border pixel ${x},${y}`,
        );
      }
    }
  });

  it("preserves alpha in the interior", () => {
    const [width, height] = [3, 3];
    const bytes = new Uint8ClampedArray(width * height * 4).fill(120);
    bytes[(1 * 3 + 1) * 4 + 3] = 33;
    const subject = img(bytes);
    filters.applySharpenKernel(subject, width, height, 1);
    assert.equal(subject.data[(1 * 3 + 1) * 4 + 3], 33);
  });

  it("is identity at strength zero", () => {
    const [width, height] = [6, 6];
    const source = noise(width, height, 6);
    const subject = img(source.data);
    filters.applySharpenKernel(subject, width, height, 0);
    assert.equal(maxAbsDiff(subject.data, source.data).worst, 0);
  });
});
