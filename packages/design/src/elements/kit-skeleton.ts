import type { KitProperties } from "./base.js";
import { KitElement } from "./base.js";

/** Shimmer placeholder rows: `<kit-skeleton rows variant width>`. */
export class KitSkeleton extends KitElement {
  static override properties: KitProperties = {
    rows: { type: Number },
    variant: { type: String },
    width: { type: String },
  };

  declare rows: number;
  declare variant: string;
  declare width: string;

  constructor() {
    super();
    this.rows = 3;
    this.variant = "";
    this.width = "";
  }

  override render(): HTMLElement[] {
    const cls = this.variant
      ? `kit-skeleton kit-skeleton-${this.variant}`
      : "kit-skeleton";
    return Array.from({ length: Math.max(0, Number(this.rows) || 0) }, () => {
      const row = document.createElement("div");
      row.className = cls;
      if (this.width) row.setAttribute("style", `width:${this.width}`);
      return row;
    });
  }
}
customElements.define("kit-skeleton", KitSkeleton);
