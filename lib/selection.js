/**
 * Selection utilities module
 * Contains selection area calculations, auto-select, and clipboard operations
 */

// Get selection area from selection coordinates
function getSelectionArea(
  selectionStart,
  selectionEnd,
  imageWidth,
  imageHeight,
  hasVisibleSelection,
) {
  if (hasVisibleSelection) {
    // Selection coordinates are already in image space
    const imgLeft = Math.round(Math.min(selectionStart.x, selectionEnd.x));
    const imgTop = Math.round(Math.min(selectionStart.y, selectionEnd.y));
    const imgWidth = Math.round(Math.abs(selectionEnd.x - selectionStart.x));
    const imgHeight = Math.round(Math.abs(selectionEnd.y - selectionStart.y));

    if (imgWidth === 0 || imgHeight === 0) {
      return null; // Invalid selection
    }

    return {
      hasSelection: true,
      left: Math.max(0, Math.min(imgLeft, imageWidth)),
      top: Math.max(0, Math.min(imgTop, imageHeight)),
      width: Math.min(imgWidth, imageWidth - Math.max(0, imgLeft)),
      height: Math.min(imgHeight, imageHeight - Math.max(0, imgTop)),
    };
  } else {
    return {
      hasSelection: false,
      left: 0,
      top: 0,
      width: imageWidth,
      height: imageHeight,
    };
  }
}

// Auto-select content by detecting background color
function autoSelectContent(imageElement, tolerance = 30, borderPercent = 0) {
  // Create canvas to analyze pixels
  const canvas = imageElement.ownerDocument.createElement("canvas");
  canvas.width = imageElement.naturalWidth;
  canvas.height = imageElement.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imageElement, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const width = canvas.width;
  const height = canvas.height;

  // Sample corner pixels to determine background color
  const getPixel = (x, y) => {
    const idx = (y * width + x) * 4;
    return {
      r: data[idx],
      g: data[idx + 1],
      b: data[idx + 2],
      a: data[idx + 3],
    };
  };

  const corners = [
    getPixel(0, 0),
    getPixel(width - 1, 0),
    getPixel(0, height - 1),
    getPixel(width - 1, height - 1),
  ];

  const bgColor = {
    r: Math.round((corners[0].r + corners[1].r + corners[2].r + corners[3].r) / 4),
    g: Math.round((corners[0].g + corners[1].g + corners[2].g + corners[3].g) / 4),
    b: Math.round((corners[0].b + corners[1].b + corners[2].b + corners[3].b) / 4),
    a: Math.round((corners[0].a + corners[1].a + corners[2].a + corners[3].a) / 4),
  };

  // Function to check if pixel is similar to background
  const isBackground = (pixel) => {
    const dr = Math.abs(pixel.r - bgColor.r);
    const dg = Math.abs(pixel.g - bgColor.g);
    const db = Math.abs(pixel.b - bgColor.b);
    const da = Math.abs(pixel.a - bgColor.a);
    return (dr + dg + db + da) / 4 <= tolerance;
  };

  // Scan from edges to find content boundaries
  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;

  // Scan from top
  found: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isBackground(getPixel(x, y))) {
        top = y;
        break found;
      }
    }
  }

  // Scan from bottom
  found: for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      if (!isBackground(getPixel(x, y))) {
        bottom = y;
        break found;
      }
    }
  }

  // Scan from left
  found: for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (!isBackground(getPixel(x, y))) {
        left = x;
        break found;
      }
    }
  }

  // Scan from right
  found: for (let x = width - 1; x >= 0; x--) {
    for (let y = 0; y < height; y++) {
      if (!isBackground(getPixel(x, y))) {
        right = x;
        break found;
      }
    }
  }

  // Check if we found any content
  if (left >= right || top >= bottom) {
    return { success: false, reason: "no-content" };
  }

  // Check if entire image is content
  if (left === 0 && right === width - 1 && top === 0 && bottom === height - 1) {
    return { success: false, reason: "entire-image" };
  }

  // Add border if requested
  if (borderPercent > 0) {
    // Calculate border based on larger content dimension
    const contentWidth = right - left + 1;
    const contentHeight = bottom - top + 1;
    const largerContentDimension = Math.max(contentWidth, contentHeight);
    const border = Math.round((largerContentDimension * borderPercent) / 100);

    // Expand selection by border on all sides
    left = Math.max(0, left - border);
    right = Math.min(width - 1, right + border);
    top = Math.max(0, top - border);
    bottom = Math.min(height - 1, bottom + border);
  }

  return {
    success: true,
    start: { x: left, y: top },
    end: { x: right, y: bottom },
    width: right - left,
    height: bottom - top,
  };
}

