import { svgEl } from './chart-utils.js';
import { KitElement } from './elements-base.js';

export class KitLineChart extends KitElement {
  static properties = {
    points: { type: Array },
    width: { type: Number },
    height: { type: Number },
    label: { type: String },
  };
  constructor() {
    super();
    this.points = [];
    this.width = 640;
    this.height = 160;
    this.label = 'Trend';
  }
  render() {
    const { width, height } = this;
    const points = this.points ?? [];
    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      class: 'kit-chart',
      role: 'img',
      'aria-label': this.label,
    });
    if (points.length < 2) return svg;
    const pad = 8,
      xs = points.map((p) => p.x),
      ys = points.map((p) => p.y);
    const x0 = Math.min(...xs),
      x1 = Math.max(...xs),
      y0 = Math.min(...ys),
      y1 = Math.max(...ys);
    const sx = (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (width - pad * 2);
    const sy = (y) => height - pad - ((y - y0) / (y1 - y0 || 1)) * (height - pad * 2);
    const d = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
      .join(' ');
    const area = `${d} L${sx(x1).toFixed(1)},${height - pad} L${sx(x0).toFixed(1)},${height - pad} Z`;
    const last = points[points.length - 1];
    svg.appendChild(svgEl('path', { d: area, class: 'kit-chart-area' }));
    svg.appendChild(svgEl('path', { d, class: 'kit-chart-line' }));
    svg.appendChild(
      svgEl('circle', {
        cx: sx(last.x),
        cy: sy(last.y),
        r: 3,
        class: 'kit-chart-dot',
      }),
    );
    return svg;
  }
}
customElements.define('kit-line-chart', KitLineChart);
