import { KitElement } from './elements-base.js';

export class KitSkeleton extends KitElement {
  static properties = {
    rows: { type: Number },
    variant: { type: String },
    width: { type: String },
  };
  constructor() {
    super();
    this.rows = 3;
    this.variant = '';
    this.width = '';
  }
  render() {
    const cls = this.variant ? `kit-skeleton kit-skeleton-${this.variant}` : 'kit-skeleton';
    return Array.from({ length: Math.max(0, Number(this.rows) || 0) }, () => {
      const row = document.createElement('div');
      row.className = cls;
      if (this.width) row.setAttribute('style', `width:${this.width}`);
      return row;
    });
  }
}
customElements.define('kit-skeleton', KitSkeleton);
