/* oxlint-disable jsx-a11y/prefer-tag-over-role -- the ring's wedges and bezel arcs are SVG <g> elements; <button> is not renderable inside <svg>, so each g carries role="button" + tabIndex + Enter/Space handling instead */
import { useId, type CSSProperties, type JSX } from 'react';
import { cx } from '../ui/cx.js';
import {
  SUNBURST,
  type PackHues,
  type RingItem,
  type SunburstDomain,
  labelArcPath,
  labelFlipped,
  labelMode,
  labelPlacement,
  labelRadius,
  reachRadius,
  ringBounds,
  sectorPath,
  truncateLabel,
  wedgeAngles,
} from './atlasSunburstGeometry.js';
import styles from './AtlasRelationsTab.module.css';

// The Map's inline-SVG body (issue #519 follow-on) — a stateless presentational
// leaf of AtlasRelationsTab. It draws three layers and nothing else:
//
//   1. the working ring — the current rung's children, at EQUAL angular spans,
//      each reaching outward by its row count and never below `ringFloor`;
//   2. the bezel — every domain at a fixed bearing, drawn only when drilled in,
//      so lateral movement never costs a trip back to the root;
//   3. the centre plate — the rung you stand on, and the control that goes up.
//
// All geometry lives in atlasSunburstGeometry.ts. This component holds no state
// and makes no visibility decision: what it is handed, it draws.

/** Paint vars for one wedge: its base hue, the far end of its domain's sweep,
 *  and where along that sweep it sits. CSS does the mixing. */
const paintOf = (p: PackHues & { mix?: string }): CSSProperties =>
  ({ '--hue': p.hue, '--hue2': p.hue2, '--mix': p.mix ?? '100%' }) as CSSProperties;

/** The centre plate's paint at the root rung, where no domain owns it. */
const ACCENT_PAINT: PackHues = { hue: 'var(--accent)', hue2: 'var(--accent)' };

const fmt = (n: number): string => n.toLocaleString('en-US');

export interface AtlasSunburstChartProps {
  /** The current rung's children — domains at the root, one domain's kinds
   *  inside. Every one is drawn; none is ever filtered for being empty. */
  items: readonly RingItem[];
  /** Every domain the plumbing switch currently shows — the bezel's contents. */
  bezelDomains: readonly SunburstDomain[];
  /** The focused domain's pack name, or `null` at the root rung. */
  focus: string | null;
  /** The focused domain's label, for the centre plate. */
  focusLabel: string | null;
  /** Total rows on the current rung — the centre plate's figure. */
  totalRows: number;
  /** The hovered/focused item id, mirrored with the list. */
  hot: string | null;
  /** The selected kind's logical name, or `null`. */
  selected: string | null;
  onActivate: (id: string) => void;
  onHot: (id: string | null) => void;
  onUp: () => void;
  onBezel: (pack: string) => void;
}

