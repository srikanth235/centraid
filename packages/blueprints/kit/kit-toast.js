import { KitElement } from "./elements-base.js";

export class KitToast extends KitElement {
  static properties = {
    text: { type: String },
    tone: { type: String },
    undoLabel: { type: String, attribute: "undo-label" },
  };
  constructor() {
    super();
    this.text = "";
    this.tone = "";
    this.undoLabel = "";
  }
  render() {
    const div = document.createElement("div");
    div.className = "kit-toast";
    if (this.tone) div.dataset.tone = this.tone;
    const span = document.createElement("span");
    span.textContent = this.text;
    div.appendChild(span);
    if (this.undoLabel) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "kit-toast-action";
      action.textContent = this.undoLabel;
      action.addEventListener("click", () =>
        this.dispatchEvent(new CustomEvent("kit-undo"))
      );
      div.appendChild(action);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "kit-toast-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.addEventListener("click", () =>
      this.dispatchEvent(new CustomEvent("kit-dismiss"))
    );
    div.appendChild(close);
    return div;
  }
}
customElements.define("kit-toast", KitToast);
