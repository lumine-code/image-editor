/**
 * Image filters and adjustments module
 * Contains blur, sharpen, color adjustments, and effects
 */

// Fast Gaussian Blur implementation using box blur approximation
function fastGaussianBlur(imageData, width, height, radius) {
  const pixels = imageData.data;
  const boxes = boxesForGauss(radius, 3); // 3 passes for good approximation

  // Apply horizontal and vertical box blurs
  for (let i = 0; i < 3; i++) {
    boxBlur(pixels, width, height, (boxes[i] - 1) / 2);
  }
}

// Calculate box sizes for Gaussian approximation
function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;

  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);

  const sizes = [];
  for (let i = 0; i < n; i++) {
    sizes.push(i < m ? wl : wu);
  }
  return sizes;
}

// Box blur implementation (horizontal + vertical)
function boxBlur(pixels, width, height, radius) {
  const temp = new Uint8ClampedArray(pixels.length);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        count = 0;

      for (let kx = -radius; kx <= radius; kx++) {
        const px = Math.min(width - 1, Math.max(0, x + kx));
        const offset = (y * width + px) * 4;
        r += pixels[offset];
        g += pixels[offset + 1];
        b += pixels[offset + 2];
        a += pixels[offset + 3];
        count++;
      }

      const offset = (y * width + x) * 4;
      temp[offset] = r / count;
      temp[offset + 1] = g / count;
      temp[offset + 2] = b / count;
      temp[offset + 3] = a / count;
    }
  }

  // Vertical pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        count = 0;

      for (let ky = -radius; ky <= radius; ky++) {
        const py = Math.min(height - 1, Math.max(0, y + ky));
        const offset = (py * width + x) * 4;
        r += temp[offset];
        g += temp[offset + 1];
        b += temp[offset + 2];
        a += temp[offset + 3];
        count++;
      }

      const offset = (y * width + x) * 4;
      pixels[offset] = r / count;
      pixels[offset + 1] = g / count;
      pixels[offset + 2] = b / count;
      pixels[offset + 3] = a / count;
    }
  }
}

// Sharpen kernel convolution
function applySharpenKernel(imageData, width, height, strength) {
  const pixels = imageData.data;

  // Sharpen kernel (adjustable by strength)
  const kernel = [0, -strength, 0, -strength, 1 + 4 * strength, -strength, 0, -strength, 0];

  const result = new Uint8ClampedArray(pixels.length);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      for (let c = 0; c < 3; c++) {
        // RGB channels only
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const idx = ((y + ky) * width + (x + kx)) * 4 + c;
            const kernelIdx = (ky + 1) * 3 + (kx + 1);
            sum += pixels[idx] * kernel[kernelIdx];
          }
        }
        const idx = (y * width + x) * 4 + c;
        result[idx] = Math.min(255, Math.max(0, sum));
      }
      // Copy alpha channel
      const idx = (y * width + x) * 4;
      result[idx + 3] = pixels[idx + 3];
    }
  }

  // Copy edges from original
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y === 0 || y === height - 1 || x === 0 || x === width - 1) {
        const idx = (y * width + x) * 4;
        for (let c = 0; c < 4; c++) {
          result[idx + c] = pixels[idx + c];
        }
      }
    }
  }

  // Copy result back to pixels
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = result[i];
  }
}

// Apply partial grayscale to image data
function applyGrayscaleAmount(imageData, amount) {
  const data = imageData.data;
  const factor = Math.min(100, Math.max(0, amount)) / 100;

  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = data[i] + (gray - data[i]) * factor;
    data[i + 1] = data[i + 1] + (gray - data[i + 1]) * factor;
    data[i + 2] = data[i + 2] + (gray - data[i + 2]) * factor;
  }
}

// Invert colors in image data
function invertColors(imageData) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i]; // Red
    data[i + 1] = 255 - data[i + 1]; // Green
    data[i + 2] = 255 - data[i + 2]; // Blue
    // Alpha channel (i + 3) remains unchanged
  }
}

