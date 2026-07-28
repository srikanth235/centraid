import { svgEl } from './chart-utils.js';
import { KitElement } from './elements-base.js';

export class KitBarChart extends KitElement {
  static properties = {
    items: { type: Array },
    width: { type: Number },
    height: { type: Number },
    label: { type: String },
  };
  constructor() {
    super();
    this.items = [];
    this.width = 640;
    this.height = 160;
    this.label = 'Totals';
  }
  render() {
    const { width, height } = this;
    const items = this.items ?? [];
    const labelBand = 16;
    const max = Math.max(...items.map((i) => i.value), 1);
    const pad = 8;
    const band = items.length ? (width - pad * 2) / items.length : 0;
    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      class: 'kit-chart',
      role: 'img',
      'aria-label': this.label,
    });
    items.forEach((item, i) => {
      const h = ((height - pad * 2 - labelBand) * item.value) / max;
      const rect = svgEl('rect', {
        x: pad + i * band + band * 0.15,
        y: height - pad - labelBand - h,
        width: band * 0.7,
        height: Math.max(h, 1),
        rx: 2,
        class: 'kit-chart-barrect',
      });
      if (item.muted) rect.dataset.muted = 'true';
      svg.appendChild(rect);
      const text = svgEl('text', {
        x: pad + i * band + band / 2,
        y: height - pad,
        class: 'kit-chart-ticklabel',
        'text-anchor': 'middle',
      });
      text.textContent = item.label;
      svg.appendChild(text);
    });
    return svg;
  }
}
customElements.define('kit-bar-chart', KitBarChart);
