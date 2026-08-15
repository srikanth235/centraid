import { identityColor, identityInitials } from "../identity.js";
import type { KitProperties } from "./base.js";
import { KitElement } from "./base.js";

/** A monogram tile: `<kit-avatar name size shape src color initials>`. */
export class KitAvatar extends KitElement {
  static override properties: KitProperties = {
    name: { type: String },
    size: { type: String },
    shape: { type: String },
    src: { type: String },
    color: { type: String },
    initials: { type: String },
  };

  declare name: string;
  declare size: string;
  declare shape: string;
  declare src: string;
  declare color: string;
  declare initials: string;

  constructor() {
    super();
    this.name = "";
    this.size = "2.25rem";
    this.shape = "";
    this.src = "";
    this.color = "";
    this.initials = "";
  }

  override render(): HTMLElement {
    const text = String(this.name ?? "?").trim() || "?";
    const fill = this.color || identityColor(text);
    const span = document.createElement("span");
    span.className = "kit-avatar";
    span.setAttribute(
      "style",
      `width:${this.size};height:${this.size};font-size:calc(${this.size} * 0.36);background:${fill}`
    );
    span.setAttribute("aria-hidden", "true");
    if (this.shape) span.dataset.shape = this.shape;
    if (this.src) {
      const img = document.createElement("img");
      img.src = this.src;
      img.alt = "";
      span.appendChild(img);
    } else span.textContent = this.initials || identityInitials(text);
    return span;
  }
}
customElements.define("kit-avatar", KitAvatar);
