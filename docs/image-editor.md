# image-editor

Opens an image from a data URL, without writing it to disk first.

|             |                                                               |
| ----------- | ------------------------------------------------------------- |
| Version     | `1.0.0`                                                       |
| Provided by | `provideImageEditor()` returning `{ openFromDataUrl }`        |
| Consumed by | `consumeImageEditor(imageEditor)`                             |
| Owner       | [`image-editor`](https://github.com/lumine-code/image-editor) |

For anything that produces an image in memory — a notebook cell's plot output, a rendered diagram, a screenshot — and wants it shown as a normal pane item rather than saved to a temporary file the user then has to clean up.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "image-editor": {
      "versions": { "^1.0.0": "consumeImageEditor" }
    }
  }
}
```

## Contract

```ts
type ImageEditorService = {
  openFromDataUrl(dataUrl: string, title?: string): ImageEditor;
};
```

| Argument  | Description                                      |
| --------- | ------------------------------------------------ |
| `dataUrl` | A `data:` URL containing the image. Required.    |
| `title`   | The tab's title. Defaults to `"Untitled Image"`. |

Returns the editor item, synchronously.

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumeImageEditor(imageEditor) {
    this.imageEditor = imageEditor;
    return new Disposable(() => (this.imageEditor = null));
  },

  showPlot(pngBase64, cellNumber) {
    this.imageEditor?.openFromDataUrl(`data:image/png;base64,${pngBase64}`, `Plot ${cellNumber}`);
  },
};
```

## Behavior

The item is added to the **active pane and activated**, so the call takes focus. There is no option to open it in a split or in the background — open it when the user asked for it, not as a side effect of something in the background.

**Always pass a `title`.** Several images opened without one all read `Untitled Image`, and the user has no way to tell them apart.

The image has no path, so it cannot be saved through the ordinary save command and is gone when the tab closes. Anything the user should keep needs to be written to disk by you.

The return value is the editor item. It is useful for tracking what you opened, but it is a pane item like any other — the user may close it at any time, so do not assume it stays alive.

Data URLs hold the whole image in memory, encoded. Large images are better written to a file and opened by path.

## Teardown

Return a `Disposable` that drops your reference. Items you opened belong to the workspace; do not destroy them on teardown, since the user may still be looking at them.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
