# image-editor

View and edit images directly in the editor.

A feature-rich image viewer with support for cropping, rotation, color adjustments, filters, and more.

## Features

- **Zoom & pan**: zoom controls, keyboard shortcuts, and right-click drag to pan.
- **Image browsing**: navigate between images in the same folder.
- **Transform tools**: rotate, flip, resize, and crop images.
- **Color adjustments**: brightness, contrast, saturation, hue, and auto-adjust.
- **Filters**: blur, sharpen, grayscale, sepia, posterize, and invert.
- **Selection tools**: create, resize, auto-select, and crop to selection.
- **SVG support**: view SVG images with automatic viewBox dimension handling (read-only).
- **Undo/redo**: full history with viewport preservation.
- **Navigation panel**: browse folder images via [navigation-panel](https://github.com/lumine-code/navigation-panel).
- **API for packages**: other packages can open images from data URLs without saving to disk. Used by [jupyter-repl](https://github.com/lumine-code/jupyter-repl) to display plot outputs.

## Installation

To install `image-editor` search for _image-editor_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/image-editor`.

## Commands

Commands available in `.image-editor`:

- `image-editor:zoom-in`: increase zoom level,
- `image-editor:zoom-out`: decrease zoom level,
- `image-editor:reset-zoom`: reset to 100%,
- `image-editor:zoom-to-fit`: scale to fit viewport,
- `image-editor:zoom-to-selection`: zoom to fit the current selection and clear it,
- `image-editor:center`: center image in viewport,
- `image-editor:first-image`: go to first image in folder,
- `image-editor:previous-image`: go to previous image,
- `image-editor:next-image`: go to next image,
- `image-editor:last-image`: go to last image in folder,
- `image-editor:reload`: refresh image from disk,
- `image-editor:open-in-new-tab`: open the current image in a new tab (also available in tree-view and text-editor context menus for SVG files),
- `image-editor:background-white`: set white background,
- `image-editor:background-black`: set black background,
- `image-editor:background-transparent`: set transparent background,
- `image-editor:background-native`: set native background,
- `image-editor:rotate-90-cw`: rotate 90° clockwise,
- `image-editor:rotate-90-ccw`: rotate 90° counter-clockwise,
- `image-editor:rotate-180`: rotate 180°,
- `image-editor:rotate-free`: rotate by custom angle with preview and optional trimming,
- `image-editor:flip-horizontal`: flip horizontally,
- `image-editor:flip-vertical`: flip vertically,
- `image-editor:resize`: resize with aspect ratio lock,
- `image-editor:auto-adjust-colors`: automatic color optimization,
- `image-editor:brightness-contrast`: adjust brightness and contrast,
- `image-editor:saturation`: adjust color intensity,
- `image-editor:hue-shift`: rotate color spectrum,
- `image-editor:grayscale`: convert to black & white with adjustable amount,
- `image-editor:invert-colors`: permanently invert colors,
- `image-editor:sepia`: apply sepia effect,
- `image-editor:posterize`: reduce color levels,
- `image-editor:blur`: custom blur radius,
- `image-editor:blur-light`: light blur,
- `image-editor:blur-medium`: medium blur,
- `image-editor:blur-strong`: strong blur,
- `image-editor:sharpen`: custom sharpen strength,
- `image-editor:sharpen-light`: light sharpen,
- `image-editor:sharpen-medium`: medium sharpen,
- `image-editor:sharpen-strong`: strong sharpen,
- `image-editor:select-all`: select entire image,
- `image-editor:auto-select`: auto-detect and select content,
- `image-editor:auto-select-with-border`: auto-select with border padding,
- `image-editor:select-visible-area`: select visible portion,
- `image-editor:copy-selection`: copy selection to clipboard,
- `image-editor:copy-path`: copy absolute image path to clipboard,
- `image-editor:copy-project-path`: copy project-relative image path to clipboard,
- `image-editor:crop-to-selection`: crop to selection,
- `image-editor:hide-selection`: clear selection,
- `image-editor:show-properties`: view file and image info,
- `image-editor:undo`: revert to previous state,
- `image-editor:redo`: restore next state,
- `image-editor:attach-to-claude`: attach image to Claude chat.

## Mouse controls

- **Left-click drag**: create selection.
- **Double left-click**: zoom to fit, or zoom to selection when double-clicking inside one.
- **Right-click drag**: pan image.
- **Mouse wheel**: navigate to previous/next image (or zoom if `switchZoomAndNavigation` is disabled).
- **Ctrl + Mouse wheel**: zoom in/out at cursor position (or navigate if `switchZoomAndNavigation` is disabled).

## Image editor API

The `image-editor` service allows other packages to open images directly from data URLs without saving to disk. Used by [jupyter-repl](https://github.com/lumine-code/jupyter-repl) to display plot outputs.

In your `package.json`:

```json
{
  "consumedServices": {
    "image-editor": {
      "versions": {
        "^1.0.0": "consumeImageEditor"
      }
    }
  }
}
```

In your main module:

```javascript
module.exports = {
  imageEditor: null,

  consumeImageEditor(service) {
    this.imageEditor = service;
    return new Disposable(() => {
      this.imageEditor = null;
    });
  },

  openImage(dataUrl) {
    if (this.imageEditor) {
      this.imageEditor.openFromDataUrl(dataUrl, "My Image Title");
    }
  },
};
```

The opened image will be marked as "modified" and prompt the user to save when closing.

## Services

- **image-editor** (`1.0.0`): provided to let other packages open images from data URLs without saving to disk — exposes `openFromDataUrl(dataUrl, title)`.
- **navigation-adapter** (`1.0.0`): provided to [navigation-panel](https://github.com/lumine-code/navigation-panel) to list all images of the current folder; clicking an entry loads that image in the same editor.
- **status-bar** (`^1.0.0`): consumed to show image dimensions, file size, and mouse position in the status bar.
- **tree-view** (`^1.0.0`): consumed to read the selected paths for the "Open in Image Editor" context command.
- **claude-chat** (`^1.0.0`): consumed to attach the current image to a Claude chat conversation.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
