export interface LineChartPoint {
  /** Position along the x axis (typically epoch-ms). */
  x: number;
  /** The value. */
  y: number;
}

export interface LineChartProps {
  /** Series data; needs at least two points to draw. */
  points: LineChartPoint[];
  /** SVG viewport width. */
  width?: number;
  /** SVG viewport height. */
  height?: number;
  /** Accessible label. */
  label?: string;
}

/** A small trend line with a filled area and a dot on the last point. */
export function LineChart({ points, width = 640, height = 160, label = 'Trend' }: LineChartProps) {
  const pad = 8;
  const common = { viewBox: `0 0 ${width} ${height}`, className: 'kit-chart', role: 'img', 'aria-label': label };
  if (!points || points.length < 2) return <svg {...common} />;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX || 1;
  const spanY = Math.max(...ys) - minY || 1;
  const sx = (x: number) => +(pad + ((x - minX) / spanX) * (width - 2 * pad)).toFixed(1);
  const sy = (y: number) => +(height - pad - ((y - minY) / spanY) * (height - 2 * pad)).toFixed(1);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x)} ${sy(p.y)}`).join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  const baseline = +(height - pad).toFixed(1);
  const area = `${line} L${sx(last.x)} ${baseline} L${sx(first.x)} ${baseline} Z`;

  return (
    <svg {...common}>
      <path className="kit-chart-area" d={area} />
      <path className="kit-chart-line" d={line} />
      <circle className="kit-chart-dot" cx={sx(last.x)} cy={sy(last.y)} r={3} />
    </svg>
  );
}
