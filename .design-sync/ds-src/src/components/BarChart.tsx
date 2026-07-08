export interface BarChartItem {
  /** Tick label under the bar. */
  label: string;
  /** Bar value. */
  value: number;
  /** Render this bar muted (de-emphasised). */
  muted?: boolean;
}

export interface BarChartProps {
  /** Bars to draw. */
  items: BarChartItem[];
  /** SVG viewport width. */
  width?: number;
  /** SVG viewport height. */
  height?: number;
  /** Accessible label. */
  label?: string;
}

/** A compact vertical bar chart with tick labels. */
export function BarChart({ items, width = 640, height = 160, label = 'Totals' }: BarChartProps) {
  const pad = 8;
  const labelBand = 16;
  const maxV = Math.max(1, ...items.map((i) => i.value));
  const band = items.length ? (width - 2 * pad) / items.length : 0;
  const barW = band * 0.7;
  const plotH = height - 2 * pad - labelBand;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="kit-chart" role="img" aria-label={label}>
      {items.map((it, i) => {
        const h = Math.max(1, (it.value / maxV) * plotH);
        const x = pad + band * i + band * 0.15;
        const y = height - pad - labelBand - h;
        return (
          <g key={i}>
            <rect
              className="kit-chart-barrect"
              x={+x.toFixed(1)}
              y={+y.toFixed(1)}
              width={+barW.toFixed(1)}
              height={+h.toFixed(1)}
              rx={2}
              {...(it.muted ? { 'data-muted': 'true' } : {})}
            />
            <text className="kit-chart-ticklabel" x={+(x + barW / 2).toFixed(1)} y={height - 4} textAnchor="middle">
              {it.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
