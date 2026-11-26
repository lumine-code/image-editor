module.exports = class OperationIndicator {
  static render($) {
    return $.span(
      { className: "loading-spinner-right", ref: "loadingSpinner" },
      $.span({
        className: "badge badge-small operation-queue-badge",
        ref: "operationQueueBadge",
        "aria-hidden": "true",
        hidden: true,
      }),
      $.button(
        {
          className:
            "btn icon-button icon-button-no-scale operation-cancel-button native-key-bindings",
          ref: "operationCancelButton",
          type: "button",
          hidden: true,
        },
        $.span({ className: "icon icon-x", "aria-hidden": "true" }),
      ),
      $.span({ className: "sr-only operation-queue-status", role: "status" }),
    );
  }

  constructor({ element, button, badge, tooltips, focusTarget, cancel }) {
    this.element = element;
    this.button = button;
    this.badge = badge;
    this.focusTarget = focusTarget;
    this.status = element.querySelector(".operation-queue-status");
    this.actionLabel = "";
    this.description = "";
    this.onMouseDown = (event) => event.preventDefault();
    this.onClick = () => {
      if (!button.hidden) cancel();
    };
    button.addEventListener("mousedown", this.onMouseDown);
    button.addEventListener("click", this.onClick);
    this.tooltip = tooltips.add(element, {
      title: () => [this.actionLabel, this.description].filter(Boolean).join(". "),
      placement: "auto left",
      trigger: "hover focus",
      html: false,
    });
  }

  update({ active, waiting = [] }) {
    const count = waiting.length;
    this.actionLabel = count ? "Clear queued operations" : "";
    if (active?.cancellable) {
      this.actionLabel = count
        ? "Cancel current operation and clear queue"
        : "Cancel current operation";
    }
    const orderedLabels = waiting.map((entry) => entry.label ?? entry).join(", then ");
    this.description = [
      active && `Running ${active.label}.`,
      count && `${count} queued. ${orderedLabels}.`,
    ]
      .filter(Boolean)
      .join(" ");

    if (!this.actionLabel && this.button === this.button.ownerDocument.activeElement) {
      this.focusTarget.focus({ preventScroll: true });
    }
    this.button.hidden = !this.actionLabel;
    this.button.setAttribute("aria-label", this.actionLabel);
    this.button.setAttribute("aria-description", this.description);
    this.badge.hidden = count === 0;
    this.badge.textContent = count ? String(count) : "";
    if (this.status.textContent !== this.description) this.status.textContent = this.description;
    this.element.classList.toggle("operation-active", Boolean(active || count));
    this.element.classList.toggle("operation-cancellable", Boolean(this.actionLabel));
  }

  dispose() {
    this.button.removeEventListener("mousedown", this.onMouseDown);
    this.button.removeEventListener("click", this.onClick);
    this.tooltip.dispose();
  }
};
