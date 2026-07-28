import { KitElement } from "./elements-base.js";

function avatarHue(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1)
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return ((hash % 360) + 360) % 360;
}

function avatarInitials(name) {
  const parts = name.split(/\s+/u);
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export class KitAvatar extends KitElement {
  static properties = {
    name: { type: String },
    size: { type: String },
    shape: { type: String },
    src: { type: String },
    color: { type: String },
    initials: { type: String },
  };

  constructor() {
    super();
    this.name = "";
    this.size = "2.25rem";
    this.shape = "";
    this.src = "";
    this.color = "";
    this.initials = "";
  }

  render() {
    const text = String(this.name ?? "?").trim() || "?";
    const fill = this.color || `hsl(${avatarHue(text)} 45% 42%)`;
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
    } else span.textContent = this.initials || avatarInitials(text);
    return span;
  }
}
customElements.define("kit-avatar", KitAvatar);
