import { KitElement } from "./elements-base.js";

export class KitMeter extends KitElement {
  static properties = { ratio: { type: Number }, tone: { type: String } };
  constructor() {
    super();
    this.ratio = 0;
    this.tone = "";
  }
  render() {
    const pct = Math.max(0, Math.min(1, Number(this.ratio) || 0)) * 100;
    const bar = document.createElement("span");
    bar.className = "kit-bar";
    bar.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.className = "kit-bar-fill";
    fill.setAttribute("style", `width:${pct}%`);
    if (this.tone) fill.dataset.tone = this.tone;
    bar.appendChild(fill);
    return bar;
  }
}
customElements.define("kit-meter", KitMeter);
