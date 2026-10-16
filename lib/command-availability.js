const mutations = new Set([
  "crop-to-selection",
  "resize-canvas-to-selection",
  "blur-light",
  "blur-medium",
  "blur-strong",
  "blur",
  "rotate-90-cw",
  "rotate-90-ccw",
  "rotate-180",
  "rotate-free",
  "flip-horizontal",
  "flip-vertical",
  "resize",
  "grayscale",
  "invert-colors",
  "sepia",
  "sharpen-light",
  "sharpen-medium",
  "sharpen-strong",
  "sharpen",
  "brightness-contrast",
  "saturation",
  "hue-shift",
  "posterize",
  "auto-adjust-colors",
  "copy-selection",
  "auto-select",
  "auto-select-with-border",
]);
const selectionCommands = new Set([
  "crop-to-selection",
  "resize-canvas-to-selection",
  "zoom-to-selection",
  "hide-selection",
]);
module.exports = function withCommandAvailability(view, commands) {
  return Object.fromEntries(
    Object.entries(commands).map(([name, listener]) => {
      const action = name.slice("image-editor:".length);
      if (
        !mutations.has(action) &&
        !selectionCommands.has(action) &&
        !["undo", "redo"].includes(action)
      )
        return [name, listener];
      return [
        name,
        {
          ...(typeof listener === "function" ? { didDispatch: listener } : listener),
          isAvailable: () => {
            if (!view.loaded || view._destroyed || (mutations.has(action) && view.readOnly))
              return false;
            if (selectionCommands.has(action) && !view.selectionVisible) return false;
            if (action === "undo") return view.historyManager.canUndo() === true;
            if (action === "redo") return view.historyManager.canRedo() === true;
            return true;
          },
        },
      ];
    }),
  );
};