// Get visible area in image coordinates
function getVisibleArea(
  containerWidth,
  containerHeight,
  translateX,
  translateY,
  zoom,
  imageWidth,
  imageHeight,
) {
  // Convert viewport bounds to image space
  let imgLeft = (0 - translateX) / zoom;
  let imgTop = (0 - translateY) / zoom;
  let imgRight = (containerWidth - translateX) / zoom;
  let imgBottom = (containerHeight - translateY) / zoom;

  // Clamp to image boundaries
  imgLeft = Math.max(0, Math.min(imgLeft, imageWidth));
  imgTop = Math.max(0, Math.min(imgTop, imageHeight));
  imgRight = Math.max(0, Math.min(imgRight, imageWidth));
  imgBottom = Math.max(0, Math.min(imgBottom, imageHeight));

  // Check if there's any visible area
  if (imgLeft >= imgRight || imgTop >= imgBottom) {
    return null;
  }

  return {
    start: { x: imgLeft, y: imgTop },
    end: { x: imgRight, y: imgBottom },
    width: Math.round(imgRight - imgLeft),
    height: Math.round(imgBottom - imgTop),
  };
}

// Copy selection to clipboard
function copyToClipboard(imageElement, left, top, width, height, onSuccess, onError) {
  if (width === 0 || height === 0) {
    if (onError) onError(new Error("Selection has no area"));
    return;
  }

  const canvas = imageElement.ownerDocument.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  ctx.drawImage(imageElement, left, top, width, height, 0, 0, width, height);

  canvas.toBlob((blob) => {
    blob
      .arrayBuffer()
      .then((buffer) => {
        lumine.clipboard.writeImage(Buffer.from(buffer));
        if (onSuccess) onSuccess();
      })
      .catch((error) => {
        if (onError) onError(error);
      });
  }, "image/png");
}

// Convert viewport coordinates to image coordinates
function viewportToImage(viewportX, viewportY, translateX, translateY, zoom) {
  return {
    x: (viewportX - translateX) / zoom,
    y: (viewportY - translateY) / zoom,
  };
}

// Convert image coordinates to viewport coordinates
function imageToViewport(imgX, imgY, translateX, translateY, zoom) {
  return {
    x: imgX * zoom + translateX,
    y: imgY * zoom + translateY,
  };
}

// Update selection box style from image coordinates
function updateSelectionBoxStyle(
  selectionBox,
  selectionStart,
  selectionEnd,
  translateX,
  translateY,
  zoom,
) {
  const leftImg = Math.min(selectionStart.x, selectionEnd.x);
  const topImg = Math.min(selectionStart.y, selectionEnd.y);
  const widthImg = Math.abs(selectionEnd.x - selectionStart.x);
  const heightImg = Math.abs(selectionEnd.y - selectionStart.y);

  // Transform to viewport coordinates
  const left = leftImg * zoom + translateX;
  const top = topImg * zoom + translateY;
  const width = widthImg * zoom;
  const height = heightImg * zoom;

  selectionBox.style.left = left + "px";
  selectionBox.style.top = top + "px";
  selectionBox.style.width = width + "px";
  selectionBox.style.height = height + "px";
}

module.exports = {
  getSelectionArea,
  autoSelectContent,
  getVisibleArea,
  copyToClipboard,
  viewportToImage,
  imageToViewport,
  updateSelectionBoxStyle,
};