// Apply sepia tone to image data
function applySepia(imageData) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    data[i] = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189);
    data[i + 1] = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168);
    data[i + 2] = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131);
  }
}

// Apply brightness and contrast to image data
function applyBrightnessContrast(imageData, brightness, contrast) {
  const data = imageData.data;
  const brightnessAdjust = brightness * 2.55; // Convert -100 to 100 range to -255 to 255
  const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));

  for (let i = 0; i < data.length; i += 4) {
    // Apply contrast first, then brightness
    for (let c = 0; c < 3; c++) {
      let value = data[i + c];
      // Contrast
      value = contrastFactor * (value - 128) + 128;
      // Brightness
      value = value + brightnessAdjust;
      data[i + c] = Math.min(255, Math.max(0, value));
    }
  }
}

// Apply saturation adjustment to image data
function applySaturation(imageData, saturation) {
  const data = imageData.data;
  const saturationFactor = (saturation + 100) / 100;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const gray = 0.299 * r + 0.587 * g + 0.114 * b;

    data[i] = Math.min(255, Math.max(0, gray + saturationFactor * (r - gray)));
    data[i + 1] = Math.min(255, Math.max(0, gray + saturationFactor * (g - gray)));
    data[i + 2] = Math.min(255, Math.max(0, gray + saturationFactor * (b - gray)));
  }
}

// Apply hue shift to image data
function applyHueShift(imageData, hueShift) {
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;

    // RGB to HSL
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h,
      s,
      l = (max + min) / 2;

    if (max === min) {
      h = s = 0;
    } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
          break;
        case g:
          h = ((b - r) / d + 2) / 6;
          break;
        case b:
          h = ((r - g) / d + 4) / 6;
          break;
      }
    }

    // Shift hue
    h = (h + hueShift / 360) % 1;
    if (h < 0) h += 1;

    // HSL to RGB
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    let nr, ng, nb;
    if (s === 0) {
      nr = ng = nb = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      nr = hue2rgb(p, q, h + 1 / 3);
      ng = hue2rgb(p, q, h);
      nb = hue2rgb(p, q, h - 1 / 3);
    }

    data[i] = Math.round(nr * 255);
    data[i + 1] = Math.round(ng * 255);
    data[i + 2] = Math.round(nb * 255);
  }
}

// Apply posterize effect to image data
function applyPosterize(imageData, levels) {
  const data = imageData.data;
  const step = 255 / (levels - 1);

  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      data[i + c] = Math.round(Math.round(data[i + c] / step) * step);
    }
  }
}

// Auto adjust colors (auto levels)
function autoAdjustColors(imageData) {
  const data = imageData.data;

  // Calculate min and max values for each color channel
  let minR = 255,
    maxR = 0;
  let minG = 255,
    maxG = 0;
  let minB = 255,
    maxB = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }

  // Calculate scaling factors for each channel (auto levels)
  const rangeR = maxR - minR;
  const rangeG = maxG - minG;
  const rangeB = maxB - minB;

  // Apply auto levels - stretch each channel to full 0-255 range
  for (let i = 0; i < data.length; i += 4) {
    // Stretch red channel
    if (rangeR > 0) {
      data[i] = Math.min(255, Math.max(0, ((data[i] - minR) * 255) / rangeR));
    }
    // Stretch green channel
    if (rangeG > 0) {
      data[i + 1] = Math.min(255, Math.max(0, ((data[i + 1] - minG) * 255) / rangeG));
    }
    // Stretch blue channel
    if (rangeB > 0) {
      data[i + 2] = Math.min(255, Math.max(0, ((data[i + 2] - minB) * 255) / rangeB));
    }
  }
}

module.exports = {
  fastGaussianBlur,
  boxesForGauss,
  boxBlur,
  applySharpenKernel,
  applyGrayscaleAmount,
  invertColors,
  applySepia,
  applyBrightnessContrast,
  applySaturation,
  applyHueShift,
  applyPosterize,
  autoAdjustColors,
};
