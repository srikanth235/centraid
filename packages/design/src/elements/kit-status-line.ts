import type { KitProperties } from "./base.js";
import { KitElement } from "./base.js";

// The Binding Layer's fifth invariant: ONE persistent status line, updated
// in place. This element is mounted once by `ensureStatusLineHost()` in
// feedback.ts and reused for every call — there is no stack, no per-message
// element, and no entry/exit animation. `text`/`undoLabel`/`done`/`total`
// are reactive properties (re-render on set); `onUndo` is a plain instance
// property the inline action reads at click time, not a reactive prop or a
// dispatched event — a persistent, reused host must never accumulate
// `addEventListener` calls across updates.
export class KitStatusLine extends KitElement {
  static override properties: KitProperties = {
    text: { type: String },
    undoLabel: { type: String, attribute: "undo-label" },
    done: { type: Number },
    total: { type: Number },
  };

  declare text: string;
  declare undoLabel: string;
  declare done: number | null;
  declare total: number | null;
  onUndo: (() => void) | undefined;

  constructor() {
    super();
    this.text = "";
    this.undoLabel = "";
    this.done = null;
    this.total = null;
    this.onUndo = undefined;
  }

  override render(): HTMLElement {
    const line = document.createElement("div");
    line.className = "kit-status-line";
    line.setAttribute("role", "status");
    line.setAttribute("aria-live", "polite");

    const dot = document.createElement("span");
    dot.className = "kit-status-line-dot";
    dot.setAttribute("aria-hidden", "true");
    line.appendChild(dot);

    const span = document.createElement("span");
    span.className = "kit-status-line-text";
    span.textContent = this.text;
    line.appendChild(span);

    if (this.total != null && this.total > 0) {
      const track = document.createElement("span");
      track.className = "kit-status-line-track";
      const fill = document.createElement("span");
      fill.className = "kit-status-line-fill";
      const pct = Math.max(
        0,
        Math.min(1, (Number(this.done) || 0) / this.total)
      );
      fill.style.width = `${Math.round(pct * 100)}%`;
      track.appendChild(fill);
      line.appendChild(track);
    }

    if (this.undoLabel) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "kit-status-line-action";
      action.textContent = this.undoLabel;
      action.addEventListener("click", () => this.onUndo?.());
      line.appendChild(action);
    }
    return line;
  }
}
customElements.define("kit-status-line", KitStatusLine);
