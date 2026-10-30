/**
 * Dialog utilities module
 * Contains dialog creation helpers for image adjustments
 */

const documentAPIs = new WeakMap();

function forDocument(document = globalThis.document) {
  if (!document) throw new Error("Image dialogs require a presentation document.");
  let api = documentAPIs.get(document);
  if (!api) {
    api = createDocumentAPI(document);
    documentAPIs.set(document, api);
  }
  return api;
}

function createDocumentAPI(document) {
  const window = document.defaultView;
  // Create a draggable dialog with backdrop
  function createDialogBackdrop() {
    const backdrop = document.createElement("div");
    backdrop.className = "image-editor-dialog-backdrop";
    return backdrop;
  }

  // Create dialog element with title and make it draggable
  function createDraggableDialog(title) {
    const dialogElement = document.createElement("div");
    dialogElement.className = "image-editor-adjustment-dialog dialog-form";
    dialogElement.setAttribute("role", "dialog");
    dialogElement.setAttribute("aria-label", title);

    // Make dialog draggable state
    let isDragging = false;
    let currentX = 0;
    let currentY = 0;
    let initialX = 0;
    let initialY = 0;

    const headerElement = document.createElement("header");
    headerElement.className = "dialog-header";
    const titleElement = document.createElement("h2");
    titleElement.className = "dialog-title";
    titleElement.textContent = title;
    headerElement.append(titleElement);
    const bodyElement = document.createElement("div");
    bodyElement.className = "dialog-body";
    dialogElement.append(headerElement, bodyElement);

    const dragStart = (e) => {
      if (headerElement.contains(e.target)) {
        initialX = e.clientX - currentX;
        initialY = e.clientY - currentY;
        isDragging = true;
        dialogElement.style.cursor = "grabbing";
      }
    };

    const drag = (e) => {
      if (isDragging) {
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;
        dialogElement.style.transform = `translate(calc(-50% + ${currentX}px), calc(-50% + ${currentY}px))`;
      }
    };

    const dragEnd = () => {
      isDragging = false;
      dialogElement.style.cursor = "move";
    };

    headerElement.addEventListener("mousedown", dragStart);
    document.addEventListener("mousemove", drag);
    document.addEventListener("mouseup", dragEnd);

    // Return cleanup function
    const cleanup = () => {
      document.removeEventListener("mousemove", drag);
      document.removeEventListener("mouseup", dragEnd);
    };

    return { dialogElement, bodyElement, titleElement, cleanup };
  }

  // Create a slider control for adjustments
  function createSliderControl(config) {
    const container = document.createElement("div");
    container.className = "dialog-slider-container dialog-field";

    const label = document.createElement("label");
    label.className = "dialog-label";
    label.textContent = config.label;
    container.appendChild(label);

    const controlsContainer = document.createElement("div");
    controlsContainer.className = "dialog-controls";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = config.min;
    slider.max = config.max;
    slider.value = config.default;
    slider.step = config.step;

    const valueLabel = document.createElement("span");
    valueLabel.className = "dialog-value-label";
    valueLabel.textContent = config.default;

    slider.addEventListener("input", () => {
      valueLabel.textContent = slider.value;
    });

    controlsContainer.appendChild(slider);
    controlsContainer.appendChild(valueLabel);
    container.appendChild(controlsContainer);

    return { container, slider, valueLabel };
  }

  // Create button container with Cancel and Apply buttons
  function createButtonContainer(cancelText = "Cancel", applyText = "Apply") {
    const buttonContainer = document.createElement("div");
    buttonContainer.className = "dialog-buttons dialog-footer dialog-actions";

    const cancelButton = document.createElement("button");
    cancelButton.className = "btn";
    cancelButton.textContent = cancelText;

    const applyButton = document.createElement("button");
    applyButton.className = "btn btn-primary";
    applyButton.textContent = applyText;

    buttonContainer.appendChild(cancelButton);
    buttonContainer.appendChild(applyButton);

    return { buttonContainer, cancelButton, applyButton };
  }

  // Create info element for displaying selection info
  function createSelectionInfo(text) {
    const infoElement = document.createElement("div");
    infoElement.className = "dialog-selection-info dialog-status text-info";
    infoElement.setAttribute("role", "status");
    infoElement.textContent = text;
    return infoElement;
  }

  // Create a number input field
  function createNumberInput(config) {
    const container = document.createElement("div");
    container.className = "dialog-slider-container dialog-field";

    const label = document.createElement("label");
    label.className = "dialog-label";
    label.textContent = config.label;
    container.appendChild(label);

    const input = document.createElement("input");
    input.type = "number";
    input.className = "input-text native-key-bindings";
    input.value = config.default;
    input.min = config.min;
    input.max = config.max;
    container.appendChild(input);

    return { container, input };
  }

  // Create a checkbox control
  function createCheckbox(id, labelText, checked = false) {
    const container = document.createElement("div");
    container.className = "dialog-slider-container dialog-field";
    container.style.flexDirection = "row";
    container.style.alignItems = "center";
    container.style.gap = "calc(var(--ui-spacing) / 2)";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = id;
    checkbox.checked = checked;

    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = labelText;
    label.style.margin = "0";

    container.appendChild(checkbox);
    container.appendChild(label);

    return { container, checkbox };
  }

  // Create a row of quick-select buttons
  function createQuickButtons(values, onClick, formatter = (v) => `${v}`) {
    const container = document.createElement("div");
    container.className = "dialog-quick-buttons";
    container.style.display = "flex";
    container.style.gap = "calc(var(--ui-spacing) / 2)";
    container.style.flexWrap = "wrap";

    values.forEach((value) => {
      const btn = document.createElement("button");
      btn.className = "btn btn-sm";
      btn.textContent = formatter(value);
      btn.addEventListener("click", () => onClick(value));
      container.appendChild(btn);
    });

    return container;
  }

  function createPreviewSourceCanvas(imageElement, maxSize = 1280) {
    const scale = Math.min(
      maxSize / imageElement.naturalWidth,
      maxSize / imageElement.naturalHeight,
      1,
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(imageElement.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(imageElement.naturalHeight * scale));
    canvas.getContext("2d").drawImage(imageElement, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function createPreviewPanel(options) {
    const {
      sourceImage,
      maxSourceSize = 1280,
      debounce = 60,
      renderPreview,
      getOutputInfo = null,
      initialValues = [],
    } = options;
    const container = document.createElement("div");
    container.className = "dialog-preview-panel";

    const canvas = document.createElement("canvas");
    container.appendChild(canvas);

    const infoElement = createSelectionInfo("");
    let sourceCanvas = createPreviewSourceCanvas(sourceImage, maxSourceSize);
    let lastValues = initialValues;
    let previewTimeout = null;
    let closed = false;

    const renderNow = (values = lastValues) => {
      if (closed) return;
      lastValues = values;
      const width = Math.max(160, Math.round(container.clientWidth - 16));
      const height = Math.max(120, Math.round(container.clientHeight - 16));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      renderPreview(sourceCanvas, canvas, values);

      if (getOutputInfo) {
        infoElement.textContent = getOutputInfo(values);
      }
    };

    const schedulePreview = (values = lastValues) => {
      if (closed) return;
      lastValues = values;
      if (previewTimeout != null) window.clearTimeout(previewTimeout);
      const timer = window.setTimeout(() => {
        if (closed || previewTimeout !== timer) return;
        previewTimeout = null;
        renderNow(lastValues);
      }, debounce);
      previewTimeout = timer;
    };

    const refreshSource = (values = lastValues) => {
      if (closed) return;
      sourceCanvas = createPreviewSourceCanvas(sourceImage, maxSourceSize);
      renderNow(values);
    };

    const resizeObserver = new window.ResizeObserver(() => renderNow(lastValues));
    resizeObserver.observe(container);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (previewTimeout != null) window.clearTimeout(previewTimeout);
      previewTimeout = null;
      resizeObserver.disconnect();
      window.removeEventListener("unload", cleanup);
    };
    window.addEventListener("unload", cleanup, { once: true });

    return {
      container,
      canvas,
      infoElement,
      get sourceCanvas() {
        return sourceCanvas;
      },
      renderNow,
      schedulePreview,
      refreshSource,
      cleanup,
    };
  }

  // Setup escape key handler for dialog
  function setupEscapeHandler(backdrop, cleanup) {
    const close = () => {
      escapeHandler.dispose();
      cleanup();
      if (document.body.contains(backdrop)) document.body.removeChild(backdrop);
    };
    const escapeHandler = (e) => {
      if (e.key === "Escape") close();
    };
    escapeHandler.dispose = () => {
      document.removeEventListener("keydown", escapeHandler);
      window.removeEventListener("unload", close);
    };
    document.addEventListener("keydown", escapeHandler);
    window.addEventListener("unload", close, { once: true });
    return escapeHandler;
  }

  // Show a generic adjustment dialog with sliders
  function showAdjustmentDialog(
    title,
    sliders,
    getSelectionArea,
    applyCallback,
    emitter,
    previewOptions = null,
    registerDialog = null,
  ) {
    const backdrop = createDialogBackdrop();
    const { dialogElement, bodyElement, cleanup: dialogCleanup } = createDraggableDialog(title);
    let previewPanel = null;

    if (previewOptions) {
      dialogElement.classList.add("image-editor-preview-dialog");
    }

    // Add selection info display
    const selectionInfo = createSelectionInfo("");
    const updateSelectionInfo = () => {
      const area = getSelectionArea();
      if (area) {
        if (area.hasSelection) {
          selectionInfo.textContent = `Will apply to selection: ${area.width}×${area.height}px`;
        } else {
          selectionInfo.textContent = "Will apply to entire image";
        }
      }
    };
    updateSelectionInfo();
    bodyElement.appendChild(selectionInfo);

    // Update selection info when mouse is released
    const selectionUpdateHandler = () => {
      updateSelectionInfo();
      if (previewPanel) {
        previewPanel.schedulePreview(sliderElements.map((s) => parseFloat(s.value)));
      }
    };
    document.addEventListener("mouseup", selectionUpdateHandler);

    // Update selection info when selection visibility changes
    const selectionVisibilityHandler = () => {
      updateSelectionInfo();
      if (previewPanel) {
        previewPanel.schedulePreview(sliderElements.map((s) => parseFloat(s.value)));
      }
    };
    emitter.on("selection-visibility-changed", selectionVisibilityHandler);
    const imageLoadDisposable = previewOptions
      ? emitter.on("did-load", () => {
          updateSelectionInfo();
          if (previewPanel) {
            previewPanel.refreshSource(sliderElements.map((s) => parseFloat(s.value)));
          }
        })
      : null;

    // Create slider controls
    const sliderElements = [];
    sliders.forEach((config) => {
      const { container, slider } = createSliderControl(config);
      sliderElements.push(slider);
      slider.addEventListener("input", () => {
        if (previewPanel) {
          previewPanel.schedulePreview(sliderElements.map((s) => parseFloat(s.value)));
        }
      });
      bodyElement.appendChild(container);
    });

    if (previewOptions) {
      previewPanel = createPreviewPanel({
        ...previewOptions,
        initialValues: sliderElements.map((s) => parseFloat(s.value)),
        renderPreview: (sourceCanvas, previewCanvas, values) => {
          previewOptions.renderPreview(sourceCanvas, previewCanvas, values, getSelectionArea());
        },
      });
      bodyElement.appendChild(previewPanel.container);
      bodyElement.appendChild(previewPanel.infoElement);
    }

    // Create buttons
    const { buttonContainer, cancelButton, applyButton } = createButtonContainer();
    let escapeHandler = null;
    let replacementDisposable = null;
    let closed = false;

    const fullCleanup = () => {
      if (closed) return;
      closed = true;
      dialogRegistration?.dispose();
      replacementDisposable?.dispose();
      if (previewPanel) previewPanel.cleanup();
      if (imageLoadDisposable) imageLoadDisposable.dispose();
      dialogCleanup();
      escapeHandler?.dispose();
      document.removeEventListener("mouseup", selectionUpdateHandler);
      emitter.off("selection-visibility-changed", selectionVisibilityHandler);
      if (document.body.contains(backdrop)) {
        document.body.removeChild(backdrop);
      }
    };
    replacementDisposable = emitter.on("will-replace-document", fullCleanup);
    const dialogRegistration = registerDialog?.(fullCleanup);

    cancelButton.addEventListener("click", fullCleanup);

    applyButton.addEventListener("click", () => {
      if (closed) return;
      const values = sliderElements.map((s) => parseFloat(s.value));
      applyCallback(values);
      fullCleanup();
    });

    dialogElement.appendChild(buttonContainer);
    backdrop.appendChild(dialogElement);
    document.body.appendChild(backdrop);

    if (previewPanel) {
      previewPanel.renderNow(sliderElements.map((s) => parseFloat(s.value)));
    }

    // Setup escape handler
    escapeHandler = setupEscapeHandler(backdrop, fullCleanup);

    // Focus the first slider
    if (sliderElements.length > 0) {
      sliderElements[0].focus();
    }

    return { backdrop, dialogElement, cleanup: fullCleanup };
  }

  return {
    createDialogBackdrop,
    createDraggableDialog,
    createSliderControl,
    createButtonContainer,
    createSelectionInfo,
    createNumberInput,
    createCheckbox,
    createQuickButtons,
    createPreviewPanel,
    setupEscapeHandler,
    showAdjustmentDialog,
  };
}

module.exports = Object.assign(forDocument(), { forDocument });