export default function AtlasSunburstChart({
  items,
  bezelDomains,
  focus,
  focusLabel,
  totalRows,
  hot,
  selected,
  onActivate,
  onHot,
  onUp,
  onBezel,
}: AtlasSunburstChartProps): JSX.Element {
  // Unique per-mount prefix for <textPath> arc ids — two mounted charts (tests,
  // previews) must never share element ids.
  const uid = useId();
  const sheenId = `${uid}-sheen`;
  const maxRows = items.reduce((m, i) => Math.max(m, i.rows), 0);
  const mode = labelMode(items.length);
  const bounds = ringBounds(mode);

  return (
    <svg
      className={styles.ring}
      viewBox={`0 0 ${SUNBURST.view} ${SUNBURST.view}`}
      role="img"
      aria-label={
        focus === null
          ? 'Radial map of every domain in the vault'
          : `Radial map of the kinds in ${focusLabel ?? focus}`
      }
      data-testid="atlas-sunburst"
      data-focus={focus ?? 'root'}
    >
      <defs>
        {/* One sheen for every wedge: a glass highlight along the inner edge
            falling to a deepened outer edge. It carries no data — it exists so
            a flat fill reads as a lit surface rather than a paint chip. */}
        <radialGradient
          id={sheenId}
          gradientUnits="userSpaceOnUse"
          cx={SUNBURST.cx}
          cy={SUNBURST.cy}
          r={bounds.out}
        >
          <stop offset={SUNBURST.ringIn / bounds.out} stopColor="#fff" stopOpacity="0.15" />
          <stop offset="0.7" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.18" />
        </radialGradient>
      </defs>

      {/* graticule — the floor and the reach, so a wedge's length is readable
          against a scale rather than eyeballed */}
      <g aria-hidden="true">
        {[bounds.floor, bounds.out].map((r) => (
          <circle key={r} className={styles.guide} cx={SUNBURST.cx} cy={SUNBURST.cy} r={r} />
        ))}
      </g>

      {/* ── the working ring ────────────────────────────────────────────── */}
      {items.map((item, i) => {
        const { start, end, mid } = wedgeAngles(i, items.length);
        const outer = reachRadius(item.rows, maxRows, mode);
        const isHot = hot === item.id;
        const isSel = selected === item.id;
        // The label hugs THIS wedge's outer edge, so an empty wedge's name sits
        // beside its dashed band instead of stranded out at the rim.
        const lp = labelPlacement(mid, labelRadius(outer), mode);

        return (
          <g
            key={item.id}
            role="button"
            tabIndex={0}
            className={cx(
              styles.wedge,
              item.empty && styles.wedgeEmpty,
              isHot && styles.wedgeHot,
              isSel && styles.wedgeSel,
            )}
            style={paintOf(item)}
            data-testid="atlas-wedge"
            data-id={item.id}
            data-empty={item.empty ? 'true' : 'false'}
            aria-label={`${item.name} — ${item.empty ? 'nothing here yet' : `${fmt(item.rows)} records`}`}
            onClick={() => onActivate(item.id)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onActivate(item.id);
              }
            }}
            onMouseOver={() => onHot(item.id)}
            onMouseOut={() => onHot(null)}
            onFocus={() => onHot(item.id)}
            onBlur={() => onHot(null)}
          >
            {/* The floor band spans the full wedge whatever the row count, so a
                short wedge is exactly as easy to hit as a long one. This is the
                hit target; the body above it is the reading. */}
            <path
              className={styles.wedgeFloor}
              d={sectorPath(start, end, SUNBURST.ringIn, bounds.floor)}
            />
            <path className={styles.wedgeBody} d={sectorPath(start, end, SUNBURST.ringIn, outer)} />
            {/* The lit surface. Skipped on an empty wedge, whose body is an
                outline — there is no fill for a highlight to sit on. */}
            {item.empty ? null : (
              <path
                className={styles.wedgeSheen}
                d={sectorPath(start, end, SUNBURST.ringIn, outer)}
                fill={`url(#${sheenId})`}
              />
            )}
            <text
              className={styles.wedgeLabel}
              x={lp.x}
              y={lp.y}
              textAnchor={lp.anchor}
              dominantBaseline="middle"
              transform={
                lp.rotate === 0
                  ? undefined
                  : `rotate(${lp.rotate.toFixed(2)} ${lp.x.toFixed(1)} ${lp.y.toFixed(1)})`
              }
            >
              {truncateLabel(item.name)}
            </text>
          </g>
        );
      })}

      {/* ── the bezel ───────────────────────────────────────────────────────
          Only when drilled in: at the root the working ring already IS the
          domains, and drawing them twice says nothing twice. */}
      {focus !== null
        ? bezelDomains.map((d, i) => {
            const { start, end, mid } = wedgeAngles(i, bezelDomains.length);
            const flip = labelFlipped(mid);
            const arcId = `${uid}-b-${d.pack}`;
            const here = d.pack === focus;
            return (
              <g
                key={d.pack}
                role="button"
                tabIndex={0}
                className={cx(
                  styles.bezel,
                  here && styles.bezelHere,
                  d.rows === 0 && styles.bezelEmpty,
                )}
                style={paintOf(d)}
                data-testid="atlas-bezel"
                data-pack={d.pack}
                aria-label={`Go to ${d.label}`}
                aria-current={here ? 'true' : undefined}
                onClick={() => onBezel(d.pack)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    onBezel(d.pack);
                  }
                }}
              >
                <path
                  className={styles.bezelArc}
                  d={sectorPath(start, end, SUNBURST.bezelIn, SUNBURST.bezelOut)}
                />
                <path
                  id={arcId}
                  fill="none"
                  d={labelArcPath(
                    start,
                    end,
                    flip ? SUNBURST.bezelLabelR + 7 : SUNBURST.bezelLabelR,
                    flip,
                  )}
                />
                <text className={styles.bezelName} textAnchor="middle">
                  <textPath href={`#${arcId}`} startOffset="50%">
                    {d.label}
                  </textPath>
                </text>
              </g>
            );
          })
        : null}

      {/* ── the centre plate ────────────────────────────────────────────
          At the root it is a readout; inside a domain it is also the way up.
          The role/tabIndex only appear when it is genuinely actionable, so a
          keyboard user never lands on a control that does nothing. */}
      <g
        className={cx(styles.core, focus === null && styles.coreRoot)}
        style={paintOf(bezelDomains.find((d) => d.pack === focus) ?? ACCENT_PAINT)}
        role={focus === null ? undefined : 'button'}
        tabIndex={focus === null ? undefined : 0}
        aria-label={focus === null ? undefined : 'Back to every domain'}
        onClick={focus === null ? undefined : onUp}
        onKeyDown={
          focus === null
            ? undefined
            : (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  onUp();
                }
              }
        }
        data-testid="atlas-core"
      >
        <circle className={styles.corePlate} cx={SUNBURST.cx} cy={SUNBURST.cy} r={SUNBURST.coreR} />
        <text className={styles.coreName} x={SUNBURST.cx} y={SUNBURST.cy - 13} textAnchor="middle">
          {focusLabel ?? 'Vault'}
        </text>
        <text className={styles.coreNum} x={SUNBURST.cx} y={SUNBURST.cy + 11} textAnchor="middle">
          {totalRows === 0 ? '—' : fmt(totalRows)}
        </text>
        <text className={styles.coreSub} x={SUNBURST.cx} y={SUNBURST.cy + 27} textAnchor="middle">
          records
        </text>
        {focus === null ? null : (
          <text className={styles.coreUp} x={SUNBURST.cx} y={SUNBURST.cy + 45} textAnchor="middle">
            ↑ all domains
          </text>
        )}
      </g>
    </svg>
  );
}
